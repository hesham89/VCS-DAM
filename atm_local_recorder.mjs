import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { URL } from "node:url";

const bindHost = process.env.LOCAL_RECORDER_BIND_HOST ?? "0.0.0.0";
const httpsPort = Number(process.env.LOCAL_RECORDER_HTTPS_PORT ?? "8443");
const httpPort = Number(process.env.LOCAL_RECORDER_HTTP_PORT ?? "8080");
const vcsWsUrl = process.env.VCS_WS_URL ?? "wss://5.1.1.243:3443/ws";
const recordingDir = path.resolve(process.env.LOCAL_RECORDER_DIR ?? "/recordings/atm-vcs");
const segmentSeconds = Math.max(30, Number(process.env.RECORDER_SEGMENT_SECONDS ?? "300"));
const certPath = process.env.LOCAL_RECORDER_CERT ?? path.join(recordingDir, "certs", "recorder.crt");
const keyPath = process.env.LOCAL_RECORDER_KEY ?? path.join(recordingDir, "certs", "recorder.key");
const rxSessions = new Map();
const txSessions = new Map();
const clients = new Set();
const startedAt = new Date();
let vcsState = null;
let vcsConnected = false;
let lastVcsMessageAt = null;
let reconnectTimer = null;

const audioDir = path.join(recordingDir, "audio");
const indexPath = path.join(recordingDir, "recording-index.jsonl");
mkdirSync(audioDir, { recursive: true });
mkdirSync(path.dirname(certPath), { recursive: true });
const indexStream = createWriteStream(indexPath, { flags: "a" });

function nowIso() {
  return new Date().toISOString();
}

function token(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 120);
}

function sessionId(prefix, channelId) {
  return `${prefix}_${token(channelId)}_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${randomBytes(3).toString("hex")}`;
}

function writeIndex(event) {
  indexStream.write(`${JSON.stringify({ at: nowIso(), ...event })}\n`);
}

function readIndex(limit = 1000) {
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function sessions(limit = 500) {
  const byId = new Map();
  for (const event of readIndex(10000)) {
    if (!event.id) continue;
    byId.set(event.id, { ...(byId.get(event.id) ?? {}), ...event });
  }
  for (const session of [...rxSessions.values(), ...txSessions.values()]) {
    byId.set(session.id, { ...(byId.get(session.id) ?? {}), ...publicSession(session), active: true });
  }
  return [...byId.values()].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? ""))).slice(0, limit);
}

function storeUsage() {
  let bytes = 0;
  let files = 0;
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      if (entry.isFile()) {
        const st = statSync(full);
        bytes += st.size;
        files += 1;
      }
    }
  };
  walk(audioDir);
  return { bytes, files };
}

function alawToPcm16(value) {
  let a = value ^ 0x55;
  const sign = a & 0x80;
  const exponent = (a & 0x70) >> 4;
  const mantissa = a & 0x0f;
  let sample = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? sample : -sample;
}

function wavHeader(dataBytes, audioFormat, channels, sampleRate, bitsPerSample) {
  const blockAlign = channels * bitsPerSample / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function rawToPcmWav(session) {
  const raw = readFileSync(session.filePath);
  if (session.encoding === "pcma") {
    const pcm = Buffer.alloc(raw.length * 2);
    for (let i = 0; i < raw.length; i++) pcm.writeInt16LE(alawToPcm16(raw[i]), i * 2);
    return Buffer.concat([wavHeader(pcm.length, 1, 1, 8000, 16), pcm]);
  }
  return Buffer.concat([wavHeader(raw.length, 1, 1, 8000, 16), raw]);
}

function openSession({ direction, channelId, channelLabel, frequency, encoding, source }) {
  const id = sessionId(direction.toLowerCase(), channelId);
  const date = new Date();
  const folder = path.join(audioDir, date.toISOString().slice(0, 10), token(channelId));
  mkdirSync(folder, { recursive: true });
  const ext = encoding === "pcma" ? "pcma" : "pcm16le";
  const fileName = `${id}.${ext}`;
  const filePath = path.join(folder, fileName);
  const session = {
    id,
    direction,
    channelId,
    channelLabel,
    frequency,
    encoding,
    source,
    sampleRate: 8000,
    startedAt: date.toISOString(),
    fileName,
    filePath,
    packets: 0,
    bytes: 0,
    stream: createWriteStream(filePath, { flags: "a" })
  };
  writeIndex({ type: "start", ...publicSession(session) });
  return session;
}

function publicSession(session) {
  const { stream, ...publicFields } = session;
  return publicFields;
}

function closeSession(session, reason = "closed") {
  if (!session) return;
  session.stoppedAt = nowIso();
  session.reason = reason;
  try { session.stream.end(); } catch {}
  writeIndex({ type: "stop", ...publicSession(session) });
}

function writeRxAudio(message) {
  const channelId = message.radioId || "unknown-rx";
  const current = rxSessions.get(channelId);
  const shouldRotate = !current || (Date.now() - Date.parse(current.startedAt)) / 1000 >= segmentSeconds;
  if (shouldRotate) {
    if (current) closeSession(current, "segment-rotate");
    const radio = vcsState?.radios?.find((item) => item.id === channelId);
    rxSessions.set(channelId, openSession({
      direction: "RX",
      channelId,
      channelLabel: radio?.label ?? channelId,
      frequency: message.frequency ?? radio?.frequency ?? "",
      encoding: "pcma",
      source: "vcs-rx-websocket"
    }));
  }
  const session = rxSessions.get(channelId);
  const payload = Buffer.from(String(message.payload ?? ""), "base64");
  session.stream.write(payload);
  session.packets += 1;
  session.bytes += payload.length;
  session.lastPacketAt = nowIso();
}

function startTx(meta) {
  const channelId = meta.radioId || "unknown-tx";
  if (txSessions.has(channelId)) closeSession(txSessions.get(channelId), "restart");
  const session = openSession({
    direction: "TX",
    channelId,
    channelLabel: meta.radioLabel ?? channelId,
    frequency: meta.frequency ?? "",
    encoding: "pcm16le",
    source: meta.operator ?? "operator-browser"
  });
  session.browserSessionId = meta.browserSessionId ?? null;
  txSessions.set(channelId, session);
}

function writeTxAudio(buffer) {
  for (const session of txSessions.values()) {
    session.stream.write(buffer);
    session.packets += 1;
    session.bytes += buffer.length;
    session.lastPacketAt = nowIso();
  }
}

function stopTx(meta) {
  const channelId = meta.radioId || [...txSessions.keys()][0];
  const session = txSessions.get(channelId);
  if (!session) return;
  txSessions.delete(channelId);
  closeSession(session, "ptt-stop");
}

function encodeWs(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]) : null;
  if (!head) throw new Error("WebSocket payload too large");
  return Buffer.concat([head, payload]);
}

function parseWsFrames(buffer) {
  const frames = [];
  let o = 0;
  while (o + 2 <= buffer.length) {
    const first = buffer[o++], second = buffer[o++], opcode = first & 15;
    let len = second & 127;
    if (len === 126) { len = buffer.readUInt16BE(o); o += 2; }
    if (len === 127) { len = Number(buffer.readBigUInt64BE(o)); o += 8; }
    const mask = second & 128 ? buffer.subarray(o, o + 4) : null;
    if (mask) o += 4;
    if (o + len > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(o, o + len));
    o += len;
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
  }
  return frames;
}

function wsAccept(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function acceptTxWs(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${wsAccept(key)}`,
    "",
    ""
  ].join("\r\n"));
  clients.add(socket);
  socket.on("data", (data) => {
    for (const frame of parseWsFrames(data)) {
      if (frame.opcode === 1) {
        try {
          const msg = JSON.parse(frame.payload.toString("utf8"));
          if (msg.type === "tx-start") startTx(msg);
          if (msg.type === "tx-stop") stopTx(msg);
          if (msg.type === "rx-audio") writeRxAudio(msg);
        } catch {}
      }
      if (frame.opcode === 2) writeTxAudio(frame.payload);
      if (frame.opcode === 8) socket.destroy();
    }
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
}

function connectVcs() {
  clearTimeout(reconnectTimer);
  const target = new URL(vcsWsUrl);
  const key = randomBytes(16).toString("base64");
  const headers = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": key,
    Host: target.host
  };
  const transport = target.protocol === "wss:" ? httpsRequest : httpRequest;
  const req = transport({
    method: "GET",
    hostname: target.hostname,
    port: target.port || (target.protocol === "wss:" ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    rejectUnauthorized: false,
    headers
  });
  req.on("upgrade", (_res, socket) => {
    vcsConnected = true;
    socket.on("data", (data) => {
      lastVcsMessageAt = nowIso();
      for (const frame of parseWsFrames(data)) {
        if (frame.opcode !== 1) continue;
        try {
          const msg = JSON.parse(frame.payload.toString("utf8"));
          if (msg.type === "state") vcsState = msg.state;
          if (msg.type === "rx-audio") writeRxAudio(msg);
        } catch {}
      }
    });
    socket.on("close", () => {
      vcsConnected = false;
      reconnectTimer = setTimeout(connectVcs, 3000);
    });
    socket.on("error", () => {
      vcsConnected = false;
      try { socket.destroy(); } catch {}
    });
  });
  req.on("error", () => {
    vcsConnected = false;
    reconnectTimer = setTimeout(connectVcs, 3000);
  });
  req.end();
}

function htmlPage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ATM Recorder Replay</title>
<style>
*{box-sizing:border-box}:root{font-family:Segoe UI,Arial,sans-serif;background:#eef3f7;color:#1e2c38}body{margin:0;background:#dce8f1}button,input,select{font:inherit}button{border:0;background:#1f7fac;color:white;min-height:36px;padding:0 13px;cursor:pointer}button.secondary{background:#5b7080}button.ghost{background:transparent;color:#d9eef8;border:1px solid rgba(255,255,255,.35)}button.icon{width:42px;padding:0;font-size:18px}.topbar{height:74px;background:#f3f6f9;border-bottom:1px solid #a8b8c5;display:grid;grid-template-columns:88px 1fr auto;align-items:center}.hamb{height:74px;border-right:1px solid #b5c3ce;display:grid;place-items:center;font-size:34px;color:#6b7780}.tabs{display:flex;height:74px}.tab{display:flex;align-items:center;gap:10px;padding:0 24px;border-right:1px solid #cfdae2;font-weight:700;color:#1f2d38}.tab.active{background:#1385ba;color:white}.tab small{font-size:28px;line-height:1}.clock{display:flex;align-items:center;gap:18px;padding:0 22px;color:#596675}.clock strong{font-size:30px;color:#52606c}.brand{font-size:26px;font-weight:800;color:#155b85;letter-spacing:.05em}.subbar{height:66px;background:#1686bb;display:grid;grid-template-columns:360px 1fr 270px;align-items:center;color:white}.viewmodes{display:flex;gap:12px;padding-left:18px}.viewmodes button{background:#0f6f9d;font-size:20px}.transport{display:flex;align-items:center;gap:10px}.transport .time{margin-left:28px;font-size:30px;font-weight:800}.tools{display:flex;align-items:center;gap:10px;justify-content:end;padding-right:14px}.layout{height:calc(100vh - 140px);min-height:650px;display:grid;grid-template-columns:360px 1fr 270px}.sourcebar{background:#e8edf2;border-right:1px solid #96abb9;display:grid;grid-template-rows:auto 1fr auto}.source-head{height:44px;background:#f8fafc;border-bottom:1px solid #b4c2cc;display:flex;align-items:center;gap:8px;padding:0 10px}.tree{overflow:auto;padding:8px 0}.group{border-bottom:1px solid #d2dbe2}.group-title{display:flex;align-items:center;gap:8px;padding:8px 12px;font-weight:700;color:#394a57}.source{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:9px 12px 9px 34px;cursor:pointer}.source:hover,.source.selected{background:#ccd7df}.source small{display:block;color:#697984}.source .count{color:#536674}.source .add{font-weight:800}.search{border-top:1px solid #b4c2cc;padding:8px}.search input{width:100%;padding:10px;border:1px solid #aebbc6}.workspace{background:#7193b2;display:grid;grid-template-rows:44px 1fr 118px}.panel-tabs{height:44px;background:#d9e1e8;display:flex;align-items:end;gap:8px;padding-left:10px}.panel-tabs button{height:34px;background:#607f9d}.panel-tabs button.active{background:#4e789b}.replay{position:relative;overflow:auto;background:#6f90ad}.ruler{position:sticky;top:0;height:34px;background:#5d7f9f;z-index:2;border-bottom:1px solid rgba(255,255,255,.35)}.ruler span{position:absolute;bottom:7px;font-size:12px;color:white;font-weight:700}.playhead{position:absolute;top:0;bottom:0;width:2px;background:#29a349;z-index:4}.track{display:grid;grid-template-columns:210px 1fr;min-height:76px;border-bottom:1px solid rgba(255,255,255,.25)}.track-label{background:#5f7f9b;color:white;padding:12px 12px;border-right:1px solid rgba(255,255,255,.35);display:grid;grid-template-columns:36px 1fr auto;align-items:center;gap:8px}.track-label .speaker{font-size:24px}.track-label strong{display:block}.track-label small{display:block;color:#d8eaf4;margin-top:4px}.lane{position:relative;min-width:760px;background:rgba(255,255,255,.08)}.segment{position:absolute;top:22px;height:30px;min-width:4px;background:#f7fbff;border:1px solid #e5f0f7;box-shadow:0 0 0 1px rgba(0,0,0,.08);cursor:pointer}.segment.tx{background:#d8f3ff;border-color:#94d9f1}.segment.rx{background:#fff}.segment.active{outline:2px solid #1f7fac}.segment:after{content:"";position:absolute;left:50%;top:8px;width:12px;height:12px;transform:translateX(-50%) rotate(45deg);background:#bfe7f6}.bottom-panels{display:grid;grid-template-columns:1fr 1fr 1fr;background:#6688a5;border-top:1px solid rgba(255,255,255,.35)}.bottom-panel{padding:10px;color:white;border-right:1px solid rgba(255,255,255,.25);overflow:auto}.bottom-panel h3{margin:0 0 8px;font-size:15px}.bottom-panel dl{display:grid;grid-template-columns:90px 1fr;gap:4px;margin:0}.bottom-panel dt{color:#d3e4ef}.bottom-panel dd{margin:0}.side{background:#6d8dac;color:white;border-left:1px solid #55728c;display:grid;grid-template-rows:auto 1fr}.side-controls{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px;border-bottom:1px solid rgba(255,255,255,.35);background:#d9e1e8;color:#1f2d38}.side-controls label{font-size:12px}.side-controls select{width:100%;height:32px}.mixers{overflow:auto}.mixer{padding:12px;border-bottom:1px solid rgba(255,255,255,.28)}.mixer h3{margin:0 0 10px;font-size:15px}.mixer audio{width:100%;height:34px}.vol{display:grid;grid-template-columns:58px 1fr;gap:10px;align-items:center;margin-bottom:8px}.vol input{width:100%}.screen{display:none;height:calc(100vh - 140px);padding:18px;overflow:auto;background:#eef3f7}.screen.active{display:block}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:14px}.card{background:white;border:1px solid #bdccd7;border-radius:4px;padding:13px}.card span{display:block;color:#667886;font-size:12px}.card strong{display:block;margin-top:8px;font-size:22px}.table{width:100%;border-collapse:collapse;background:white;border:1px solid #bdccd7}.table th,.table td{text-align:left;padding:10px;border-bottom:1px solid #dce5ec;font-size:14px}.table th{background:#e6edf3;color:#465865}.pill{display:inline-block;border-radius:999px;padding:3px 8px;background:#dce6ee;font-weight:700}.pill.rx{background:#d8f0df}.pill.tx{background:#f3d5da}.note{color:#526879}.alarm-ok{color:#24763d}.alarm-warn{color:#a26a00}.settings-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.setting{background:white;border:1px solid #bdccd7;padding:12px}.setting h3{margin:0 0 8px}.setting p{margin:0;color:#526879}@media(max-width:1100px){.layout{grid-template-columns:280px 1fr}.side{display:none}.subbar{grid-template-columns:280px 1fr}.tools{display:none}.cards,.settings-grid{grid-template-columns:1fr 1fr}}@media(max-width:760px){.layout{grid-template-columns:1fr}.sourcebar{display:none}.subbar{grid-template-columns:1fr}.transport{padding-left:10px}.clock,.viewmodes{display:none}.cards,.settings-grid{grid-template-columns:1fr}}
</style></head><body>
<div class="topbar"><div class="hamb">=</div><nav class="tabs"><div class="tab active" data-screen="replay"><small>▶</small>Replay</div><div class="tab" data-screen="admin"><small>▣</small>Admin</div><div class="tab" data-screen="reports"><small>▰</small>Reports</div><div class="tab" data-screen="alarms"><small>!</small>Alarms</div><div class="tab" data-screen="settings"><small>⚙</small>Settings</div></nav><div class="clock"><span id="dateNow">-</span><strong id="clockNow">--:--:--</strong><span class="brand">JOTRON STYLE</span></div></div>
<div class="subbar"><div class="viewmodes"><button class="icon">☷</button><button class="icon">▦</button><button class="icon">▣</button></div><div class="transport"><button class="icon secondary" onclick="jump(-60)">↶</button><button class="icon" onclick="jump(-10)">◀</button><button class="icon" onclick="playSelected()">▶</button><button class="icon secondary" onclick="pauseAll()">■</button><button class="icon" onclick="jump(10)">▶</button><button class="icon secondary" onclick="jump(60)">↷</button><span id="centerDate"></span><span class="time" id="replayClock">--:--:--</span><span>UTC</span></div><div class="tools"><button class="icon ghost">⌕</button><button class="icon ghost">31</button><button class="icon ghost">▣</button><button class="icon ghost">☰</button></div></div>
<section id="replay" class="screen active" style="padding:0"><div class="layout"><aside class="sourcebar"><div class="source-head"><button class="secondary" onclick="clearSelection()">Remove all</button><button class="secondary" onclick="selectAllAudio()">+</button></div><div class="tree" id="tree"></div><div class="search"><input id="sourceSearch" placeholder="Insert source name or tag" oninput="renderTree()"></div></aside><main class="workspace"><div class="panel-tabs"><button class="active">Source panel</button><button>Presenter panel</button><button>Metadata panel</button><strong style="align-self:center;margin-left:14px;color:#2e3f4c" id="onlineState">Online</strong></div><div class="replay" id="timeline"><div class="ruler" id="ruler"></div><div class="playhead" id="playhead"></div><div id="tracks"></div></div><div class="bottom-panels"><div class="bottom-panel"><h3>Source panel</h3><div id="sourceInfo"></div></div><div class="bottom-panel"><h3>Presenter panel</h3><div id="presenterInfo"></div></div><div class="bottom-panel"><h3>Metadata panel</h3><dl id="metadataInfo"></dl></div></div></main><aside class="side"><div class="side-controls"><label>Replay Speed<select id="speed"><option>0.5x</option><option selected>1x</option><option>2x</option><option>4x</option></select></label><label>View Range<select id="range" onchange="renderTimeline()"><option value="300">5 minutes</option><option value="600" selected>10 minutes</option><option value="1800">30 minutes</option><option value="3600">1 hour</option></select></label></div><div class="mixers" id="mixers"></div></aside></div></section>
<section id="admin" class="screen"><div class="cards"><div class="card"><span>VCS Feed</span><strong id="vcs">-</strong></div><div class="card"><span>Last VCS Message</span><strong id="last">-</strong></div><div class="card"><span>Storage</span><strong id="storage">-</strong></div><div class="card"><span>Active Sessions</span><strong id="active">-</strong></div></div><table class="table"><thead><tr><th>Channel</th><th>Direction</th><th>Started</th><th>Duration</th><th>Bytes</th><th>Playback</th></tr></thead><tbody id="rows"></tbody></table></section>
<section id="reports" class="screen"><div class="cards"><div class="card"><span>Total Channels</span><strong id="reportChannels">-</strong></div><div class="card"><span>Total Sessions</span><strong id="reportSessions">-</strong></div><div class="card"><span>Recorded Bytes</span><strong id="reportBytes">-</strong></div><div class="card"><span>Generated</span><strong id="reportAt">-</strong></div></div><table class="table"><thead><tr><th>Channel</th><th>RX</th><th>TX</th><th>Sessions</th><th>Bytes</th></tr></thead><tbody id="reportRows"></tbody></table></section>
<section id="alarms" class="screen"><div class="cards"><div class="card"><span>Recorder</span><strong id="alarmRecorder">-</strong></div><div class="card"><span>VCS subscriber</span><strong id="alarmVcs">-</strong></div><div class="card"><span>Storage</span><strong id="alarmStorage">-</strong></div><div class="card"><span>RX/TX ingest</span><strong id="alarmIngest">-</strong></div></div><table class="table"><thead><tr><th>Time</th><th>Severity</th><th>Alarm</th><th>Details</th></tr></thead><tbody id="alarmRows"></tbody></table></section>
<section id="settings" class="screen"><div class="settings-grid"><div class="setting"><h3>Replay</h3><p>Timeline replay, channel source selection, speed control, WAV export and synchronized RX/TX inspection are active.</p></div><div class="setting"><h3>Admin</h3><p>User and group administration is planned. Current access depends on local network and browser certificate trust.</p></div><div class="setting"><h3>Reports</h3><p>Channel statistics, storage use and session counts are generated from the recorder index.</p></div><div class="setting"><h3>Alarms</h3><p>Recorder service, storage and VCS feed health are shown in the alarms panel.</p></div><div class="setting"><h3>Archive</h3><p>Retention, impound, quarantine and archive workflows are planned for the next storage policy pass.</p></div><div class="setting"><h3>Interfaces</h3><p>Current ingest uses browser RX/TX duplication plus optional direct VCS WebSocket subscriber.</p></div></div><h2>Audit trail</h2><table class="table"><thead><tr><th>Time</th><th>Action</th><th>Channel</th><th>Remote</th></tr></thead><tbody id="auditRows"></tbody></table></section>
<script>
let health=null, recordings=[], reports=null, audit=[], selectedIds=new Set(), selectedRecording=null, timelineStart=0, timelineEnd=0;
const fmtBytes=n=>{n=Number(n)||0;return n>1073741824?(n/1073741824).toFixed(1)+' GB':n>1048576?(n/1048576).toFixed(1)+' MB':n>1024?(n/1024).toFixed(1)+' KB':n+' B'};
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function dur(r){if(!r.startedAt)return'-';const end=r.stoppedAt||r.lastPacketAt||new Date().toISOString();return Math.max(0,Math.round((Date.parse(end)-Date.parse(r.startedAt))/1000))+' s'}
function shortTime(t){if(!t)return'-';return new Date(t).toISOString().slice(11,19)}
function dateOnly(t){return t?new Date(t).toISOString().slice(0,10):''}
function byChannel(){const map=new Map();for(const r of recordings){const k=r.channelId||'unknown';if(!map.has(k))map.set(k,{id:k,label:r.channelLabel||k,frequency:r.frequency||'',rx:0,tx:0,items:[]});const c=map.get(k);c.items.push(r);if(r.direction==='RX')c.rx++;if(r.direction==='TX')c.tx++;if(r.frequency)c.frequency=r.frequency}return [...map.values()].sort((a,b)=>a.label.localeCompare(b.label))}
function setScreen(id){document.querySelectorAll('.screen').forEach(e=>e.classList.toggle('active',e.id===id));document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('active',e.dataset.screen===id));if(id==='reports')renderReports();if(id==='alarms')renderAlarms();if(id==='settings')renderAudit()}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>setScreen(t.dataset.screen));
function tickClock(){const d=new Date();clockNow.textContent=d.toISOString().slice(11,19);dateNow.textContent=d.toISOString().slice(0,10);if(!selectedRecording)replayClock.textContent=d.toISOString().slice(11,19)}setInterval(tickClock,1000);tickClock();
async function loadHealth(){health=await fetch('/api/health').then(r=>r.json());vcs.textContent=health.vcsConnected?'Connected':'Disconnected';vcs.className=health.vcsConnected?'alarm-ok':'alarm-warn';last.textContent=health.lastVcsMessageAt||'browser feed mode';storage.textContent=fmtBytes(health.storage.bytes)+' / '+health.storage.files+' files';active.textContent=health.active.rx+health.active.tx;onlineState.textContent=health.ok?'Online':'Degraded'}
async function loadRecordings(){recordings=await fetch('/api/recordings').then(r=>r.json());if(!selectedIds.size)byChannel().slice(0,4).forEach(c=>selectedIds.add(c.id));renderTree();renderTimeline();renderRows();renderMixers();renderPanels()}
async function loadReports(){reports=await fetch('/api/reports').then(r=>r.json()).catch(()=>null)}
async function loadAudit(){audit=await fetch('/api/audit').then(r=>r.json()).catch(()=>[])}
function renderTree(){const q=(sourceSearch.value||'').toLowerCase();const channels=byChannel().filter(c=>!q||c.label.toLowerCase().includes(q)||c.id.toLowerCase().includes(q));const groups=[['Audio','ED137 version B',channels],['H264','Video channels planned',[]],['H265','Video channels planned',[]],['Radar','EthernetRAW planned',[]],['Raw','Packet data planned',[]],['ReVue','Screen replay planned',[]]];tree.innerHTML=groups.map(g=>'<div class="group"><div class="group-title">▾ '+esc(g[0])+' <span style="margin-left:auto">'+g[2].length+'</span></div>'+(g[2].length?g[2].map(c=>'<div class="source '+(selectedIds.has(c.id)?'selected':'')+'" onclick="toggleSource(\\''+esc(c.id)+'\\')"><div><strong>'+esc(c.label)+'</strong><small>'+esc(c.id)+' / '+esc(c.frequency)+'</small></div><span class="count">'+c.items.length+'</span><span class="add">'+(selectedIds.has(c.id)?'-':'+')+'</span></div>').join(''):'<div class="source"><div><strong>'+esc(g[1])+'</strong><small>not configured</small></div><span class="count">0</span><span class="add">+</span></div>')+'</div>').join('')}
function toggleSource(id){selectedIds.has(id)?selectedIds.delete(id):selectedIds.add(id);renderTree();renderTimeline();renderMixers();renderPanels()}
function clearSelection(){selectedIds.clear();renderTree();renderTimeline();renderMixers();renderPanels()}
function selectAllAudio(){byChannel().forEach(c=>selectedIds.add(c.id));renderTree();renderTimeline();renderMixers();renderPanels()}
function calcWindow(){const range=Number(document.getElementById('range').value)||600;const times=recordings.flatMap(r=>[Date.parse(r.startedAt)||0,Date.parse(r.stoppedAt||r.lastPacketAt)||0]).filter(Boolean);timelineEnd=Math.max(Date.now(),...times);timelineStart=timelineEnd-(range*1000)}
function pct(t){return Math.max(0,Math.min(100,((t-timelineStart)/(timelineEnd-timelineStart))*100))}
function renderTimeline(){calcWindow();centerDate.textContent=dateOnly(timelineEnd);ruler.innerHTML='';for(let i=0;i<=4;i++){const t=timelineStart+((timelineEnd-timelineStart)*i/4),s=document.createElement('span');s.style.left=(i*25)+'%';s.textContent=shortTime(t);ruler.appendChild(s)}playhead.style.left=pct(Date.now())+'%';const channels=byChannel().filter(c=>selectedIds.has(c.id));tracks.innerHTML=channels.map(c=>'<div class="track"><div class="track-label"><span class="speaker">'+(c.tx&&!c.rx?'⌁':'◉')+'</span><div><strong>'+esc(c.label)+'</strong><small>'+esc(c.id)+' / '+esc(c.frequency)+'</small></div><span>▾</span></div><div class="lane">'+c.items.map(r=>{const a=Date.parse(r.startedAt)||timelineStart,b=Date.parse(r.stoppedAt||r.lastPacketAt)||a+1000,left=pct(a),width=Math.max(.5,pct(b)-left);return '<div class="segment '+r.direction.toLowerCase()+' '+(selectedRecording?.id===r.id?'active':'')+'" style="left:'+left+'%;width:'+width+'%" title="'+esc(r.direction+' '+r.channelLabel+' '+r.startedAt)+'" onclick="selectRecording(\\''+esc(r.id)+'\\')"></div>'}).join('')+'</div></div>').join('')||'<div style="padding:30px;color:white">No selected sources</div>'}
function renderRows(){rows.innerHTML=recordings.map(r=>'<tr onclick="selectRecording(\\''+esc(r.id)+'\\')"><td>'+esc(r.channelLabel||r.channelId)+'</td><td><span class="pill '+String(r.direction).toLowerCase()+'">'+esc(r.direction)+'</span></td><td>'+esc(r.startedAt)+'</td><td>'+dur(r)+'</td><td>'+fmtBytes(r.bytes)+'</td><td><audio controls preload="none" src="/api/recordings/'+encodeURIComponent(r.id)+'/wav"></audio></td></tr>').join('')}
function renderMixers(){const channels=byChannel().filter(c=>selectedIds.has(c.id));mixers.innerHTML=channels.map(c=>{const latest=c.items[0];return '<div class="mixer"><h3>'+esc(c.label)+'</h3><div class="vol"><span>Volume</span><input type="range" min="0" max="100" value="80"></div><label>Channel<select><option>'+esc(c.id)+'</option></select></label>'+(latest?'<audio controls preload="none" src="/api/recordings/'+encodeURIComponent(latest.id)+'/wav"></audio>':'')+'</div>'}).join('')}
function renderPanels(){const channels=byChannel().filter(c=>selectedIds.has(c.id));sourceInfo.innerHTML=channels.map(c=>'<div>'+esc(c.label)+' <span style="float:right">'+c.items.length+'</span></div>').join('')||'<span class="note">No source selected</span>';presenterInfo.innerHTML=(selectedRecording?'<strong>'+esc(selectedRecording.channelLabel||selectedRecording.channelId)+'</strong><br>'+esc(selectedRecording.direction)+' / '+esc(selectedRecording.frequency)+'<br><button onclick="playSelected()">Play selected</button>':'<span class="note">Select a segment</span>');metadataInfo.innerHTML=selectedRecording?['id','direction','channelId','frequency','encoding','startedAt','stoppedAt','bytes','source'].map(k=>'<dt>'+k+'</dt><dd>'+esc(selectedRecording[k]??'-')+'</dd>').join(''):'<dt>Status</dt><dd>No segment selected</dd>'}
function selectRecording(id){selectedRecording=recordings.find(r=>r.id===id)||null;if(selectedRecording){replayClock.textContent=shortTime(selectedRecording.startedAt);selectedIds.add(selectedRecording.channelId)}renderTree();renderTimeline();renderPanels()}
function playSelected(){if(!selectedRecording)return;const a=new Audio('/api/recordings/'+encodeURIComponent(selectedRecording.id)+'/wav');a.playbackRate=Number(speed.value.replace('x',''))||1;a.play().catch(()=>{})}
function pauseAll(){document.querySelectorAll('audio').forEach(a=>a.pause())}
function jump(sec){if(selectedRecording){const t=new Date(Date.parse(selectedRecording.startedAt)+sec*1000);replayClock.textContent=t.toISOString().slice(11,19)}}
function renderReports(){if(!reports)return;reportChannels.textContent=reports.channels.length;reportSessions.textContent=reports.channels.reduce((a,c)=>a+c.sessions,0);reportBytes.textContent=fmtBytes(reports.storage.bytes);reportAt.textContent=shortTime(reports.generatedAt);reportRows.innerHTML=reports.channels.map(c=>'<tr><td>'+esc(c.channelLabel)+'<br><small>'+esc(c.channelId)+'</small></td><td>'+c.rx+'</td><td>'+c.tx+'</td><td>'+c.sessions+'</td><td>'+fmtBytes(c.bytes)+'</td></tr>').join('')}
function renderAlarms(){const alarms=[];if(!health?.ok)alarms.push(['critical','RECORDER_DOWN','Recorder service is not healthy']);if(!health?.vcsConnected)alarms.push(['warning','VCS_SUBSCRIBER_OFFLINE','Direct VCS subscriber is offline. Browser RX/TX duplication can still record from operator terminals.']);if((health?.storage?.bytes||0)===0)alarms.push(['warning','NO_AUDIO_INDEXED','No operational recordings are indexed yet.']);alarmRecorder.textContent=health?.ok?'OK':'Down';alarmVcs.textContent=health?.vcsConnected?'Connected':'Browser mode';alarmStorage.textContent=fmtBytes(health?.storage?.bytes||0);alarmIngest.textContent=(health?.active?.rx||0)+(health?.active?.tx||0)+' active';alarmRows.innerHTML=(alarms.length?alarms:[['ok','NO_ACTIVE_CRITICAL','No recorder critical alarms']]).map(a=>'<tr><td>'+new Date().toISOString()+'</td><td>'+a[0]+'</td><td>'+a[1]+'</td><td>'+a[2]+'</td></tr>').join('')}
function renderAudit(){auditRows.innerHTML=(audit.length?audit:[{at:'-',action:'No audit events yet',channelId:'-',remoteAddress:'-'}]).map(a=>'<tr><td>'+esc(a.at)+'</td><td>'+esc(a.action)+'</td><td>'+esc(a.channelId||a.id||'-')+'</td><td>'+esc(a.remoteAddress||'-')+'</td></tr>').join('')}
async function loadAll(){await loadHealth();await loadRecordings();await loadReports();await loadAudit();renderReports();renderAlarms();renderAudit()}loadAll();setInterval(async()=>{await loadHealth();renderAlarms()},3000);
</script></body></html>`;
}

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function handleHttp(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(htmlPage());
  }
  if (url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      vcsWsUrl,
      vcsConnected,
      lastVcsMessageAt,
      recordingDir,
      storage: storeUsage(),
      active: { rx: rxSessions.size, tx: txSessions.size }
    });
  }
  if (url.pathname === "/api/recordings") {
    const direction = url.searchParams.get("direction");
    const channel = url.searchParams.get("channel");
    return json(res, 200, sessions(500).filter((item) => (!direction || item.direction === direction) && (!channel || item.channelId === channel)));
  }
  if (url.pathname === "/api/reports") {
    const all = sessions(2000);
    const byChannel = {};
    for (const item of all) {
      const key = item.channelId ?? "unknown";
      byChannel[key] ??= { channelId: key, channelLabel: item.channelLabel ?? key, rx: 0, tx: 0, bytes: 0, sessions: 0 };
      byChannel[key].sessions += 1;
      byChannel[key].bytes += Number(item.bytes) || 0;
      if (item.direction === "RX") byChannel[key].rx += 1;
      if (item.direction === "TX") byChannel[key].tx += 1;
    }
    return json(res, 200, { generatedAt: nowIso(), storage: storeUsage(), channels: Object.values(byChannel) });
  }
  if (url.pathname === "/api/audit") {
    return json(res, 200, readIndex(2000).filter((item) => item.type === "audit").slice(-500).reverse());
  }
  const wavMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/wav$/);
  if (wavMatch) {
    const session = sessions(2000).find((item) => item.id === wavMatch[1]);
    if (!session?.filePath || !existsSync(session.filePath)) return json(res, 404, { ok: false, error: "Recording not found" });
    const wav = rawToPcmWav(session);
    writeIndex({ type: "audit", action: "export-wav", id: session.id, channelId: session.channelId, direction: session.direction, remoteAddress: req.socket.remoteAddress });
    res.writeHead(200, { "content-type": "audio/wav", "content-length": wav.length, "content-disposition": `attachment; filename="${token(session.id)}.wav"` });
    return res.end(wav);
  }
  json(res, 404, { ok: false, error: "Not found" });
}

if (!existsSync(certPath) || !existsSync(keyPath)) {
  console.error(`TLS certificate not found. Expected ${certPath} and ${keyPath}.`);
  process.exit(1);
}

const tlsOptions = { cert: readFileSync(certPath), key: readFileSync(keyPath) };
const httpsServer = createHttpsServer(tlsOptions, handleHttp);
httpsServer.on("upgrade", (req, socket) => req.url?.startsWith("/tx") ? acceptTxWs(req, socket) : socket.destroy());
httpsServer.listen(httpsPort, bindHost, () => console.log(`ATM local recorder HTTPS listening on https://${bindHost}:${httpsPort}`));

createHttpServer((req, res) => {
  if (req.url === "/api/health") return handleHttp(req, res);
  res.writeHead(302, { location: `https://${req.headers.host?.split(":")[0] ?? "127.0.0.1"}:${httpsPort}/` });
  res.end();
}).listen(httpPort, bindHost, () => console.log(`ATM local recorder HTTP redirect listening on http://${bindHost}:${httpPort}`));

connectVcs();

process.on("SIGTERM", () => {
  for (const session of rxSessions.values()) closeSession(session, "shutdown");
  for (const session of txSessions.values()) closeSession(session, "shutdown");
  indexStream.end(() => process.exit(0));
});

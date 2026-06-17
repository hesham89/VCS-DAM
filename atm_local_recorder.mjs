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
<title>ATM Recorder</title>
<style>
:root{font-family:Segoe UI,Arial,sans-serif;background:#0f1217;color:#f5f7fb}body{margin:0}main{width:min(1400px,calc(100vw - 40px));margin:auto;padding:22px 0}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}h1{margin:0;font-size:28px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px}.card,.toolbar,table{border:1px solid #303a49;background:#171d26;border-radius:8px}.card{padding:12px}.card span{display:block;color:#9fb0c5;font-size:12px}.card strong{display:block;margin-top:6px;font-size:18px}.toolbar{display:flex;gap:8px;align-items:end;padding:12px;margin-bottom:14px;flex-wrap:wrap}label{display:grid;gap:5px;color:#9fb0c5;font-size:12px}input,select{background:#0f141c;color:#fff;border:1px solid #455368;border-radius:6px;padding:9px}button{border:1px solid #5b6b80;border-radius:6px;background:#2668ad;color:#fff;padding:10px 14px}table{width:100%;border-collapse:collapse;overflow:hidden}th,td{text-align:left;padding:10px;border-bottom:1px solid #2a3340;font-size:14px}th{color:#9fb0c5;background:#131923}tr:hover{background:#1e2632}audio{width:260px}.pill{display:inline-block;padding:3px 8px;border-radius:999px;background:#243146}.rx{background:#163a29}.tx{background:#43202a}@media(max-width:900px){.grid{grid-template-columns:1fr 1fr}table{display:block;overflow:auto}}
</style></head><body><main>
<header><h1>ATM Voice Recorder</h1><button onclick="loadAll()">Refresh</button></header>
<section class="grid">
<div class="card"><span>VCS Feed</span><strong id="vcs">-</strong></div>
<div class="card"><span>Last VCS Message</span><strong id="last">-</strong></div>
<div class="card"><span>Storage</span><strong id="storage">-</strong></div>
<div class="card"><span>Active Sessions</span><strong id="active">-</strong></div>
</section>
<section class="toolbar">
<label>Direction<select id="direction"><option value="">All</option><option>RX</option><option>TX</option></select></label>
<label>Channel<input id="channel" placeholder="dev2-rx"></label>
<button onclick="loadRecordings()">Search</button>
</section>
<table><thead><tr><th>Time</th><th>Dir</th><th>Channel</th><th>Frequency</th><th>Duration</th><th>Bytes</th><th>Playback</th><th>Export</th></tr></thead><tbody id="rows"></tbody></table>
</main><script>
const fmtBytes=n=>n>1073741824?(n/1073741824).toFixed(1)+' GB':n>1048576?(n/1048576).toFixed(1)+' MB':n>1024?(n/1024).toFixed(1)+' KB':n+' B';
function dur(r){if(!r.startedAt)return'-';const end=r.stoppedAt||r.lastPacketAt||new Date().toISOString();return Math.max(0,Math.round((Date.parse(end)-Date.parse(r.startedAt))/1000))+' s'}
async function loadHealth(){const h=await fetch('/api/health').then(r=>r.json());vcs.textContent=h.vcsConnected?'Connected':'Disconnected';last.textContent=h.lastVcsMessageAt||'-';storage.textContent=fmtBytes(h.storage.bytes)+' / '+h.storage.files+' files';active.textContent=h.active.rx+h.active.tx}
async function loadRecordings(){const qs=new URLSearchParams();if(direction.value)qs.set('direction',direction.value);if(channel.value)qs.set('channel',channel.value);const rows=await fetch('/api/recordings?'+qs).then(r=>r.json());document.getElementById('rows').innerHTML=rows.map(r=>'<tr><td>'+r.startedAt+'</td><td><span class="pill '+r.direction.toLowerCase()+'">'+r.direction+'</span></td><td>'+r.channelLabel+'<br><small>'+r.channelId+'</small></td><td>'+r.frequency+'</td><td>'+dur(r)+'</td><td>'+fmtBytes(r.bytes||0)+'</td><td><audio controls preload="none" src="/api/recordings/'+r.id+'/wav"></audio></td><td><a href="/api/recordings/'+r.id+'/wav">WAV</a></td></tr>').join('')}
async function loadAll(){await loadHealth();await loadRecordings()}loadAll();setInterval(loadHealth,3000);
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
  const wavMatch = url.pathname.match(/^\/api\/recordings\/([^/]+)\/wav$/);
  if (wavMatch) {
    const session = sessions(2000).find((item) => item.id === wavMatch[1]);
    if (!session?.filePath || !existsSync(session.filePath)) return json(res, 404, { ok: false, error: "Recording not found" });
    const wav = rawToPcmWav(session);
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

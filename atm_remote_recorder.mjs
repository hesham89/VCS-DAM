import { createServer } from "node:http";
import dgram from "node:dgram";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const bindHost = process.env.RECORDER_BIND_HOST ?? "0.0.0.0";
const udpPort = Number.parseInt(process.env.RECORDER_UDP_PORT ?? "45000", 10);
const httpPort = Number.parseInt(process.env.RECORDER_HTTP_PORT ?? "45080", 10);
const recordingDir = path.resolve(process.env.RECORDER_DIR ?? path.join(process.cwd(), "remote-recordings"));
const exportDir = path.join(recordingDir, "exports");
const indexPath = path.join(recordingDir, "recording-index.jsonl");
const sessions = new Map();
const startedAt = new Date();

mkdirSync(recordingDir, { recursive: true });
mkdirSync(exportDir, { recursive: true });

const indexStream = createWriteStream(indexPath, { flags: "a" });

function safeFileToken(value) {
  return String(value ?? "unknown").replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 120);
}

function writeIndex(event) {
  indexStream.write(`${JSON.stringify(event)}\n`);
}

function parsePacket(packet) {
  if (packet.length < 6 || packet.subarray(0, 4).toString("ascii") !== "AVR1") return null;
  const headerLength = packet.readUInt16BE(4);
  if (headerLength < 1 || 6 + headerLength > packet.length) return null;
  try {
    const header = JSON.parse(packet.subarray(6, 6 + headerLength).toString("utf8"));
    return { header, payload: packet.subarray(6 + headerLength) };
  } catch {
    return null;
  }
}

function startSession(header, source) {
  const session = header.session;
  if (!session?.id) return;
  const fileName = `${safeFileToken(session.id)}.pcma`;
  const filePath = path.join(recordingDir, fileName);
  const stream = createWriteStream(filePath, { flags: "a" });
  const stored = {
    ...session,
    fileName,
    filePath,
    sourceIp: source.address,
    sourcePort: source.port,
    packets: 0,
    bytes: 0,
    recorderStartedAt: new Date().toISOString()
  };
  sessions.set(session.id, { ...stored, stream });
  writeIndex({ type: "start", ...stored, filePath: undefined });
}

function writePayload(header, payload, source) {
  const current = sessions.get(header.id);
  if (!current) {
    const fileName = `${safeFileToken(header.id)}.pcma`;
    const filePath = path.join(recordingDir, fileName);
    const stream = createWriteStream(filePath, { flags: "a" });
    sessions.set(header.id, { id: header.id, fileName, filePath, sourceIp: source.address, sourcePort: source.port, packets: 0, bytes: 0, stream });
  }
  const session = sessions.get(header.id);
  session.stream.write(payload);
  session.packets += 1;
  session.bytes += payload.length;
  session.lastPayloadAt = new Date().toISOString();
}

function stopSession(header) {
  const session = sessions.get(header.id);
  if (!session) return;
  session.stream.end();
  sessions.delete(header.id);
  writeIndex({
    type: "stop",
    ...session,
    stream: undefined,
    filePath: undefined,
    stoppedAt: header.stoppedAt ?? new Date().toISOString(),
    packets: header.packets ?? session.packets,
    bytes: header.bytes ?? session.bytes
  });
}

function readSessions(limit = 200) {
  if (!existsSync(indexPath)) return [];
  const rows = readFileSync(indexPath, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-5000).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const byId = new Map();
  for (const event of rows) {
    if (!event.id) continue;
    byId.set(event.id, { ...(byId.get(event.id) ?? {}), ...event });
  }
  return [...byId.values()].sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? ""))).slice(0, limit);
}

function storeUsage() {
  let bytes = 0;
  let files = 0;
  for (const entry of readdirSync(recordingDir)) {
    const fullPath = path.join(recordingDir, entry);
    const stat = statSync(fullPath);
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
    }
  }
  return { bytes, files };
}

const udp = dgram.createSocket("udp4");
udp.on("message", (packet, source) => {
  const parsed = parsePacket(packet);
  if (!parsed) return;
  const { header, payload } = parsed;
  if (header.type === "start") return startSession(header, source);
  if (header.type === "payload") return writePayload(header, payload, source);
  if (header.type === "stop") return stopSession(header);
});

udp.bind(udpPort, bindHost, () => {
  console.log(`ATM remote recorder UDP listening on ${bindHost}:${udpPort}`);
  console.log(`Recording directory: ${recordingDir}`);
});

function json(res, code, body) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

createServer((req, res) => {
  if (req.url === "/" || req.url === "/api/health") {
    return json(res, 200, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      udpPort,
      httpPort,
      recordingDir,
      activeSessions: sessions.size,
      storage: storeUsage()
    });
  }
  if (req.url === "/api/recordings") return json(res, 200, readSessions(200));
  json(res, 404, { ok: false, error: "Not found" });
}).listen(httpPort, bindHost, () => {
  console.log(`ATM remote recorder HTTP listening on http://${bindHost}:${httpPort}`);
});

process.on("SIGTERM", () => {
  for (const session of sessions.values()) session.stream.end();
  indexStream.end(() => process.exit(0));
});

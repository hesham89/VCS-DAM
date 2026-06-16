import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import crypto from "node:crypto";
import os from "node:os";
import net from "node:net";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const httpsCertPath = process.env.HTTPS_CERT || "";
const httpsKeyPath = process.env.HTTPS_KEY || "";
const configPath = path.join(process.cwd(), "radios.config.json");
const logDir = path.join(process.cwd(), "logs");
const auditLogPath = path.join(logDir, "atm-vcs-audit.log");
const alarmLogPath = path.join(logDir, "atm-vcs-alarms.log");
const recordingDir = path.join(process.cwd(), "recordings");
const exportDir = path.join(recordingDir, "exports");
const recordingMetaPath = path.join(recordingDir, "recording-index.jsonl");
const startedAt = new Date();

const defaultConfig = {
  localIpFallback: "5.1.1.3",
  mediaAdvertiseIp: null,
  maxPttSeconds: 120,
  radioPollSeconds: 15,
  rxListenPort: Number.parseInt(process.env.RX_LISTEN_PORT ?? "3004", 10),
  rxSilenceMs: 1500,
  snmpCommunity: "public",
  snmpPort: 161,
  snmpTrapBindIp: process.env.SNMP_TRAP_BIND_IP ?? "5.1.1.248",
  snmpTrapPort: Number.parseInt(process.env.SNMP_TRAP_PORT ?? "162", 10),
  recording: {
    enabled: true,
    localEnabled: true,
    retentionDays: 30,
    retentionRunTime: "02:00",
    storageBytes: 8 * 1024 * 1024 * 1024 * 1024,
    format: "G.711 raw RTP payload with JSONL metadata",
    exportFormat: "MP3 via ffmpeg",
    ed137RecorderInterface: "planned",
    remote: {
      enabled: false,
      host: "",
      port: 45000,
      protocol: "atm-vcs-recorder-udp-v1"
    }
  },
  radios: [
    { id: "r1", label: "Receiver 121.700", role: "rx", ip: "5.1.1.250", frequency: "121.700", mode: "ed137", sipPort: 5060, rtpPort: 3004, enabled: true },
    { id: "r2", label: "Ground 121.300", role: "tx", ip: "192.168.1.9", frequency: "121.300", mode: "auto", sipPort: 5060, rtpPort: 3004, enabled: true },
    { id: "r3", label: "Approach 119.100", role: "tx", ip: "192.168.1.11", frequency: "119.100", mode: "auto", sipPort: 5060, rtpPort: 3004, enabled: false },
    { id: "r4", label: "Emergency 121.500", role: "tx", ip: "192.168.1.12", frequency: "121.500", mode: "auto", sipPort: 5060, rtpPort: 3004, enabled: false },
    { id: "rx1", label: "Receiver 121.300", role: "rx", ip: "192.168.1.5", frequency: "121.300", mode: "standard-rtp", rtpPort: 3004, enabled: true }
  ]
};

let config = loadConfig();
let logLines = ["ATM VCS service ready."];
let activeCall = null;
let activeRx = null;
let pttWatchdog = null;
const rxRtpSockets = new Map();
const radioStatus = new Map();
const rxMonitors = new Map();
const rxActivity = {};
const audioLevels = {};
const delayStats = { tx: {}, rx: {} };
const rxStats = {
  packets: 0,
  bytes: 0,
  unmatchedPackets: 0,
  droppedPackets: 0,
  payloadTypes: {},
  byRadio: {},
  lastPacketAt: null,
  lastSource: null,
  lastPayloadType: null,
  lastPayloadBytes: 0,
  lastSequence: null,
  lastSsrc: null
};
const udpDebugStats = {};
const alarms = new Map();
const rxSessions = new Map();
const snmpTraps = [];
const clients = new Set();
const rxMonitorStarts = new Map();
let lastTelemetryBroadcast = 0;
const remoteRecorderSocket = dgram.createSocket("udp4");

mkdirSync(logDir, { recursive: true });
mkdirSync(recordingDir, { recursive: true });
mkdirSync(exportDir, { recursive: true });

function loadConfig() {
  if (!existsSync(configPath)) return defaultConfig;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    return normalizeConfig(parsed);
  } catch {
    return defaultConfig;
  }
}

function normalizeConfig(nextConfig = {}) {
  return {
    ...defaultConfig,
    ...nextConfig,
    recording: {
      ...defaultConfig.recording,
      ...(nextConfig.recording ?? {}),
      remote: {
        ...defaultConfig.recording.remote,
        ...(nextConfig.recording?.remote ?? {})
      }
    },
    radios: nextConfig.radios ?? defaultConfig.radios
  };
}

function saveConfig(nextConfig) {
  config = normalizeConfig(nextConfig);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  log("Radio configuration saved.");
  return config;
}

function normalizeRadio(radio) {
  const remoteFrequency = radioStatus?.get?.(radio.id)?.web?.actualFrequencyMhz;
  const webHost = radio.webHost ?? radio.ip ?? "";
  const sipHost = radio.sipHost ?? hostOnly(radio.ip);
  const rtpHost = radio.rtpHost ?? radio.sipHost ?? hostOnly(radio.ip);
  return {
    txEnabled: radio.txEnabled ?? true,
    rxEnabled: radio.rxEnabled ?? true,
    ...radio,
    webHost,
    sipHost,
    rtpHost,
    webPort: radio.webPort,
    sipPort: radio.sipPort ?? 5060,
    rtpPort: radio.rtpPort ?? 3004,
    configuredFrequency: radio.frequency,
    frequency: remoteFrequency ?? radio.frequency
  };
}

function configuredRadios() {
  return config.radios.map(normalizeRadio);
}

function applicationKey(radio) {
  return String(radio.applicationId || radio.groupId || radio.frequency || radio.id);
}

function applicationLabel(radio) {
  return String(radio.applicationLabel || radio.appLabel || radio.frequency || radio.label || radio.id);
}

function configuredApplications() {
  const apps = new Map();
  for (const radio of configuredRadios()) {
    const id = applicationKey(radio);
    const app = apps.get(id) ?? { id, label: applicationLabel(radio), rx: null, tx: null, radios: [] };
    app.label = radio.applicationLabel || app.label;
    app.radios.push(radio);
    if (radio.role === "rx" && !app.rx) app.rx = radio;
    if (radio.role === "tx" && !app.tx) app.tx = radio;
    apps.set(id, app);
  }
  return [...apps.values()];
}

function log(line) {
  const entry = `[${new Date().toISOString()}] ${line}`;
  appendFileSync(auditLogPath, `${entry}\n`);
  logLines.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  logLines = logLines.slice(-300);
  broadcast({ type: "state", state: publicState() });
}

function alarmKey(source, code) {
  return `${source}:${code}`;
}

function raiseAlarm({ source, code, severity = "warning", message, details = {} }) {
  const key = alarmKey(source, code);
  const existing = alarms.get(key);
  const isNew = !existing || existing.state === "cleared";
  const alarm = {
    id: key,
    source,
    code,
    severity,
    message,
    details,
    state: "active",
    firstRaisedAt: existing?.firstRaisedAt ?? new Date().toISOString(),
    lastRaisedAt: new Date().toISOString(),
    acknowledgedAt: existing?.acknowledgedAt ?? null
  };
  alarms.set(key, alarm);
  if (isNew) appendFileSync(alarmLogPath, `${JSON.stringify({ type: "raise", ...alarm })}\n`);
  broadcast({ type: "state", state: publicState() });
  return alarm;
}

function clearAlarm(source, code, details = {}) {
  const key = alarmKey(source, code);
  const alarm = alarms.get(key);
  if (!alarm || alarm.state === "cleared") return null;
  const cleared = { ...alarm, state: "cleared", clearedAt: new Date().toISOString(), clearDetails: details };
  alarms.set(key, cleared);
  appendFileSync(alarmLogPath, `${JSON.stringify({ type: "clear", ...cleared })}\n`);
  broadcast({ type: "state", state: publicState() });
  return cleared;
}

function acknowledgeAlarm(id, user = "local") {
  const alarm = alarms.get(id);
  if (!alarm) return null;
  const acknowledged = { ...alarm, acknowledgedAt: new Date().toISOString(), acknowledgedBy: user };
  alarms.set(id, acknowledged);
  appendFileSync(alarmLogPath, `${JSON.stringify({ type: "ack", ...acknowledged })}\n`);
  broadcast({ type: "state", state: publicState() });
  return acknowledged;
}

function activeAlarms() {
  return [...alarms.values()].filter((alarm) => alarm.state === "active").sort((a, b) => String(b.lastRaisedAt).localeCompare(String(a.lastRaisedAt)));
}

function localIps() {
  const exact = [];
  const sameSubnet = [];
  const radioLan = [];
  const commonLan = [];
  const otherPrivate = [];
  const other = [];
  const fallbackPrefix = config.localIpFallback?.split(".").slice(0, 3).join(".");
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (config.localIpFallback && entry.address === config.localIpFallback) exact.push(entry.address);
      else if (fallbackPrefix && entry.address.startsWith(`${fallbackPrefix}.`)) sameSubnet.push(entry.address);
      else if (entry.address.startsWith("192.168.1.")) radioLan.push(entry.address);
      else if (entry.address.startsWith("192.168.")) commonLan.push(entry.address);
      else if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)) otherPrivate.push(entry.address);
      else other.push(entry.address);
    }
  }
  const ips = [...exact, ...sameSubnet, ...radioLan, ...commonLan, ...otherPrivate, ...other];
  if (!ips.length && config.localIpFallback) ips.push(config.localIpFallback);
  return ips;
}

function selectLocalIp() {
  return localIps()[0] ?? "0.0.0.0";
}

function mediaAdvertiseIp(fallbackIp = selectLocalIp()) {
  return config.mediaAdvertiseIp || config.localIpFallback || fallbackIp;
}

function randomToken(prefix = "") {
  return `${prefix}${crypto.randomBytes(5).toString("hex")}`;
}

function safeFileToken(value) {
  return String(value).replace(/[^a-z0-9_.-]+/gi, "_").slice(0, 80);
}

function hostOnly(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) {
    try {
      return new URL(text).hostname;
    } catch {
      return text;
    }
  }
  if (text.startsWith("[") && text.includes("]")) return text.slice(1, text.indexOf("]"));
  return text.split(":")[0];
}

function webAddress(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return /^https?:\/\//i.test(text) ? text.replace(/\/+$/, "") : `http://${text}`;
}

function endpointHost(radio, kind = "sip") {
  if (kind === "web") return String(radio.webHost || radio.managementHost || radio.ip || "").trim();
  if (kind === "control") return hostOnly(radio.controlHost || radio.managementHost || radio.webHost || radio.ip);
  if (kind === "snmp") return hostOnly(radio.snmpHost || radio.managementHost || radio.webHost || radio.ip);
  if (kind === "rtp") return hostOnly(radio.rtpHost || radio.sipHost || radio.ip);
  return hostOnly(radio.sipHost || radio.ip);
}

function endpointPort(radio, kind, fallback) {
  const value = kind === "web" ? radio.webPort : kind === "rtp" ? radio.rtpPort : kind === "control" ? radio.controlPort : kind === "snmp" ? radio.snmpPort : radio.sipPort;
  return Number(value) || fallback;
}

function rxLocalPort(radio) {
  return Number(radio.localRtpPort ?? radio.listenPort ?? radio.rtpPort ?? config.rxListenPort) || 3004;
}

function webEndpoint(radio) {
  const raw = endpointHost(radio, "web");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/+$/, "");
  const hasPort = raw.includes(":");
  const portText = radio.webPort ? `:${Number(radio.webPort)}` : "";
  return `http://${raw}${hasPort ? "" : portText}`;
}

function readRecordingIndex(limit = 200) {
  if (!existsSync(recordingMetaPath)) return [];
  return readFileSync(recordingMetaPath, "utf8").trim().split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean).reverse();
}

function readRecordingSessions(limit = 200) {
  const events = readRecordingIndex(5000).reverse();
  const sessions = new Map();
  for (const event of events) {
    if (!event.id) continue;
    const current = sessions.get(event.id) ?? {};
    sessions.set(event.id, { ...current, ...event });
  }
  return [...sessions.values()].sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
}

function recordingStoreUsage() {
  let bytes = 0;
  let files = 0;
  if (!existsSync(recordingDir)) return { bytes, files };
  for (const entry of readdirSync(recordingDir)) {
    const fullPath = path.join(recordingDir, entry);
    const stat = statSync(fullPath);
    if (stat.isFile()) {
      bytes += stat.size;
      files += 1;
    }
  }
  return { bytes, files };
}

function recordingStatus() {
  const localEnabled = recordingLocalEnabled();
  const usage = localEnabled ? recordingStoreUsage() : { bytes: 0, files: 0 };
  const storageBytes = Number(config.recording?.storageBytes) || 0;
  return {
    enabled: Boolean(config.recording?.enabled),
    localEnabled,
    remoteEnabled: recordingRemoteEnabled(),
    remoteHost: config.recording?.remote?.host ?? "",
    remotePort: Number(config.recording?.remote?.port) || 0,
    remoteProtocol: config.recording?.remote?.protocol ?? "atm-vcs-recorder-udp-v1",
    format: config.recording?.format,
    exportFormat: config.recording?.exportFormat,
    retentionDays: config.recording?.retentionDays,
    retentionRunTime: config.recording?.retentionRunTime,
    storageBytes,
    usedBytes: usage.bytes,
    fileCount: usage.files,
    freePlannedBytes: storageBytes ? Math.max(0, storageBytes - usage.bytes) : null,
    ed137RecorderInterface: config.recording?.ed137RecorderInterface ?? "planned",
    mp3EncoderAvailable: localEnabled ? Boolean(findFfmpeg()) : false,
    storePath: localEnabled ? recordingDir : null,
    exportPath: localEnabled ? exportDir : null,
    indexPath: localEnabled ? recordingMetaPath : null
  };
}

function evaluateSystemAlarms() {
  const desiredLocalIp = config.mediaAdvertiseIp ? null : config.localIpFallback;
  const hostIps = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
  if (desiredLocalIp && !hostIps.includes(desiredLocalIp)) {
    raiseAlarm({ source: "rx-rtp", code: "RTP_DEST_IP_MISSING", severity: "critical", message: `Configured receiver RTP destination IP ${desiredLocalIp} is not configured on this PC. Either add it to Ethernet or set the receiver RTP out IP to ${hostIps.find((ip) => ip.startsWith("5.1.1.")) ?? selectLocalIp()}.`, details: { desiredLocalIp, hostIps } });
  } else {
    clearAlarm("rx-rtp", "RTP_DEST_IP_MISSING", { desiredLocalIp, hostIps });
  }
  if (recordingLocalEnabled() && !findFfmpeg()) {
    raiseAlarm({ source: "recording", code: "MP3_ENCODER_MISSING", severity: "warning", message: "MP3 extraction is unavailable because ffmpeg is not installed or FFMPEG_PATH is not set." });
  } else {
    clearAlarm("recording", "MP3_ENCODER_MISSING");
  }
  const storageBytes = Number(config.recording?.storageBytes) || 0;
  if (recordingLocalEnabled() && storageBytes) {
    const usage = recordingStoreUsage();
    if (usage.bytes > storageBytes * 0.9) {
      raiseAlarm({ source: "recording", code: "STORAGE_HIGH", severity: "critical", message: "Recording storage usage is above 90%.", details: { usedBytes: usage.bytes, storageBytes } });
    } else {
      clearAlarm("recording", "STORAGE_HIGH");
    }
  } else {
    clearAlarm("recording", "STORAGE_HIGH");
  }
}

function appendRecordingMeta(event) {
  appendFileSync(recordingMetaPath, `${JSON.stringify(event)}\n`);
}

function recordingLocalEnabled() {
  return Boolean(config.recording?.enabled && config.recording?.localEnabled !== false);
}

function recordingRemoteEnabled() {
  return Boolean(config.recording?.enabled && config.recording?.remote?.enabled && config.recording?.remote?.host);
}

function sendRemoteRecordingEvent(event, payload = Buffer.alloc(0)) {
  if (!recordingRemoteEnabled()) return;
  const host = String(config.recording.remote.host);
  const port = Number(config.recording.remote.port) || 45000;
  const header = Buffer.from(JSON.stringify({ protocol: "atm-vcs-recorder-udp-v1", ...event }));
  if (header.length > 65500 || payload.length > 60000) return;
  const packet = Buffer.alloc(6 + header.length + payload.length);
  packet.write("AVR1", 0, "ascii");
  packet.writeUInt16BE(header.length, 4);
  header.copy(packet, 6);
  payload.copy(packet, 6 + header.length);
  remoteRecorderSocket.send(packet, port, host, (error) => {
    if (error) log(`Remote recorder send failed: ${error.message}`);
  });
}

function findFfmpeg() {
  const pathExt = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const pathCandidates = (process.env.PATH ?? "").split(path.delimiter).flatMap((dir) => pathExt.map((ext) => path.join(dir, `ffmpeg${ext}`)));
  const candidates = [process.env.FFMPEG_PATH, "C:\\ffmpeg\\bin\\ffmpeg.exe", "C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe", ...pathCandidates].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function recordingExportName(session) {
  const frequency = safeFileToken(session.frequency ?? "unknown_frequency");
  const started = safeFileToken(String(session.startedAt ?? new Date().toISOString()).replace(/[:.]/g, "-"));
  return `${frequency}_${started}_PTT.mp3`;
}

function exportRecordingMp3(session) {
  return new Promise((resolve, reject) => {
    const ffmpeg = findFfmpeg();
    if (!ffmpeg) return reject(new Error("MP3 encoder unavailable. Install ffmpeg or set FFMPEG_PATH."));
    const sourcePath = path.join(recordingDir, session.fileName);
    if (!existsSync(sourcePath)) return reject(new Error("Recording payload file not found."));
    const outputName = recordingExportName(session);
    const outputPath = path.join(exportDir, outputName);
    const args = ["-y", "-f", "alaw", "-ar", "8000", "-ac", "1", "-i", sourcePath, "-codec:a", "libmp3lame", "-b:a", "64k", outputPath];
    execFile(ffmpeg, args, { timeout: 60000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || error.message).trim()));
      appendRecordingMeta({ type: "export", id: session.id, exportedAt: new Date().toISOString(), exportFormat: "mp3", exportName: outputName, exportPath: outputPath });
      resolve({ outputName, outputPath });
    });
  });
}

function startRecordingSession(radio, localIp, callId, direction = "TX", remoteIp = radio.ip) {
  if (!config.recording?.enabled || (!recordingLocalEnabled() && !recordingRemoteEnabled())) return null;
  const startedAtIso = new Date().toISOString();
  const id = `${startedAtIso.replace(/[:.]/g, "-")}_${safeFileToken(radio.id)}_${safeFileToken(direction)}_${randomToken()}`;
  const fileName = `${id}.pcma`;
  const filePath = path.join(recordingDir, fileName);
  const retentionDays = Number(config.recording?.retentionDays) || 30;
  const retainedUntil = new Date(Date.parse(startedAtIso) + retentionDays * 86400000).toISOString();
  const session = { id, radioId: radio.id, radioLabel: radio.label, frequency: radio.frequency, direction, startedAt: startedAtIso, retainedUntil, localIp, remoteIp, callId, fileName, filePath, local: recordingLocalEnabled(), remote: recordingRemoteEnabled(), packets: 0, bytes: 0 };
  if (session.local) appendRecordingMeta({ type: "start", ...session });
  sendRemoteRecordingEvent({ type: "start", session: { ...session, filePath: undefined } });
  return session;
}

function writeRecordingPayload(session, payload) {
  if (!session) return;
  if (session.local) appendFileSync(session.filePath, payload);
  sendRemoteRecordingEvent({ type: "payload", id: session.id, sequence: session.packets, timestamp: Date.now() }, payload);
  session.packets += 1;
  session.bytes += payload.length;
}

function stopRecordingSession(session) {
  if (!session) return;
  const stoppedAt = new Date().toISOString();
  if (session.local) appendRecordingMeta({ type: "stop", ...session, stoppedAt });
  sendRemoteRecordingEvent({ type: "stop", id: session.id, stoppedAt, packets: session.packets, bytes: session.bytes });
}

function enforceRecordingRetention(reason = "scheduled") {
  const now = Date.now();
  let removed = 0;
  for (const session of readRecordingSessions(5000)) {
    if (!session.retainedUntil || Date.parse(session.retainedUntil) > now) continue;
    const sourcePath = path.join(recordingDir, session.fileName ?? "");
    if (session.fileName && existsSync(sourcePath)) {
      unlinkSync(sourcePath);
      removed += 1;
    }
    const exportName = recordingExportName(session);
    const exportPath = path.join(exportDir, exportName);
    if (existsSync(exportPath)) {
      unlinkSync(exportPath);
      removed += 1;
    }
    appendRecordingMeta({ type: "retention-delete", id: session.id, deletedAt: new Date().toISOString(), reason });
  }
  if (removed) log(`Recording retention removed ${removed} expired files.`);
  return { removed };
}

function msUntilRetentionRun() {
  const [hourText, minuteText] = String(config.recording?.retentionRunTime ?? "02:00").split(":");
  const next = new Date();
  next.setHours(Number(hourText) || 2, Number(minuteText) || 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
}

function scheduleRecordingRetention() {
  setTimeout(() => {
    enforceRecordingRetention("scheduled");
    setInterval(() => enforceRecordingRetention("scheduled"), 86400000);
  }, msUntilRetentionRun());
}

function tcpCheck(ip, portNumber, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostOnly(ip), port: portNumber });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open ? "open" : "closed");
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

async function httpCheck(ip, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webAddress(ip), { signal: controller.signal });
    return response.ok ? "open" : `http-${response.status}`;
  } catch {
    return "closed";
  } finally {
    clearTimeout(timer);
  }
}

async function jotronWebInfo(ip, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = webAddress(ip);
    const response = await fetch(`${base}/system.html`, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `http-${response.status}` };
    const html = await response.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const home = await fetch(`${base}/`, { signal: controller.signal }).then((r) => r.ok ? r.text() : "").catch(() => "");
    const homeText = home.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const icao = text.match(/Frequency\s*\[ICAO\]\s*:\s*(\d+)/i)?.[1] ?? null;
    const actualHz = text.match(/Actual frequency\s*\[Hz\]\s*:\s*(\d+)/i)?.[1] ?? null;
    const radioType = homeText.match(/Radio Type:\s*([A-Z0-9-]+)/i)?.[1] ?? null;
    const radioId = homeText.match(/Radio ID:\s*([A-Z0-9_-]+)/i)?.[1] ?? null;
    return {
      ok: true,
      radioType,
      radioId,
      frequencyIcaoKhz: icao ? Number(icao) : null,
      actualFrequencyHz: actualHz ? Number(actualHz) : null,
      actualFrequencyMhz: actualHz ? (Number(actualHz) / 1000000).toFixed(3) : null,
      frequencyWrite: "not exposed on read-only embedded web pages"
    };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function radioHttpCheck(radio, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(webEndpoint(radio), { signal: controller.signal });
    return response.ok ? "open" : `http-${response.status}`;
  } catch {
    return "closed";
  } finally {
    clearTimeout(timer);
  }
}

async function radioWebInfo(radio, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = webEndpoint(radio);
    const response = await fetch(`${base}/system.html`, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `http-${response.status}` };
    const html = await response.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const home = await fetch(`${base}/`, { signal: controller.signal }).then((r) => r.ok ? r.text() : "").catch(() => "");
    const homeText = home.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const icao = text.match(/Frequency\s*\[ICAO\]\s*:\s*(\d+)/i)?.[1] ?? null;
    const actualHz = text.match(/Actual frequency\s*\[Hz\]\s*:\s*(\d+)/i)?.[1] ?? null;
    const radioType = homeText.match(/Radio Type:\s*([A-Z0-9-]+)/i)?.[1] ?? null;
    const radioId = homeText.match(/Radio ID:\s*([A-Z0-9_-]+)/i)?.[1] ?? null;
    return {
      ok: true,
      radioType,
      radioId,
      frequencyIcaoKhz: icao ? Number(icao) : null,
      actualFrequencyHz: actualHz ? Number(actualHz) : null,
      actualFrequencyMhz: actualHz ? (Number(actualHz) / 1000000).toFixed(3) : null,
      frequencyWrite: "not exposed on read-only embedded web pages",
      endpoint: base
    };
  } catch (error) {
    return { ok: false, error: error.name === "AbortError" ? "timeout" : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function udpProbe(ip, portNumber, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let finished = false;
    const done = (state) => {
      if (finished) return;
      finished = true;
      socket.close();
      resolve(state);
    };
    socket.on("error", () => done("unknown"));
    socket.bind(() => {
      socket.send(Buffer.from([0]), portNumber, hostOnly(ip), (error) => {
        if (error) done("unknown");
      });
    });
    setTimeout(() => done("sent"), timeoutMs);
  });
}

function berLength(length) {
  if (length < 128) return Buffer.from([length]);
  const bytes = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function berTlv(tag, payload) {
  return Buffer.concat([Buffer.from([tag]), berLength(payload.length), payload]);
}

function berInteger(value) {
  let v = Number(value);
  const bytes = [];
  do {
    bytes.unshift(v & 0xff);
    v >>= 8;
  } while (v > 0);
  if (bytes[0] & 0x80) bytes.unshift(0);
  return berTlv(0x02, Buffer.from(bytes));
}

function berOctetString(value) {
  return berTlv(0x04, Buffer.from(String(value), "utf8"));
}

function berNull() {
  return Buffer.from([0x05, 0x00]);
}

function berOid(oid) {
  const parts = String(oid).replace(/^\./, "").split(".").map((part) => Number.parseInt(part, 10));
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const stack = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) stack.unshift((value & 0x7f) | 0x80);
    bytes.push(...stack);
  }
  return berTlv(0x06, Buffer.from(bytes));
}

function berSequence(...items) {
  return berTlv(0x30, Buffer.concat(items));
}

function buildSnmpGet({ community, oid, requestId }) {
  const varbind = berSequence(berOid(oid), berNull());
  const varbindList = berSequence(varbind);
  const pdu = berTlv(0xa0, Buffer.concat([berInteger(requestId), berInteger(0), berInteger(0), varbindList]));
  return berSequence(berInteger(1), berOctetString(community), pdu);
}

function readTlv(buffer, offset = 0) {
  const tag = buffer[offset++];
  let length = buffer[offset++];
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | buffer[offset++];
  }
  const start = offset;
  const end = start + length;
  return { tag, length, start, end, value: buffer.subarray(start, end), next: end };
}

function decodeInteger(buffer) {
  let value = 0;
  for (const byte of buffer) value = (value << 8) | byte;
  return value;
}

function decodeOid(buffer) {
  if (!buffer.length) return "";
  const parts = [Math.floor(buffer[0] / 40), buffer[0] % 40];
  let value = 0;
  for (const byte of buffer.subarray(1)) {
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function decodeSnmpValue(tlv) {
  if (tlv.tag === 0x02 || tlv.tag === 0x43) return decodeInteger(tlv.value);
  if (tlv.tag === 0x04) return tlv.value.toString("utf8").replace(/\0/g, "");
  if (tlv.tag === 0x05) return null;
  if (tlv.tag === 0x06) return decodeOid(tlv.value);
  if (tlv.tag === 0x40) return [...tlv.value].join(".");
  return `0x${tlv.value.toString("hex")}`;
}

function parseSnmpMessage(buffer) {
  const message = readTlv(buffer);
  let offset = message.start;
  const versionTlv = readTlv(buffer, offset);
  const version = decodeInteger(versionTlv.value);
  offset = versionTlv.next;
  const communityTlv = readTlv(buffer, offset);
  const community = communityTlv.value.toString("utf8");
  offset = communityTlv.next;
  const pdu = readTlv(buffer, offset);
  let pduOffset = pdu.start;
  const requestIdTlv = readTlv(buffer, pduOffset);
  const requestId = decodeInteger(requestIdTlv.value);
  pduOffset = requestIdTlv.next;
  const errorStatusTlv = readTlv(buffer, pduOffset);
  const errorStatus = decodeInteger(errorStatusTlv.value);
  pduOffset = errorStatusTlv.next;
  const errorIndexTlv = readTlv(buffer, pduOffset);
  const errorIndex = decodeInteger(errorIndexTlv.value);
  pduOffset = errorIndexTlv.next;
  const list = readTlv(buffer, pduOffset);
  const varbinds = [];
  let vbOffset = list.start;
  while (vbOffset < list.end) {
    const vb = readTlv(buffer, vbOffset);
    const oidTlv = readTlv(buffer, vb.start);
    const valueTlv = readTlv(buffer, oidTlv.next);
    varbinds.push({ oid: decodeOid(oidTlv.value), type: `0x${valueTlv.tag.toString(16)}`, value: decodeSnmpValue(valueTlv) });
    vbOffset = vb.next;
  }
  return { version, community, pduType: `0x${pdu.tag.toString(16)}`, requestId, errorStatus, errorIndex, varbinds };
}

function snmpGet(ip, oid, options = {}) {
  const requestId = crypto.randomInt(1, 0x7fffffff);
  const community = options.community ?? config.snmpCommunity ?? "public";
  const portNumber = options.port ?? config.snmpPort ?? 161;
  const timeoutMs = options.timeoutMs ?? 2500;
  const packet = buildSnmpGet({ community, oid, requestId });
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => done({ oid, state: "timeout", value: null }), timeoutMs);
    const done = (result) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
      resolve(result);
    };
    socket.on("message", (data) => {
      try {
        const parsed = parseSnmpMessage(data);
        const vb = parsed.varbinds[0];
        done({ oid: vb?.oid ?? oid, state: parsed.errorStatus ? `error-${parsed.errorStatus}` : "ok", value: vb?.value ?? null, type: vb?.type ?? "unknown" });
      } catch (error) {
        done({ oid, state: "parse-error", value: null, error: error.message });
      }
    });
    socket.on("error", (error) => done({ oid, state: "error", value: null, error: error.message }));
    socket.bind(() => socket.send(packet, portNumber, hostOnly(ip), (error) => {
      if (error) done({ oid, state: "error", value: null, error: error.message });
    }));
  });
}

async function snmpSystemPoll(radio) {
  const options = { community: radio.snmpCommunity ?? config.snmpCommunity, port: radio.snmpPort ?? config.snmpPort };
  const [sysDescr, sysObjectId, sysUpTime] = await Promise.all([
    snmpGet(endpointHost(radio, "snmp"), "1.3.6.1.2.1.1.1.0", options),
    snmpGet(endpointHost(radio, "snmp"), "1.3.6.1.2.1.1.2.0", options),
    snmpGet(endpointHost(radio, "snmp"), "1.3.6.1.2.1.1.3.0", options)
  ]);
  return {
    port: options.port,
    community: options.community ? "***" : "",
    sysDescr,
    sysObjectId,
    sysUpTime,
    ok: [sysDescr, sysObjectId, sysUpTime].some((item) => item.state === "ok")
  };
}

function sendSip(socket, radio, message) {
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(message, "ascii"), endpointPort(radio, "sip", 5060), endpointHost(radio, "sip"), (error) => error ? reject(error) : resolve());
  });
}

function waitSipResponse(socket, matcher, timeoutMs = 3500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("SIP response timeout"));
    }, timeoutMs);
    function onMessage(data) {
      const text = data.toString("latin1");
      if (!matcher(text)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(text);
    }
    socket.on("message", onMessage);
  });
}

function parseHeader(message, name) {
  return message.match(new RegExp(`^${name}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
}

function parseRemoteRtpPort(sdpMessage, fallback) {
  return Number.parseInt(sdpMessage.match(/^m=audio\s+(\d+)/im)?.[1] ?? fallback, 10);
}

function linearToAlaw(sample) {
  const segmentEnd = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
  let pcm = Math.max(-32768, Math.min(32767, sample)) >> 3;
  let mask;
  if (pcm >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    pcm = -pcm - 1;
  }
  let segment = 0;
  while (segment < segmentEnd.length && pcm > segmentEnd[segment]) segment += 1;
  if (segment >= 8) return 0x7f ^ mask;
  const mantissa = segment < 2 ? (pcm >> 1) & 0x0f : (pcm >> segment) & 0x0f;
  return ((segment << 4) | mantissa) ^ mask;
}

function pcm16ToPcma(buffer) {
  const out = Buffer.alloc(Math.floor(buffer.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = linearToAlaw(buffer.readInt16LE(i * 2));
  return out;
}

function linearToUlaw(sample) {
  const bias = 0x84;
  const clip = 32635;
  let pcm = Math.max(-clip, Math.min(clip, sample));
  const sign = pcm < 0 ? 0x80 : 0x00;
  if (pcm < 0) pcm = -pcm;
  pcm += bias;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(pcm & mask); mask >>= 1) exponent -= 1;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function pcm16ToPcmu(buffer) {
  const out = Buffer.alloc(Math.floor(buffer.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = linearToUlaw(buffer.readInt16LE(i * 2));
  return out;
}

function g711Codec(radio) {
  const codec = String(radio.codec || radio.rtpCodec || config.codec || "pcmu").toLowerCase();
  return codec.includes("a") && !codec.includes("u") ? "pcma" : "pcmu";
}

function g711PayloadType(radio) {
  return g711Codec(radio) === "pcma" ? 8 : 0;
}

function g711RtpMap(radio) {
  return g711Codec(radio) === "pcma" ? "a=rtpmap:8 PCMA/8000" : "a=rtpmap:0 PCMU/8000";
}

function pcm16ToG711(buffer, radio) {
  return g711Codec(radio) === "pcma" ? pcm16ToPcma(buffer) : pcm16ToPcmu(buffer);
}

function alawLevel(payload) {
  if (!payload?.length) return 0;
  let sum = 0;
  for (const byte of payload) {
    const a = byte ^ 0x55;
    const exp = (a & 0x70) >> 4;
    const mant = a & 0x0f;
    let sample = exp === 0 ? (mant << 4) + 8 : ((mant << 4) + 0x108) << (exp - 1);
    sum += Math.abs(sample / 32768);
  }
  return Math.min(1, Math.sqrt(sum / payload.length) * 2.2);
}

function pcm16Level(buffer) {
  if (!buffer?.length) return 0;
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) sum += Math.abs(buffer.readInt16LE(i * 2) / 32768);
  return Math.min(1, Math.sqrt(sum / samples) * 2.2);
}

function ed137Word(pttType, mode) {
  if (mode === "lsb") return pttType & 0x07;
  if (mode === "sample") return pttType ? 0x30010800 : 0x00000000;
  return (pttType & 0x07) << 29;
}

function ed137RtpExtensionProfile() {
  return Number(config.ed137RtpExtensionProfile ?? 0x0167) & 0xffff;
}

function parseRtpPacket(packet) {
  if (packet.length < 12) return null;
  const version = packet[0] >> 6;
  if (version !== 2) return null;
  const hasExtension = Boolean(packet[0] & 0x10);
  const csrcCount = packet[0] & 0x0f;
  const payloadType = packet[1] & 0x7f;
  const sequence = packet.readUInt16BE(2);
  const timestamp = packet.readUInt32BE(4);
  const ssrc = packet.readUInt32BE(8);
  let offset = 12 + csrcCount * 4;
  if (hasExtension && packet.length >= offset + 4) {
    const extensionWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extensionWords * 4;
  }
  if (offset > packet.length) return null;
  return { payloadType, sequence, timestamp, ssrc, payload: packet.subarray(offset) };
}

function txRadiosForRx(radio) {
  return configuredRadios().filter((tx) => tx.role === "tx" && (
    (radio.applicationId && tx.applicationId === radio.applicationId) ||
    (!radio.applicationId && tx.frequency === radio.frequency)
  ));
}

function setRxActivity(radio, active) {
  let changed = rxActivity[radio.id] !== active;
  rxActivity[radio.id] = active;
  for (const tx of txRadiosForRx(radio)) {
    const next = active && tx.rxEnabled !== false;
    changed = changed || rxActivity[tx.id] !== next;
    rxActivity[tx.id] = next;
  }
  if (changed) broadcast({ type: "state", state: publicState() });
}

function matchRxRadio(sourceAddress, localPort) {
  const radios = configuredRadios();
  return radios.find((radio) => radio.role === "rx" && rxLocalPort(radio) === Number(localPort) && radio.enabled)
    ?? radios.find((radio) => radio.role === "rx" && hostOnly(radio.ip) === sourceAddress)
    ?? radios.find((radio) => radio.role === "rx" && radio.enabled)
    ?? radios.find((radio) => hostOnly(radio.ip) === sourceAddress);
}

function updateRxStats(rtp, source, radio, accepted) {
  rxStats.packets += 1;
  rxStats.bytes += rtp.payload.length;
  rxStats.lastPacketAt = new Date().toISOString();
  rxStats.lastSource = `${source.address}:${source.port}`;
  rxStats.lastPayloadType = rtp.payloadType;
  rxStats.lastPayloadBytes = rtp.payload.length;
  rxStats.lastSequence = rtp.sequence;
  rxStats.lastSsrc = rtp.ssrc;
  rxStats.payloadTypes[rtp.payloadType] = (rxStats.payloadTypes[rtp.payloadType] ?? 0) + 1;
  if (!radio) rxStats.unmatchedPackets += 1;
  if (!accepted) rxStats.droppedPackets += 1;
  if (radio) {
    const current = rxStats.byRadio[radio.id] ?? { packets: 0, bytes: 0, payloadTypes: {} };
    current.packets += 1;
    current.bytes += rtp.payload.length;
    current.lastPacketAt = rxStats.lastPacketAt;
    current.lastSource = rxStats.lastSource;
    current.lastPayloadType = rtp.payloadType;
    current.lastPayloadBytes = rtp.payload.length;
    current.lastSequence = rtp.sequence;
    current.lastSsrc = rtp.ssrc;
    const nowMs = Date.now();
    if (current.lastArrivalMs !== undefined && current.lastRtpTimestamp !== undefined) {
      const arrivalDeltaMs = nowMs - current.lastArrivalMs;
      const rtpDeltaMs = ((rtp.timestamp - current.lastRtpTimestamp) >>> 0) / 8;
      const timingErrorMs = Math.max(0, Math.abs(arrivalDeltaMs - rtpDeltaMs));
      current.lastTimingErrorMs = Math.round(timingErrorMs);
      current.jitterMs = Math.round(((current.jitterMs ?? timingErrorMs) * 0.85) + (timingErrorMs * 0.15));
      delayStats.rx[radio.id] = { delayMs: current.lastTimingErrorMs, jitterMs: current.jitterMs, updatedAt: nowMs };
    } else {
      delayStats.rx[radio.id] = { delayMs: 0, jitterMs: 0, updatedAt: nowMs };
    }
    current.lastArrivalMs = nowMs;
    current.lastRtpTimestamp = rtp.timestamp;
    current.payloadTypes[rtp.payloadType] = (current.payloadTypes[rtp.payloadType] ?? 0) + 1;
    rxStats.byRadio[radio.id] = current;
    audioLevels[radio.id] = { ...(audioLevels[radio.id] ?? {}), rx: alawLevel(rtp.payload), rxAt: nowMs };
    broadcastTelemetry();
  }
}

function recentRxForRadio(radioId, windowMs = 5000) {
  const lastPacketAt = rxStats.byRadio[radioId]?.lastPacketAt;
  if (!lastPacketAt) return false;
  return Date.now() - Date.parse(lastPacketAt) < windowMs;
}

function rxMonitorSipPort(index = 0) {
  return 5200 + (index * 100) + Math.floor(Math.random() * 80);
}

function txSipPort() {
  return 5400 + Math.floor(Math.random() * 120);
}

function txRtpPort() {
  return 5600 + Math.floor(Math.random() * 120);
}

function handleRxRtp(packet, source, localPort) {
  const rtp = parseRtpPacket(packet);
  if (!rtp || !rtp.payload.length) return;
  const radio = matchRxRadio(source.address, localPort);
  const accepted = Boolean(radio && radio.enabled !== false && radio.rxEnabled !== false);
  updateRxStats(rtp, source, radio, accepted);
  if (!radio || radio.enabled === false || radio.rxEnabled === false) return;
  clearAlarm(radio.id, "RX_SIP_MONITOR_FAILED", { reason: "rtp-received", source: `${source.address}:${source.port}` });
  clearAlarm(radio.id, "RX_SIP_MONITOR_DROPPED", { reason: "rtp-received", source: `${source.address}:${source.port}` });
  const key = radio.id;
  let session = rxSessions.get(key);
  if (!session) {
    session = {
      recording: startRecordingSession(radio, selectLocalIp(), `rx-${randomToken()}@${source.address}`, "RX", source.address),
      timer: null,
      packets: 0,
      lastSequence: rtp.sequence
    };
    rxSessions.set(key, session);
    log(`${radio.label}: RX activity started from ${source.address}:${source.port}, RTP payload type ${rtp.payloadType}, SSRC ${rtp.ssrc}.`);
  }
  writeRecordingPayload(session.recording, rtp.payload);
  broadcast({ type: "rx-audio", radioId: radio.id, frequency: radio.frequency, payloadType: rtp.payloadType, payload: rtp.payload.toString("base64") });
  session.packets += 1;
  session.lastSequence = rtp.sequence;
  setRxActivity(radio, true);
  clearTimeout(session.timer);
  session.timer = setTimeout(() => {
    stopRecordingSession(session.recording);
    rxSessions.delete(key);
    setRxActivity(radio, false);
    log(`${radio.label}: RX activity ended, packets received ${session.packets}.`);
  }, Number(config.rxSilenceMs) || 1500);
}

function startRxRtpListener() {
  const listenPorts = [...new Set([Number(config.rxListenPort) || 3004, ...configuredRadios().filter((radio) => radio.role === "rx" && radio.enabled !== false).map(rxLocalPort)])];
  const hostIps = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
  const bindIp = config.localIpFallback && hostIps.includes(config.localIpFallback) ? config.localIpFallback : "0.0.0.0";
  for (const listenPort of listenPorts) {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (packet, source) => handleRxRtp(packet, source, listenPort));
    socket.on("error", (error) => {
      raiseAlarm({ source: "rx-rtp", code: "RX_LISTENER_ERROR", severity: "critical", message: `RX RTP listener error on UDP ${listenPort}: ${error.message}` });
      log(`RX RTP listener error on UDP ${listenPort}: ${error.message}`);
    });
    socket.bind(listenPort, bindIp, () => {
      if (!activeRx) activeRx = socket;
      rxRtpSockets.set(`${bindIp}:${listenPort}`, socket);
      rxRtpSockets.set(`0.0.0.0:${listenPort}`, socket);
      rxRtpSockets.set(listenPort, socket);
      clearAlarm("rx-rtp", "RX_LISTENER_ERROR");
      log(`RX RTP listener active on ${bindIp}:UDP ${listenPort}.`);
    });
  }
}

function noteUdpDebugPacket(label, packet, source, localPort) {
  const current = udpDebugStats[label] ?? { packets: 0, bytes: 0 };
  current.packets += 1;
  current.bytes += packet.length;
  current.lastPacketAt = new Date().toISOString();
  current.lastSource = `${source.address}:${source.port}`;
  current.lastBytes = packet.length;
  const rtp = parseRtpPacket(packet);
  current.lastLooksLikeRtp = Boolean(rtp);
  current.lastPayloadType = rtp?.payloadType ?? null;
  udpDebugStats[label] = current;
  if (current.packets === 1) log(`UDP debug ${label}: first packet from ${current.lastSource}, ${packet.length} bytes, RTP ${current.lastLooksLikeRtp ? `PT ${current.lastPayloadType}` : "no"}.`);
  if (rtp) handleRxRtp(packet, source, localPort);
}

function startUdpDebugListeners() {
  const hostIps = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
  const binds = [];
  for (const ip of hostIps.filter((ip) => ip.startsWith("5.1.1.") && ip !== config.localIpFallback)) binds.push({ ip, port: Number(config.rxListenPort) || 3004 });
  for (const portNumber of [3003]) binds.push({ ip: "0.0.0.0", port: portNumber });
  for (const bind of binds) {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const label = `${bind.ip}:${bind.port}`;
    socket.on("message", (packet, source) => noteUdpDebugPacket(label, packet, source, bind.port));
    socket.on("error", (error) => log(`UDP debug ${label} error: ${error.message}`));
    socket.bind(bind.port, bind.ip, () => log(`UDP debug listener active on ${label}.`));
  }
}

class TxCall {
  constructor(radio, localIp, extensionMode = radio.ed137ExtensionMode || config.ed137ExtensionMode || "msb") {
    this.radio = radio;
    this.localIp = localIp;
    this.extensionMode = extensionMode;
    this.sipSocket = dgram.createSocket("udp4");
    this.rtpSocket = dgram.createSocket("udp4");
    this.localSipPort = txSipPort();
    this.localRtpPort = txRtpPort();
    this.remoteRtpHost = endpointHost(radio, "rtp");
    this.remoteRtpPort = endpointPort(radio, "rtp", 3004);
    this.seq = 1;
    this.timestamp = 0;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.sent = 0;
    this.sipActive = false;
    this.callId = `${randomToken("call-")}@${localIp}`;
    this.fromTag = randomToken("tag");
    this.remoteHost = endpointHost(radio, "sip");
    this.toHeader = `<sip:txradio@${this.remoteHost}>`;
    this.recording = null;
    this.pcmQueue = Buffer.alloc(0);
    this.txTimer = null;
    this.nextTxAt = 0;
    this.underflows = 0;
    this.maxQueueBytes = 0;
    this.stopped = false;
  }

  targetUsers() {
    const web = radioStatus.get(this.radio.id)?.web;
    return [...new Set([
      this.radio.sipExtension,
      this.radio.sipUser,
      "txradio",
      "radio",
      web?.radioId,
      this.radio.radioId
    ].filter(Boolean).map(String))];
  }

  async start() {
    if (this.stopped) throw new Error("PTT was released before TX start completed.");
    await new Promise((resolve, reject) => this.rtpSocket.bind(this.localRtpPort, this.localIp, (error) => error ? reject(error) : resolve()));
    if (this.stopped) throw new Error("PTT was released before TX RTP started.");
    this.recording = startRecordingSession(this.radio, this.localIp, this.callId);
    if (this.radio.mode === "standard-rtp") {
      log(`${this.radio.label}: Standard RTP TX to ${this.remoteRtpHost}:${this.remoteRtpPort}`);
      if (!this.stopped) this.startPacketClock();
      return;
    }
    try {
      await this.startSip();
    } catch (error) {
      if (this.radio.mode === "ed137") throw error;
      log(`${this.radio.label}: SIP unavailable (${error.message}), fallback Standard RTP to ${this.remoteRtpHost}:${this.remoteRtpPort}`);
    }
    if (!this.stopped) this.startPacketClock();
  }

  async startSip() {
    if (this.stopped) throw new Error("PTT was released before SIP started.");
    await new Promise((resolve, reject) => this.sipSocket.bind(this.localSipPort, this.localIp, (error) => error ? reject(error) : resolve()));
    if (this.stopped) throw new Error("PTT was released before SIP INVITE.");
    const errors = [];
    for (const user of this.targetUsers()) {
      try {
        await this.invite(user);
        return;
      } catch (error) {
        errors.push(`${user}: ${error.message}`);
      }
    }
    throw new Error(errors.join("; "));
  }

  async invite(user) {
    const mediaIp = mediaAdvertiseIp(this.localIp);
    const sdp = [
      "v=0",
      `o=vcs 1 1 IN IP4 ${mediaIp}`,
      `s=${this.radio.label}`,
      `c=IN IP4 ${mediaIp}`,
      "t=0 0",
      `m=audio ${this.localRtpPort} RTP/AVP 8 123`,
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:123 R2S/8000",
      "a=ptime:20",
      "a=sendrecv",
      "a=rtphe:1",
      "",
    ].join("\r\n");
    const invite = [
      `INVITE sip:${user}@${this.remoteHost}:${this.radio.sipPort ?? 5060} SIP/2.0`,
      `Via: SIP/2.0/UDP ${mediaIp}:${this.localSipPort};branch=z9hG4bK${randomToken()};rport`,
      "Max-Forwards: 70",
      `From: <sip:vcs@${mediaIp}>;tag=${this.fromTag}`,
      `To: <sip:${user}@${this.remoteHost}>`,
      `Call-ID: ${this.callId}`,
      "CSeq: 1 INVITE",
      `Contact: <sip:vcs@${mediaIp}:${this.localSipPort}>`,
      "WG67-Version: radio.01",
      "Priority: normal",
      "Subject: radio",
      "Content-Type: application/sdp",
      `Content-Length: ${Buffer.byteLength(sdp)}`,
      "",
      sdp,
    ].join("\r\n");
    const responsePromise = waitSipResponse(this.sipSocket, (text) => text.startsWith("SIP/2.0 200") || /^SIP\/2.0 [456]/.test(text));
    responsePromise.catch(() => {});
    await sendSip(this.sipSocket, this.radio, invite);
    const response = await responsePromise;
    if (this.stopped) throw new Error("PTT was released before SIP response.");
    if (!response.startsWith("SIP/2.0 200")) {
      const reason = parseHeader(response, "Reason") || parseHeader(response, "Warning");
      throw new Error(`${response.split("\r\n")[0]}${reason ? ` (${reason})` : ""}`);
    }
    this.toHeader = parseHeader(response, "To");
    const sdpRtpPort = parseRemoteRtpPort(response, NaN);
    this.remoteRtpPort = Number.isFinite(sdpRtpPort) && sdpRtpPort !== this.localRtpPort ? sdpRtpPort : Number(this.radio.remoteRtpPort ?? this.remoteRtpPort);
    const ack = [
      `ACK sip:${user}@${this.remoteHost}:${this.radio.sipPort ?? 5060} SIP/2.0`,
      `Via: SIP/2.0/UDP ${mediaIp}:${this.localSipPort};branch=z9hG4bK${randomToken()};rport`,
      "Max-Forwards: 70",
      `From: <sip:vcs@${mediaIp}>;tag=${this.fromTag}`,
      `To: ${this.toHeader}`,
      `Call-ID: ${this.callId}`,
      "CSeq: 1 ACK",
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    await sendSip(this.sipSocket, this.radio, ack);
    if (this.stopped) throw new Error("PTT was released before SIP ACK completed.");
    this.sipActive = true;
    log(`${this.radio.label}: SIP connected as ${user}, RTP ${this.remoteRtpHost}:${this.remoteRtpPort}`);
  }

  startPacketClock() {
    if (this.stopped) return;
    this.stopPacketClock();
    this.nextTxAt = Date.now();
    this.txTimer = setInterval(() => this.tickPacketClock(), 5);
  }

  stopPacketClock() {
    clearInterval(this.txTimer);
    this.txTimer = null;
  }

  sendPcm(buffer) {
    if (this.stopped) return;
    const chunk = Buffer.from(buffer);
    audioLevels[this.radio.id] = { ...(audioLevels[this.radio.id] ?? {}), tx: pcm16Level(chunk), txAt: Date.now() };
    this.pcmQueue = Buffer.concat([this.pcmQueue, chunk]);
    const maxBufferedBytes = 320 * 8;
    if (this.pcmQueue.length > maxBufferedBytes) this.pcmQueue = this.pcmQueue.subarray(this.pcmQueue.length - maxBufferedBytes);
    this.maxQueueBytes = Math.max(this.maxQueueBytes, this.pcmQueue.length);
    delayStats.tx[this.radio.id] = { queueMs: Math.round(this.pcmQueue.length / 16), underflows: this.underflows, updatedAt: Date.now() };
    broadcastTelemetry();
  }

  tickPacketClock() {
    if (this.stopped) return;
    const now = Date.now();
    let sentThisTick = 0;
    while (now >= this.nextTxAt && sentThisTick < 4) {
      this.sendQueuedFrame();
      this.nextTxAt += 20;
      sentThisTick += 1;
    }
    if (now - this.nextTxAt > 200) this.nextTxAt = now + 20;
  }

  sendQueuedFrame() {
    if (this.stopped) return;
    const frameBytes = 320;
    let buffer;
    if (this.pcmQueue.length >= frameBytes) {
      buffer = this.pcmQueue.subarray(0, frameBytes);
      this.pcmQueue = this.pcmQueue.subarray(frameBytes);
    } else {
      buffer = Buffer.alloc(frameBytes);
      this.underflows += 1;
      audioLevels[this.radio.id] = { ...(audioLevels[this.radio.id] ?? {}), tx: 0, txAt: Date.now() };
    }
    delayStats.tx[this.radio.id] = { queueMs: Math.round(this.pcmQueue.length / 16), underflows: this.underflows, updatedAt: Date.now() };
    const payload = pcm16ToPcma(buffer);
    const useExtension = this.sipActive;
    const headerLength = useExtension ? 20 : 12;
    const packet = Buffer.alloc(headerLength + payload.length);
    packet[0] = useExtension ? 0x90 : 0x80;
    packet[1] = (this.sent === 0 ? 0x80 : 0x00) | 8;
    packet.writeUInt16BE(this.seq, 2);
    packet.writeUInt32BE(this.timestamp, 4);
    packet.writeUInt32BE(this.ssrc, 8);
    if (useExtension) {
      packet.writeUInt16BE(ed137RtpExtensionProfile(), 12);
      packet.writeUInt16BE(1, 14);
      packet.writeUInt32BE(ed137Word(1, this.extensionMode), 16);
    }
    payload.copy(packet, headerLength);
    this.rtpSocket.send(packet, this.remoteRtpPort, this.remoteRtpHost, (error) => {
      if (!error) return;
      this.underflows += 1;
      if (!this.stopped) log(`${this.radio.label}: RTP send failed: ${error.message}`);
    });
    writeRecordingPayload(this.recording, payload);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + payload.length) >>> 0;
    this.sent += 1;
  }

  async stop() {
    this.stopped = true;
    this.stopPacketClock();
    if (this.sipActive) {
      const bye = [
        `BYE sip:txradio@${this.remoteHost}:${this.radio.sipPort ?? 5060} SIP/2.0`,
        `Via: SIP/2.0/UDP ${mediaAdvertiseIp(this.localIp)}:${this.localSipPort};branch=z9hG4bK${randomToken()};rport`,
        `From: <sip:vcs@${mediaAdvertiseIp(this.localIp)}>;tag=${this.fromTag}`,
        `To: ${this.toHeader}`,
        `Call-ID: ${this.callId}`,
        "CSeq: 2 BYE",
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n");
      await sendSip(this.sipSocket, this.radio, bye).catch(() => {});
    }
    try { this.sipSocket.close(); } catch {}
    try { this.rtpSocket.close(); } catch {}
    stopRecordingSession(this.recording);
    log(`${this.radio.label}: PTT released, packets sent ${this.sent}, underflows ${this.underflows}, max TX buffer ${this.maxQueueBytes} bytes.`);
  }
}

class RxMonitorCall {
  constructor(radio, localIp, localSipPort) {
    this.radio = radio;
    this.localIp = localIp;
    this.localSipPort = localSipPort;
    this.localRtpPort = rxLocalPort(radio);
    this.sipSocket = dgram.createSocket("udp4");
    this.rtpSocket = null;
    this.callId = `${randomToken("rxmon-")}@${localIp}`;
    this.fromTag = randomToken("tag");
    this.remoteHost = endpointHost(radio, "sip");
    this.toHeader = `<sip:${this.targetUsers()[0]}@${this.remoteHost}>`;
    this.active = false;
    this.cseq = 1;
    this.targetUser = this.targetUsers()[0];
    this.remoteRtpHost = endpointHost(radio, "rtp");
    this.remoteRtpPort = radio.remoteRtpPort ?? endpointPort(radio, "rtp", 3003);
    this.keepaliveTimer = null;
    this.stopping = false;
    this.seq = 1;
    this.timestamp = 0;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
  }

  targetUsers() {
    return [...new Set([this.radio.sipExtension, this.radio.sipUser, "900", "radio", "rxradio"].filter(Boolean).map(String))];
  }

  async start() {
    await new Promise((resolve, reject) => this.sipSocket.bind(this.localSipPort, this.localIp, (error) => error ? reject(error) : resolve()));
    this.rtpSocket = rxRtpSockets.get(`${this.localIp}:${this.localRtpPort}`) || rxRtpSockets.get(this.localRtpPort);
    if (!this.rtpSocket) {
      this.rtpSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      await new Promise((resolve, reject) => {
        this.rtpSocket.once("error", reject);
        this.rtpSocket.bind(this.localRtpPort, this.localIp, () => {
          this.rtpSocket.off("error", reject);
          resolve();
        });
      });
    }
    this.sipSocket.on("message", (data) => this.handleSipMessage(data).catch((error) => log(`${this.radio.label}: RX SIP message handling failed: ${error.message}`)));
    const errors = [];
    for (const user of this.targetUsers()) {
      try {
        await this.invite(user);
        this.targetUser = user;
        this.active = true;
        this.stopping = false;
        this.startKeepalive();
        clearAlarm(this.radio.id, "RX_SIP_MONITOR_FAILED");
        clearAlarm(this.radio.id, "RX_SIP_MONITOR_DROPPED");
        log(`${this.radio.label}: RX SIP monitor connected as ${user}, expecting RTP on ${mediaAdvertiseIp(this.localIp)}:${this.localRtpPort} forwarded to ${this.localIp}:${this.localRtpPort}.`);
        return;
      } catch (error) {
        errors.push(`${user}: ${error.message}`);
      }
    }
    throw new Error(errors.join("; "));
  }

  async invite(user) {
    const mediaIp = mediaAdvertiseIp(this.localIp);
    const sdp = [
      "v=0",
      `o=vcs 1 1 IN IP4 ${mediaIp}`,
      `s=${this.radio.label} RX monitor`,
      `c=IN IP4 ${mediaIp}`,
      "t=0 0",
      `m=audio ${this.localRtpPort} RTP/AVP 8 123`,
      "a=rtpmap:8 PCMA/8000",
      "a=rtpmap:123 R2S/8000",
      "a=R2S-KeepAlivePeriod:200",
      "a=R2S-KeepAliveMultiplier:10",
      "a=sigtime:1",
      "a=ptt_rep:0",
      `a=fid:${this.radio.frequency ?? ""}`,
      "a=type:radio",
      "a=ptime:20",
      "a=ptt-id:0",
      "a=txrxmode:Rx",
      "a=bss:RSSI",
      "a=recvonly",
      "a=rtphe:1",
      "",
    ].join("\r\n");
    const cseq = this.cseq++;
    const invite = [
      `INVITE sip:${user}@${this.remoteHost}:${this.radio.sipPort ?? 5060} SIP/2.0`,
      `Via: SIP/2.0/UDP ${mediaIp}:${this.localSipPort};branch=z9hG4bK${randomToken()};rport`,
      "Max-Forwards: 70",
      `From: <sip:vcs@${mediaIp}>;tag=${this.fromTag}`,
      `To: <sip:${user}@${this.remoteHost}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} INVITE`,
      `Contact: <sip:vcs@${mediaIp}:${this.localSipPort}>`,
      "WG67-Version: radio.01",
      "Priority: normal",
      "Subject: radio",
      "Content-Type: application/sdp",
      `Content-Length: ${Buffer.byteLength(sdp)}`,
      "",
      sdp,
    ].join("\r\n");
    const responsePromise = waitSipResponse(this.sipSocket, (text) => text.startsWith("SIP/2.0 200") || /^SIP\/2.0 [456]/.test(text), 5000);
    responsePromise.catch(() => {});
    await sendSip(this.sipSocket, this.radio, invite);
    const response = await responsePromise;
    if (!response.startsWith("SIP/2.0 200")) throw new Error(response.split("\r\n")[0]);
    this.toHeader = parseHeader(response, "To") || `<sip:${user}@${this.remoteHost}>`;
    const responseRtpPort = parseRemoteRtpPort(response, this.remoteRtpPort);
    if (!this.radio.remoteRtpPort && Number.isFinite(responseRtpPort)) this.remoteRtpPort = responseRtpPort;
    const ack = [
      `ACK sip:${user}@${this.remoteHost}:${this.radio.sipPort ?? 5060} SIP/2.0`,
      `Via: SIP/2.0/UDP ${mediaIp}:${this.localSipPort};branch=z9hG4bK${randomToken()};rport`,
      "Max-Forwards: 70",
      `From: <sip:vcs@${mediaIp}>;tag=${this.fromTag}`,
      `To: ${this.toHeader}`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${cseq} ACK`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    await sendSip(this.sipSocket, this.radio, ack);
    log(`${this.radio.label}: RX SIP accepted by ${user}, R2S keepalive target ${this.remoteRtpHost}:${this.remoteRtpPort}${Number.isFinite(responseRtpPort) ? ` (radio SDP ${responseRtpPort})` : ""}.`);
  }

  async handleSipMessage(data) {
    const text = data.toString("latin1");
    if (/^BYE\s/i.test(text)) {
      const response = [
        "SIP/2.0 200 OK",
        parseHeader(text, "Via") ? `Via: ${parseHeader(text, "Via")}` : "",
        parseHeader(text, "From") ? `From: ${parseHeader(text, "From")}` : "",
        parseHeader(text, "To") ? `To: ${parseHeader(text, "To")}` : "",
        parseHeader(text, "Call-ID") ? `Call-ID: ${parseHeader(text, "Call-ID")}` : "",
        parseHeader(text, "CSeq") ? `CSeq: ${parseHeader(text, "CSeq")}` : "",
        "Content-Length: 0",
        "",
        "",
      ].filter((line) => line !== "").join("\r\n");
      await sendSip(this.sipSocket, this.radio, response).catch(() => {});
      this.active = false;
      this.stopKeepalive();
      const reason = parseHeader(text, "Reason") || parseHeader(text, "Warning");
      log(`${this.radio.label}: RX SIP monitor cleared by radio BYE${reason ? `: ${reason}` : ""}.`);
      if (!this.stopping && !recentRxForRadio(this.radio.id)) {
        raiseAlarm({ source: this.radio.id, code: "RX_SIP_MONITOR_DROPPED", severity: "warning", message: `${this.radio.label} RX SIP monitor was cleared by the radio; reconnecting.`, details: { reason } });
        const rxRadios = configuredRadios().filter((radio) => radio.role === "rx" && radio.enabled !== false && radio.rxEnabled !== false && radio.mode !== "standard-rtp");
        const reconnectIndex = Math.max(0, rxRadios.findIndex((radio) => radio.id === this.radio.id));
        setTimeout(() => startRxMonitorForRadio(configuredRadios().find((radio) => radio.id === this.radio.id), reconnectIndex).catch((error) => log(`${this.radio.label}: RX SIP reconnect failed: ${error.message}`)), 1200);
      } else if (!this.stopping) {
        clearAlarm(this.radio.id, "RX_SIP_MONITOR_DROPPED", { reason: "rtp-still-live" });
        log(`${this.radio.label}: RX RTP is still live, so SIP monitor reconnect is suppressed.`);
      }
    } else if (/^SIP\/2.0 [3-6]/.test(text)) {
      log(`${this.radio.label}: RX SIP monitor received ${text.split("\r\n")[0]} ${parseHeader(text, "Reason") || parseHeader(text, "Warning")}`.trim());
    }
  }

  startKeepalive() {
    this.stopKeepalive();
    this.sendSilenceKeepalive();
    this.keepaliveTimer = setInterval(() => this.sendSilenceKeepalive(), 100);
  }

  stopKeepalive() {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  sendSilenceKeepalive() {
    if (!this.active) return;
    const payload = Buffer.alloc(0);
    const packet = Buffer.alloc(20 + payload.length);
    packet[0] = 0x90;
    packet[1] = 123;
    packet.writeUInt16BE(this.seq, 2);
    packet.writeUInt32BE(0, 4);
    packet.writeUInt32BE(this.ssrc, 8);
    packet.writeUInt16BE(ed137RtpExtensionProfile(), 12);
    packet.writeUInt16BE(1, 14);
    packet.writeUInt32BE(ed137Word(0, "msb"), 16);
    payload.copy(packet, 20);
    this.rtpSocket.send(packet, this.remoteRtpPort, this.remoteRtpHost, (error) => {
      if (error) log(`${this.radio.label}: RX R2S keepalive send failed to ${this.remoteRtpHost}:${this.remoteRtpPort}: ${error.message}`);
    });
    this.seq = (this.seq + 1) & 0xffff;
  }

  async stop() {
    this.stopping = true;
    this.stopKeepalive();
    if (this.active) {
      const bye = [
        `BYE sip:${this.targetUser}@${this.remoteHost}:${this.radio.sipPort ?? 5060} SIP/2.0`,
        `Via: SIP/2.0/UDP ${mediaAdvertiseIp(this.localIp)}:${this.localSipPort};branch=z9hG4bK${randomToken()};rport`,
        `From: <sip:vcs@${mediaAdvertiseIp(this.localIp)}>;tag=${this.fromTag}`,
        `To: ${this.toHeader}`,
        `Call-ID: ${this.callId}`,
        `CSeq: ${this.cseq++} BYE`,
        "Content-Length: 0",
        "",
        "",
      ].join("\r\n");
      await sendSip(this.sipSocket, this.radio, bye).catch(() => {});
    }
    this.active = false;
    try { this.sipSocket.close(); } catch {}
    if (!rxRtpSockets.get(`${this.localIp}:${this.localRtpPort}`) && !rxRtpSockets.get(this.localRtpPort)) {
      try { this.rtpSocket?.close(); } catch {}
    }
  }
}

async function startRxMonitorForRadio(radio, index = 0) {
  if (!radio) return;
  if (!radio.enabled || radio.role !== "rx" || radio.rxEnabled === false || radio.mode === "standard-rtp") {
    await stopRxMonitorForRadio(radio.id, radio.rxEnabled === false ? "rx-disabled" : "not-monitorable");
    return;
  }
  const pending = rxMonitorStarts.get(radio.id);
  if (pending) return pending;
  const start = (async () => {
  const web = await radioWebInfo(radio, 1800);
  if (web?.actualFrequencyMhz) {
    const old = radioStatus.get(radio.id) ?? { id: radio.id, label: radio.label, ip: radio.ip };
    radioStatus.set(radio.id, { ...old, web, http: "open", reachable: true, checkedAt: new Date().toISOString() });
    radio = { ...radio, configuredFrequency: radio.frequency, frequency: web.actualFrequencyMhz };
  }
  const current = rxMonitors.get(radio.id);
  if (current?.active) return;
  if (recentRxForRadio(radio.id)) {
    if (current) {
      rxMonitors.delete(radio.id);
      await current.stop().catch(() => {});
    }
    clearAlarm(radio.id, "RX_SIP_MONITOR_FAILED", { reason: "rtp-live" });
    clearAlarm(radio.id, "RX_SIP_MONITOR_DROPPED", { reason: "rtp-live" });
    return;
  }
  if (current) await current.stop().catch(() => {});
  const localIp = selectLocalIp();
  const monitor = new RxMonitorCall(radio, localIp, rxMonitorSipPort(index));
  rxMonitors.set(radio.id, monitor);
  try {
    await monitor.start();
  } catch (error) {
    rxMonitors.delete(radio.id);
    raiseAlarm({ source: radio.id, code: "RX_SIP_MONITOR_FAILED", severity: "warning", message: `${radio.label} RX SIP monitor could not establish an ED-137 session and will retry: ${error.message}` });
    log(`${radio.label}: RX SIP monitor failed: ${error.message}`);
  }
  })();
  rxMonitorStarts.set(radio.id, start);
  try {
    await start;
  } finally {
    rxMonitorStarts.delete(radio.id);
  }
}

async function stopRxMonitorForRadio(radioId, reason = "stopped") {
  const current = rxMonitors.get(radioId);
  if (!current) return;
  rxMonitors.delete(radioId);
  await current.stop().catch(() => {});
  clearAlarm(radioId, "RX_SIP_MONITOR_FAILED", { reason });
  clearAlarm(radioId, "RX_SIP_MONITOR_DROPPED", { reason });
  log(`${current.radio.label}: RX SIP monitor stopped (${reason}).`);
}

async function startRxSipMonitors() {
  const radios = configuredRadios().filter((radio) => radio.role === "rx" && radio.enabled && radio.rxEnabled !== false);
  await Promise.all(radios.map((radio, index) => startRxMonitorForRadio(radio, index)));
}

function publicState() {
  return {
    active: Boolean(activeCall),
    activeRadioId: activeCall?.radio?.id ?? null,
    monitoring: Boolean(activeRx),
    rxSipMonitors: Object.fromEntries([...rxMonitors].map(([id, monitor]) => [id, { active: monitor.active, localIp: monitor.localIp, localSipPort: monitor.localSipPort, targetUser: monitor.targetUser }])),
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    maxPttSeconds: config.maxPttSeconds,
    radioPollSeconds: config.radioPollSeconds,
    snmpPort: config.snmpPort,
    snmpTrapBindIp: config.snmpTrapBindIp,
    snmpTrapPort: config.snmpTrapPort,
    radios: configuredRadios(),
    applications: configuredApplications(),
    radioStatus: Object.fromEntries(radioStatus),
    rxActivity,
    audioLevels,
    delayStats,
    rxStats,
    udpDebugStats,
    snmpTraps,
    recording: recordingStatus(),
    alarms: activeAlarms(),
    localIps: localIps(),
    log: logLines.join("\n")
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function checkRadio(radio) {
  const [http, tcp3008, snmp, web] = await Promise.all([
    radioHttpCheck(radio),
    tcpCheck(endpointHost(radio, "control"), endpointPort(radio, "control", 3008)),
    snmpSystemPoll(radio),
    radioWebInfo(radio)
  ]);
  const reachable = http === "open" || tcp3008 === "open" || snmp.ok;
  const endpoints = {
    web: webEndpoint(radio),
    control: `${endpointHost(radio, "control")}:${endpointPort(radio, "control", 3008)}`,
    snmp: `${endpointHost(radio, "snmp")}:${endpointPort(radio, "snmp", config.snmpPort ?? 161)}`,
    sip: `${endpointHost(radio, "sip")}:${endpointPort(radio, "sip", 5060)}`,
    rtp: `${endpointHost(radio, "rtp")}:${endpointPort(radio, "rtp", 3004)}`
  };
  const rtp = `configured:${endpoints.rtp}`;
  const status = { id: radio.id, label: radio.label, ip: radio.ip, endpoints, http, tcp3008, snmp, web, rtp, reachable, checkedAt: new Date().toISOString() };
  radioStatus.set(radio.id, status);
  if (web?.actualFrequencyMhz && radio.frequency && Number(web.actualFrequencyMhz).toFixed(3) !== Number(radio.frequency).toFixed(3)) {
    raiseAlarm({ source: radio.id, code: "FREQUENCY_MISMATCH", severity: "warning", message: `${radio.label} local frequency ${radio.frequency} does not match radio frequency ${web.actualFrequencyMhz} MHz.`, details: { localFrequency: radio.frequency, remoteFrequency: web.actualFrequencyMhz, frequencyWrite: web.frequencyWrite } });
  } else {
    clearAlarm(radio.id, "FREQUENCY_MISMATCH", { localFrequency: radio.frequency, remoteFrequency: web?.actualFrequencyMhz });
  }
  if (radio.enabled && !reachable) {
    raiseAlarm({ source: radio.id, code: "RADIO_UNREACHABLE", severity: radio.role === "rx" ? "critical" : "warning", message: `${radio.label} is not reachable by HTTP, TCP 3008 or SNMP.`, details: status });
  } else {
    clearAlarm(radio.id, "RADIO_UNREACHABLE", status);
  }
  return status;
}

async function refreshJotronWebReadbacks() {
  const enabled = configuredRadios().filter((radio) => radio.enabled);
  await Promise.all(enabled.map(async (radio) => {
    const web = await radioWebInfo(radio, 1800);
    const old = radioStatus.get(radio.id) ?? { id: radio.id, label: radio.label, ip: radio.ip };
    radioStatus.set(radio.id, { ...old, web, http: web.ok ? "open" : old.http, reachable: old.reachable || web.ok, checkedAt: new Date().toISOString() });
    if (web?.actualFrequencyMhz && radio.frequency && Number(web.actualFrequencyMhz).toFixed(3) !== Number(radio.frequency).toFixed(3)) {
      raiseAlarm({ source: radio.id, code: "FREQUENCY_MISMATCH", severity: "warning", message: `${radio.label} local frequency ${radio.frequency} does not match radio frequency ${web.actualFrequencyMhz} MHz.`, details: { localFrequency: radio.frequency, remoteFrequency: web.actualFrequencyMhz } });
    } else {
      clearAlarm(radio.id, "FREQUENCY_MISMATCH", { localFrequency: radio.frequency, remoteFrequency: web?.actualFrequencyMhz });
    }
  }));
  broadcast({ type: "state", state: publicState() });
}

function recordSnmpTrap(source, data) {
  let parsed;
  try {
    parsed = parseSnmpMessage(data);
  } catch (error) {
    parsed = { error: error.message, raw: `0x${data.toString("hex").slice(0, 160)}` };
  }
  const event = { source: `${source.address}:${source.port}`, receivedAt: new Date().toISOString(), parsed };
  snmpTraps.unshift(event);
  snmpTraps.splice(25);
  log(`SNMP trap from ${event.source}: ${JSON.stringify(parsed.varbinds ?? parsed)}`);
  return event;
}

function startSnmpTrapListener() {
  const trapPort = Number(config.snmpTrapPort) || 3013;
  const requestedBindIp = config.snmpTrapBindIp || "0.0.0.0";
  const hostIps = Object.values(os.networkInterfaces()).flatMap((entries) => entries ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address);
  const trapBindIp = requestedBindIp === "0.0.0.0" || hostIps.includes(requestedBindIp) ? requestedBindIp : "0.0.0.0";
  if (trapBindIp !== requestedBindIp) {
    raiseAlarm({ source: "snmp", code: "TRAP_BIND_IP_MISSING", severity: "warning", message: `SNMP trap IP ${requestedBindIp} is not configured on this PC; listening on all local interfaces instead.` });
  }
  const socket = dgram.createSocket("udp4");
  socket.on("message", (data, source) => recordSnmpTrap(source, data));
  socket.on("error", (error) => log(`SNMP trap listener error on UDP ${trapPort}: ${error.message}`));
  socket.bind(trapPort, trapBindIp, () => log(`SNMP trap listener active on ${trapBindIp}:UDP ${trapPort}.`));
}

async function pollRadios(reason = "poll") {
  const enabled = configuredRadios().filter((radio) => radio.enabled);
  const results = await Promise.all(enabled.map((radio) => checkRadio(radio).catch((error) => ({
    id: radio.id,
    label: radio.label,
    ip: radio.ip,
    http: "unknown",
    tcp3008: "unknown",
    rtp: "unknown",
    reachable: false,
    error: error.message,
    checkedAt: new Date().toISOString()
  }))));
  for (const result of results) radioStatus.set(result.id, result);
  if (reason !== "startup") broadcast({ type: "state", state: publicState() });
  return results;
}

function schedulePttWatchdog(radio) {
  clearTimeout(pttWatchdog);
  pttWatchdog = setTimeout(() => {
    log(`${radio.label}: PTT watchdog timeout after ${config.maxPttSeconds} seconds.`);
    stopActiveCall("watchdog").catch((error) => log(`PTT watchdog stop failed: ${error.message}`));
  }, Math.max(1, Number(config.maxPttSeconds) || 120) * 1000);
}

async function stopActiveCall(reason = "operator") {
  if (!activeCall) return;
  const call = activeCall;
  activeCall = null;
  clearTimeout(pttWatchdog);
  pttWatchdog = null;
  await call.stop();
  if (reason !== "operator") log(`PTT released by ${reason}.`);
  broadcast({ type: "state", state: publicState() });
}

function controllerHtml() {
  return page("ATM VCS Console", `
    <main class="controller">
      <header><h1>ATM VCS Console</h1><a href="/admin">Engineering</a></header>
      <section id="radios" class="radio-grid"></section>
      <section class="selected-readout">
        <span>Selected channel</span><strong id="selectedReadout">Waiting for radio state</strong>
      </section>
      <button id="rxAudio" class="audio">Enable RX Audio</button>
      <button id="ptt" class="ptt">Hold PTT</button>
      <meter id="level" min="0" max="1" value="0"></meter>
      <section class="rx-readout">
        <span>RX RTP</span><strong id="rxReadout">No packets yet</strong>
      </section>
      <section class="delay-grid">
        <div><span>RX Delay / Jitter</span><strong id="rxDelay">-</strong></div>
        <div><span>TX Queue Delay</span><strong id="txDelay">-</strong></div>
      </section>
    </main>
    <script>${clientScript("controller")}</script>
  `);
}

function adminHtml() {
  return page("Jotron Radio Engineering", `
    <main>
      <header><h1>Jotron Radio Engineering</h1><nav><a href="/controller">Controller</a><a href="/recording">Recording</a></nav></header>
      <section class="system-panel">
        <div><span>Server uptime</span><strong id="uptime">-</strong></div>
        <div><span>PTT watchdog</span><strong id="watchdog">-</strong></div>
        <div><span>SNMP trap port</span><strong id="trapPort">-</strong></div>
        <div><span>RX RTP packets</span><strong id="rxPackets">-</strong></div>
        <div><span>RX RTP source</span><strong id="rxSource">-</strong></div>
        <div><span>RX payload</span><strong id="rxPayload">-</strong></div>
      </section>
      <section id="editor" class="admin-list"></section>
      <div class="actions"><button id="addRadio">Add Radio Device</button><button id="save">Save Radio Profiles</button><button id="check">Check Connections</button><button id="snmp">Check SNMP</button></div>
      <section id="alarms" class="alarm-list"></section>
      <section id="snmpPanel" class="snmp-panel"></section>
      <pre id="log"></pre>
    </main>
    <script>${clientScript("admin")}</script>
  `);
}

function recordingHtml() {
  return page("ATM Recording System", `
    <main>
      <header><h1>ATM Recording System</h1><nav><a href="/controller">Controller</a><a href="/admin">Engineering</a></nav></header>
      <section class="system-panel">
        <div><span>Recorder</span><strong id="recEnabled">-</strong></div>
        <div><span>Retention</span><strong id="recRetention">-</strong></div>
        <div><span>ED-137 Recorder</span><strong id="recEd137">-</strong></div>
      </section>
      <section class="system-panel">
        <div><span>Planned Storage</span><strong id="recStorage">-</strong></div>
        <div><span>Used Storage</span><strong id="recUsed">-</strong></div>
        <div><span>Recording Files</span><strong id="recFiles">-</strong></div>
      </section>
      <section class="system-panel">
        <div><span>Retention Schedule</span><strong id="recSchedule">-</strong></div>
        <div><span>MP3 Extraction</span><strong id="recMp3">-</strong></div>
        <div><span>Export Format</span><strong id="recExportFormat">-</strong></div>
      </section>
      <section class="recording-toolbar">
        <button id="refreshRecordings">Refresh</button>
      </section>
      <section id="recordings" class="recording-list"></section>
      <pre id="log"></pre>
    </main>
    <script>${clientScript("recording")}</script>
  `);
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
    :root{font-family:Segoe UI,Arial,sans-serif;color:#f5f7fb;background:#101216}*{box-sizing:border-box}body{margin:0;background:#101216}main{width:min(1560px,calc(100vw - 48px));margin:0 auto;padding:24px 0}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}nav{display:flex;gap:14px}a{color:#9fd0ff}h1{margin:0;font-size:28px}.radio-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.radio{border:1px solid #334153;background:#171c24;border-radius:8px;padding:0;min-height:220px;overflow:hidden}.radio.selected{outline:3px solid #2f80ed}.radio.off{opacity:.45}.radio.down{border-color:#94414a}.freq-head{display:flex;justify-content:space-between;align-items:flex-start;padding:14px 14px 10px;border-bottom:1px solid #303844;background:#151a22}.freq{font-size:25px;font-weight:800;line-height:1}.label{color:#b9c6d8;margin-top:6px}.channel-status{font-size:12px;color:#9dafc6;display:grid;gap:3px}.io-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:12px}.io-pane{border:1px solid #344256;background:#111720;border-radius:6px;min-height:116px;padding:12px;display:grid;align-content:center;justify-items:center;cursor:pointer}.io-pane strong{font-size:19px;letter-spacing:.04em}.io-pane small{margin-top:7px;color:#9dafc6}.indicator{width:0;height:0;margin-top:12px;opacity:.28}.tx-indicator{border-left:22px solid transparent;border-right:22px solid transparent;border-bottom:36px solid #728096}.rx-indicator{border-left:22px solid transparent;border-right:22px solid transparent;border-top:36px solid #728096}.level-bar{width:100%;height:8px;margin-top:10px;border:1px solid #3f4d60;border-radius:999px;background:#070a0f;overflow:hidden}.level-fill{display:block;height:100%;width:0%;background:#32c276;transition:width .08s linear}.io-pane.tx .level-fill{background:#ff596c}.io-pane.enabled{border-color:#60718a}.io-pane.disabled{opacity:.38;background:#0c1016}.io-pane.disabled .indicator{opacity:.12}.io-pane.active.tx{background:#2b1520;border-color:#d94b5b}.io-pane.active.rx{background:#12251c;border-color:#32c276}.io-pane.active .tx-indicator{opacity:1;border-bottom-color:#ff596c}.io-pane.active .rx-indicator{opacity:1;border-top-color:#32c276}.status{display:inline-flex;align-items:center;gap:7px;margin-top:5px;color:#c9d5e7;font-size:13px}.status:before{content:"";width:10px;height:10px;border-radius:50%;background:#777;flex:0 0 auto}.status.ok:before{background:#32c276}.status.bad:before{background:#d94b5b}.status.unknown:before{background:#d5aa38}.selected-readout,.rx-readout,.delay-grid div{margin-top:8px;border:1px solid #303844;background:#171c24;border-radius:8px;padding:12px}.selected-readout{max-width:420px;border-color:#2f80ed}.selected-readout span,.rx-readout span,.delay-grid span{display:block;color:#9dafc6;font-size:12px}.selected-readout strong,.rx-readout strong,.delay-grid strong{display:block;margin-top:4px}.ptt{margin:18px 14px 18px 0;width:260px;height:78px;border:0;border-radius:8px;background:#23885e;color:white;font-size:24px;font-weight:800}.ptt.active{background:#b7343f}.ptt:disabled{opacity:.45}.audio{margin:18px 10px 18px 0;width:180px;height:54px;background:#1f5f9f}.audio.enabled{background:#1f7d55}.rx-readout{max-width:420px}.delay-grid{display:grid;grid-template-columns:repeat(2,minmax(0,210px));gap:12px;margin-top:8px}button{border:1px solid #526173;border-radius:6px;background:#286bb5;color:white;padding:11px 15px;font-size:15px;white-space:nowrap}button.danger{background:#8f2f3b}meter{width:260px}.system-panel{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:16px}.system-panel div,.snmp-card,.recording-item,.alarm,.app-edit{border:1px solid #303844;background:#171c24;border-radius:8px;padding:12px}.system-panel span{display:block;color:#9dafc6;font-size:12px}.system-panel strong{display:block;margin-top:5px}.snmp-panel,.recording-list,.alarm-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:14px 0}.alarm.critical{border-color:#d94b5b}.alarm.warning{border-color:#d5aa38}.alarm h3{margin:0 0 8px;font-size:16px}.alarm p{margin:0 0 10px;color:#c9d5e7}.recording-toolbar{margin:16px 0}.recording-item h3{font-size:16px;margin:0 0 8px}.recording-item dl,.snmp-card dl{display:grid;grid-template-columns:120px 1fr;gap:6px;margin:0}.recording-item dt,.snmp-card dt{color:#9dafc6}.recording-item dd,.snmp-card dd{margin:0;word-break:break-word}.snmp-card h3{font-size:16px;margin:0 0 8px}pre{background:#070a0f;border:1px solid #303844;border-radius:8px;color:#d7e7d0;padding:16px;min-height:240px;overflow:auto}.admin-list{display:grid;gap:12px}.app-edit{display:grid;gap:10px;min-width:0}.app-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}.side-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.side-box{border:1px solid #344256;border-radius:6px;padding:10px;background:#111720;min-width:0;overflow:hidden}.side-title{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;font-weight:800}.field-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:end}.edit label,.app-edit label{display:grid;color:#aebbd0;font-size:12px;gap:5px;min-width:0}.edit input,.edit select,.app-edit input,.app-edit select{background:#111720;color:#fff;border:1px solid #4d5c70;border-radius:6px;padding:9px;min-width:0;width:100%}.remote-readback{color:#c7e5ff;font-size:14px;margin:6px 0 8px}.remote-readback small{color:#9dafc6}.actions{margin:16px 0;display:flex;gap:10px;flex-wrap:wrap}@media(max-width:1200px){.side-grid{grid-template-columns:1fr}.radio-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:900px){main{width:calc(100vw - 28px)}.radio-grid,.system-panel,.snmp-panel,.recording-list,.alarm-list,.field-grid,.app-head,.delay-grid{grid-template-columns:1fr}}
  </style></head><body>${body}</body></html>`;
}

function clientScript(surface) {
  return `
  let ws, state, selectedRadioId, audioContext, processor, source, stream, resample={buffer:[],position:0}, queue=[], rxAudioContext, rxProcessor, rxGain, rxSampleQueue=[], rxAudioEnabled=false, adminEditorDirty=false, adminEditorRendered=false;
  const $=id=>document.getElementById(id);
  function connect(){const proto=location.protocol==='https:'?'wss://':'ws://';ws=new WebSocket(proto+location.host+'/ws');ws.binaryType='arraybuffer';ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='state'){state=m.state;render()}if(m.type==='error')alert(m.message);if(m.type==='rx-audio')playRxAudio(m)};ws.onclose=()=>setTimeout(connect,1000)}
  function render(){if(!state)return;const log=$('log');if(log)log.textContent=state.log;if('${surface}'==='controller'){renderController();bindControllerToggles()}else if('${surface}'==='recording')renderRecording();else renderAdmin()}
  function statusFor(r){const s=state.radioStatus[r.id];if(!r.enabled)return{cls:'unknown',text:'Disabled'};if(!s)return{cls:'unknown',text:'Checking'};if(s.reachable)return{cls:'ok',text:'Online'};return{cls:'bad',text:'Offline'}}
  function fmtBytes(n){if(n===null||n===undefined)return'-';const u=['B','KB','MB','GB','TB'];let v=Number(n),i=0;while(v>=1024&&i<u.length-1){v/=1024;i++}return v.toFixed(i?1:0)+' '+u[i]}
  function levelFor(id,kind){const l=id&&state.audioLevels?.[id];if(!l)return 0;const at=l[kind+'At']||0;if(Date.now()-at>900)return 0;return Math.max(0,Math.min(1,Number(l[kind]||0)))}
  function levelHtml(id,kind){return '<div class="level-bar" aria-label="'+kind.toUpperCase()+' audio level"><span class="level-fill" data-level-id="'+esc(id||'')+'" data-level-kind="'+kind+'" style="width:'+Math.round(levelFor(id,kind)*100)+'%"></span></div>'}
  function updateControllerMeters(){document.querySelectorAll('[data-level-id]').forEach(el=>{el.style.width=Math.round(levelFor(el.dataset.levelId,el.dataset.levelKind)*100)+'%'})}
  function selectedApp(){const apps=state?.applications||[];return apps.find(a=>a.tx?.id===selectedRadioId||a.rx?.id===selectedRadioId)||apps[0]}
  function selectedTx(){const app=selectedApp();return app?.tx}
  function fmtDelay(v){return v===null||v===undefined||Number.isNaN(Number(v))?'-':Math.round(Number(v))+' ms'}
  function bindControllerToggles(){document.querySelectorAll('.radio').forEach(el=>el.onclick=()=>{selectedRadioId=el.dataset.tx||el.dataset.rx;renderController();bindControllerToggles()});document.querySelectorAll('.io-pane').forEach(el=>el.onclick=e=>{e.stopPropagation();if(!el.dataset.id)return;selectedRadioId=el.dataset.id;ws.send(JSON.stringify({type:'toggle-radio-function',radioId:el.dataset.id,func:el.dataset.action}))})}
  function renderController(){const apps=(state.applications||[]).slice(0,4);selectedRadioId ||= apps.find(a=>a.tx?.enabled)?.tx?.id || apps.find(a=>a.rx?.enabled)?.rx?.id || apps[0]?.tx?.id || apps[0]?.rx?.id; $('radios').innerHTML=apps.map(a=>{const txr=a.tx,rxr=a.rx,selected=[txr?.id,rxr?.id].includes(selectedRadioId),txs=txr?statusFor(txr):{cls:'unknown',text:'No TX'},rxs=rxr?statusFor(rxr):{cls:'unknown',text:'No RX'},tx=txr&&state.active&&state.activeRadioId===txr.id,rx=!!(rxr&&state.rxActivity[rxr.id]),txOn=!!txr&&txr.enabled&&txr.txEnabled!==false,rxOn=!!rxr&&rxr.enabled&&rxr.rxEnabled!==false;return '<div class="radio '+(selected?'selected ':'')+(!txOn&&!rxOn?'off ':'')+'" data-tx="'+(txr?.id||'')+'" data-rx="'+(rxr?.id||'')+'"><div class="freq-head"><div><div class="freq">'+esc(a.label)+'</div><div class="label">RX '+esc(rxr?.frequency||'-')+' / TX '+esc(txr?.frequency||'-')+'</div></div><div class="channel-status"><div class="status '+rxs.cls+'">RX '+rxs.text+'</div><div class="status '+txs.cls+'">TX '+txs.text+'</div></div></div><div class="io-grid"><div class="io-pane tx '+(txOn?'enabled':'disabled')+' '+(tx?'active':'')+'" data-action="tx" data-id="'+(txr?.id||'')+'"><strong>TX</strong><div class="indicator tx-indicator"></div><small>'+(txOn?'Enabled':'Disabled')+'</small>'+levelHtml(txr?.id,'tx')+'</div><div class="io-pane rx '+(rxOn?'enabled':'disabled')+' '+(rx&&rxOn?'active':'')+'" data-action="rx" data-id="'+(rxr?.id||'')+'"><strong>RX</strong><div class="indicator rx-indicator"></div><small>'+(rxOn?'Enabled':'Disabled')+'</small>'+levelHtml(rxr?.id,'rx')+'</div></div></div>'}).join('');document.querySelectorAll('.radio').forEach(el=>el.onclick=()=>{selectedRadioId=el.dataset.tx||el.dataset.rx;renderController()});document.querySelectorAll('.io-pane').forEach(el=>el.onclick=e=>{e.stopPropagation();if(!el.dataset.id)return;selectedRadioId=el.dataset.id;renderController()});updateControllerMeters();const app=selectedApp(),txRadio=app?.tx,rxRadio=app?.rx,rr=rxRadio&&state.rxStats?.byRadio?.[rxRadio.id],readout=$('rxReadout'),sel=$('selectedReadout');if(sel)sel.textContent=app?app.label+' / RX '+(rxRadio?.ip||'-')+' / TX '+(txRadio?.ip||'-'):'No selected channel';if(readout)readout.textContent=rr?((rr.packets||0)+' packets'+(rr.lastSource?' from '+rr.lastSource:'')+(rr.lastPayloadType!==null&&rr.lastPayloadType!==undefined?' / PT '+rr.lastPayloadType:'')):'No packets for selected RX';const rxDelay=state.delayStats?.rx?.[rxRadio?.id],txDelay=state.delayStats?.tx?.[txRadio?.id];if($('rxDelay'))$('rxDelay').textContent=rxDelay?(fmtDelay(rxDelay.delayMs)+' / '+fmtDelay(rxDelay.jitterMs)):'No RTP timing';if($('txDelay'))$('txDelay').textContent=txDelay?(fmtDelay(txDelay.queueMs)+(txDelay.underflows?' / '+txDelay.underflows+' underflows':'')):'No PTT audio';$('ptt').disabled=!txRadio||!txRadio.enabled||txRadio.txEnabled===false;$('ptt').classList.toggle('active',state.active);$('ptt').textContent=state.active?'Release PTT':'Hold PTT'}
  function snmpText(item){return item?(item.state==='ok'?String(item.value):item.state):'not checked'}
  function esc(v){return String(v??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;')}
  function remoteText(r){const raw=r&&state.radioStatus[r.id];if(!r)return'Not configured';if(raw?.web?.actualFrequencyMhz)return raw.web.actualFrequencyMhz+' MHz'+(raw.web.radioType?' / '+raw.web.radioType:'');return raw?.web?.ok?'Frequency not found':'Waiting for radio readback'}
  function sideFields(side,r){const s=r?statusFor(r):{cls:'unknown',text:'Not configured'},raw=r&&state.radioStatus[r.id],rr=r&&state.rxStats?.byRadio?.[r.id],ep=raw?.endpoints;return '<div class="side-box" data-side="'+side+'" data-id="'+esc(r?.id||'')+'"><div class="side-title">'+side.toUpperCase()+' Unit <span data-live-status="'+esc(r?.id||'')+'" class="status '+s.cls+'" title="'+(raw?esc('Web '+(ep?.web||r?.webHost||r?.ip||'-')+', Control '+(ep?.control||'-')+', SNMP '+(ep?.snmp||'-')+', SIP '+(ep?.sip||'-')+', RTP '+(ep?.rtp||'-')+', HTTP '+raw.http+', TCP3008 '+raw.tcp3008+', SNMP '+(raw.snmp?.ok?'ok':'fail')+', RX packets '+(rr?.packets||0)):'Not checked')+'">'+s.text+'</span></div><div class="remote-readback"><small>Remote frequency from radio</small><br><strong data-live-remote="'+esc(r?.id||'')+'">'+esc(remoteText(r))+'</strong></div><div class="field-grid"><label>Web Host<input data-k="webHost" value="'+esc(r?.webHost||r?.ip||'')+'"></label><label>Web Port<input data-k="webPort" value="'+esc(r?.webPort||'')+'"></label><label>SIP Host<input data-k="sipHost" value="'+esc(r?.sipHost||'')+'"></label><label>SIP Port<input data-k="sipPort" value="'+esc(r?.sipPort||5060)+'"></label><label>RTP Host<input data-k="rtpHost" value="'+esc(r?.rtpHost||'')+'"></label><label>RTP Port<input data-k="rtpPort" value="'+esc(r?.rtpPort||3004)+'"></label><label>Control Host<input data-k="controlHost" value="'+esc(r?.controlHost||r?.webHost||'')+'"></label><label>Control Port<input data-k="controlPort" value="'+esc(r?.controlPort||3008)+'"></label><label>SNMP Host<input data-k="snmpHost" value="'+esc(r?.snmpHost||r?.webHost||'')+'"></label><label>SNMP Port<input data-k="snmpPort" value="'+esc(r?.snmpPort||161)+'"></label><label>Trap IP<input data-k="snmpTrapIp" value="'+esc(r?.snmpTrapIp||'')+'"></label><label>Local RTP<input data-k="localRtpPort" value="'+esc(r?.localRtpPort||'')+'"></label><label>Mode<select data-k="mode"><option '+((r?.mode||'auto')==='auto'?'selected':'')+'>auto</option><option '+(r?.mode==='ed137'?'selected':'')+'>ed137</option><option '+(r?.mode==='standard-rtp'?'selected':'')+'>standard-rtp</option></select></label><label>Enabled<input data-k="enabled" type="checkbox" '+(r?.enabled?'checked':'')+'></label></div></div>'}
  function appRow(a){return '<div class="app-edit" data-app="'+esc(a.id)+'"><div class="app-head"><label>Application / Position<input data-k="applicationLabel" value="'+esc(a.label)+'"></label><button class="danger remove-radio" type="button">Remove Application</button></div><div class="side-grid">'+sideFields('rx',a.rx)+sideFields('tx',a.tx)+'</div></div>'}
  function bindEditor(){document.querySelectorAll('#editor [data-k]').forEach(el=>{el.oninput=()=>adminEditorDirty=true;el.onchange=()=>adminEditorDirty=true});document.querySelectorAll('.remove-radio').forEach(btn=>btn.onclick=()=>{adminEditorDirty=true;btn.closest('.app-edit').remove()})}
  function shouldRedrawEditor(){const editor=$('editor');return !adminEditorRendered||(!adminEditorDirty&&!(editor&&editor.contains(document.activeElement)))}
  function updateEditorLiveStatus(){document.querySelectorAll('[data-live-remote]').forEach(el=>{const r=state.radios.find(x=>x.id===el.dataset.liveRemote);if(r)el.textContent=remoteText(r)});document.querySelectorAll('[data-live-status]').forEach(el=>{const r=state.radios.find(x=>x.id===el.dataset.liveStatus);if(!r)return;const s=statusFor(r);el.className='status '+s.cls;el.textContent=s.text})}
  function renderAdmin(){const radios=state.radios,rx=state.rxStats||{};$('uptime').textContent=state.uptimeSeconds+' sec';$('watchdog').textContent=state.maxPttSeconds+' sec';$('trapPort').textContent=state.snmpTrapBindIp+':'+state.snmpTrapPort;$('rxPackets').textContent=String(rx.packets||0);$('rxSource').textContent=rx.lastSource||'No packets';$('rxPayload').textContent=rx.lastPayloadType===undefined?'-':'PT '+rx.lastPayloadType+' / '+(rx.lastPayloadBytes||0)+' B';$('alarms').innerHTML=state.alarms.length?state.alarms.map(a=>'<article class="alarm '+a.severity+'"><h3>'+a.severity.toUpperCase()+' '+a.code+'</h3><p>'+a.message+'</p><button data-alarm="'+a.id+'">'+(a.acknowledgedAt?'Acknowledged':'Acknowledge')+'</button></article>').join(''):'<article class="alarm"><h3>No active alarms</h3><p>System supervision has no active alarm.</p></article>';document.querySelectorAll('[data-alarm]').forEach(b=>b.onclick=()=>ws.send(JSON.stringify({type:'ack-alarm',id:b.dataset.alarm})));if(shouldRedrawEditor()){$('editor').innerHTML=(state.applications||[]).map(a=>appRow(a)).join('');adminEditorRendered=true;bindEditor()}else updateEditorLiveStatus();$('snmpPanel').innerHTML=radios.filter(r=>r.enabled).map(r=>{const raw=state.radioStatus[r.id],snmp=raw?.snmp,rr=rx.byRadio?.[r.id],web=raw?.web;return '<article class="snmp-card"><h3>'+r.label+' / '+r.role.toUpperCase()+'</h3><dl><dt>IP</dt><dd>'+r.ip+'</dd><dt>Radio Freq</dt><dd>'+(web?.actualFrequencyMhz?web.actualFrequencyMhz+' MHz':'Not read')+'</dd><dt>Readback Source</dt><dd>Jotron system.html</dd><dt>Model</dt><dd>'+(web?.radioType||'-')+'</dd><dt>SNMP</dt><dd>'+(snmp?.ok?'OK':'No response')+'</dd><dt>RX RTP</dt><dd>'+(rr?((rr.packets||0)+' packets from '+(rr.lastSource||'-')+', PT '+rr.lastPayloadType):'No packets')+'</dd><dt>sysDescr</dt><dd>'+snmpText(snmp?.sysDescr)+'</dd><dt>sysObjectID</dt><dd>'+snmpText(snmp?.sysObjectId)+'</dd><dt>sysUpTime</dt><dd>'+snmpText(snmp?.sysUpTime)+'</dd></dl></article>'}).join('')}
  function exportName(r){return String((r.frequency||'unknown')+'_'+String(r.startedAt||'').replaceAll(':','-').replaceAll('.','-')+'_PTT.mp3').replace(/[^a-z0-9_.-]+/gi,'_')}
  async function renderRecording(){const rec=state.recording;$('recEnabled').textContent=rec.enabled?'Enabled':'Disabled';$('recRetention').textContent=rec.retentionDays+' days';$('recEd137').textContent=rec.ed137RecorderInterface;$('recStorage').textContent=fmtBytes(rec.storageBytes);$('recUsed').textContent=fmtBytes(rec.usedBytes);$('recFiles').textContent=String(rec.fileCount);$('recSchedule').textContent='Daily '+rec.retentionRunTime;$('recMp3').textContent=rec.mp3EncoderAvailable?'Available':'ffmpeg missing';$('recExportFormat').textContent=rec.exportFormat;const rows=await fetch('/api/recording/search').then(r=>r.json()).catch(()=>[]);$('recordings').innerHTML=rows.length?rows.map(r=>'<article class="recording-item"><h3>'+r.radioLabel+' '+r.direction+'</h3><dl><dt>Frequency</dt><dd>'+r.frequency+'</dd><dt>Started</dt><dd>'+r.startedAt+'</dd><dt>Stopped</dt><dd>'+(r.stoppedAt||'-')+'</dd><dt>Retain Until</dt><dd>'+(r.retainedUntil||'-')+'</dd><dt>Packets</dt><dd>'+(r.packets||0)+'</dd><dt>Bytes</dt><dd>'+fmtBytes(r.bytes||0)+'</dd><dt>MP3 Name</dt><dd>'+exportName(r)+'</dd><dt>Extract</dt><dd><a href="/api/recording/export?id='+encodeURIComponent(r.id)+'">MP3</a></dd></dl></article>').join(''):'<article class="recording-item"><h3>No recordings yet</h3><p>TX sessions will appear here after PTT audio is transmitted.</p></article>'}
  function downsample(input,rate){for(let i=0;i<input.length;i++)resample.buffer.push(input[i]);const ratio=rate/8000,outLen=Math.max(0,Math.floor((resample.buffer.length-resample.position)/ratio)),pcm=new Int16Array(outLen);let peak=0;for(let i=0;i<outLen;i++){const start=resample.position+i*ratio,end=start+ratio,a=Math.floor(start),b=Math.min(resample.buffer.length,Math.ceil(end));let sum=0,count=0;for(let j=a;j<b;j++){sum+=resample.buffer[j]||0;count++}let s=count?sum/count:0;s=Math.max(-1,Math.min(1,s*1.1));peak=Math.max(peak,Math.abs(s));pcm[i]=s*24000}resample.position+=outLen*ratio;const drop=Math.floor(resample.position);if(drop){resample.buffer=resample.buffer.slice(drop);resample.position-=drop}const meter=$('level');if(meter)meter.value=peak;return pcm}
  function sendFrames(pcm){queue.push(...pcm);while(queue.length>=160){const f=new Int16Array(160);for(let i=0;i<160;i++)f[i]=queue[i];queue=queue.slice(160);ws.send(f.buffer)}}
  function decodeAlawByte(a){a^=0x55;const sign=a&0x80,exp=(a&0x70)>>4,mant=a&0x0f;let sample=exp===0?(mant<<4)+8:((mant<<4)+0x108)<<(exp-1);return (sign?sample:-sample)/32768}
  function decodeUlawByte(u){u=(~u)&0xff;const sign=u&0x80,exp=(u>>4)&7,mant=u&15;let sample=((mant<<3)+0x84)<<exp;sample-=0x84;return (sign?-sample:sample)/32768}
  function b64bytes(b64){const bin=atob(b64),out=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);return out}
  async function enableRxAudio(){rxAudioContext ||= new AudioContext({latencyHint:'interactive'});if(!rxProcessor){rxProcessor=rxAudioContext.createScriptProcessor(1024,0,1);rxGain=rxAudioContext.createGain();rxGain.gain.value=2.4;rxProcessor.onaudioprocess=e=>{const out=e.outputBuffer.getChannelData(0),need=out.length,ratio=8000/rxAudioContext.sampleRate;let p=0;for(let i=0;i<need;i++){const srcIndex=Math.floor(p);out[i]=srcIndex<rxSampleQueue.length?rxSampleQueue[srcIndex]:0;p+=ratio}const used=Math.floor(p);if(used>0)rxSampleQueue.splice(0,Math.min(used,rxSampleQueue.length));if(rxSampleQueue.length>8000)rxSampleQueue.splice(0,rxSampleQueue.length-4000)};rxProcessor.connect(rxGain);rxGain.connect(rxAudioContext.destination)}if(rxAudioContext.state!=='running')await rxAudioContext.resume();rxAudioEnabled=true;const b=$('rxAudio');b.textContent='RX Audio On';b.classList.add('enabled')}
  async function disableRxAudio(){rxAudioEnabled=false;rxSampleQueue=[];if(rxGain)rxGain.gain.value=0;if(rxAudioContext&&rxAudioContext.state==='running')await rxAudioContext.suspend().catch(()=>{});const b=$('rxAudio');b.textContent='Enable RX Audio';b.classList.remove('enabled')}
  async function toggleRxAudio(){if(rxAudioEnabled)await disableRxAudio();else{if(rxGain)rxGain.gain.value=2.4;await enableRxAudio()}}
  function playRxAudio(m){const app=selectedApp(),rxRadio=app?.rx;if(rxRadio&&m.radioId&&m.radioId!==rxRadio.id)return;if(!rxAudioEnabled||!rxAudioContext)return;if(rxAudioContext.state==='suspended')rxAudioContext.resume().catch(()=>{});const bytes=b64bytes(m.payload),ulaw=Number(m.payloadType)===0;for(let i=0;i<bytes.length;i++)rxSampleQueue.push(Math.max(-1,Math.min(1,(ulaw?decodeUlawByte(bytes[i]):decodeAlawByte(bytes[i])))))}
  async function startMic(){if(audioContext&&audioContext.state!=='closed')return;resample={buffer:[],position:0};queue=[];stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,sampleRate:48000,echoCancellation:false,noiseSuppression:false,autoGainControl:false}});const ctx=new AudioContext({sampleRate:48000,latencyHint:'interactive'});audioContext=ctx;source=ctx.createMediaStreamSource(stream);processor=ctx.createScriptProcessor(2048,1,1);processor.onaudioprocess=e=>{if(!audioContext||audioContext!==ctx||ctx.state==='closed')return;sendFrames(downsample(e.inputBuffer.getChannelData(0),ctx.sampleRate))};const g=ctx.createGain();g.gain.value=0;source.connect(processor);processor.connect(g);g.connect(ctx.destination)}
  async function stopMic(){const ctx=audioContext;if(processor)processor.onaudioprocess=null;if(processor)processor.disconnect();if(source)source.disconnect();if(stream)stream.getTracks().forEach(t=>t.stop());processor=source=audioContext=stream=null;queue=[];if(ctx&&ctx.state!=='closed')await ctx.close().catch(()=>{})}
  if('${surface}'==='controller'){$('rxAudio').onclick=()=>toggleRxAudio();$('ptt').onpointerdown=async e=>{e.preventDefault();const tx=selectedTx();if(!tx||!tx.enabled||tx.txEnabled===false)return;await startMic();ws.send(JSON.stringify({type:'ptt-start',radioId:tx.id,applicationId:selectedApp()?.id}))};window.onpointerup=async()=>{if(state?.active){ws.send(JSON.stringify({type:'ptt-stop'}));await stopMic()}}}
  if('${surface}'==='admin'){$('addRadio').onclick=()=>{const id='app'+Date.now();const app={id,label:'New Application',rx:{id:id+'-rx',role:'rx',ip:'',webHost:'',sipHost:'',rtpHost:'',frequency:'',mode:'auto',sipPort:5060,rtpPort:3004,enabled:false},tx:{id:id+'-tx',role:'tx',ip:'',webHost:'',sipHost:'',rtpHost:'',frequency:'',mode:'auto',sipPort:5060,rtpPort:3004,enabled:false}};adminEditorDirty=true;$('editor').insertAdjacentHTML('beforeend',appRow(app));bindEditor()};$('save').onclick=()=>{const radios=[];document.querySelectorAll('.app-edit').forEach(app=>{const appId=app.dataset.app||('app'+Date.now()),appLabel=app.querySelector('[data-k="applicationLabel"]')?.value||appId;app.querySelectorAll('.side-box').forEach(side=>{const role=side.dataset.side,old=state.radios.find(r=>r.id===side.dataset.id)||{id:side.dataset.id||appId+'-'+role,role,sipPort:5060,rtpPort:3004,txEnabled:true,rxEnabled:true};const next={...old,role,applicationId:appId,applicationLabel:appLabel,label:appLabel+' '+role.toUpperCase()};side.querySelectorAll('[data-k]').forEach(i=>{let v=i.type==='checkbox'?i.checked:i.value;if(['webPort','sipPort','rtpPort','controlPort','snmpPort','localRtpPort'].includes(i.dataset.k))v=Number(v)||undefined;next[i.dataset.k]=v});if(!next.ip)next.ip=next.webHost||next.sipHost||next.rtpHost||'';if(next.webHost||next.sipHost||next.rtpHost||next.ip||next.frequency||next.enabled)radios.push(next)})});adminEditorDirty=false;adminEditorRendered=false;ws.send(JSON.stringify({type:'save-radios',radios}))};$('check').onclick=()=>ws.send(JSON.stringify({type:'check-radios'}));$('snmp').onclick=()=>ws.send(JSON.stringify({type:'check-snmp'}))}
  if('${surface}'==='recording'){$('refreshRecordings').onclick=()=>renderRecording()}
  connect();if('${surface}'==='controller')setInterval(()=>{if(state)updateControllerMeters()},100);`;
}

function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  const accept = crypto.createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
  clients.add(socket);
  sendWs(socket, { type: "state", state: publicState() });
  socket.on("data", (data) => handleWs(socket, data));
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
}

function encodeWs(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const header = [0x80 | opcode];
  if (body.length < 126) header.push(body.length);
  else header.push(126, body.length >> 8, body.length & 255);
  return Buffer.concat([Buffer.from(header), body]);
}

function sendWs(socket, object) {
  if (!socket.destroyed) socket.write(encodeWs(JSON.stringify(object)));
}

function broadcast(object) {
  for (const c of clients) sendWs(c, object);
}

function broadcastTelemetry(maxHz = 2) {
  const now = Date.now();
  if (now - lastTelemetryBroadcast < 1000 / maxHz) return;
  lastTelemetryBroadcast = now;
  broadcast({ type: "state", state: publicState() });
}

function parseFrames(buffer) {
  const frames = [];
  let o = 0;
  while (o + 2 <= buffer.length) {
    const first = buffer[o++], second = buffer[o++], opcode = first & 15;
    let len = second & 127;
    if (len === 126) { len = buffer.readUInt16BE(o); o += 2; }
    if (len === 127) { len = Number(buffer.readBigUInt64BE(o)); o += 8; }
    const mask = second & 128 ? buffer.subarray(o, o + 4) : null;
    if (mask) o += 4;
    const payload = Buffer.from(buffer.subarray(o, o + len));
    o += len;
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
  }
  return frames;
}

async function handleWs(socket, data) {
  for (const frame of parseFrames(data)) {
    if (frame.opcode === 1) {
      let msg;
      try {
        msg = JSON.parse(frame.payload.toString("utf8"));
      } catch {
        sendWs(socket, { type: "error", message: "Invalid control message." });
        continue;
      }
      if (msg.type === "ptt-start") {
        if (activeCall) return sendWs(socket, { type: "error", message: "Another radio is already transmitting." });
        const applications = configuredApplications();
        const requested = configuredRadios().find((r) => r.id === msg.radioId);
        const app = applications.find((item) => item.tx?.id === msg.radioId || item.rx?.id === msg.radioId || item.id === msg.applicationId);
        const radio = requested?.role === "tx" ? requested : app?.tx;
        if (!radio || !radio.enabled) return sendWs(socket, { type: "error", message: "Radio unavailable." });
        if (radio.role !== "tx") return sendWs(socket, { type: "error", message: `${radio.label} is receive-only.` });
        if (radio.txEnabled === false) return sendWs(socket, { type: "error", message: `${radio.label} TX is disabled.` });
        activeCall = new TxCall(radio, selectLocalIp());
        activeCall.start()
          .then(() => {
            if (!activeCall || activeCall.radio.id !== radio.id) return;
            schedulePttWatchdog(radio);
            log(`${radio.label}: PTT active.`);
          })
          .catch((error) => {
            if (activeCall?.radio?.id === radio.id) activeCall = null;
            clearTimeout(pttWatchdog);
            pttWatchdog = null;
            log(`${radio.label}: PTT failed: ${error.message}`);
          });
      }
      if (msg.type === "ptt-stop" && activeCall) {
        await stopActiveCall("operator");
      }
      if (msg.type === "save-radios") {
        const nextIds = new Set((msg.radios ?? []).map((radio) => radio.id));
        for (const id of rxMonitors.keys()) {
          if (!nextIds.has(id)) await stopRxMonitorForRadio(id, "radio-removed");
        }
        if (activeCall && !nextIds.has(activeCall.radio.id)) await stopActiveCall("radio-removed");
        saveConfig({ ...config, radios: msg.radios });
        startRxSipMonitors().catch((error) => log(`RX SIP monitor refresh failed: ${error.message}`));
      }
      if (msg.type === "ack-alarm") {
        const alarm = acknowledgeAlarm(msg.id);
        if (!alarm) sendWs(socket, { type: "error", message: "Alarm not found." });
      }
      if (msg.type === "toggle-radio-function") {
        const key = msg.func === "rx" ? "rxEnabled" : msg.func === "tx" ? "txEnabled" : null;
        if (!key) return sendWs(socket, { type: "error", message: "Unknown radio function." });
        const target = configuredRadios().find((radio) => radio.id === msg.radioId);
        if (key === "txEnabled" && target?.role !== "tx") return sendWs(socket, { type: "error", message: `${target?.label ?? msg.radioId} is receive-only.` });
        const radios = configuredRadios().map((radio) => radio.id === msg.radioId ? { ...radio, [key]: radio[key] === false } : radio);
        const changed = radios.find((radio) => radio.id === msg.radioId);
        saveConfig({ ...config, radios });
        if (changed && key === "txEnabled" && changed.txEnabled === false && activeCall?.radio?.id === changed.id) await stopActiveCall("tx-disabled");
        if (changed?.role === "rx") {
          if (changed.rxEnabled === false) stopRxMonitorForRadio(changed.id, "rx-disabled").catch((error) => log(`RX SIP monitor stop failed: ${error.message}`));
          else startRxMonitorForRadio(changed).catch((error) => log(`RX SIP monitor refresh failed: ${error.message}`));
        }
        log(`${changed?.label ?? msg.radioId}: ${key === "txEnabled" ? "TX" : "RX"} ${changed?.[key] === false ? "disabled" : "enabled"}.`);
      }
      if (msg.type === "check-radios") {
        for (const radio of config.radios) log(`${radio.label}: ${JSON.stringify(await checkRadio(radio))}`);
      }
      if (msg.type === "check-snmp") {
        for (const radio of config.radios.filter((r) => r.enabled)) {
          const snmp = await snmpSystemPoll(radio);
          const old = radioStatus.get(radio.id) ?? { id: radio.id, label: radio.label, ip: radio.ip };
          radioStatus.set(radio.id, { ...old, snmp, reachable: old.reachable || snmp.ok, checkedAt: new Date().toISOString() });
          log(`${radio.label}: SNMP ${snmp.ok ? "ok" : "no response"} ${JSON.stringify({ sysDescr: snmp.sysDescr, sysObjectId: snmp.sysObjectId, sysUpTime: snmp.sysUpTime })}`);
        }
        broadcast({ type: "state", state: publicState() });
      }
    } else if (frame.opcode === 2 && activeCall) {
      activeCall.sendPcm(frame.payload);
    }
  }
}

const serverOptions = httpsCertPath && httpsKeyPath && existsSync(httpsCertPath) && existsSync(httpsKeyPath)
  ? { key: readFileSync(httpsKeyPath), cert: readFileSync(httpsCertPath) }
  : null;
const serverScheme = serverOptions ? "https" : "http";

const server = (serverOptions ? createHttpsServer(serverOptions) : createHttpServer()) ;
server.on("request", async (req, res) => {
  if (req.url === "/" || req.url === "/controller") return res.end(controllerHtml());
  if (req.url === "/admin") return res.end(adminHtml());
  if (req.url === "/recording") return res.end(recordingHtml());
  if (req.url === "/api/status") return json(res, 200, publicState());
  if (req.url === "/api/health") return json(res, activeCall ? 200 : 200, {
    ok: true,
    active: Boolean(activeCall),
    activeRadioId: activeCall?.radio?.id ?? null,
    uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
    localIps: localIps(),
    enabledRadios: config.radios.filter((radio) => radio.enabled).length,
    reachableRadios: [...radioStatus.values()].filter((status) => status.reachable).length,
    snmpTrapBindIp: config.snmpTrapBindIp,
    snmpTrapPort: config.snmpTrapPort,
    snmpTrapCount: snmpTraps.length,
    activeAlarmCount: activeAlarms().length,
    auditLogPath
  });
  if (req.url === "/api/alarms") return json(res, 200, activeAlarms());
  if (req.url?.startsWith("/api/alarms/ack")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    const alarm = acknowledgeAlarm(url.searchParams.get("id"));
    return json(res, alarm ? 200 : 404, alarm ?? { ok: false, error: "Alarm not found." });
  }
  if (req.url === "/api/radios/check") return json(res, 200, await pollRadios("manual"));
  if (req.url === "/api/recording/status") return json(res, 200, recordingStatus());
  if (req.url === "/api/recording/search") return json(res, 200, readRecordingSessions(100));
  if (req.url === "/api/recording/retention/run") return json(res, 200, enforceRecordingRetention("manual"));
  if (req.url?.startsWith("/api/recording/export")) {
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    const id = url.searchParams.get("id");
    const session = readRecordingSessions(1000).find((item) => item.id === id);
    if (!session) return json(res, 404, { ok: false, error: "Recording session not found." });
    try {
      const exported = await exportRecordingMp3(session);
      const body = readFileSync(exported.outputPath);
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": body.length,
        "content-disposition": `attachment; filename="${exported.outputName}"`
      });
      return res.end(body);
    } catch (error) {
      return json(res, 503, { ok: false, error: error.message, required: "Install ffmpeg on the recording server or set FFMPEG_PATH." });
    }
  }
  if (req.url === "/api/snmp/check") {
    const results = [];
    for (const radio of config.radios.filter((r) => r.enabled)) {
      const snmp = await snmpSystemPoll(radio);
      const old = radioStatus.get(radio.id) ?? { id: radio.id, label: radio.label, ip: radio.ip };
      radioStatus.set(radio.id, { ...old, snmp, reachable: old.reachable || snmp.ok, checkedAt: new Date().toISOString() });
      results.push({ id: radio.id, label: radio.label, ip: radio.ip, snmp });
    }
    return json(res, 200, results);
  }
  if (req.url === "/api/snmp/traps") return json(res, 200, snmpTraps);
  res.writeHead(404).end("Not found");
});

server.on("upgrade", (req, socket) => req.url === "/ws" ? acceptWebSocket(req, socket) : socket.destroy());
server.listen(port, host, () => {
  console.log(`ATM VCS server: ${serverScheme}://${host}:${port}/controller`);
  log(`ATM VCS service started on ${serverScheme}://${host}:${port}.`);
  startSnmpTrapListener();
  startRxRtpListener();
  startUdpDebugListeners();
  setTimeout(() => startRxSipMonitors().catch((error) => log(`Startup RX SIP monitor failed: ${error.message}`)), 1500);
  setInterval(() => startRxSipMonitors().catch((error) => log(`RX SIP monitor retry failed: ${error.message}`)), 30000);
  if (recordingLocalEnabled()) {
    scheduleRecordingRetention();
    log(`Recording retention scheduled daily at ${config.recording?.retentionRunTime ?? "02:00"}.`);
  } else {
    log("Local recording disabled; retention scan is not scheduled.");
  }
  evaluateSystemAlarms();
  setInterval(evaluateSystemAlarms, 30000);
  pollRadios("startup").catch((error) => log(`Startup radio poll failed: ${error.message}`));
  setInterval(() => pollRadios().catch((error) => log(`Radio poll failed: ${error.message}`)), Math.max(5, Number(config.radioPollSeconds) || 15) * 1000);
  setInterval(() => refreshJotronWebReadbacks().catch((error) => log(`Jotron web readback failed: ${error.message}`)), 5000);
});

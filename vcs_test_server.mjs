import { createServer } from "node:http";
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import crypto from "node:crypto";
import os from "node:os";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const radioIp = process.env.JOTRON_IP ?? "192.168.1.10";
const receiverIp = process.env.JOTRON_RX_IP ?? "192.168.1.5";
const sipPort = Number.parseInt(process.env.JOTRON_SIP_PORT ?? "5060", 10);
const localSipPort = Number.parseInt(process.env.LOCAL_SIP_PORT ?? "5062", 10);
const localRtpPort = Number.parseInt(process.env.LOCAL_RTP_PORT ?? "3006", 10);
const localRxSipPort = Number.parseInt(process.env.LOCAL_RX_SIP_PORT ?? "5064", 10);
const localRxRtpPort = Number.parseInt(process.env.LOCAL_RX_RTP_PORT ?? "3004", 10);
const fallbackLocalIp = process.env.LOCAL_VCS_IP ?? "192.168.1.15";

let logLines = ["Idle. Ready for Jotron TA-7650 microphone/PTT test."];
let currentCall = null;
let currentMonitor = null;
let rxStats = { packets: 0, lastPayloadType: null, lastFrom: "", lastAt: null, decodedPackets: 0 };
const clients = new Set();

function validIpv4(value) {
  const parts = String(value).trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  logLines.push(`[${stamp}] ${line}`);
  logLines = logLines.slice(-250);
  broadcast({ type: "status", state: publicState() });
}

function execPowerShell(command, timeout = 8000) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", command], { timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout.trim(), stderr: stderr.trim(), error: error?.message ?? "" });
    });
  });
}

function local192Ips() {
  const ips = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address.startsWith("192.168.1.")) {
        ips.push(entry.address);
      }
    }
  }
  if (!ips.length && validIpv4(fallbackLocalIp) && fallbackLocalIp.startsWith("192.168.1.")) {
    ips.push(fallbackLocalIp);
  }
  return ips;
}

function selectSourceIp() {
  const ips = local192Ips();
  return ips.find((ip) => ip !== radioIp && ip !== receiverIp) ?? ips[0] ?? "0.0.0.0";
}

async function endpointStatus(ip, localIp, extension, probePort) {
  const http = await execPowerShell(
    `try { $r=Invoke-WebRequest -UseBasicParsing http://${ip} -TimeoutSec 3; if($r.StatusCode -eq 200){'open'}else{'closed'} } catch { 'closed' }`,
    6000
  );
  const tcp3008 = await execPowerShell(
    `try { $r=Test-NetConnection ${ip} -Port 3008 -InformationLevel Quiet; if($r){'open'}else{'closed'} } catch { 'closed' }`,
    8000
  );
  const sip = await sipOptionsProbe({ localIp, targetIp: ip, extension, probePort }).catch((error) => `closed: ${error.message}`);
  return { http: http.stdout || "unknown", tcp3008: tcp3008.stdout || "unknown", sip5060: sip };
}

async function networkStatus() {
  const ips = local192Ips();
  const sourceIp = selectSourceIp();
  const tx = await endpointStatus(radioIp, sourceIp, "txradio", localSipPort + 10);
  const rxHttp = await execPowerShell(
    `try { $r=Invoke-WebRequest -UseBasicParsing http://${receiverIp} -TimeoutSec 3; if($r.StatusCode -eq 200){'open'}else{'closed'} } catch { 'closed' }`,
    6000
  );
  const rxTcp3008 = await execPowerShell(
    `try { $r=Test-NetConnection ${receiverIp} -Port 3008 -InformationLevel Quiet; if($r){'open'}else{'closed'} } catch { 'closed' }`,
    8000
  );
  return {
    localIps: ips,
    sourceIp,
    hasExpectedVcsIps: ips.includes("192.168.1.10") && ips.includes("192.168.1.16"),
    tx,
    rx: { http: rxHttp.stdout || "unknown", tcp3008: rxTcp3008.stdout || "unknown", mode: "static RTP", listenPort: localRxRtpPort },
  };
}

function randomToken(prefix = "") {
  return `${prefix}${crypto.randomBytes(5).toString("hex")}`;
}

function buildSdp(localIp) {
  return [
    "v=0",
    `o=vcs 1 1 IN IP4 ${localIp}`,
    "s=Jotron TA7650 browser microphone",
    `c=IN IP4 ${localIp}`,
    "t=0 0",
    `m=audio ${localRtpPort} RTP/AVP 8 123`,
    "a=rtpmap:8 PCMA/8000",
    "a=rtpmap:123 R2S/8000",
    "a=ptime:20",
    "a=sendrecv",
    "a=rtphe:1",
    "",
  ].join("\r\n");
}

function sendSip(socket, targetIp, message) {
  return new Promise((resolve, reject) => {
    socket.send(Buffer.from(message, "ascii"), sipPort, targetIp, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitSipResponse(socket, matcher, timeoutMs = 5000) {
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

async function sipOptionsProbe({ localIp, targetIp, extension, probePort }) {
  if (localIp === "0.0.0.0") return "no-local-ip";
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => socket.bind(probePort, localIp, (error) => error ? reject(error) : resolve()));
  const callId = `${randomToken("options-")}@${localIp}`;
  const branch = `z9hG4bK${randomToken()}`;
  const message = [
    `OPTIONS sip:${extension}@${targetIp}:${sipPort} SIP/2.0`,
    `Via: SIP/2.0/UDP ${localIp}:${probePort};branch=${branch};rport`,
    "Max-Forwards: 70",
    `From: <sip:vcs@${localIp}>;tag=probe`,
    `To: <sip:${extension}@${targetIp}>`,
    `Call-ID: ${callId}`,
    "CSeq: 1 OPTIONS",
    `Contact: <sip:vcs@${localIp}:${probePort}>`,
    "Accept: application/sdp",
    "Content-Length: 0",
    "",
    "",
  ].join("\r\n");
  try {
    const responsePromise = waitSipResponse(socket, (text) => text.startsWith("SIP/2.0"), 2500);
    await sendSip(socket, targetIp, message);
    const response = await responsePromise;
    return response.startsWith("SIP/2.0 200") ? "open" : response.split("\r\n")[0];
  } finally {
    socket.close();
  }
}

function parseSipHeader(message, name) {
  const match = message.match(new RegExp(`^${name}:\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function parseRemoteRtpPort(sdpMessage) {
  const match = sdpMessage.match(/^m=audio\s+(\d+)/im);
  return match ? Number.parseInt(match[1], 10) : 3003;
}

function linearToAlaw(sample) {
  let sign = 0x80;
  if (sample < 0) {
    sample = -sample - 1;
    sign = 0x00;
  }
  sample = Math.min(sample >> 4, 0x0fff);
  let compressed;
  if (sample >= 256) {
    let exponent = 7;
    let mask = 0x400;
    while (exponent > 0 && !(sample & mask)) {
      exponent -= 1;
      mask >>= 1;
    }
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    compressed = (exponent << 4) | mantissa;
  } else {
    compressed = sample >> 4;
  }
  return compressed ^ (sign ^ 0x55);
}

function pcm16ToPcma(buffer) {
  const out = Buffer.alloc(Math.floor(buffer.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = linearToAlaw(buffer.readInt16LE(i * 2));
  }
  return out;
}

function alawToLinear(value) {
  value ^= 0x55;
  let sample = (value & 0x0f) << 4;
  const exponent = (value & 0x70) >> 4;
  if (exponent === 0) {
    sample += 8;
  } else if (exponent === 1) {
    sample += 0x108;
  } else {
    sample += 0x108;
    sample <<= exponent - 1;
  }
  return (value & 0x80) ? sample : -sample;
}

function pcmaToPcm16(payload) {
  const out = Buffer.alloc(payload.length * 2);
  for (let i = 0; i < payload.length; i += 1) {
    out.writeInt16LE(alawToLinear(payload[i]), i * 2);
  }
  return out;
}

function ulawToLinear(value) {
  value = ~value & 0xff;
  const sign = value & 0x80;
  const exponent = (value >> 4) & 0x07;
  const mantissa = value & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function pcmuToPcm16(payload) {
  const out = Buffer.alloc(payload.length * 2);
  for (let i = 0; i < payload.length; i += 1) {
    out.writeInt16LE(ulawToLinear(payload[i]), i * 2);
  }
  return out;
}

function ed137Word(pttType, mode) {
  if (mode === "lsb") return pttType & 0x07;
  if (mode === "sample") return pttType ? 0x30010800 : 0x00000000;
  return (pttType & 0x07) << 29;
}

function rtpPayload(packet) {
  if (packet.length < 12) return null;
  const version = packet[0] >> 6;
  if (version !== 2) return null;
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = Boolean(packet[0] & 0x10);
  const payloadType = packet[1] & 0x7f;
  let offset = 12 + csrcCount * 4;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    const extWords = packet.readUInt16BE(offset + 2);
    offset += 4 + extWords * 4;
  }
  if (packet.length <= offset) return null;
  return { payloadType, payload: packet.subarray(offset) };
}

class Ed137Call {
  constructor({ localIp, extensionMode }) {
    this.localIp = localIp;
    this.radioIp = radioIp;
    this.extensionMode = extensionMode;
    this.callId = `${randomToken("call-")}@${localIp}`;
    this.fromTag = randomToken("tag");
    this.sipSocket = dgram.createSocket("udp4");
    this.rtpSocket = dgram.createSocket("udp4");
    this.remoteRtpPort = 3003;
    this.toHeader = `<sip:txradio@${this.radioIp}>`;
    this.seq = 1;
    this.timestamp = 0;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.sentRtp = 0;
  }

  async start() {
    await new Promise((resolve, reject) => this.sipSocket.bind(localSipPort, this.localIp, (error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => this.rtpSocket.bind(localRtpPort, this.localIp, (error) => error ? reject(error) : resolve()));
    this.sipSocket.on("error", (error) => log(`SIP socket error: ${error.message}`));
    this.rtpSocket.on("error", (error) => log(`RTP socket error: ${error.message}`));

    const sdp = buildSdp(this.localIp);
    const branch = `z9hG4bK${randomToken()}`;
    const invite = [
      `INVITE sip:txradio@${this.radioIp}:${sipPort} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${localSipPort};branch=${branch};rport`,
      "Max-Forwards: 70",
      `From: <sip:vcs@${this.localIp}>;tag=${this.fromTag}`,
      `To: <sip:txradio@${this.radioIp}>`,
      `Call-ID: ${this.callId}`,
      "CSeq: 1 INVITE",
      `Contact: <sip:vcs@${this.localIp}:${localSipPort}>`,
      "WG67-Version: radio.01",
      "Priority: normal",
      "Subject: radio",
      "Content-Type: application/sdp",
      `Content-Length: ${Buffer.byteLength(sdp)}`,
      "",
      sdp,
    ].join("\r\n");

    const finalResponsePromise = waitSipResponse(
      this.sipSocket,
      (text) => text.startsWith("SIP/2.0 200") || /^SIP\/2.0 [456]/.test(text),
      6000
    );
    await sendSip(this.sipSocket, this.radioIp, invite);
    log(`SIP INVITE sent from ${this.localIp}:${localSipPort}`);
    const response = await finalResponsePromise;
    log(response.split("\r\n")[0]);
    if (!response.startsWith("SIP/2.0 200")) {
      throw new Error(response.split("\r\n")[0]);
    }

    this.toHeader = parseSipHeader(response, "To");
    this.remoteRtpPort = parseRemoteRtpPort(response);
    const ack = [
      `ACK sip:txradio@${this.radioIp}:${sipPort} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${localSipPort};branch=z9hG4bK${randomToken()};rport`,
      "Max-Forwards: 70",
      `From: <sip:vcs@${this.localIp}>;tag=${this.fromTag}`,
      `To: ${this.toHeader}`,
      `Call-ID: ${this.callId}`,
      "CSeq: 1 ACK",
      `Contact: <sip:vcs@${this.localIp}:${localSipPort}>`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    await sendSip(this.sipSocket, this.radioIp, ack);
    log(`ACK sent. RTP target ${this.radioIp}:${this.remoteRtpPort}, ED-137 extension ${this.extensionMode}.`);
  }

  sendPcm(buffer, pttType = 1) {
    if (!buffer.length) return;
    const pcma = pcm16ToPcma(buffer);
    this.sendRtp(pcma, pttType);
  }

  sendRtp(payload, pttType) {
    const packet = Buffer.alloc(20 + payload.length);
    packet[0] = 0x90;
    packet[1] = (this.sentRtp === 0 ? 0x80 : 0x00) | 8;
    packet.writeUInt16BE(this.seq, 2);
    packet.writeUInt32BE(this.timestamp, 4);
    packet.writeUInt32BE(this.ssrc, 8);
    packet.writeUInt16BE(0x0067, 12);
    packet.writeUInt16BE(1, 14);
    packet.writeUInt32BE(ed137Word(pttType, this.extensionMode), 16);
    payload.copy(packet, 20);
    this.rtpSocket.send(packet, this.remoteRtpPort, this.radioIp);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + Math.max(payload.length, 160)) >>> 0;
    this.sentRtp += 1;
  }

  sendPttOff() {
    const silence = Buffer.alloc(160, 0xd5);
    for (let i = 0; i < 6; i += 1) {
      this.sendRtp(silence, 0);
    }
  }

  async stop() {
    this.sendPttOff();
    const bye = [
      `BYE sip:txradio@${this.radioIp}:${sipPort} SIP/2.0`,
      `Via: SIP/2.0/UDP ${this.localIp}:${localSipPort};branch=z9hG4bK${randomToken()};rport`,
      "Max-Forwards: 70",
      `From: <sip:vcs@${this.localIp}>;tag=${this.fromTag}`,
      `To: ${this.toHeader}`,
      `Call-ID: ${this.callId}`,
      "CSeq: 2 BYE",
      `Contact: <sip:vcs@${this.localIp}:${localSipPort}>`,
      "Content-Length: 0",
      "",
      "",
    ].join("\r\n");
    await sendSip(this.sipSocket, this.radioIp, bye).catch(() => {});
    this.sipSocket.close();
    this.rtpSocket.close();
    log(`PTT released. BYE sent. RTP packets sent: ${this.sentRtp}.`);
  }
}

class StandardRtpCall {
  constructor({ localIp }) {
    this.localIp = localIp;
    this.radioIp = radioIp;
    this.rtpSocket = dgram.createSocket("udp4");
    this.remoteRtpPort = 3004;
    this.seq = 1;
    this.timestamp = 0;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.sentRtp = 0;
  }

  async start() {
    await new Promise((resolve, reject) => this.rtpSocket.bind(localRtpPort, this.localIp, (error) => error ? reject(error) : resolve()));
    this.rtpSocket.on("error", (error) => log(`Standard RTP socket error: ${error.message}`));
    log(`SIP timed out; using Standard RTP fallback to ${this.radioIp}:${this.remoteRtpPort}.`);
  }

  sendPcm(buffer) {
    if (!buffer.length) return;
    this.sendRtp(pcm16ToPcma(buffer));
  }

  sendRtp(payload) {
    const packet = Buffer.alloc(12 + payload.length);
    packet[0] = 0x80;
    packet[1] = (this.sentRtp === 0 ? 0x80 : 0x00) | 8;
    packet.writeUInt16BE(this.seq, 2);
    packet.writeUInt32BE(this.timestamp, 4);
    packet.writeUInt32BE(this.ssrc, 8);
    payload.copy(packet, 12);
    this.rtpSocket.send(packet, this.remoteRtpPort, this.radioIp);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + Math.max(payload.length, 160)) >>> 0;
    this.sentRtp += 1;
  }

  async stop() {
    this.rtpSocket.close();
    log(`PTT released. Standard RTP packets sent: ${this.sentRtp}.`);
  }
}

class ReceiverMonitor {
  constructor({ localIp }) {
    this.localIp = localIp;
    this.rtpSocket = dgram.createSocket("udp4");
    this.receivedRtp = 0;
  }

  async start() {
    await new Promise((resolve, reject) => this.rtpSocket.bind(localRxRtpPort, this.localIp, (error) => error ? reject(error) : resolve()));
    rxStats = { packets: 0, lastPayloadType: null, lastFrom: "", lastAt: null, decodedPackets: 0 };
    this.rtpSocket.on("error", (error) => log(`RX RTP socket error: ${error.message}`));
    this.rtpSocket.on("message", (packet, rinfo) => {
      const rtp = rtpPayload(packet);
      if (!rtp) return;
      this.receivedRtp += 1;
      rxStats = {
        packets: this.receivedRtp,
        lastPayloadType: rtp.payloadType,
        lastFrom: `${rinfo.address}:${rinfo.port}`,
        lastAt: new Date().toISOString(),
        decodedPackets: rxStats.decodedPackets,
      };
      if (this.receivedRtp === 1 || this.receivedRtp % 50 === 0) {
        log(`RX RTP packets received: ${this.receivedRtp}, PT ${rtp.payloadType}, from ${rxStats.lastFrom}`);
      }
      if (rtp.payloadType === 8 || rtp.payloadType === 0 || rtp.payloadType === 2) {
        const decoded = rtp.payloadType === 8 ? pcmaToPcm16(rtp.payload) : pcmuToPcm16(rtp.payload);
        rxStats.decodedPackets += 1;
        broadcast({ type: "rx-audio", codec: "pcm16", sampleRate: 8000, audio: decoded.toString("base64") });
      }
    });
    log(`RX monitor active. RA-7203 uses static RTP; listening on ${this.localIp}:${localRxRtpPort}.`);
  }

  async stop() {
    this.rtpSocket.close();
    log(`RX monitor stopped. RTP packets received: ${this.receivedRtp}.`);
  }
}

function publicState() {
  return {
    active: Boolean(currentCall),
    monitoring: Boolean(currentMonitor),
    rxStats,
    log: logLines.join("\n"),
    config: { radioIp, receiverIp, sipPort, localSipPort, localRtpPort, localRxSipPort, localRxRtpPort },
  };
}

async function receiverConfigReport() {
  const network = await execPowerShell(
    `$c=(Invoke-WebRequest -UseBasicParsing http://${receiverIp}/network.html -TimeoutSec 5).Content; ($c -replace '<[^>]+>',' ' -replace '&nbsp;',' ' -replace '\\s+',' ').Trim()`,
    10000
  );
  const system = await execPowerShell(
    `$c=(Invoke-WebRequest -UseBasicParsing http://${receiverIp}/system.html -TimeoutSec 5).Content; ($c -replace '<[^>]+>',' ' -replace '&nbsp;',' ' -replace '\\s+',' ').Trim()`,
    10000
  );
  const text = `${network.stdout}\n${system.stdout}`;
  const hasEd137 = /VoIP option:\s*Installed/i.test(text) && /ED137/i.test(text);
  const standardRtp = /VoIP option:\s*NOT Installed/i.test(text) && /Standard Real-Time Protocol/i.test(text);
  const remoteIp = text.match(/Remote IP:\s*([0-9.]+)/i)?.[1] ?? "unknown";
  const remotePort = text.match(/Remote Port:\s*(\d+)/i)?.[1] ?? "unknown";
  const codec = text.match(/Voice codec \(from radio\)\s*(\d+)/i)?.[1] ?? text.match(/Output audio codec:\s*(\d+)/i)?.[1] ?? "unknown";
  const interval = text.match(/Packet interval \(from radio\)\s*(\d+)/i)?.[1] ?? text.match(/Output interval:\s*(\d+)/i)?.[1] ?? "unknown";
  return {
    receiverIp,
    pcIp: selectSourceIp(),
    hasEd137,
    standardRtp,
    remoteIp,
    remotePort,
    codec,
    interval,
    verdict: hasEd137
      ? "ED-137 appears installed."
      : "ED-137 is not installed/enabled on this RA-7203. This cannot be enabled safely by the web app; it requires Jotron service/config software and the appropriate licensed option.",
    recommendedStandardRtp: {
      remoteIp: selectSourceIp(),
      remotePort: localRxRtpPort,
      codec,
      interval,
    },
  };
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function acceptWebSocket(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));
  clients.add(socket);
  sendWs(socket, { type: "status", state: publicState() });
  socket.on("data", (data) => handleWsData(socket, data));
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
}

function encodeWsFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const header = [];
  header.push(0x80 | opcode);
  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length <= 0xffff) {
    header.push(126, body.length >> 8, body.length & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0, (body.length / 2 ** 24) & 0xff, (body.length / 2 ** 16) & 0xff, (body.length / 2 ** 8) & 0xff, body.length & 0xff);
  }
  return Buffer.concat([Buffer.from(header), body]);
}

function sendWs(socket, object) {
  if (!socket.destroyed) socket.write(encodeWsFrame(JSON.stringify(object), 1));
}

function broadcast(object) {
  for (const client of clients) sendWs(client, object);
}

function parseWsFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset++];
    const second = buffer[offset++];
    const opcode = first & 0x0f;
    let len = second & 0x7f;
    if (len === 126) {
      if (offset + 2 > buffer.length) break;
      len = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (offset + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const masked = Boolean(second & 0x80);
    const mask = masked ? buffer.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (offset + len > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + len));
    offset += len;
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ opcode, payload });
  }
  return frames;
}

async function handleWsData(socket, data) {
  for (const frame of parseWsFrames(data)) {
    if (frame.opcode === 8) {
      socket.end();
      continue;
    }
    if (frame.opcode === 1) {
      const message = JSON.parse(frame.payload.toString("utf8"));
      if (message.type === "ptt-start") {
        if (currentCall) {
          sendWs(socket, { type: "error", message: "PTT already active." });
          continue;
        }
        try {
          const localIp = selectSourceIp();
          if (localIp === "0.0.0.0") throw new Error("No 192.168.1.x interface found.");
          currentCall = new Ed137Call({ localIp, extensionMode: message.extensionMode ?? "msb" });
          try {
            await currentCall.start();
          } catch (error) {
            currentCall = new StandardRtpCall({ localIp });
            await currentCall.start();
          }
          log("PTT active. Speak into the PC microphone.");
        } catch (error) {
          log(`PTT start failed: ${error.message}`);
          currentCall = null;
        }
      }
      if (message.type === "ptt-stop" && currentCall) {
        const call = currentCall;
        currentCall = null;
        await call.stop();
      }
      if (message.type === "monitor-start") {
        if (currentMonitor) {
          sendWs(socket, { type: "error", message: "RX monitor is already active." });
          continue;
        }
        try {
          const localIp = selectSourceIp();
          if (localIp === "0.0.0.0") throw new Error("No 192.168.1.x interface found.");
          currentMonitor = new ReceiverMonitor({ localIp });
          await currentMonitor.start();
        } catch (error) {
          log(`RX monitor start failed: ${error.message}`);
          currentMonitor = null;
        }
      }
      if (message.type === "monitor-stop" && currentMonitor) {
        const monitor = currentMonitor;
        currentMonitor = null;
        await monitor.stop();
      }
      if (message.type === "refresh") {
        sendWs(socket, { type: "status", state: publicState() });
      }
      if (message.type === "receiver-config") {
        try {
          sendWs(socket, { type: "receiver-config", report: await receiverConfigReport() });
        } catch (error) {
          sendWs(socket, { type: "error", message: `Receiver config check failed: ${error.message}` });
        }
      }
    }
    if (frame.opcode === 2 && currentCall) {
      currentCall.sendPcm(frame.payload, 1);
    }
  }
}

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Jotron TA-7650 VCS PTT</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, Segoe UI, Arial, sans-serif; background: #101216; color: #f4f7fb; }
    body { margin: 0; min-height: 100vh; background: #101216; }
    main { max-width: 1180px; margin: 0 auto; padding: 26px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 18px; }
    h1 { margin: 0; font-size: 28px; letter-spacing: 0; }
    .status { border: 1px solid #3b4654; background: #171c24; border-radius: 6px; padding: 8px 12px; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .panel { border: 1px solid #303946; background: #171b22; border-radius: 8px; padding: 15px; }
    .label { color: #9ba8b8; font-size: 12px; text-transform: uppercase; margin-bottom: 7px; }
    .value { font-size: 17px; font-weight: 680; overflow-wrap: anywhere; }
    .warning { display: none; border: 1px solid #8d7132; background: #2a2111; color: #ffe0a6; padding: 12px; border-radius: 8px; margin-bottom: 16px; line-height: 1.45; }
    .report { display: none; border: 1px solid #314558; background: #121a24; padding: 14px; border-radius: 8px; margin: 0 0 16px; white-space: pre-wrap; line-height: 1.45; }
    .controls { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 18px 0; }
    button { border: 1px solid #526173; border-radius: 6px; color: #fff; background: #2364aa; padding: 12px 18px; font-size: 15px; cursor: pointer; }
    button.ptt { min-width: 220px; min-height: 64px; font-size: 19px; font-weight: 750; background: #1d7d56; }
    button.ptt.active { background: #b12d36; }
    button.monitor.active { background: #7b4db5; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    select { border: 1px solid #526173; background: #171c24; color: #fff; border-radius: 6px; padding: 10px 12px; }
    meter { width: 220px; height: 18px; }
    pre { margin: 0; min-height: 320px; padding: 16px; overflow: auto; border: 1px solid #303844; border-radius: 8px; background: #090b0f; color: #d7e7d0; line-height: 1.45; }
    @media (max-width: 780px) { .grid { grid-template-columns: 1fr 1fr; } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Jotron TA-7650 VCS PTT</h1>
      <div class="status" id="state">Loading</div>
    </header>
    <div class="warning" id="warning"></div>
    <div class="report" id="report"></div>
    <section class="grid">
      <div class="panel"><div class="label">TA-7650</div><div class="value" id="radio">192.168.1.2</div></div>
      <div class="panel"><div class="label">RA-7203</div><div class="value" id="receiver">192.168.1.4</div></div>
      <div class="panel"><div class="label">TX SIP</div><div class="value">UDP 5060</div></div>
      <div class="panel"><div class="label">RTP To Radio</div><div class="value">UDP 3004 fallback</div></div>
      <div class="panel"><div class="label">RX Listen</div><div class="value">Static RTP 3004</div></div>
    </section>
    <div class="controls">
      <button class="ptt" id="ptt">Hold PTT</button>
      <button class="monitor" id="monitor">Monitor RX</button>
      <meter id="level" min="0" max="1" value="0"></meter>
      <select id="extension">
        <option value="msb">ED-137 extension MSB</option>
        <option value="lsb">ED-137 extension LSB</option>
        <option value="sample">ED-137 sample word</option>
      </select>
      <button id="refresh">Refresh</button>
      <button id="config">Check RA Config</button>
    </div>
    <pre id="log"></pre>
  </main>
  <script>
    let ws;
    let audioContext;
    let processor;
    let source;
    let stream;
    let playbackContext;
    let nextPlaybackTime = 0;
    let resampleState = { inputRate: 48000, buffer: [], position: 0 };
    let txFrameQueue = [];
    const ptt = document.getElementById('ptt');
    const monitor = document.getElementById('monitor');
    const level = document.getElementById('level');

    function connect() {
      ws = new WebSocket('ws://' + location.host + '/ws');
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => document.getElementById('state').textContent = 'Connected';
      ws.onclose = () => { document.getElementById('state').textContent = 'Disconnected'; setTimeout(connect, 1000); };
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'status') render(msg.state);
        if (msg.type === 'error') alert(msg.message);
        if (msg.type === 'rx-audio') playPcm16(msg.audio, msg.sampleRate);
        if (msg.type === 'receiver-config') renderReport(msg.report);
      };
    }

    function render(state) {
      document.getElementById('state').textContent = state.active ? 'PTT Active' : (state.monitoring ? 'Monitoring RX' : 'Ready');
      document.getElementById('log').textContent = state.log;
      document.getElementById('radio').textContent = state.config.radioIp;
      document.getElementById('receiver').textContent = state.config.receiverIp;
      ptt.classList.toggle('active', state.active);
      monitor.classList.toggle('active', state.monitoring);
      ptt.textContent = state.active ? 'Release PTT' : 'Hold PTT';
      monitor.textContent = state.monitoring ? 'Stop RX Monitor' : 'Monitor RX';
    }

    function base64ToArrayBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    async function ensurePlaybackContext() {
      if (!playbackContext) playbackContext = new AudioContext();
      if (playbackContext.state !== 'running') await playbackContext.resume();
      if (nextPlaybackTime < playbackContext.currentTime) nextPlaybackTime = playbackContext.currentTime + 0.04;
    }

    async function playPcm16(base64, sampleRate) {
      await ensurePlaybackContext();
      const pcm = new Int16Array(base64ToArrayBuffer(base64));
      const audioBuffer = playbackContext.createBuffer(1, pcm.length, sampleRate);
      const channel = audioBuffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
      const node = playbackContext.createBufferSource();
      node.buffer = audioBuffer;
      node.connect(playbackContext.destination);
      node.start(nextPlaybackTime);
      nextPlaybackTime += audioBuffer.duration;
    }

    function floatToPcm16(sample) {
      const clamped = Math.max(-1, Math.min(1, sample));
      return clamped < 0 ? clamped * 32768 : clamped * 32767;
    }

    function downsampleTo8k(float32, inputRate) {
      resampleState.buffer.push(...float32);
      const ratio = inputRate / 8000;
      const available = resampleState.buffer.length - 1;
      const outLen = Math.max(0, Math.floor((available - resampleState.position) / ratio));
      const pcm = new Int16Array(outLen);
      let peak = 0;
      for (let i = 0; i < outLen; i++) {
        const sourceIndex = resampleState.position + i * ratio;
        const left = Math.floor(sourceIndex);
        const fraction = sourceIndex - left;
        const sample = (resampleState.buffer[left] || 0) * (1 - fraction) + (resampleState.buffer[left + 1] || 0) * fraction;
        peak = Math.max(peak, Math.abs(sample));
        pcm[i] = floatToPcm16(sample);
      }
      resampleState.position += outLen * ratio;
      const drop = Math.floor(resampleState.position);
      if (drop > 0) {
        resampleState.buffer = resampleState.buffer.slice(drop);
        resampleState.position -= drop;
      }
      level.value = peak;
      return pcm;
    }

    function sendPcmFrames(pcm) {
      txFrameQueue.push(...pcm);
      while (txFrameQueue.length >= 160) {
        const frame = new Int16Array(160);
        for (let i = 0; i < 160; i++) frame[i] = txFrameQueue[i];
        txFrameQueue = txFrameQueue.slice(160);
        ws.send(frame.buffer);
      }
    }

    async function startMic() {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      audioContext = new AudioContext({ latencyHint: 'interactive' });
      resampleState = { inputRate: audioContext.sampleRate, buffer: [], position: 0 };
      txFrameQueue = [];
      source = audioContext.createMediaStreamSource(stream);
      processor = audioContext.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (event) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const pcm = downsampleTo8k(event.inputBuffer.getChannelData(0), audioContext.sampleRate);
        if (pcm.length) sendPcmFrames(pcm);
      };
      source.connect(processor);
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      processor.connect(silentGain);
      silentGain.connect(audioContext.destination);
    }

    async function stopMic() {
      if (processor) processor.disconnect();
      if (source) source.disconnect();
      if (audioContext) await audioContext.close();
      if (stream) stream.getTracks().forEach(track => track.stop());
      processor = source = audioContext = stream = null;
      level.value = 0;
    }

    async function pttStart() {
      await startMic();
      ws.send(JSON.stringify({ type: 'ptt-start', extensionMode: document.getElementById('extension').value }));
    }

    async function pttStop() {
      ws.send(JSON.stringify({ type: 'ptt-stop' }));
      await stopMic();
    }

    async function monitorToggle() {
      await ensurePlaybackContext();
      ws.send(JSON.stringify({ type: monitor.classList.contains('active') ? 'monitor-stop' : 'monitor-start' }));
    }

    function renderReport(report) {
      const lines = [
        'RA-7203 Config Assistant',
        '',
        'Receiver IP: ' + report.receiverIp,
        'PC IP: ' + report.pcIp,
        'ED-137 installed: ' + (report.hasEd137 ? 'yes' : 'no'),
        'Standard RTP active: ' + (report.standardRtp ? 'yes' : 'no'),
        'Current RTP remote IP: ' + report.remoteIp,
        'Current RTP remote port: ' + report.remotePort,
        'Codec: ' + report.codec,
        'Interval: ' + report.interval + ' ms',
        '',
        report.verdict,
        '',
        'For audio to this PC, set Standard RTP:',
        'Remote IP: ' + report.recommendedStandardRtp.remoteIp,
        'Remote Port: ' + report.recommendedStandardRtp.remotePort
      ];
      const el = document.getElementById('report');
      el.textContent = lines.join('\\n');
      el.style.display = 'block';
    }

    ptt.addEventListener('pointerdown', async (event) => { event.preventDefault(); if (!ptt.classList.contains('active')) await pttStart(); });
    window.addEventListener('pointerup', async () => { if (ptt.classList.contains('active')) await pttStop(); });
    ptt.addEventListener('keydown', async (event) => { if (event.code === 'Space' && !ptt.classList.contains('active')) { event.preventDefault(); await pttStart(); } });
    ptt.addEventListener('keyup', async (event) => { if (event.code === 'Space' && ptt.classList.contains('active')) { event.preventDefault(); await pttStop(); } });
    monitor.addEventListener('click', monitorToggle);
    document.getElementById('refresh').addEventListener('click', () => ws?.send(JSON.stringify({ type: 'refresh' })));
    document.getElementById('config').addEventListener('click', () => ws?.send(JSON.stringify({ type: 'receiver-config' })));
    connect();
  </script>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const body = html();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
    return;
  }
  if (req.method === "GET" && req.url === "/api/status") {
    json(res, 200, { ...publicState(), network: await networkStatus() });
    return;
  }
  if (req.method === "GET" && req.url === "/api/receiver-config") {
    json(res, 200, await receiverConfigReport());
    return;
  }
  json(res, 404, { ok: false, message: "Not found" });
});

server.on("upgrade", (req, socket) => {
  if (req.url === "/ws") acceptWebSocket(req, socket);
  else socket.destroy();
});

server.listen(port, host, () => {
  console.log(`Jotron TA-7650 VCS PTT console: http://${host}:${port}`);
});

#!/usr/bin/env python3
"""
Minimal VCS-style RTP test tool for a Jotron TA-7650 static RTP setup.

It sends a G.711 A-law RTP tone toward the radio and can listen for RTP packets
coming back to the PC. This is not a full ED-137 SIP/VCS implementation; use it
to prove IP, UDP, codec, RTP sequence/timestamp, and audio path basics.
"""

from __future__ import annotations

import argparse
import math
import socket
import struct
import threading
import time
from dataclasses import dataclass


RTP_CLOCK = 8000
SAMPLES_PER_PACKET = 160  # 20 ms at 8 kHz


def linear_to_alaw(sample: int) -> int:
    """Convert signed 16-bit PCM to ITU G.711 A-law."""
    ALAW_MAX = 0xFFF
    sign = 0x80

    if sample < 0:
        sample = -sample - 1
        sign = 0x00

    sample = min(sample >> 4, ALAW_MAX)

    if sample >= 256:
        exponent = 7
        mask = 0x400
        while exponent > 0 and not (sample & mask):
            exponent -= 1
            mask >>= 1
        mantissa = (sample >> (exponent + 3)) & 0x0F
        compressed = (exponent << 4) | mantissa
    else:
        compressed = sample >> 4

    return compressed ^ (sign ^ 0x55)


def build_tone_packet(
    frequency_hz: float,
    amplitude: int,
    first_sample: int,
    sample_count: int = SAMPLES_PER_PACKET,
) -> bytes:
    payload = bytearray()
    for offset in range(sample_count):
        t = (first_sample + offset) / RTP_CLOCK
        pcm = int(amplitude * math.sin(2 * math.pi * frequency_hz * t))
        payload.append(linear_to_alaw(pcm))
    return bytes(payload)


def parse_rtp_header(data: bytes) -> dict[str, int] | None:
    if len(data) < 12:
        return None
    b0, b1, seq, timestamp, ssrc = struct.unpack("!BBHII", data[:12])
    version = b0 >> 6
    if version != 2:
        return None
    return {
        "payload_type": b1 & 0x7F,
        "marker": b1 >> 7,
        "sequence": seq,
        "timestamp": timestamp,
        "ssrc": ssrc,
        "payload_len": len(data) - 12,
    }


@dataclass
class ReceiverStats:
    packets: int = 0
    bytes: int = 0
    last_from: str = ""


def listen_rtp(bind_ip: str, bind_port: int, stop: threading.Event) -> ReceiverStats:
    stats = ReceiverStats()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((bind_ip, bind_port))
    sock.settimeout(0.5)
    print(f"listening for RTP on {bind_ip}:{bind_port}")

    while not stop.is_set():
        try:
            data, addr = sock.recvfrom(4096)
        except socket.timeout:
            continue
        stats.packets += 1
        stats.bytes += len(data)
        stats.last_from = f"{addr[0]}:{addr[1]}"
        header = parse_rtp_header(data)
        if header:
            print(
                "rx RTP "
                f"from={stats.last_from} pt={header['payload_type']} "
                f"seq={header['sequence']} ts={header['timestamp']} "
                f"payload={header['payload_len']}B"
            )
        else:
            print(f"rx UDP from={stats.last_from} bytes={len(data)} non-RTP")

    sock.close()
    return stats


def send_rtp(args: argparse.Namespace) -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    if args.source_ip or args.source_port:
        sock.bind((args.source_ip or "0.0.0.0", args.source_port))

    sequence = args.sequence & 0xFFFF
    timestamp = args.timestamp & 0xFFFFFFFF
    ssrc = args.ssrc
    packets = int((args.duration * RTP_CLOCK) / SAMPLES_PER_PACKET)
    next_send = time.perf_counter()

    print(
        f"sending RTP PCMA tone to {args.radio_ip}:{args.radio_rtp_port} "
        f"duration={args.duration:.1f}s pt={args.payload_type}"
    )

    for packet_index in range(packets):
        marker = 0x80 if packet_index == 0 else 0x00
        header = struct.pack(
            "!BBHII",
            0x80,
            marker | (args.payload_type & 0x7F),
            sequence,
            timestamp,
            ssrc,
        )
        payload = build_tone_packet(
            args.tone_hz,
            args.amplitude,
            packet_index * SAMPLES_PER_PACKET,
        )
        sock.sendto(header + payload, (args.radio_ip, args.radio_rtp_port))

        sequence = (sequence + 1) & 0xFFFF
        timestamp = (timestamp + SAMPLES_PER_PACKET) & 0xFFFFFFFF
        next_send += SAMPLES_PER_PACKET / RTP_CLOCK
        sleep_for = next_send - time.perf_counter()
        if sleep_for > 0:
            time.sleep(sleep_for)

    sock.close()
    print(f"sent {packets} RTP packets")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Send/listen RTP for TA-7650 transmission path testing."
    )
    parser.add_argument("--radio-ip", default="192.168.1.2")
    parser.add_argument("--radio-rtp-port", type=int, default=3003)
    parser.add_argument("--listen-ip", default="0.0.0.0")
    parser.add_argument("--listen-port", type=int, default=3004)
    parser.add_argument("--source-ip", default="")
    parser.add_argument("--source-port", type=int, default=0)
    parser.add_argument("--duration", type=float, default=5.0)
    parser.add_argument("--tone-hz", type=float, default=1000.0)
    parser.add_argument("--amplitude", type=int, default=9000)
    parser.add_argument("--payload-type", type=int, default=8, help="8 = PCMA/G.711 A-law")
    parser.add_argument("--sequence", type=int, default=1)
    parser.add_argument("--timestamp", type=int, default=0)
    parser.add_argument("--ssrc", type=lambda value: int(value, 0), default=0x76500001)
    parser.add_argument("--listen-only", action="store_true")
    parser.add_argument("--no-listen", action="store_true")
    args = parser.parse_args()

    stop = threading.Event()
    listener_thread = None

    if not args.no_listen:
        listener_thread = threading.Thread(
            target=listen_rtp,
            args=(args.listen_ip, args.listen_port, stop),
            daemon=True,
        )
        listener_thread.start()
        time.sleep(0.2)

    try:
        if args.listen_only:
            print("press Ctrl+C to stop")
            while True:
                time.sleep(1)
        else:
            send_rtp(args)
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("stopping")
    finally:
        stop.set()
        if listener_thread:
            listener_thread.join(timeout=1.0)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

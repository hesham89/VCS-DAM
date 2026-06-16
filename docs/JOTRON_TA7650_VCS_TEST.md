# Jotron TA-7650 VCS RTP Test

This workspace includes a minimal VCS-style RTP test tool for checking the TA-7650 transmit audio path.

## Current Test Parameters

```text
TA-7650 IP:       192.168.1.2
RTP to radio:     UDP 3003
RTP from radio:   UDP 3004
Codec:            G.711 A-law / PCMA, RTP payload type 8
Packet timing:    20 ms, 160 samples at 8 kHz
```

The radio configuration you gave uses VCS-side IPs `192.168.1.10` and `192.168.1.16`. If this PC does not have those IPs, either add them as secondary Ethernet IPs or change the Jotron RTP destination/source settings to match the PC.

## Optional IP Setup

Run PowerShell as Administrator:

```powershell
.\configure_jotron_vcs_ips.ps1
```

This adds these secondary addresses to the `Ethernet` adapter:

```text
192.168.1.10/24
192.168.1.16/24
```

## Run RTP Test

Only run this when the transmitter is connected to a suitable load/antenna setup and the test frequency is authorized.

```powershell
.\run_jotron_vcs_test.ps1
```

Direct Python command:

```powershell
python .\scripts\vcs_rtp_test.py --radio-ip 192.168.1.2 --radio-rtp-port 3003 --source-ip 192.168.1.10 --listen-ip 0.0.0.0 --listen-port 3004 --duration 5
```

## Listen Only

```powershell
python .\scripts\vcs_rtp_test.py --listen-only --listen-ip 0.0.0.0 --listen-port 3004
```

## Important ED-137 Note

This is not a complete ED-137 SIP VCS. It sends valid RTP audio packets for a static/direct RTP test. If the TA-7650 requires a SIP session, ED-137 PTT signalling, or radio gateway control before transmission, this RTP-only test will prove network/audio reachability but may not key the transmitter by itself.

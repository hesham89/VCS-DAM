# ATM VCS for Jotron VOIP Radios

Standalone ATM-style voice communication system for Jotron VOIP radios.

It has two independent web interfaces:

- Controller console: simplified air traffic controller view with four radio positions and PTT audio.
- Engineering console: monitoring, programming, and connection checks for Jotron TA/RA VOIP radios.

## Run

```powershell
cd C:\Users\hesha\OneDrive\Desktop\vcshusam
.\run_service.ps1
```

Then open:

```text
Controller:  http://127.0.0.1:3000/controller
Engineering: http://127.0.0.1:3000/admin
Recording:   http://127.0.0.1:3000/recording
```

## Ubuntu Quick Start

Copy this project folder to the Ubuntu server, then run this from inside the project folder:

```bash
sudo bash ./run_ubuntu.sh
```

The script installs Node.js 20 if needed, installs ffmpeg, copies the app to `/opt/atm-vcs`, creates `atm-vcs.service`, starts it, and prints the controller/admin URLs.

## Remote Recorder

The VCS server can keep local recording disabled and forward recording audio to a separate airport recorder server. Install the recorder on the separate Ubuntu server with:

```bash
sudo bash ./scripts/install_remote_recorder_ubuntu.sh
```

Then set `recording.enabled=true`, `recording.localEnabled=false`, and `recording.remote.host` to the recorder server IP in `radios.config.json`. Leave `recording.enabled=false` to disable all VCS recording and forwarding.

## Current Defaults

```text
Radio 1 TA-7650: 192.168.1.10 / 121.700 MHz
Radio 2 TA-7650: 192.168.1.9  / 121.300 MHz
Radio 3 TX:      192.168.1.11 / 119.100 MHz
Radio 4 TX:      192.168.1.12 / 121.500 MHz
RA-7203 RX:      192.168.1.5
PC IP:           auto-detected 192.168.1.x interface, fallback 192.168.1.15
```

TX mode defaults to automatic: SIP/ED-137 is tried first, then Standard RTP on UDP 3004 is used if SIP does not answer.
The engineering console can save radio profiles to `radios.config.json`.

## Compliance Planning

The baseline ATM VCS compliance matrix is in:

```text
docs\ATM_VCS_COMPLIANCE_MATRIX.md
```

Ubuntu server deployment notes are in:

```text
docs\UBUNTU_DEPLOYMENT.md
```

Market comparison and supporting subsystem roadmap:

```text
docs\MARKET_COMPARISON_AND_SUBSYSTEMS.md
```

Active subsystem implementation plan:

```text
docs\SUBSYSTEM_IMPLEMENTATION_PLAN.md
```

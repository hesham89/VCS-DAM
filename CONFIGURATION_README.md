# ATM VCS Configuration And Deployment README

This file documents the current VCS project configuration, network settings, router findings, and the steps to run the system on a new Ubuntu device.

## Project Files

- `atm_vcs_server.mjs`: main ATM VCS web/controller service.
- `atm_remote_recorder.mjs`: standalone UDP recording receiver for a separate airport recording server.
- `atm_local_recorder.mjs`: local Ricochet-style recording/playback server for operator-side RX/TX stream copies.
- `radios.config.json`: active radio, RTP, SNMP, recording, and application configuration.
- `run_ubuntu.sh`: ready-to-run Ubuntu installer/service setup script.
- `deploy/atm-vcs.service`: systemd service template.
- `deploy/atm-remote-recorder.service`: systemd service template for the separate recorder server.
- `deploy/atm-local-recorder.service`: systemd service template for the local recorder server.
- `scripts/install_remote_recorder_ubuntu.sh`: Ubuntu installer for the separate recorder server.
- `scripts/install_local_recorder_ubuntu.sh`: Ubuntu installer for the local recorder server.
- `scripts/setup_voip_recording_disk.sh`: prepares the `voip` VM recording disk and mounts it at `/recordings`.
- `README.md`: original project notes.
- `docs/`: implementation and deployment notes.
- `logs/`: local test logs and captured router pages.
- `recordings/`: raw PCMA recording files and recording index.

## Current Radio/VCS Network

Remote Ubuntu VCS server:

- SSH: `vcs@10.50.0.206`
- Password used during setup: `vcs`
- Radio LAN IPs on server: `5.1.1.243/24` and `5.1.1.58/24`
- Wi-Fi/LAN IP on server: `10.50.0.206/24`
- Service URL on radio LAN: `https://5.1.1.243:3443/controller`
- Health URL on radio LAN: `https://5.1.1.243:3443/api/health`
- Working LTE/private-SIM access URL: `https://10.26.54.1:3443/controller`
- Working LTE/private-SIM health URL: `https://10.26.54.1:3443/api/health`
- Service health last verified as OK with 4 enabled radios and 4 reachable radios.

Main radio LAN gateway/router:

- Radio-side Cudy LT700 LAN IP: `5.1.1.222`
- Radio-side Cudy private SIM IP: `10.26.54.1`

Local operator side:

- Local Cudy LT700 LAN IP: `192.168.20.1`
- Local Cudy private SIM IP: `10.26.54.13`
- Windows operator PC Wi-Fi IP: `192.168.20.195`

## Active Radio Configuration

The active configuration is in `radios.config.json`.

Global VCS settings:

- `localIpFallback`: `5.1.1.243`
- `mediaAdvertiseIp`: `5.1.1.243`
- `rxListenPort`: `3004`
- `snmpCommunity`: `public`
- `snmpPort`: `161`
- `snmpTrapBindIp`: `0.0.0.0`
- `snmpTrapPort`: `162`
- `codec`: `pcma`
- `ed137ExtensionMode`: `msb`
- Recording enabled on VCS server: no
- Local VCS recording enabled: no
- Remote recorder forwarding: configured in software, disabled until the recorder server IP is set
- Local recorder client: enabled for operator-side RX/TX stream duplication to `wss://10.50.0.215:8443/tx`
- Recording retention: 30 days
- Recording export: MP3 through `ffmpeg`

Configured radios:

| App | Role | ID | IP | Frequency | RTP remote | Local RTP | Control | SNMP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ATIS / TX 1 | RX | `dev2-rx` | `5.1.1.250` | `128.225` | `3003` | `3004` | `3008` | `161` |
| ATIS / TX 1 | TX | `dev1-tx` | `5.1.1.252` | `130.000` | `3003` | n/a | `3008` | `143` in config |
| Pair 2 | RX | `dev4-rx` | `5.1.1.245` | `130.000` | `3003` | `5305` | `3008` | `161` |
| Pair 2 | TX | `dev3-tx` | `5.1.1.244` | `130.000` | `3003` | n/a | `3008` | `161` |

Note: `dev1-tx` currently has `snmpPort: 143` in `radios.config.json`. If SNMP polling for that transmitter should use the normal Jotron SNMP port, change it to `161`.

## Cudy LT700 Findings

Both Cudys can reach each other on the private SIM network:

- Local Cudy `10.26.54.13` can ping radio Cudy `10.26.54.1`.
- Radio Cudy `10.26.54.1` can ping local Cudy `10.26.54.13`.

Port forwarding was configured on the radio-side Cudy:

- `10.26.54.1:3443` to `5.1.1.243:3443`
- `10.26.54.1:3444` to `5.1.1.243:3443`

Packet capture later showed that packets from the local LTE side can reach `5.1.1.243:3443`, but the Ubuntu server must have a return route back to the private SIM network through the radio-side Cudy. Without that route, the server replies through the wrong gateway (`5.1.1.1`) and the LTE URL times out.

IPSec site-to-site policies were configured but stayed down:

- Local policy: `192.168.20.0/24` to `5.1.1.0/24`, remote gateway `10.26.54.1`
- Radio policy: `5.1.1.0/24` to `192.168.20.0/24`, remote gateway `10.26.54.13`
- Pre-shared key used during testing: `Housamm1VCS2026`

WireGuard pages exist, but the radio-side server page did not expose peer management fields in this firmware, so it was not completed.

Conclusion: Cudy port forwarding can work for this private-SIM path only when the Ubuntu VCS server has the correct return route to the LTE network. The critical route is `10.26.54.0/24 via 5.1.1.222 dev eno2`.

## Persistent Ubuntu Return Route

The LTE URL stopped working when the Ubuntu return route disappeared/reset. The live fix was:

```bash
sudo ip route replace 10.26.54.0/24 via 5.1.1.222 dev eno2
sudo ip route replace 192.168.20.0/24 via 5.1.1.222 dev eno2
```

To make this persistent, a systemd oneshot service was installed on Ubuntu:

```text
/etc/systemd/system/atm-vcs-routes.service
```

Service contents:

```ini
[Unit]
Description=ATM VCS LTE return routes
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/sbin/ip route replace 10.26.54.0/24 via 5.1.1.222 dev eno2
ExecStart=/usr/sbin/ip route replace 192.168.20.0/24 via 5.1.1.222 dev eno2
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

Useful commands:

```bash
sudo systemctl status atm-vcs-routes.service
sudo systemctl restart atm-vcs-routes.service
ip route get 10.26.54.13
ip route get 192.168.20.195
```

Expected route result:

```text
10.26.54.13 via 5.1.1.222 dev eno2 src 5.1.1.243
192.168.20.195 via 5.1.1.222 dev eno2 src 5.1.1.243
```

## Windows Routes Used During Testing

The local Windows PC needed routes through the local Cudy Wi-Fi interface:

```powershell
route -p add 10.26.54.0 MASK 255.255.255.0 192.168.20.1 METRIC 1 IF 11
route -p add 5.1.1.0 MASK 255.255.255.0 192.168.20.1 METRIC 1 IF 11
```

The interface index `11` was the Wi-Fi interface on the test PC. On a new PC, run this first and use the new Wi-Fi interface index:

```powershell
Get-NetIPInterface -AddressFamily IPv4
```

## Ubuntu Installation On A New Device

1. Copy the project folder to the new Ubuntu device.

Example:

```bash
scp -r ./vcshusam vcs@NEW_SERVER_IP:~/Desktop/vcshusam
```

2. Give the Ubuntu device a radio-LAN IP matching the radio network.

The current production config expects the VCS media/control IP to be:

```text
5.1.1.243
```

If the new server uses a different radio-LAN IP, update these fields in `radios.config.json`:

- `localIpFallback`
- `mediaAdvertiseIp`
- every radio `snmpTrapIp`

3. Run the installer from the project folder:

```bash
cd ~/Desktop/vcshusam
sudo bash ./run_ubuntu.sh
```

Optional service port:

```bash
sudo PORT=3443 bash ./run_ubuntu.sh
```

4. Check the service:

```bash
sudo systemctl status atm-vcs.service
sudo journalctl -u atm-vcs.service -f
sudo tail -f /opt/atm-vcs/logs/service.out.log
```

5. Open the UI:

```text
http://SERVER_IP:PORT/controller
http://SERVER_IP:PORT/admin
http://SERVER_IP:PORT/api/health
```

If using HTTPS on port `3443`, use:

```text
https://SERVER_IP:3443/controller
https://SERVER_IP:3443/admin
https://SERVER_IP:3443/api/health
```

## Remote Airport Recording Server

Recording should run on a separate server so the VCS server does not write audio files in the live RX/TX path. The current VCS configuration has recording disabled:

```json
"recording": {
  "enabled": false,
  "localEnabled": false
}
```

To install the recorder on a different Ubuntu server at the airport:

```bash
cd ~/Desktop/vcshusam
sudo bash ./scripts/install_remote_recorder_ubuntu.sh
```

The recorder service listens on:

```text
UDP ingest: 0.0.0.0:45000
HTTP health: http://RECORDER_SERVER_IP:45080/api/health
Recordings API: http://RECORDER_SERVER_IP:45080/api/recordings
Recording folder: /opt/atm-recorder/remote-recordings
```

After the recorder server is installed and reachable from the VCS server, enable only remote forwarding on the VCS server:

```json
"recording": {
  "enabled": true,
  "localEnabled": false,
  "remote": {
    "enabled": true,
    "host": "RECORDER_SERVER_IP",
    "port": 45000,
    "protocol": "atm-vcs-recorder-udp-v1"
  }
}
```

Then restart the VCS service:

```bash
sudo systemctl restart atm-vcs.service
```

To disable all recording and all recorder forwarding on the VCS server:

```json
"recording": {
  "enabled": false,
  "localEnabled": false,
  "remote": {
    "enabled": false
  }
}
```

## Local Operator-Side Recorder

The current recording architecture keeps the Ubuntu VCS server out of recording storage and conversion work. The local `voip` VM records the streams received on the operator side:

- RX audio is duplicated by the operator browser from the VCS `rx-audio` stream to the local recorder.
- TX microphone audio is duplicated by the operator browser to the local recorder while PTT is active.
- The VCS server still performs live TX/RX only and does not write recording files.
- The local recorder also has a direct VCS WebSocket subscriber mode for future use when the `voip` VM has a route to the VCS WebSocket endpoint.

Recorder server:

```text
Host: voip
IP: 10.50.0.215
Service: atm-local-recorder.service
UI: https://10.50.0.215:8443/
Health: http://10.50.0.215:8080/api/health
Storage mount: /recordings
Recorder data: /recordings/atm-vcs
```

Proxmox storage:

```text
Proxmox host: 10.50.0.10
VM ID: 101
Added disk: scsi1, 500 GB from local-lvm
Guest device: /dev/sdb1
Mount: /recordings
Filesystem: ext4
```

VCS config block:

```json
"localRecorder": {
  "enabled": true,
  "txWebSocketUrl": "wss://10.50.0.215:8443/tx",
  "uiUrl": "https://10.50.0.215:8443/",
  "browserRxDuplicate": true
}
```

Useful commands on `voip`:

```bash
sudo systemctl status atm-local-recorder.service
sudo journalctl -u atm-local-recorder.service -f
df -hT /recordings
curl -k https://127.0.0.1:8443/api/health
```

## Manual Run Without systemd

For a quick test:

```bash
cd /path/to/vcshusam
HOST=0.0.0.0 PORT=3000 node atm_vcs_server.mjs
```

Then open:

```text
http://SERVER_IP:3000/controller
```

## Verification Checklist

On the Ubuntu VCS server:

```bash
ip -4 -br addr
ss -ltnp | grep -E ':3000|:3443'
curl -k https://5.1.1.243:3443/api/health
ping -c 3 5.1.1.244
ping -c 3 5.1.1.245
ping -c 3 5.1.1.250
ping -c 3 5.1.1.252
```

Expected health result:

- `ok: true`
- `enabledRadios: 4`
- `reachableRadios: 4`
- `activeAlarmCount: 0`

## Important Browser/Microphone Note

Browser microphone access requires HTTPS or localhost. If opening the controller from another PC, use HTTPS for microphone/PTT audio:

```text
https://SERVER_IP:3443/controller
```

If the browser shows a certificate warning, accept it for this local/private VCS server.

## Recommended Remote Access Design

The current working remote access path is:

```text
Windows PC 192.168.20.195
  -> local Cudy 192.168.20.1 / SIM 10.26.54.13
  -> radio Cudy SIM 10.26.54.1
  -> port forward TCP 3443
  -> Ubuntu VCS 5.1.1.243:3443
```

If this path becomes unstable again, the best long-term alternatives are:

1. Use a real site-to-site VPN that exposes peer/routing controls, or
2. Use a public VPS relay VPN where both VCS sides connect outward, or
3. Replace/flash the router with firmware that allows explicit firewall zone forwarding and routes.

Always verify both directions: packets must reach the VCS, and the VCS must return traffic through `5.1.1.222`.

# Ubuntu Deployment Notes

Target: two Ubuntu hardware servers, each with 8 TB audio storage.

## Initial Install

1. Install Ubuntu Server.
2. Install Node.js 20 LTS or newer.
3. Install `ffmpeg` for MP3 recording extraction.
4. Copy this project to the server.
5. From the project folder, run:

```bash
sudo apt update
sudo apt install -y ffmpeg
```

Then run:

```bash
sudo bash scripts/install_ubuntu_service.sh
```

The service will run as:

```text
atm-vcs.service
```

Default service URL:

```text
http://SERVER_IP:3000/controller
http://SERVER_IP:3000/admin
http://SERVER_IP:3000/api/health
```

## Two-Server Target

| Item | Server A | Server B |
|---|---|---|
| VCS service | Active | Standby or active |
| Audio storage | 8 TB | 8 TB |
| Recorder | Planned | Planned |
| Metadata database | Planned primary/replica | Planned replica/primary |
| Replication | Planned to Server B | Planned to Server A |

## Current Implemented Service Paths

```text
/opt/atm-vcs/logs/atm-vcs-audit.log
/opt/atm-vcs/logs/service.out.log
/opt/atm-vcs/logs/service.err.log
/opt/atm-vcs/recordings
/opt/atm-vcs/recordings/exports
```

## Next Ubuntu Work

- Add storage mount plan for the 8 TB disks.
- Add database service and replication.
- Add recorder service.
- Add backup/retention policy.
- Add firewall and TLS configuration.

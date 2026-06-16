# Supporting Subsystem Implementation Plan

Document status: Active implementation plan  
Project: ATM VCS for Jotron VoIP Radios  
Date: 2026-06-13

## Implementation Strategy

Market VCS products are not a single feature; they are a stack of subsystems. The practical path for this project is to implement the stack in layers, proving each layer before adding the next one.

## Layer Plan

| Layer | Implement First | Later Hardening |
|---|---|---|
| Voice media | RX RTP listener, activity indication, RX recording | Jitter buffer, browser playback, packet loss metrics |
| Supervision | Alarm manager, radio reachability alarms, recorder alarms | Alarm history, severity policy, acknowledge roles, SNMP/syslog export |
| Recording | TX/RX PCMA capture, MP3 extraction, retention schedule | Playback UI, export packages, tamper protection, ED-137 Vol 4 recorder interface |
| Data | JSONL metadata and config | PostgreSQL schema, replication, migrations |
| Security | Local alarm/control discipline | Login, RBAC, HTTPS/WSS, audit identity |
| Redundancy | systemd service scaffold | Active/standby, database replication, storage replication, failover tests |
| Compliance evidence | Matrix and logs | FAT/SAT scripts, packet captures, ED-137 VOTER results |

## Started In This Slice

| Subsystem | Implemented |
|---|---|
| Alarm Manager | Active alarm model, persistent alarm log, alarm API, engineering alarm display, acknowledge action |
| RX RTP Foundation | UDP RTP listener on configured `rxListenPort`, RTP parser, RX activity state, RX payload recording |
| Recording Completion | RX recordings now use the same indexed recording store as TX recordings |
| Operational Monitoring | Radio unreachable alarms, recorder MP3 encoder alarm, storage-high alarm |

## Next Slices

| Order | Slice | Goal |
|---|---|---|
| 1 | Browser RX playback | Hear receiver audio in controller console using jitter buffer |
| 2 | PostgreSQL metadata | Move recordings, alarms, config and audit to a real database |
| 3 | Authentication/RBAC | Protect engineering and recording actions |
| 4 | Alarm hardening | Alarm history, filter, clear/ack policies and export |
| 5 | ED-137 hardening | Complete radio profile and validation evidence |


# ATM VCS Market Comparison And Supporting Subsystems

Document status: Baseline market comparison  
Project: ATM VCS for Jotron VoIP Radios  
Date: 2026-06-13

## Purpose

This document compares the current project with leading ATM Voice Communication System products and identifies the supporting subsystems needed to move toward an operational, certifiable architecture.

## Leading Market Systems Reviewed

| Vendor | Product / Family | Market Position | Relevant Capabilities |
|---|---|---|---|
| Frequentis | VCS3020X / X10 | Major ATM voice communications supplier for tower, approach and ACC environments | Safety-critical air-ground and ground-ground communications, high-performance VoIP, networked ACC/tower use, duplicated/parallel operation, collaborative and virtual-center concepts |
| Rohde & Schwarz | CERTIUM VCS | Full IP ATC voice system integrated into CERTIUM portfolio | Quad-redundant IP architecture, strong security mechanisms, scalable from small towers to nationwide/multi-ACC systems, dual network connections, multiple backup mechanisms |
| SITTI | MULTIFONO M800IP | Modular ED-137 ATM VCS family | ED-137 compliance, modular/scalable architecture, no single point of failure, distributed processing, radio/telephone gateways, GPS master clocks, recording and playback system |
| Indra | Garex | IP VCS for area, approach, tower, simulator and backup systems | Migration from analogue to digital, air-ground and ground-ground integration, telephone/intercom connectivity, recorder output, tie lines and legacy interfaces |

## Current Project Baseline

| Area | Current Project State |
|---|---|
| Controller console | Graphical frequency/application windows with TX/RX panes and PTT |
| Engineering console | Radio profile management, HTTP/TCP checks, SNMP MIB-2 polling, SNMP trap listener |
| Recording console | Recording page, TX PTT PCMA payload capture, retention timestamps, scheduled cleanup, MP3 export endpoint |
| Radio interface | Partial SIP/ED-137 attempt, Standard RTP fallback for Jotron testing |
| Storage target | Two Ubuntu servers planned, each with 8 TB |
| Compliance state | Prototype/partial, not operationally certified |

## Subsystem Gap Comparison

| Subsystem | Market Systems Offer | Current Project | Required Path |
|---|---|---|---|
| Core VCS switching | Multi-position, multi-radio, multi-site voice switching with air-ground and ground-ground functions | Single Node.js service with four radio windows | Build central voice switching layer with resource routing, sector assignment, priority, conference/coupling and role control |
| ED-137 radio interface | Fully ED-137 compliant SIP/RTP radio profile | Partial SIP attempt and RTP fallback | Implement full ED-137 state machine, PTT/squelch, RTP extension, timers and VOTER test evidence |
| Controller working position | Certified CWP with ergonomic ATC controls, headset/PTT devices, alarms | Browser CWP prototype | Add device management, headset monitoring, selected/standby radios, stuck-mic warning, emergency/guard workflow |
| Engineering/maintenance | Dedicated maintenance tools, diagnostics, provisioning, alarms | Basic engineering page with SNMP/HTTP/TCP checks | Add alarm model, MIB support, configuration backup/restore, packet capture, maintenance role controls |
| Legal recording | Continuous recording and playback, ED-137 recorder interface | TX payload recording only; MP3 export requires ffmpeg | Add RX recording, ED-137 Vol 4 recorder interface, playback, export package, immutable audit and retention enforcement |
| Redundancy | Dual/quad redundancy, no single point of failure, multiple backup mechanisms | Single active service on one PC | Two-server active/standby or active/active architecture, replicated DB/config/storage and failover testing |
| Network resilience | Dual network connections, QoS, distributed operation | Basic IP operation | Add dual NIC/VLAN design, DSCP/QoS, network health, jitter/loss metrics and ED-138 performance testing |
| Security | Strong security mechanisms, role separation, protected maintenance access | No authentication/TLS yet | Add login, RBAC, HTTPS/WSS, audit, firewall rules, hardening and vulnerability scanning |
| Time sync | Integrated or external GPS/NTP/PTP timing support | Not implemented | Add NTP/PTP/GPS time health page and timestamp evidence for logs/recordings |
| Gateways | ED-137 radio/telephone gateways, legacy E1/analog/ISDN interfaces | Direct IP radio only | Add gateway abstraction for Jotron/ED-137 radios and optional legacy gateway integration |
| Telephony/intercom | SIP/ATS-QSIG/ISDN/intercom/conference functions | Not implemented | Add SIP ground-ground telephone/intercom subsystem |
| Monitoring | System-wide monitoring, alarms, supervision, fault management | Basic `/api/health`, radio checks and logs | Add metrics, dashboards, alarm history, acknowledge/clear, SNMP/syslog export |
| Deployment | Installed managed services and vendor support lifecycle | Windows/local prototype plus Ubuntu service scaffold | Build production deployment package, update/rollback, backup/restore and support runbooks |
| FAT/SAT evidence | Formal acceptance test procedures and compliance reports | Compliance matrix only | Create automated and manual FAT/SAT scripts with packet captures and signed results |

## Supporting Subsystems To Add

| Priority | Subsystem | Purpose | Build Or Integrate |
|---|---|---|---|
| Critical | ED-137 Radio Gateway | Standards-compliant radio sessions with Jotron and future radios | Build core, validate with Jotron and ED-137 tests |
| Critical | RX Audio/Jitter Buffer | Receive and hear radio audio reliably | Build |
| Critical | Recorder Service | Continuous TX/RX capture, retrieval and export | Build, use `ffmpeg`, later ED-137 recorder interface |
| Critical | Time Sync Monitor | Prove timestamp accuracy for recording/legal traceability | Integrate NTP/PTP/GPS, build monitor |
| Critical | HA/Failover Manager | Keep service available across two Ubuntu servers | Build with systemd/keepalived/PostgreSQL replication or equivalent |
| Critical | Authentication/RBAC | Separate controller, supervisor, maintainer and admin roles | Build |
| High | SNMP/MIB Supervision | Jotron alarms, status and traps | Integrate Jotron MIBs, extend current SNMP layer |
| High | Alarm Manager | Operational fault display, acknowledge and history | Build |
| High | Config Database | Versioned config, rollback and audit | Build with PostgreSQL |
| High | Storage/Retention Manager | 8 TB server storage, replication and purge policy | Build |
| High | Metrics Dashboard | Health, RTP, SIP, SNMP, storage, process and network metrics | Build or integrate Prometheus/Grafana |
| High | Packet Capture Diagnostics | Controlled captures for engineering diagnostics | Integrate `tshark`/`dumpcap` |
| Medium | Telephone/Intercom | Ground-ground calling and coordination | Build SIP subsystem or integrate PBX |
| Medium | Legacy Gateway Adapter | Analog/E1/leased-line migration if needed | Integrate hardware gateway if site requires |
| Medium | Simulator/Test Harness | FAT/SAT, training and offline validation | Build |

## Recommended Architecture Target

| Layer | Components |
|---|---|
| Controller Layer | Browser or dedicated CWP, headset/PTT devices, role/sector assignment |
| Voice Core | ED-137 radio service, RTP media engine, jitter buffer, switching/coupling, SIP telephone/intercom |
| Recording Layer | Recorder service, metadata DB, MP3/export service, retention manager, playback/retrieval UI |
| Engineering Layer | Radio provisioning, SNMP/MIB supervision, trap viewer, packet capture, config backup/restore |
| Reliability Layer | Two Ubuntu servers, service failover, replicated database, replicated recording storage |
| Security Layer | RBAC, HTTPS/WSS, firewall/VLAN isolation, audit log, hardening |
| Evidence Layer | Automated tests, packet captures, FAT/SAT reports, compliance matrix |

## Best Next Implementation Order

| Step | Work Package | Why |
|---|---|---|
| 1 | RX audio/jitter buffer | Needed for actual VCS usefulness and recording completeness |
| 2 | Recording playback/export hardening | Converts current recorder into a usable retrieval tool |
| 3 | Authentication/RBAC | Required before engineering/recording access is operationally acceptable |
| 4 | PostgreSQL metadata store | Needed for config, audit, recordings, alarms and HA |
| 5 | Alarm manager | Turns checks into operational supervision |
| 6 | ED-137 compliance hardening | Required for market-level interoperability |
| 7 | Two-server Ubuntu HA deployment | Required to close single-point-of-failure gap |

## Source Notes

- Frequentis describes VCS3020X as a safety-critical air-ground and ground-ground communications system for ACC, approach and tower, with high-performance VoIP and networked operation.
- Rohde & Schwarz describes CERTIUM VCS as a quad-redundant IP-based ATC voice system with strong security mechanisms and scaling from small towers to nationwide systems.
- SITTI describes MULTIFONO M800IP as modular, scalable, ED-137 compliant, and designed without a single point of failure; SITTI also offers ED-137 gateways, GPS clocks and recording/playback systems.
- Indra describes Garex as a fully IP-based VoIP solution for area, approach, tower, simulator and backup systems, with analogue-to-digital migration support.


# ATM VCS Compliance Matrix

Document status: Baseline draft  
Project: ATM VCS for Jotron VoIP Radios  
Target deployment: Two Ubuntu hardware servers, each with 8 TB audio storage  
Current prototype path: `C:\Users\hesha\OneDrive\Desktop\PROJECTX\VOIP`

## Purpose

This matrix tracks the requirements needed to evolve the current Jotron VoIP radio prototype into an ATM Voice Communication System suitable for operational assessment.

This document is not a certification claim. It is the working checklist for requirements, design, implementation, verification evidence, and remaining gaps.

## Reference Standards And Sources

| Ref | Source | Use In This Project |
|---|---|---|
| ICAO Annex 10 Vol II | Communication procedures including radiotelephony procedures | Operating procedures, phraseology support, radio service expectations |
| ICAO Annex 10 Vol III Part II | Voice communication systems | Core voice system requirements baseline |
| ICAO Annex 10 Vol V | Aeronautical radio frequency spectrum utilization | Frequency/channel planning and radio configuration constraints |
| ICAO Doc 9896 | Manual on ATN using Internet Protocol Suite standards and protocols | IP network architecture, security, QoS, migration to ATN/IPS |
| EUROCAE ED-137 | Interoperability Standards for VoIP ATM Components | Radio, telephone, recording, and supervision interoperability |
| EUROCAE ED-138 | Network requirements and performance for VoIP ATM | Delay, jitter, packet loss, QoS and network engineering targets |
| EUROCONTROL VoIP in ATM / VOTER | Implementation and interoperability test framework | Compliance test evidence for ED-137 interfaces |

## Deployment Assumptions

| Item | Assumption |
|---|---|
| Server OS | Ubuntu Server |
| Server count | 2 physical hardware servers |
| Storage | 8 TB per server for audio recording, retrieval, metadata and audit retention |
| Availability target | Operational design shall avoid a single point of failure |
| Radio environment | Jotron TA-7650 transmitters and RA-7203 receiver/radio units |
| Current lab radio IPs | TA-7650 at `192.168.1.10`, additional TX profile at `192.168.1.9`, RA-7203 at `192.168.1.5` |
| Current prototype | Node.js web service with controller and engineering interfaces |

## Compliance Status Legend

| Status | Meaning |
|---|---|
| Implemented | Feature exists and is ready for formal verification |
| Partial | Prototype or incomplete implementation exists |
| Planned | Required but not implemented yet |
| External | Depends on network, radio, recorder, operating system, or regulator/ANSP process |
| Unknown | Needs confirmation from equipment manual, regulator, or site design |

## Compliance Matrix

| ID | Requirement Area | Requirement | Source | Current Status | Gap | Target Implementation | Evidence Needed | Priority |
|---|---|---|---|---|---|---|---|---|
| VCS-001 | System purpose | System shall provide air-ground voice communications between controller working positions and radio resources. | ICAO Annex 10 Vol III, ED-137 Radio | Partial | Current system supports basic TX PTT only. RX and operational call handling are incomplete. | Multi-radio TX/RX voice service with controller working positions. | Functional test with all configured radios. | Critical |
| VCS-002 | Controller HMI | Controller interface shall expose only operational controls needed by ATC, not engineering internals. | ATM HMI best practice, vendor practice | Partial | Basic controller page exists, but needs sector, status, emergency and alarm indications. | Dedicated CWP with radio tiles, PTT, RX level, radio availability, emergency controls and alarms. | HMI test screenshots and controller workflow test. | High |
| VCS-003 | Engineering HMI | Separate interface shall provide monitoring, programming, diagnostics and radio connection controls. | ED-137 Supervision, operational maintenance practice | Partial | Current admin page edits profiles and checks HTTP/TCP only. | Engineering console with SNMP, SIP/RTP status, traps, TCP 3008 tools, logs, backup/restore. | Admin workflow test and config audit log. | High |
| VCS-004 | Minimum radio resources | System shall support at least 4 radios from one controller console. | User requirement | Partial | Four TX profiles exist, but only basic selection/PTT is implemented. | Four active radio positions with independent status, TX and RX paths. | 4-radio integration test. | Critical |
| VCS-005 | ED-137 radio interface | VCS shall support ED-137 compliant VoIP radio interface using SIP/RTP. | EUROCAE ED-137 Vol 1 | Partial | Prototype tries SIP and falls back to standard RTP; not a complete ED-137 state machine. | Full ED-137 SIP call setup, RTP media, PTT, squelch, radio status and session timers. | ED-137/VOTER radio test results. | Critical |
| VCS-006 | Standard RTP compatibility | System may support non-ED-137/Jotron standard RTP mode for lab or legacy operation. | Local Jotron integration need | Partial | Standard RTP TX exists. RX compatibility is incomplete. | Configurable compatibility mode per radio, clearly marked as non-certified fallback. | Jotron TA/RA lab test. | Medium |
| VCS-007 | PTT control | PTT shall provide deterministic push-to-talk operation, release handling and failure indication. | ED-137 Radio, Annex 10 voice service expectation | Partial | Web PTT exists; no stuck-mic timer, forced release or radio confirmation. | PTT state machine with timeout, lockout, forced release and TX confirmation. | PTT timing and failure-mode test. | Critical |
| VCS-008 | Squelch/COR indication | RX channels shall show receive/squelch state to the controller. | ED-137 Radio | Planned | No reliable RX squelch state exists. | Decode ED-137 squelch/status, or Jotron-specific status if available. | RX signal test with active/inactive carrier. | High |
| VCS-009 | RX audio monitoring | Controller shall hear receiver audio with controlled latency and jitter handling. | ED-137 Radio, ED-138 | Planned | Current receive monitoring is not production-ready. | RTP listener, jitter buffer, packet loss concealment and browser playback. | Audio quality and latency test. | Critical |
| VCS-010 | Audio codec | Voice shall use approved ATM VoIP codec/profile compatible with ED-137 and radios. | ED-137 Radio | Partial | Prototype uses A-law style RTP payload path but not formally validated. | Validate payload type, PCMA/PCMU profile, packetization interval and RTP clock. | Packet capture and ED-137 test. | Critical |
| VCS-011 | RTP timing | RTP packetization and timestamps shall be standards-compliant and stable. | ED-137, ED-138 | Partial | Basic 20 ms/160 sample RTP path exists. | Confirm packet timing, sequence, timestamp, SSRC behavior and recovery. | Wireshark/tshark RTP analysis. | High |
| VCS-012 | Network QoS | Voice network shall define QoS markings, latency, jitter and loss objectives. | ED-138, ICAO Doc 9896 | Planned | No QoS engineering in prototype. | DSCP/QoS policy, switch/router queueing, monitoring, SLA dashboard. | Network performance test report. | Critical |
| VCS-013 | Redundancy | Operational system shall avoid single point of failure. | ATM safety practice, vendor benchmark | Planned | Single PC/single process today. | Two Ubuntu servers in active/standby or active/active mode, redundant LAN paths. | Failover test and architecture diagram. | Critical |
| VCS-014 | Server failover | On server failure, service shall continue or recover within defined time. | ATM availability requirement | Planned | No clustering or failover. | HA service manager, replicated config, shared status, failover watchdog. | Pull-power/failover test. | Critical |
| VCS-015 | Storage redundancy | Audio recordings shall be protected against single disk/server loss. | Legal recording practice | Planned | No recorder storage. | RAID/ZFS per server plus replication between 8 TB servers. | Storage failure and restore test. | Critical |
| VCS-016 | Legal recording | All operational TX/RX audio shall be recorded with timestamps and metadata. | ICAO Annex 10 Vol II 3.5.1.5, ED-137 Vol 4 Recording, ATM legal recording practice | Partial | TX PTT sessions are indexed and recorded as PCMA payload files with JSONL metadata; RX recording, tamper controls, playback conversion, ED-137 recorder interface and formal retention evidence are not complete. | Continuous multichannel recorder, WAV/FLAC or compliant container, metadata database. | Recording playback and integrity test. | Critical |
| VCS-017 | Audio retrieval | Authorized users shall retrieve recorded audio by time, radio, controller and event. | User requirement, recording practice | Partial | Recording page, recent index search and MP3 extraction endpoint exist; authorization, advanced filters, browser playback and investigation package are not complete. | Search UI, playback, export, retention controls and audit trail. | Retrieval workflow test. | Critical |
| VCS-018 | Time synchronization | Servers, recordings and logs shall use synchronized time. | ICAO Doc 9896, recording/legal traceability | Planned | No time sync design. | NTP/PTP/GPS source, time health monitoring, timestamp precision definition. | Time offset monitoring evidence. | Critical |
| VCS-019 | Audit logging | System shall log operator actions, admin changes and service events. | Security and operational assurance | Partial | Persistent service/PTT/config log exists, but user identity and old/new config diffs are not implemented yet. | Persistent audit log with user, time, action, old/new values. | Audit log inspection test. | High |
| VCS-020 | Authentication | Admin and controller access shall be authenticated. | Security practice, ICAO Doc 9896 security guidance | Planned | No login. | User accounts, roles, password policy or external identity integration. | Access-control test. | Critical |
| VCS-021 | Authorization | Controller, supervisor, maintainer and admin roles shall have separated privileges. | Security and operational practice | Planned | No role separation. | RBAC with least privilege, protected engineering functions. | Role matrix and access test. | Critical |
| VCS-022 | Encryption | Management interfaces shall use secure transport. | ICAO Doc 9896 security guidance | Planned | HTTP/WebSocket only. | HTTPS/WSS, certificate management, optional VPN/segmentation. | TLS scan and certificate record. | High |
| VCS-023 | Network isolation | VCS/radio network shall be isolated from public/general IT networks. | ATM security practice | External | Site network design unknown. | VLANs/subnets/firewall rules for controller, radio, admin, storage and management. | Network diagram and firewall config. | Critical |
| VCS-024 | SNMP supervision | System shall poll radio status and receive traps. | ED-137 Supervision, Jotron support | Partial | Generic SNMPv2c MIB-2 polling and UDP trap listener exist; Jotron MIB mapping, SNMPv3, and successful device response evidence are not complete. | SNMP v2/v3 polling, trap receiver, alarm mapping, MIB support. | SNMP walk/trap test. | High |
| VCS-025 | Radio TCP control | System shall monitor and optionally use Jotron TCP control port 3008 where supported. | Jotron integration | Partial | TCP 3008 open check exists only. | Controlled command set after vendor documentation confirmation. | Safe command test and rollback procedure. | Medium |
| VCS-026 | Configuration management | Radio/system configuration shall be versioned, backed up and restorable. | Operational maintenance practice | Partial | JSON config only. | Config database, export/import, checksum, rollback, approval flow. | Backup/restore test. | High |
| VCS-027 | Alarm management | System shall generate clear alarms for radio, server, network, storage and recording failures. | ATM supervision practice | Planned | No alarm model. | Alarm severity, acknowledge, clear, history, SNMP/syslog/email integration. | Alarm scenario test. | High |
| VCS-028 | Health monitoring | System shall expose service health for process, RTP, SIP, storage and network. | Operational maintenance practice | Partial | `/api/health`, `/api/status`, and radio check status exist, but metrics dashboards and storage/SIP/RTP deep checks are not complete. | Health endpoints, metrics, dashboards, watchdog probes. | Monitoring dashboard and alert test. | High |
| VCS-029 | Emergency radio handling | Emergency/guard frequency support shall be clearly available and protected. | Annex 10 radio service expectation, local ops | Partial | Emergency profile exists but disabled by default. | Guard channel tile, protected config, priority alarm/selection rules. | Emergency frequency workflow test. | High |
| VCS-030 | Sector/role operation | System shall support controller roles and radio assignment per sector. | ATM VCS vendor benchmark | Planned | No sectors or operator roles. | Sector config, role login, radio group assignment, supervisor override. | Sector handover test. | High |
| VCS-031 | Coupling/cross-coupling | System shall support frequency coupling where operationally required. | ATM VCS vendor benchmark | Planned | Not implemented. | Controlled cross-coupling between selected radios with loop prevention. | Coupling audio test. | Medium |
| VCS-032 | Intercom/telephone | Operational VCS often includes ground-ground telephony/intercom. | ED-137 Telephone, vendor benchmark | Planned | Not implemented. | SIP telephone/intercom module, extension directory, priority calls. | Telephone/intercom test. | Medium |
| VCS-033 | Replay and incident export | System shall support secure export of recorded audio for investigation. | Recording/legal practice | Planned | Not implemented. | Export package with audio, metadata, checksum and audit record. | Export verification test. | High |
| VCS-034 | Data retention | Retention period shall be configurable according to regulator/ANSP policy and storage capacity. | Legal/ANSP requirement | Partial | Configurable retention period and scheduled cleanup exist; final retention duration, protected deletion workflow, storage forecasting and regulator approval are not complete. | Retention policy engine for 8 TB per server, storage forecast and purge protection. | Retention calculation and purge test. | High |
| VCS-035 | Backup | Config, metadata and recordings shall be backed up according to criticality. | Operational continuity | Planned | No backup. | Local snapshots plus remote replication/backup plan. | Restore drill. | High |
| VCS-036 | Cyber hardening | Ubuntu servers shall be hardened for operational deployment. | ICAO Doc 9896 security guidance, OS security practice | Planned | Deployment not yet built. | Minimal packages, firewall, SSH hardening, updates, service user, auditd. | Hardening checklist and vulnerability scan. | High |
| VCS-037 | Service installation | System shall install as managed services on Ubuntu. | Deployment requirement | Planned | Current project runs manually on Windows. | systemd units for VCS, recorder, monitor, web UI, log rotation. | Reboot/startup test. | High |
| VCS-038 | Database | System shall persist config, users, metadata, alarms and audit logs. | Operational system requirement | Planned | JSON/in-memory only. | PostgreSQL or equivalent replicated database. | DB migration and recovery test. | High |
| VCS-039 | Performance capacity | System shall define supported concurrent radios, users and recordings. | ED-138, vendor benchmark | Unknown | No sizing test. | Capacity plan for initial 4+ radios and expansion. | Load test report. | Medium |
| VCS-040 | Browser audio permissions | Controller audio shall recover safely from browser/device permission failures. | HMI reliability | Partial | Browser mic permission can fail with limited recovery. | Device selection, permission checks, headset monitoring, failure alarms. | Headset/mic failure test. | High |
| VCS-041 | Watchdog/stuck mic | System shall detect stuck microphone/PTT and enforce limits. | ATC safety practice | Partial | Automatic maximum PTT duration release exists; warning UI and formal test evidence are not complete. | Configurable maximum TX duration, warning, forced release. | Stuck PTT test. | Critical |
| VCS-042 | Radio unavailability | Controller shall see unavailable/failed radios clearly. | ATC HMI practice | Partial | Live HTTP/TCP 3008 availability is shown in controller/admin; ED-137/SNMP radio-state validation is not complete. | Live radio state and degraded-mode indication. | Radio disconnect test. | High |
| VCS-043 | Logging persistence | Runtime logs shall survive process restart. | Operational support | Planned | Logs are in memory only. | File/database logging with rotation and retention. | Restart log continuity test. | Medium |
| VCS-044 | Packet capture diagnostics | Engineering interface shall support controlled diagnostics without disrupting service. | Maintenance practice | Planned | Not implemented. | tshark/dumpcap capture jobs with ring buffers and access controls. | Diagnostic capture test. | Medium |
| VCS-045 | Vendor radio documentation | Jotron-specific management and VoIP capabilities shall be confirmed against official manuals/MIBs. | Jotron integration | Unknown | Manuals/MIBs not included in project. | Import Jotron MIBs/manuals and map exact OIDs/commands. | Document traceability table. | Critical |
| VCS-046 | Acceptance testing | System shall have formal factory/site acceptance procedures. | ATM procurement practice | Planned | No FAT/SAT scripts. | FAT/SAT checklist, test tools, pass/fail records. | Signed test reports. | Critical |
| VCS-047 | ED-137 test evidence | System shall pass relevant ED-137 radio, recording and supervision interoperability tests. | EUROCONTROL VOTER / ED-137 | Planned | Not tested. | Run VOTER or equivalent ED-137 test suite. | Test suite report. | Critical |
| VCS-048 | Documentation | System shall include admin, operator, maintenance and recovery documentation. | Operational deployment practice | Partial | Basic README only. | Full manuals and runbooks. | Documentation review. | High |
| VCS-049 | Change control | Operational changes shall be controlled and traceable. | Safety/security governance | Planned | No change control workflow. | Versioned releases, migration scripts, rollback plans. | Release record and rollback test. | High |
| VCS-050 | Regulatory approval | Final operational use shall be approved by the relevant aviation authority/ANSP. | ICAO/state implementation practice | External | Authority and process not specified. | Build compliance package for local regulator/ANSP. | Approval records. | Critical |

## Initial Server Architecture Target

| Component | Server A | Server B |
|---|---|---|
| Controller web UI | Active | Standby or active |
| Engineering web UI | Active | Standby or active |
| SIP/RTP media service | Active primary | Hot standby or active secondary |
| Recorder service | Active recording | Replicated recording |
| Audio storage | 8 TB local storage | 8 TB local storage |
| Metadata database | Primary or replicated | Replica or peer |
| Monitoring | Active | Active |
| Backup role | Replicates to B | Replicates to A |

## Recommended Phase Plan

| Phase | Deliverable | Main Requirements |
|---|---|---|
| Phase 1 | Stabilize lab VCS | VCS-004, VCS-007, VCS-009, VCS-024, VCS-042 |
| Phase 2 | ED-137 radio compliance | VCS-005, VCS-008, VCS-010, VCS-011, VCS-047 |
| Phase 3 | Ubuntu HA deployment | VCS-013, VCS-014, VCS-036, VCS-037, VCS-038 |
| Phase 4 | Recording and retrieval | VCS-016, VCS-017, VCS-018, VCS-033, VCS-034 |
| Phase 5 | Security and operations | VCS-020, VCS-021, VCS-022, VCS-023, VCS-049 |
| Phase 6 | FAT/SAT and approval package | VCS-046, VCS-048, VCS-050 |

## Implementation Progress

| Date | Slice | Requirements Advanced | Notes |
|---|---|---|---|
| 2026-06-13 | Monitoring and safety foundation | VCS-019, VCS-028, VCS-041, VCS-042 | Added persistent audit log under `logs/atm-vcs-audit.log`, `/api/health`, `/api/radios/check`, live advisory radio availability, and automatic PTT watchdog release. Connection checks are cross-platform for Ubuntu readiness and do not send dummy RTP packets to radios. |
| 2026-06-13 | SNMP supervision foundation | VCS-003, VCS-024, VCS-028, VCS-042 | Added generic SNMPv2c polling for MIB-2 `sysDescr`, `sysObjectID`, and `sysUpTime`; added `/api/snmp/check`, `/api/snmp/traps`, an engineering SNMP panel, and UDP trap listener on configurable port `SNMP_TRAP_PORT` defaulting to `3013`. Current lab radios timed out on UDP 161, so device SNMP response remains unproven. |
| 2026-06-13 | Recording system foundation | VCS-016, VCS-017, VCS-018, VCS-033, VCS-034 | Added third `/recording` system page linked from Engineering, recording status APIs, recording index search, storage/retention status, and TX PTT payload capture to local PCMA files with JSONL metadata. This is a foundation only: full ICAO/ED-137 recording compliance still requires RX capture, authenticated retrieval, immutable audit, retention enforcement, playback/export, replicated 8 TB Ubuntu storage, time sync evidence and ED-137 Volume 4 recorder interface validation. |
| 2026-06-13 | Scheduled retention and MP3 extraction | VCS-017, VCS-033, VCS-034 | Added daily scheduled retention enforcement, retained-until timestamps per PTT session, and MP3 export endpoint using `ffmpeg`. MP3 filenames are generated as `frequency_start-time_PTT.mp3`. Ubuntu deployment notes now require `ffmpeg`. |
| 2026-06-13 | Alarm manager and RX RTP foundation | VCS-009, VCS-016, VCS-027, VCS-028, VCS-042 | Added active alarm model with persistent alarm log, alarm APIs and Engineering display/acknowledge action. Added RX RTP listener on `rxListenPort`, RTP parser, RX activity indication and RX payload recording into the recording store. Browser RX playback and jitter-buffer audio output remain next steps. |

## Path To Compliance

| Step | Target | Requirements Closed Or Advanced | Acceptance Evidence |
|---|---|---|---|
| 1 | Stabilize radio TX/RX core | VCS-001, VCS-004, VCS-007, VCS-009, VCS-010, VCS-011 | Packet captures, 4-radio TX/RX test, audio latency and quality report |
| 2 | Complete ED-137 radio interface | VCS-005, VCS-008, VCS-047 | EUROCONTROL VOTER or equivalent ED-137 radio test report |
| 3 | Complete legal recording subsystem | VCS-016, VCS-017, VCS-018, VCS-033, VCS-034 | Continuous TX/RX recording test, retrieval/export test, retention calculation, timestamp sync report |
| 4 | Deploy on two Ubuntu servers | VCS-013, VCS-014, VCS-015, VCS-035, VCS-036, VCS-037, VCS-038 | HA failover test, storage failure test, service reboot test, backup/restore drill |
| 5 | Add security and operational controls | VCS-020, VCS-021, VCS-022, VCS-023, VCS-026, VCS-049 | RBAC test, TLS scan, firewall/network diagram, change-control records |
| 6 | Final FAT/SAT and regulatory package | VCS-046, VCS-048, VCS-050 | Signed FAT/SAT, manuals, compliance traceability, local authority/ANSP acceptance |

## Open Inputs Needed

| Input | Needed From |
|---|---|
| Local aviation regulator/ANSP acceptance requirements | User/client |
| Required recording retention period | User/client/regulator |
| Exact number of controller positions | User/client |
| Exact number of radios/frequencies now and future expansion | User/client |
| Jotron TA-7650 and RA-7203 manuals/MIB files | User/vendor |
| ED-137 version required by customer/regulator | User/client |
| Network design, VLANs and IP ranges | User/network team |
| Ubuntu server hardware specification | User/server supplier |

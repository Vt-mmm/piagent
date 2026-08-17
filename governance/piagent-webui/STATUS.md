---
plan_id: piagent-webui
document: status
status: active
canonical_plan: 10-master-plan.md
last_updated: 2026-08-15
---

# Piagent WebUI status

## Current state

| Field | Value |
|---|---|
| Direction | Approved for implementation |
| Current milestone | `WEBUI-5 Session Hub` |
| Current work item | `WUI5-18` independent ship gate |
| Active writer | `/root` |
| Implementation status | `complete` |
| First shippable milestone | `WEBUI-1` |
| Control default | Off |
| Remote access | Out of scope |

Plan creation does not count as product implementation evidence.

## Milestone tracker

| Milestone | State | Estimate | Depends on | Exit summary |
|---|---|---:|---|---|
| `WEBUI-0` Contract | `complete` | 15–22 engineer-days | Existing runtime contracts | Schemas, exact projections, evidence stores, threat model, bridge proof |
| `WEBUI-1` Read-only WebUI | `complete` | 20–28 engineer-days | `WEBUI-0` | Local dashboard/diff/activity; zero model turns; failure isolation |
| `WEBUI-2` Chat & Control | `complete` | 28–42 engineer-days | `WEBUI-1`, bridge proof | Exact-session chat, approval and durable controls |
| `WEBUI-3` Review Actions | `complete` | 18–28 engineer-days | `WEBUI-2` | Digest-bound review/stage/revert; no auto-commit |
| `WEBUI-4` Long-task Dashboard | `complete` | 15–22 engineer-days | `WEBUI-2`, durable history | Task/timeline/handoff/subagent/benchmark projections |
| `WEBUI-5` Session Hub | `complete` | 48–72 engineer-days | `WEBUI-0`–`WEBUI-4`, Pi SDK 0.84.1 | Gateway lifecycle, durable session catalog/runtime, conversation-first shell |

Base estimate: 96–142 engineer-days. Planning budget with integration
contingency: 110–160 engineer-days after the WUI0-11 host-gap rebaseline.

## WEBUI-0 work items

| ID | State | Objective | Depends on |
|---|---|---|---|
| `WUI0-01` | `complete` | Freeze product invariants, terminology and control semantics | — |
| `WUI0-02` | `complete` | Define versioned snapshot/event/source/diff/control/approval schemas | `WUI0-01` |
| `WUI0-03` | `complete` | Implement safe porcelain-v2 Git collector and three projections | `WUI0-02` |
| `WUI0-04` | `complete` | Add bounded Task Baseline Manifest and content refs | `WUI0-02` |
| `WUI0-05` | `complete` | Persist mutation provenance evidence | `WUI0-02` |
| `WUI0-06` | `complete` | Add verifier per-file snapshot and stale-file calculation | `WUI0-02` |
| `WUI0-07` | `complete` | Build criteria/file/verifier projection and Inspector v2 | `WUI0-03`–`WUI0-06` |
| `WUI0-08` | `complete` | Define runtime events, cursor/replay and resync behavior | `WUI0-02` |
| `WUI0-09` | `complete` | Complete local WebUI threat model | `WUI0-01`, `WUI0-02` |
| `WUI0-10` | `complete` | Build zero-model-turn conformance harness | `WUI0-07`, `WUI0-08` |
| `WUI0-11` | `complete` | Prove same-process/current-session bridge | `WUI0-01`, `WUI0-08` |
| `WUI0-12` | `complete` | Run WEBUI-0 independent gate audit | `WUI0-03`–`WUI0-11` |

## WEBUI-1 work items

| ID | State | Objective | Depends on |
|---|---|---|---|
| `WUI1-01` | `complete` | Scaffold private WebUI package, build and distribution boundary | `WUI0-12` |
| `WUI1-02` | `complete` | Implement loopback server, bootstrap auth and read-only routes | `WUI1-01`, `WUI0-09` |
| `WUI1-03` | `complete` | Serve snapshots and SSE with cursor/resync | `WUI1-02`, `WUI0-08` |
| `WUI1-04` | `complete` | Build task/session header and criteria dashboard | `WUI1-03` |
| `WUI1-05` | `complete` | Build Task/Working Tree/Staged file views | `WUI1-03`, `WUI0-07` |
| `WUI1-06` | `complete` | Build bounded inline/split/accessible diff viewer | `WUI1-05` |
| `WUI1-07` | `complete` | Build activity timeline and log previews | `WUI1-03` |
| `WUI1-08` | `complete` | Build verifier, usage, continuation and handoff panels | `WUI1-03` |
| `WUI1-09` | `complete` | Complete responsive and accessibility behavior | `WUI1-04`–`WUI1-08` |
| `WUI1-10` | `complete` | Pass security, fault-injection and performance suites | `WUI1-02`–`WUI1-09` |
| `WUI1-11` | `complete` | Run WEBUI-1 independent ship gate | `WUI1-10` |

## WEBUI-2 work items

| ID | State | Objective | Depends on |
|---|---|---|---|
| `WUI2-01` | `complete` | Productionize same-session Pi bridge | `WUI1-11`, `WUI0-11` |
| `WUI2-02` | `complete` | Stream bounded transcript, assistant and tool events | `WUI2-01` |
| `WUI2-03` | `complete` | Implement composer, follow-up queue and interrupt semantics | `WUI2-02` |
| `WUI2-04` | `complete` | Implement model/thinking selection at valid lifecycle points | `WUI2-01` |
| `WUI2-05` | `complete` | Implement bounded file/image attachments | `WUI2-01`, `WUI1-10` |
| `WUI2-06` | `complete` | Implement approval broker and terminal/WebUI race handling | `WUI2-01`, `WUI0-09` |
| `WUI2-07` | `complete` | Add journal-backed stop/pause/resume state contract | `WUI2-01` |
| `WUI2-08` | `complete` | Build control and approval UX | `WUI2-03`, `WUI2-06`, `WUI2-07` |
| `WUI2-09` | `complete` | Prove idempotency, reconnect and exact-session identity | `WUI2-02`–`WUI2-08` |
| `WUI2-10` | `complete` | Run WEBUI-2 independent gate | `WUI2-09` |

## WEBUI-3 work items

| ID | State | Objective | Depends on |
|---|---|---|---|
| `WUI3-01` | `complete` | Add digest-bound reviewed/unreviewed state | `WUI2-10` |
| `WUI3-02` | `complete` | Implement guarded stage/unstage by file | `WUI3-01` |
| `WUI3-03` | `complete` | Implement hunk preimage and patch-CAS engine | `WUI3-01` |
| `WUI3-04` | `complete` | Implement previewed reject/revert with confirmation | `WUI3-03` |
| `WUI3-05` | `complete` | Implement Open in VS Code handoff | `WUI2-10` |
| `WUI3-06` | `complete` | Add explicit deterministic/model commit summary paths | `WUI3-02` |
| `WUI3-07` | `complete` | Audit every mutation and invalidate verifier/review state | `WUI3-02`–`WUI3-06` |
| `WUI3-08` | `complete` | Run WEBUI-3 independent gate | `WUI3-07` |

## WEBUI-4 work items

| ID | State | Objective | Depends on |
|---|---|---|---|
| `WUI4-01` | `complete` | Build local task/run index from authoritative state | `WUI2-10` |
| `WUI4-02` | `complete` | Project crash/resume/pause/checkpoint timeline | `WUI4-01` |
| `WUI4-03` | `complete` | Project compaction and recovery history | `WUI4-01` |
| `WUI4-04` | `complete` | Project handoff history and next-action state | `WUI4-01` |
| `WUI4-05` | `complete` | Project subagent tree, ownership and stale results | `WUI4-01` |
| `WUI4-06` | `complete` | Add local benchmark/release monitoring views | `WUI4-01` |
| `WUI4-07` | `complete` | Pass retention, corrupt-history and scale tests | `WUI4-02`–`WUI4-06` |
| `WUI4-08` | `complete` | Run WEBUI-4 independent gate | `WUI4-07` |

## WEBUI-5 work items

| ID | State | Objective | Depends on |
|---|---|---|---|
| `WUI5-01` | `complete` | Freeze Session Hub product, ownership and persistence contract | `WUI4-08` |
| `WUI5-02` | `complete` | Define Gateway protocol, catalog and capability schemas | `WUI5-01` |
| `WUI5-03` | `complete` | Prove real Pi SDK create/resume/fork with policy extensions | `WUI5-01` |
| `WUI5-04` | `complete` | Extend threat model for leases, handoff and crash ambiguity | `WUI5-02`, `WUI5-03` |
| `WUI5-05` | `complete` | Build one-per-profile Gateway process and dashboard CLI | `WUI5-04` |
| `WUI5-06` | `complete` | Build bounded durable session catalog and metadata overlay | `WUI5-05` |
| `WUI5-07` | `complete` | Add authenticated typed WS transport and replay/resync | `WUI5-05`, `WUI5-06` |
| `WUI5-08` | `complete` | Implement create/open/resume runtimes with owner leases | `WUI5-07` |
| `WUI5-09` | `complete` | Implement idempotent send/stream/abort/model/thinking/permission | `WUI5-08` |
| `WUI5-10` | `complete` | Add rename/pin/archive/fork and terminal adapter handoff | `WUI5-09` |
| `WUI5-11` | `complete` | Build conversation-first MUI sidebar, compact New chat, multi-folder import, session controls, MCP actions and Pi provider OAuth | `WUI5-06` |
| `WUI5-12` | `complete` | Build main transcript/composer/tool/approval experience | `WUI5-09`, `WUI5-11` |
| `WUI5-13` | `complete` | Move Task/Source/Activity/Verifier into Agent Inspector drawer | `WUI5-11` |
| `WUI5-14` | `complete` | Complete VI/EN, light/dark, responsive and accessibility | `WUI5-11`–`WUI5-13` |
| `WUI5-15` | `complete` | Pass crash/restart, stale-lease and uncertain-command recovery | `WUI5-08`–`WUI5-10` |
| `WUI5-16` | `complete` | Add dashboard doctor/explicit repair; keep OS service install optional and deferred | `WUI5-05`, `WUI5-15` |
| `WUI5-17` | `complete` | Enforce shared terminal/Gateway ownership through the terminal compatibility adapter | `WUI5-10` |
| `WUI5-18` | `complete` | Run independent security/performance/browser ship gate | `WUI5-14`–`WUI5-17` |

## Active work-item handoff

```text
Work item: WUI5-18 independent Session Hub ship gate
State: complete
Owner/session: /root
Baseline tree/status: WEBUI-0 through WEBUI-4 accepted; WEBUI-5 candidate completed 2026-08-15
Expected changes: local Gateway Session Hub, durable session controls, conversation UI, Agent Inspector and recovery
Out of scope: remote access, multi-user, full editor, auto-commit/push and utility-model dashboard calls
Verification commands: npm run verify; npm run docs:check; npm run docs:neutrality; npm run release:identity
Verified: 2,350 Node tests, 11 real Chromium scenarios, root/WebUI typecheck, architecture, package/integrity, language, neutrality and dependency-audit gates
Model-turn audit: plan, catalog and dashboard read paths must remain zero-turn
Schema/migration: additive WUI5 family; existing 22 browser contracts remain supported during compatibility period
Security/performance: lease/owner identity, idempotency, bounded pages and hostile-browser inputs are mandatory schema axes
Rollback: omit WUI5 Gateway registration; retain accepted current-session WebUI
Known limitation: optional operating-system service installation is deferred; terminal sessions remain terminal-owned and use the compatibility adapter; remote and multi-user access remain out of scope
Blocker: none
Next exact action: publish the verified document-workspace and session-activity release as v1.5.0; the accepted WUI5-18 candidate remains the v1.4.0 baseline
```

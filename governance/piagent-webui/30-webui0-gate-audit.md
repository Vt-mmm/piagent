---
plan_id: piagent-webui
work_item: WUI0-12
document: webui0-gate-audit
status: accepted
evidence: webui0-gate-evidence.v1.json
audit_date: 2026-08-13
---

# WEBUI-0 gate audit

## Verdict

Independent gate verdict: **ACCEPTED**. Open P0: 0. Open P1: 0.

The independent read-only review found four protected-content read gaps through
successive adversarial read-backs. The implementation session applied bounded
remediations and current focused gates pass. The independent reviewer reproduced
the staged and committed protected/internal cases on the final tree and accepted
the closure without modifying the repository.

The machine-readable matrix is
[`webui0-gate-evidence.v1.json`](webui0-gate-evidence.v1.json). It maps every
WEBUI-0 deliverable, required fixture and exit gate to persisted implementation
and focused tests.

## Audit method

The gate was evaluated against the master plan rather than work-item status
text. The audit checked:

1. all WUI0-01…WUI0-11 ADRs are accepted;
2. every deliverable has production/schema evidence and a focused test;
3. every required Git/baseline/race fixture is present;
4. every exit criterion has executable evidence;
5. all public capabilities remain inspect-only;
6. full WebUI, type, architecture, docs, capability, package and offline repo
   gates pass on the same working tree;
7. unbuilt WEBUI-1/2 claims are not counted as WEBUI-0 evidence.

## Finding closed during audit

`WUI0-AUDIT-P1-001`: the initial bridge proof inspected the pinned host API and
source but deliberately did not dispatch a message. That did not satisfy the
master-plan exit text requiring a test message in the exact running Pi
process/session.

The fix adds one controlled, provider-free pinned-host E2E. It creates exactly
one Pi `AgentSession`, loads the extension bridge into that process, dispatches a
marker through `ExtensionAPI.sendUserMessage`, and proves:

- extension `input` observes `source=extension` and the expected session ID;
- the same marker reaches the scripted provider context;
- the host emits the user `message_start` and `agent_settled` events;
- the session manager identity remains unchanged.

This is a test fixture, not a production second-runtime fallback.

## Independent finding remediated; awaiting read-back

`WUI0-AUDIT-P1-002`: `task-source-projection.ts` applies protected state stored
in the task-start manifest but ignores the current `isProtectedPath` policy when
projecting or rereading task content. An independently reproduced task view
published content digests and exact stats for a protected post-baseline file;
the task diff then returned its literal content. Required remediation:

- check the current path and every historical/rename path before reading bytes;
- expose no protected base/current digest or exact line statistics;
- make task diff return a typed protected/unavailable document without hunks;
- add a regression for a protected file introduced after baseline;
- rerun the full gate and obtain independent acceptance on the changed tree.

The remediation removes the unscoped whole-tree content snapshot from task
projection discovery/revision, applies effective protection to current and
old/rename paths before reading current, baseline or Git blob bytes, publishes
null digests and unavailable stats for protected files, and prevents task
content lookup from returning protected bytes. For a dirty baseline that becomes
protected later, exact comparison is impossible without reading protected
content, so the whole task view fails closed. New regressions cover a
post-baseline protected file, rename history and dirty-baseline overlap.

`WUI0-AUDIT-P1-003`: independent read observation then proved that the shared
Working Tree/Staged collector still called its untracked content helper after
classifying the path protected; task diff recollection repeated that read. The
second remediation now:

- skips untracked inspection before any protected workspace read;
- builds a pure Git content-inspection plan that excludes protected current and
  old/rename paths before numstat or blob-digest commands;
- makes canonical working-tree snapshot hashing policy-aware, representing
  protected entries with unavailable metadata carriers rather than content;
- observes the protected inode during full three-view/task-diff recollection and
  canonical snapshot construction and requires zero reads.

`WUI0-AUDIT-P1-004`: a third read-back found that a rename whose historical path
was protected could still be hashed through its apparently public current name.
The final bounded remediation now:

- evaluates a rename record as one protection unit for workspace revision
  hashing, Git inspection and canonical working-tree evidence;
- propagates protection in both directions, so either the old or new name
  protects both carriers before content access;
- treats a rename out of `.pi/piagent-state` as internal on both sides and keeps
  its paths and object IDs out of the Git inspection plan;
- observes the current inode under old-only and new-only policies through source
  collection, task diff recollection and canonical snapshot construction, and
  requires zero reads.

`WUI0-AUDIT-P1-005`: the next read-back proved that Task Changes maintained a
separate path union from the shared Git plan. A clean tracked internal-state file
renamed to a public-looking name was excluded from the shared plan, but Task
Changes rediscovered both names from baseline/current trees and task diff read
the current bytes. The remediation now:

- excludes internal baseline entries before they enter the task path map;
- reads bounded `--name-status -z --find-renames` evidence against the immutable
  task-start tree, so alias identity survives a later commit and clean status;
- evaluates current-status and baseline-tree aliases as one graph when selecting
  Task Changes paths and calculating its workspace revision;
- suppresses the complete alias component from recorded/current tree unions when
  any member is internal state;
- propagates old-only or new-only protected policy across staged and committed
  rename aliases before current, baseline or diff content lookup;
- repeats the record-level visibility check at task content lookup and rejects a
  file reference absent from the canonical task view;
- observes the renamed inode for staged and committed internal/protected renames
  through source projection and task content/diff lookup, requiring zero reads
  and no raw path, digest, stats or hunk exposure.

All four independent findings passed final read-back on the same verified tree.

## Exit-gate readback

| Gate | Verdict | Evidence summary |
|---|---|---|
| Exact task patch/unavailable | Pass | Dirty-baseline task patch, restore/delete, protected/corrupt/expired unavailable |
| Provenance truth | Pass | Only model-authorship transaction yields exact runtime-observed-agent; overlap remains mixed/unattributed |
| Baseline non-mutation | Pass | Git status/index/object count unchanged; concurrent capture not published |
| Snapshot equality | Pass | Inspector v2 formats the same canonical projection; deep equality asserted |
| Security fail-closed | Pass | Protected/symlink/corrupt/event/path/schema invariants and frozen threat contract |
| Zero model turns | Pass | Quiescent and causal-concurrent harness; unknown attribution fails |
| Same-session message | Pass | Controlled pinned Pi host E2E described above |
| No second runtime | Pass | Production module has no child-process/RPC/SDK/session-owner path; capabilities off |
| Rollback | Pass | Terminal Inspector operates without WebUI; public handshake is inspect-only |

## Scope discipline

No loopback server, SSE route, browser bundle, Chat UI, lifecycle control,
approval broker or review action is claimed. Their security/performance/failure
gates remain owned by WEBUI-1 through WEBUI-3.

Pi `0.84.1` proves same-session Chat feasibility, not complete control. Stop is
partial; Pause/Resume/approval remain unavailable. The WEBUI-2 estimate was
rebaselined accordingly.

## Verification summary

- WebUI current-tree implementation suite excluding audit assertions: 105/105;
- protected task-source remediation: 10/10;
- protected source/diff/snapshot regression set: 29/29;
- full repository suite: 2124/2124;
- bridge message E2E: 1/1;
- bridge/schema/zero-turn/package focused gate: 34/34;
- typecheck, architecture, docs and capability gates: pass;
- `npm run verify -- --offline`: exit 0, scaffold PASS on 2026-08-13.

- final `npm run verify -- --offline`: exit 0 and scaffold PASS after adding the
  audit artifact, message E2E and protected-path remediation.

## Independent review result

The independent reviewer recorded `accepted` with P0=0 and P1=0 after rerunning
the committed/staged internal and one-sided protected rename reproductions,
strict Git parser review, focused 39/39 verification and status-digest read-back.
WEBUI-0 is complete and WUI1-01 may start.

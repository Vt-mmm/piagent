---
plan_id: piagent-webui
work_item: WUI0-01
document: product-control-decision
status: accepted
decision_date: 2026-08-13
host_baseline: "@earendil-works/pi-coding-agent 0.84.1"
---

# WUI0-01 — Product and control contract

## 1. Decision

Piagent WebUI là một local operator surface của **đúng Pi runtime và Pi session
đang hoạt động**. Nó không sở hữu conversation, không chạy agent riêng và không
tạo state machine cạnh tranh với Task Contract hoặc task journal.

Quyết định này khóa năm contract cho toàn bộ `WEBUI-0` đến `WEBUI-4`:

1. thuật ngữ và identity;
2. source-of-truth ownership;
3. capability boundaries;
4. exact Stop/Pause/Resume semantics;
5. zero-model-turn conformance.

Đây là product contract, chưa phải bằng chứng control đã được implement. Khả năng
attach vào current process/session vẫn phải pass `WUI0-11`; durable controls phải
được implement và test ở `WUI2-07` đến `WUI2-09`.

## 2. Evidence hiện tại và gap đã biết

Quyết định dựa trên runtime contract hiện có:

- Task Contract v2 bind `taskRunId` với `sessionId` và giữ terminal outcome tại
  [`docs/task-implementation-contract.md`](../../../docs/task-implementation-contract.md).
- Task journal là owner-only, append-only, hash-chained và sequence-numbered;
  Task Contract vẫn được đọc trước journal khi resume, theo
  [`docs/en/architecture.md`](../../../docs/en/architecture.md) và
  [`task-journal.js`](../../../packages/piagent-core/extensions/task-journal.js).
- Resume hiện kiểm tra task/session identity, journal, authority, trajectory,
  handoff, working-tree digest và verifier evidence tại
  [`resume-state.ts`](../../../packages/piagent-core/runtime/recovery/resume-state.ts).
- Pi host `0.84.1` hiện expose extension events, read-only `sessionManager`,
  `ctx.isIdle()`, `ctx.abort()`, `ctx.hasPendingMessages()`, `pi.sendUserMessage()`,
  `pi.setModel()` và `pi.setThinkingLevel()`.

Các gap sau là blocking evidence, không được che bằng UI:

- Task Contract work-plan status chỉ có `pending`, `in-progress`, `done`,
  `skipped`, `failed`; `paused` không phải task outcome hoặc work-plan status.
- Journal replay có thể nhận một checkpoint status `paused`, nhưng chưa có
  versioned control record, control revision hoặc exact pause/resume transition.
  Một open Task Contract step còn được ưu tiên trước journal checkpoint khi
  recovery decision được dựng.
- Session-start hiện activate task tool groups cho mọi resume state
  `enforcementSafe`, kể cả recovery decision `paused`; input/tool guards chưa
  enforce một pause barrier. Live status cũng chiếu mọi pending + safe task thành
  `active`.
- Completion audit hiện map terminal outcome `partial` sang checkpoint text
  `paused`. Đây là historical completion label, không phải operational Pause và
  không được reuse cho WebUI control.
- Pi extension `ctx.abort()` là fire-and-forget tại extension boundary. Trong TUI
  hiện tại, nó clear steering/follow-up về terminal editor rồi gọi raw agent
  abort; nó không trả settlement promise và không chứng minh cancel mọi
  retry/compaction/branch-summary/direct-bash phase. Underlying `AgentSession` có
  API phong phú hơn nhưng không được cấp cho loaded extension.
- Approval hiện chờ trực tiếp trong `ctx.ui.confirm`; chưa có durable broker để
  Pause cancel/deny một pending approval hoặc để terminal và WebUI race bằng CAS.
- Chưa có durable `runtimeInstanceId`, `agentOperationId` hoặc control idempotency
  receipt trong product schema.

Do đó WebUI có thể ship read-only khi các read-only gates pass, nhưng không được
advertise `control` chỉ dựa trên các API rời rạc nói trên.

### 2.1 Current-host capability verdict

| Surface on Pi `0.84.1` | Current same-process evidence | Product verdict before `WUI0-11` |
|---|---|---|
| Session identity/transcript | Extension context + read-only session manager | Feasible |
| Assistant/tool streaming | Message, turn and tool lifecycle hooks | Feasible with bridge-owned sequence/snapshot |
| Chat/steer/follow-up/image | `sendUserMessage`, `sendMessage` | Feasible; void acceptance needs observed acknowledgement/idempotency |
| Model/thinking | Catalog/current/set + selection events | Feasible with lifecycle/effect-scope gate |
| Context usage | Current context usage | Feasible; total billed stats need existing Piagent evidence, not invention |
| Structured Piagent approval | Tool-call block + Piagent-owned broker required | Not implemented |
| Universal Stop | No public awaited stop-all/phase snapshot | Unavailable until proved per phase |
| Semantic Pause/Resume | No Pi host primitive | Requires Piagent durable cooperative gate |
| Attach existing TUI through SDK/RPC | SDK/RPC creates or owns another runtime | Forbidden fallback |

## 3. Canonical terminology

| Term | Exact meaning | Không được dùng thay cho |
|---|---|---|
| Project | Canonical repository/workspace root Pi đang trust và guard đang govern | Browser current directory |
| Pi runtime instance | Một lifetime của Pi process đang giữ extension và session owner; có opaque `runtimeInstanceId` mới mỗi launch | Pi installation hoặc sidecar process |
| Pi session | Conversation/session do Pi sở hữu, định danh bằng raw `sessionId` ở trusted runtime và opaque ref ở browser | HTTP session, browser tab hoặc task |
| Task | Logical work identified by `taskId` | Một model turn |
| Task attempt | Một Task Contract v2 identified by unique `taskRunId` và bound vào một `sessionId` | Retry trong cùng low-level run |
| Agent operation | Khoảng Pi không idle cho một accepted human/system dispatch, gồm các model/tool turns, retry và compaction cho đến `agent_settled` | Một provider request, tool call hoặc terminal task outcome |
| Turn | Một model response và các tool call của response đó; một operation có thể có nhiều turn | User message, provider request hoặc toàn bộ task |
| Provider request | Một invocation cụ thể tới model provider; một operation có thể tạo nhiều request qua tool loop/retry | User dispatch hoặc turn |
| Tool call | Một invocation có stable `toolCallId` và observed lifecycle | Command text không được runtime observe |
| Task control state | Durable non-terminal barrier state `active`, `pause-requested` hoặc `paused` | Task outcome `partial` hoặc work-plan status |
| Runtime liveness | Live fact như `idle`, `running`, `stopping`, `settled`, `unknown` | Connection state hoặc persisted proof rằng task complete |
| Projection | Deterministic, rebuildable view từ authoritative facts | Source of truth hoặc model summary |
| Sidecar | Failure-isolated local collector/server; không sở hữu Pi session hay task state | Pi runtime hoặc approval executor |
| Browser client | Authenticated local presentation client | Trusted filesystem principal |
| Control intent | Typed request gửi tới same-process bridge để runtime revalidate | Direct browser command execution |
| Approval intent | One-time allow/deny answer cho exact active guard request | Quyền chạy action khác hoặc future action |
| Revision | Opaque compare-and-swap token của authoritative snapshot/control head | Browser timestamp hoặc array index |

`session`, `task`, `turn`, `operation` và `tool call` không được dùng lẫn nhau
trong schema, log, route hoặc UI copy.

## 4. Identity contract

### 4.1 Minimum binding

Mỗi snapshot/event phải bind đủ identity phù hợp với loại fact:

```text
projectRef
runtimeInstanceId
sessionRef
taskId | null
taskRunId | null
agentOperationId | null
toolCallId | null
revision
```

- Trusted runtime giữ raw `sessionId`; browser chỉ nhận opaque `sessionRef` trừ
  khi một explicit diagnostic contract cho phép detail đã redact.
- `taskRunId` phải map về Task Contract có cùng raw `sessionId`.
- `agentOperationId` mới cho mỗi accepted dispatch; retry/auto-compaction thuộc
  cùng operation cho tới authoritative settlement.
- `toolCallId` chỉ có ý nghĩa bên trong đúng runtime/session/agent operation.
- `revision` phải thay đổi khi authoritative control head hoặc identity thay đổi.
- Current session ownership phải có một runtime lease/epoch bound vào canonical
  session file plus raw `sessionId`; một process khác không được attach làm writer
  khi lease hiện tại còn live.

### 4.2 Side-effect request binding

Mọi request `control`, `approve` hoặc `reviewActions` phải có:

- capability scope;
- exact identity tuple cần cho action;
- `expectedRevision`;
- one-time `idempotencyKey`;
- exact action payload/digest;
- expiry khi action có pending authority;
- audited result.

Server compare-and-swap trên authoritative current state. Identity mismatch,
unknown required field, stale revision hoặc replay phải trả typed rejection và
không gọi Pi/model/tool/Git mutation.

Browser reconnect không được reuse authority của runtime instance cũ.

Revision không phải một browser counter chung. Snapshot giữ ít nhất các thành
phần độc lập `runtimeRevision`, `taskRevision`, `controlRevision`,
`workspaceRevision`, `indexRevision` và `approvalRevision` khi domain đó tồn tại.
Mỗi action nêu rõ precondition revision nào áp dụng:

- lifecycle control: runtime + task + control;
- approval: runtime + task + approval + exact action digest;
- source review action: task + workspace/index + patch preimage;
- active Pi setting: runtime + session-option revision.

Dedup receipt được runtime/journal giữ, không chỉ sidecar RAM. Cùng key + cùng
canonical payload trả receipt cũ; cùng key + payload khác bị reject. Validation và
append receipt phải atomic dưới authoritative lock.

## 5. Source-of-truth ownership

| Fact | Sole authority | Valid derived readers |
|---|---|---|
| Session transcript, active model/thinking, live idle/stream state | Current Pi runtime/session manager | Bridge snapshot/event projection |
| Task identity, scope, criteria, plan, terminal outcome | Task Contract v2 | Inspector/WebUI task projection |
| Durable control state, checkpoints, continuation reservation | Verified task journal joined to current Task Contract | Resume/control projection |
| Current repository/index/worktree state | Git plus current filesystem under fixed project roots | Safe Git collector and diff projection |
| Task-start content/digests | Immutable Task Baseline Manifest introduced by `WUI0-04` | Task Changes/diff projection |
| Tool, mutation, verifier and usage evidence | Runtime-observed bounded ledgers/snapshots | Activity/verifier/usage projection |
| Approval decision | Current Pi guard request/promise and exact-action receipt | Approval card/status projection |
| Accepted held-message queue | Current Pi runtime/bridge plus owner-only bounded queue record | Queue projection; browser drafts remain non-authoritative |
| Staged attachment bytes | Owner-only bounded extension temp store bound to runtime/session/message/expiry | Safe metadata projection; bytes enter Pi only on explicit Send |
| UI layout, filters, selected file, collapsed hunk | Browser-local presentation state | Browser only; never prompt input |

Conflict resolution is fail-closed for authority:

1. Terminal Task Contract outcome wins over non-terminal journal/UI state.
2. Journal control facts are usable only when chain, task and session binding
   validate against the current Task Contract.
3. Live Pi liveness wins over a cached `running` or `idle` presentation value.
4. Current Git/filesystem facts win over cached source snapshots; historical
   baselines remain immutable reference facts.
5. Missing proof becomes `unknown` or `unavailable`; model prose and browser cache
   are never fallback evidence.

No component may persist a second authoritative transcript, Task Contract,
approval store or control state. Rebuildable caches must carry input digests and
version.

## 6. Capability boundaries

| Capability | Allowed | Forbidden |
|---|---|---|
| `inspect` | Read bounded snapshots, source views/diffs, activity, verifier, usage, context, handoff | Provider call, user message, prompt mutation, repo mutation, approval resolution |
| `control.chat` | Send explicit chat and hold/dispatch the runtime-owned queue | Hidden send, generic prompt injection or browser-owned transcript |
| `control.lifecycle` | Pi-native Stop and journal-backed Pause/Resume | Shell endpoint, OS signal pause, second Pi process, direct task/source mutation |
| `control.sessionOptions` | Lifecycle-valid model/thinking selection with exact effect scope | Prompt-only override or silent persistent-default mutation |
| `attachments` | Stage bounded file/image content for an explicit `control.chat` dispatch | Model turn on upload, archive execution or arbitrary root read |
| `approve` | Resolve one exact active Pi guard request with allow/deny through first-valid CAS | Execute action, broaden scope, edit then reuse digest, standing blanket approval |
| `reviewActions` | Guard-mediated review mark, stage/unstage and previewed digest-bound patch/revert in `WEBUI-3` | Auto-stage, auto-commit/push, unconfirmed discard/revert, arbitrary path write |

The `control` product group is negotiated through the sub-capabilities above;
none implies another. Attachment upload alone must not create a model turn.
`WEBUI-1` exposes only `inspect`. Unknown capability version disables all
authority capabilities; compatible read-only inspection may degrade explicitly.

Browser never executes tool, shell, Git mutation or approval target itself. It
sends typed intent; Pi guard remains the executor/decision boundary.

## 7. Orthogonal state machines

### 7.1 Task outcome

Existing Task Contract outcome remains:

```text
pending -> completed | blocked | partial | failed
```

Terminal outcome is immutable. Stop, pause and resume do not change it. A paused
task therefore remains `pending`.

### 7.2 Task control state

Durable control state is separate:

```text
active -> pause-requested -> paused -> active
   ^             |            |
   +-------------+------------+
        cancel/resume
```

- `active`: no pause barrier.
- `pause-requested`: barrier is durable, but the active atomic unit has not yet
  reached a proved safe point.
- `paused`: journal proves the barrier is active and no new agent/model/tool
  mutation may start.
- `pausing` is a UI projection of `pause-requested`, not a fourth durable state.
- A terminal Task Contract makes the control projection terminal; it does not
  rewrite terminal outcome to `paused`.

### 7.3 Runtime liveness

Runtime liveness is ephemeral and independent:

```text
idle | running | stopping | settled | unknown
```

Wire contracts keep at least these axes independent:

```text
connectionState   connected | disconnected | unknown
operationState    idle | running | stopping | settled | unknown
controlState      active | pause-requested | paused | terminal | unknown
taskOutcome       pending | completed | blocked | partial | failed
verificationState not-run | running | current | stale | failed | unavailable
approvalState     none | waiting | resolved | expired | unknown
```

`waiting-approval`, `verifying`, `verification-stale`, `recovering`,
`blocker-present` and similar UI attention labels are projections over these
axes. `blocker-present` on a pending task is distinct from terminal Task Contract
outcome `blocked`.

## 8. Safe point

A pause may become `paused` only when the same-process bridge proves all relevant
conditions:

- the active tool call/atomic filesystem action has ended;
- no provider request, automatic retry or compaction retry is in flight;
- no Pi-accepted continuation can auto-dispatch past the barrier;
- every pending approval for the task was resolved as cancelled/denied by the
  runtime barrier or otherwise proved unable to start work;
- current runtime/session/task identity still matches;
- the durable pause event was appended and read back from a valid journal head.

An `agent_settled` event with `ctx.isIdle() === true` is the preferred host signal,
but is not sufficient if pending Pi messages can still dispatch. `WUI0-11` must
prove that Pi-native steering/follow-up queues are cleared, returned to a
non-dispatching surface or quarantined behind the barrier. If the host cannot
prove a safe point, state stays
`pause-requested` or becomes `unknown`; it must not be presented as `paused`.

Pause never uses `SIGSTOP`, `SIGKILL` or process suspension and never interrupts a
filesystem mutation halfway merely to make UI status change quickly.

## 9. Exact control transitions

### 9.1 Stop

**Meaning:** abort only the current Pi agent operation using Pi-native abort.

Preconditions:

- `control.lifecycle` capability negotiated;
- exact current runtime/session/agent-operation binding;
- matching `expectedRevision` and unused `idempotencyKey`;

Task journal/Task Contract integrity is not required to perform an emergency
session-scoped abort: Stop is risk-reducing. When task binding or journal is
unsafe, runtime may stop the exactly bound current operation but returns an
`emergency-stop`/`audit-unavailable` receipt and must not claim a durable task
transition.

Transition:

1. CAS/persist `task-control.stop-requested` against the current operation when
   task journal is valid; otherwise emit only a best-effort emergency audit fact.
2. Close the dispatch gate and clear/return/quarantine Pi-native pending messages.
3. Invoke the same-process Pi-native abort once.
4. Wait for authoritative settlement/idle acknowledgement.
5. Refresh current-tree and stale-verifier projection.
6. Record `task-control.stop-settled` or a typed failed/unknown result.

Postconditions:

- Task Contract stays `pending` unless an independent terminal gate changes it.
- Stop does not create a pause barrier.
- Runtime-owned held messages stay held and are not silently dispatched.
- Pi-native pending messages cannot run after the action is reported stopped.
- Success is not reported merely because the abort function returned void.
- Repeating the same key returns the original receipt and never aborts a newer
  operation.

If already idle, Stop returns typed `already-idle` with zero authoritative change.
If control state is `pause-requested`, successful stop may let the safe-point
observer finish the transition to `paused`.

Stop capability is phase-specific. If current host cannot abort and observe
settlement for the active retry, compaction, branch-summary, direct-bash or other
phase, bridge returns `unsupported-operation-phase` and must not show “Stopped”.
Adding an awaited `stopAll()`/phase-aware host adapter is preferred over guessing
from a timeout.

### 9.2 Pause

**Meaning:** install a durable cooperative barrier after the current atomic unit;
do not terminate the task and do not create a model turn.

Preconditions:

- active non-terminal Task Contract bound to current session;
- `control.lifecycle` capability and exact current identity/revision;
- writable valid journal for a confirmed durable pause.

Pause is risk-reducing, so an unsafe authority/recovery state does not itself
forbid closing the live input/tool gate. If journal is corrupt/unwritable, runtime
may emergency-stop the exactly bound operation, but returns `pause-unconfirmed`
and never presents durable `paused`.

Transition:

1. CAS `active -> pause-requested` and persist `task-control.pause-requested`
   before claiming it.
2. Refuse new WebUI chat dispatch, continuation, model call and every new task
   tool start.
3. Cancel/deny a pending exact approval with reason `task-pausing`; clear, return
   or quarantine every Pi-native queued message behind the barrier.
4. Allow already-started atomic tool calls to settle, block any not-yet-started
   tool call, then Pi-native abort the remainder of the current operation. When no
   tool is active, abort provider streaming/retry immediately.
5. Flush observed evidence and refresh current-tree/verifier state.
6. At a proved safe point, append/read back `task-control.paused` and advance
   revision.

If Pi is already at a proved safe point, the transition may complete immediately.
Duplicate key returns the same receipt. A second distinct pause while
`pause-requested`/`paused` returns typed `already-pausing`/`already-paused`.
Journal failure rejects the transition; browser state alone cannot hold pause.
An already-persisted `pause-requested` remains a fail-closed task gate across
restart even when settlement is not yet proved; UI then shows
`recovery-required`, not a false `paused` acknowledgement.

### 9.3 Resume

**Meaning:** validate durable state and remove the pause barrier only. The machine
action is `control.resume`; it is distinct from Pi session resume/recovery. Resume
does not send a message, dispatch queued work or invoke a provider.

Validation before `paused -> active`:

- runtime/session/task identity and expected revision;
- Task Contract is still `pending`;
- journal chain and pause epoch are valid;
- authority snapshot is compatible/pinned;
- current tree uses proof-capable digest evidence and is classified safely;
- recovery/handoff/trajectory state does not require operator review.

A changed tree does not automatically mean identity failure. It must be
reclassified; affected verifier evidence becomes stale and the next safe action
may be exact re-verification. Unsafe/unavailable evidence blocks resume.

CAS/persist `task-control.resume-requested` before validation. On failure append
`task-control.resume-rejected` and keep the barrier. On success append/read back
`task-control.resumed`, advance revision and allow future dispatch. Existing
Runtime-owned queue remains held until an explicit dispatch action.
If already active, return typed `already-active` without mutation.

Resume from `pause-requested` means cancel the not-yet-applied barrier with a
durable `task-control.pause-cancelled` transition; it does not restart or add
work. Every delayed pause side effect carries the pause epoch/control revision
and must recheck it immediately before abort, approval cancellation and `paused`
append. Resume keeps dispatch closed until the pause worker acknowledges
cancellation and proves no delayed side effect remains. A stale worker becomes a
no-op and cannot abort a newer operation or overwrite `active` with `paused`.

### 9.4 Resume & continue

**Meaning:** resume, then dispatch exactly one explicit operator-authored message
and start one agent operation in the same Pi session. That operation may contain
multiple turns/provider requests through its normal tool loop.

- It is a distinct action and UI label from Resume.
- It creates exactly one user message/accepted agent operation after successful
  resume; it does not promise one provider request.
- One command ID/idempotency key covers `continue-requested`, prepare, resume and
  observed `continue-dispatched` receipt.
- Retry never creates a second message after a proved dispatch.
- If a crash makes dispatch acknowledgement ambiguous, state becomes
  `dispatch-unknown`; automatic replay is forbidden until reconciled against the
  Pi session leaf/message identity.
- Failure after resume but before dispatch leaves the task active and reports
  `resumed-not-dispatched`; it never claims the model continued.

This human-requested operation is not a CAP-12/CAP-13 automatic continuation budget
reservation. Automatic recovery/review continuations keep their existing bounded
budget and journal evidence.

### 9.5 Model/thinking selection

Selection changes the active Pi runtime setting, not prompt text. It is allowed
only at lifecycle points exposed by the negotiated bridge contract, initially
idle and pre-fresh-task. It creates zero provider requests. A mid-operation
request is rejected; it is never queued as a hidden future switch.

Pi `0.84.1` extension `setModel` can also persist the user default. Therefore
`control.sessionOptions` must advertise effect scope (`session` or
`session-and-user-default`). Session-only control remains unavailable unless the
host proves it. A broader effect requires explicit disclosure/confirmation and
must never be described as session-only.

### 9.6 Minimum durable control facts

`WUI0-02`/`WUI0-08` sẽ khóa payload schema và replay, nhưng semantics tối thiểu
không được mất:

```text
task-control.stop-requested
task-control.stop-settled
task-control.pause-requested
task-control.paused
task-control.pause-cancelled
task-control.resume-requested
task-control.resumed
task-control.resume-rejected
task-control.continue-requested
task-control.continue-dispatched
task-control.continue-uncertain
```

Mỗi normal fact task-scoped bind task/session/runtime epoch, command/idempotency key,
expected control revision, request/parent sequence, result reason và relevant
pre/post tree digest. Requested fact không được chiếu thành settled state. Same-key
dedup và expected-revision CAS phải chạy dưới journal writer lock. Emergency Stop
khi task journal unsafe chỉ có session/operation-scoped best-effort audit và không
được replay như durable task-control fact.

## 10. Control race rules

- Runtime is the only transition writer; browser button disabled state is advice.
- Every accepted transition increments an opaque control revision.
- State validation and append must happen under one journal/CAS lock; a read then
  separate append is not a valid transition implementation.
- First valid CAS wins; losers receive current snapshot and typed stale result.
- Stop after an accepted pause request targets only the bound current operation;
  settlement may complete pause.
- A terminal Task Contract observed during any transition wins and prevents new
  dispatch.
- Approval, Pause and tool-start use one runtime execution arbiter/linearization
  point. Approval resolution grants only a provisional exact-action permit; tool
  execution must atomically consume it while rechecking current control revision.
  If tool-start wins, it is an in-flight atomic action allowed to settle before
  pause. If `pause-requested` wins, broker cancels/denies the permit and every
  later browser/terminal decision or delayed tool start is stale. Approval never
  implicitly resumes a task.
- Sidecar/browser disconnect never changes durable control state.
- Browser disconnect never manufactures approval allow/deny. The Pi guard owns
  the request; only a runtime-native expiry may record `expired` and apply its
  documented default-deny behavior.
- Terminal remains the fallback authority surface when WebUI control is disabled.

## 11. Restart and reconnect semantics

### Browser or sidecar restart

- Rebuild from an authoritative snapshot plus event cursor.
- Never restore `running`, `paused`, approval or queue authority from browser
  storage alone.
- Pending WebUI authority token/nonce is invalidated as its security contract
  requires; durable task pause remains in the journal.
- Browser-local composer drafts are presentation state and have no delivery
  receipt. Runtime-acknowledged held messages are rebuilt from the runtime-owned
  bounded queue record and survive browser/sidecar reconnect without dispatch.

### Pi runtime restart

- New process gets a new `runtimeInstanceId`.
- Prior stop requests are historical; they are not replayed against a new
  operation.
- `paused` may be restored only after task/session/journal/authority/tree checks.
- `pause-requested` may become `paused` only when durable evidence proves the old
  operation settled before restart. Otherwise projection is `unknown` or
  `recovery-required`; its task gate stays closed and mutation/control stays
  disabled except exact recovery and emergency Stop.
- Any ambiguous resume-and-dispatch receipt requires session reconciliation; no
  blind resend.
- Rehydrated held messages remain `revalidation-required` and never auto-dispatch
  after runtime restart. If the negotiated capability declares only
  `runtime-lifetime` queue persistence, lost items must not be presented as
  acknowledged or recoverable.
- Every approval is bound to its creating `runtimeInstanceId`. Pi runtime death
  makes a waiting old-runtime approval terminal `cancelled`/`expired` with reason
  `runtime-restarted` on next integrity-safe audit. It cannot be restored,
  resolved or consumed by the new runtime, even if task/tool text matches.

Reconnect and restart themselves create zero provider turns.

### Pi session switch/reload in the same process

- Bridge closes its dispatch gate synchronously in
  `session_before_switch`/`session_before_fork` before allowing replacement. For
  reload/quit paths without that pre-event, it closes the gate at the beginning
  of its `session_shutdown` handler.
- The pre-event creates `replacement-pending`; it is not evidence teardown will
  happen. Because another handler may cancel or validation may fail before
  `session_shutdown`, the host/bridge adapter must expose a replacement result
  callback for `committed | cancelled | failed`. `cancelled`/`failed` rebind and
  revalidate the unchanged session before reopening dispatch. Without such a
  callback, control remains `resync-required/unavailable`; it must not stay
  silently wedged or reopen from a timer/browser guess.
- `session_shutdown` is a teardown notification, not proof the old context is
  already invalid. The handler may still read the outgoing session to flush
  bounded evidence, but it must reject new authority work. Host invalidates the
  old context only after the handler returns.
- `session_start` atomically binds the current session manager and issues new
  session/control revisions.
- Captured extension context/session-manager objects from before replacement are
  stale and must never be reused.
- Old session refs, event cursors, command receipts and pending browser authority
  require resync; no command is forwarded across the switch.

## 12. Zero-model-turn contract

### 12.1 View-zero-turn

The following actions must create **zero provider requests attributable to the UI
action and zero authoritative runtime mutation caused by it**:

- open, close, refresh or reconnect WebUI;
- switch tabs, select file, expand/collapse diff or log;
- read snapshot, Task Contract, source views, activity, verifier, usage, context,
  continuation, handoff or capability state;
- client-side search/filter/sort and reviewed presentation before review actions
  are introduced.

For the same captured fact bundle, Inspector JSON and WebUI snapshot must
canonical-deep-equal on their shared projection fields after excluding declared
transport metadata such as `generatedAt`, cursor delivery and HTTP cache fields.

### 12.2 Control-zero-turn

Stop, Pause, Resume and lifecycle-valid model/thinking selection may change
control/session state, but must still create, by causal attribution:

- zero provider request;
- zero new user or assistant transcript message;
- zero token/cost delta attributable to a model;
- zero automatic continuation reservation/consumption;
- zero prompt or provider-visible tool-schema change caused by UI presentation.

Allowed authoritative mutations are action-specific and exhaustive:

| Action | Allowed non-model mutations |
|---|---|
| Stop | Operation state/receipt; Pi-native pending queue clear/return/quarantine; observed evidence flush; current-tree and verifier-stale projection caused by settlement |
| Pause | Control journal/revision; pending approval cancel/deny; runtime queue hold/quarantine; operation abort/settlement; observed evidence flush; current-tree/verifier-stale projection |
| Resume | Control journal/revision and deterministic resume/tree/verifier projection recomputation; no queue dispatch |
| Model/thinking | Exact active setting plus selection event and only the negotiated/disclosed persistence scope |

Any other Task Contract, transcript, prompt, tool-schema, source/index or external
mutation fails the zero-turn contract. Stop may also finish an already in-flight
atomic action; its observed result is attributed to that prior operation, not a
new action started by Stop.

`Resume & continue` and `Send chat` are explicitly not zero-turn; each accepted
command creates exactly one user message/agent operation, which may contain
multiple turns/provider requests. Uploading or editing a held queue item creates
zero operations until explicit dispatch.

### 12.3 Conformance observation

A zero-turn test uses a command/correlation ID and captures before/after:

```text
provider request count
Pi session id and leaf/message ids
user and assistant message counts
session token/cost totals
continuation journal count
Task Contract digest
task-journal head (view paths only)
provider-visible tool-schema digest
```

Pass rules:

- no provider request, message, token/cost or continuation is attributable to the
  UI command;
- quiescent tests additionally require global provider/message/token/
  continuation counts to remain unchanged;
- concurrent tests allow unrelated active-operation counters to settle, but must
  prove absence of the UI correlation/causal path;
- view paths also keep Task Contract and journal head unchanged;
- control-zero-turn paths may change only the action-specific allowlist in
  section 12.2;
- no `user-message`, `before_agent_start` or equivalent turn-trigger event occurs;
- layout/filter/selection data is absent from all provider input.

Stop may cause usage from an already-running request to settle; that usage is not
a new request caused by Stop. Unknown attribution/measurement is a test failure
for a claimed zero-turn route, not inferred success.

## 13. Required downstream contracts

### `WUI0-02`

Schemas must represent:

- identity tuple and opaque revision;
- domain revision components and action-specific preconditions;
- orthogonal task outcome, control state and runtime liveness;
- typed control command/result/error with idempotency receipt;
- capability version/reason when unavailable;
- `unknown`, `unavailable`, `disconnected` and `resync-required` honestly.

### `WUI0-08`

Event contract must define request/accepted/settled facts, cursor/replay,
deduplication and snapshot resync. It must not treat a requested transition as a
completed transition.

### `WUI0-11`

Same-process bridge proof must demonstrate:

- exact runtime/session identity;
- current operation-phase snapshot and per-phase Stop capability;
- awaited or otherwise proved abort settlement;
- no auto-dispatch past Stop or pause barrier, including Pi-native pending
  steering/follow-up, approval, retry and compaction;
- an extension/public-host primitive for queue clear/quarantine and settlement,
  or a documented host change that supplies it;
- one-message dispatch idempotency and crash ambiguity handling;
- observed acknowledgement after void `sendUserMessage()` rather than treating
  invocation as accepted/completed;
- current model/thinking catalog and lifecycle checks;
- session-replacement commit/cancel/failure acknowledgement so a pre-closed gate
  safely reopens only after unchanged-session revalidation;
- failure isolation when bridge or sidecar disappears.

If any proof fails, advertise `control: unavailable` with a reason and keep
`WEBUI-2` blocked. Spawning `pi --session`, using generic RPC against a second Pi
process or OS process suspension is not an allowed fallback.

### `WUI2-07` to `WUI2-09`

Implementation must persist journal-backed control state, project it into the
WebUI, exercise all races/restarts, and prove exact current-session behavior.
Required races include Resume cancelling an in-flight pause worker before a new
dispatch, Pause versus approval versus tool-start in both orderings, and Pi
runtime restart while approval is waiting.

## 14. Rejected alternatives

| Alternative | Decision |
|---|---|
| Use Task Contract outcome `partial` as pause | Rejected: `partial` is terminal and immutable |
| Add `paused` to work-plan step only | Rejected: step status cannot govern whole-session dispatch or survive every lifecycle race |
| Browser/sidecar owns pause flag | Rejected: restart creates a second authority and stale state |
| Spawn Pi RPC/session process for WebUI | Rejected: second writer/current-session identity risk |
| Pause with `SIGSTOP` or kill current command | Rejected: can interrupt atomic mutation and strand locks/state |
| Treat `ctx.abort()` invocation as stopped acknowledgement | Rejected: request is not settlement proof |
| Resume automatically sends “continue” | Rejected: Resume is zero-turn; continuation needs explicit agent-operation action |
| Retry ambiguous message dispatch | Rejected: can duplicate a paid/actionable agent operation |
| Infer missing state from assistant prose | Rejected: prose is a claim, not operational evidence |

## 15. Acceptance of this decision

`WUI0-01` is complete when:

- this record is linked by the control-plane index and master plan;
- terminology, ownership, capabilities, transitions, restart rules and zero-turn
  observations are internally consistent with current repository contracts;
- local documentation links, docs gate and architecture gate pass;
- known Pi host gaps remain explicit gates for `WUI0-11`, not implementation
  claims.

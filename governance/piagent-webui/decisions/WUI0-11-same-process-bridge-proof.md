---
plan_id: piagent-webui
work_item: WUI0-11
document: same-process-current-session-bridge-proof
status: accepted
decision_date: 2026-08-13
host_version: 0.84.1
---

# WUI0-11 — Same-process/current-session bridge proof

## 1. Verdict

Pi Coding Agent `0.84.1` can support same-process Chat, current-session identity,
assistant/tool streaming, provider-request observation, model/thinking selection
and content-array dispatch through the loaded extension runtime. It cannot yet
support the full Piagent lifecycle/approval contract.

Therefore:

- `WEBUI-1` remains inspect-only;
- same-session Chat feasibility is proved for `WEBUI-2` productionization;
- no second CLI/RPC/SDK runtime is permitted as fallback;
- Stop stays partial and is not advertised;
- Pause, Resume, Resume & continue and browser approval remain unavailable;
- public `capabilities-v1` stays `inspect-only` until WUI2 implements, binds and
  verifies each supported action.

## 2. Exact host surface reviewed

The installed and package-pinned host is `@earendil-works/pi-coding-agent`
`0.84.1`. The source/type audit found:

- `ExtensionContext.sessionManager.getSessionId()` and session lifecycle events
  bind the current callback to the active session;
- `ExtensionAPI.sendUserMessage()` dispatches through the current `AgentSession`
  and supports `deliverAs: steer | followUp` while streaming;
- message/turn, tool execution, input, provider request/response and
  `agent_settled` events are available to loaded extensions;
- `ExtensionAPI.setModel()` and `setThinkingLevel()` plus scoped model/thinking
  facts and selection events are available;
- `sendUserMessage()` accepts text/image content arrays.

The probe reads method presence and the current session identity only. It never
calls send, abort, model, thinking, provider or tool methods.

## 3. Host gaps

### Stop

`ExtensionContext.abort(): void` has no command-bound acknowledgement. In TUI it
first clears/restores steer/follow-up and compaction queues, then calls the
underlying agent abort. `agent_settled` proves the agent loop settled, but the
extension surface does not prove that abort cancelled retry, compaction or
branch-summary phases or bind settlement to the exact Stop command/operation.

Stop is therefore `partial`, reason `void-abort-without-operation-ack`, and
cannot be advertised until a bridge arbiter supplies exact operation identity,
phase handling and receipt semantics or the host exposes a stronger API.

### Pause and Resume

The host has no semantic durable Pause barrier. Process signals are not a valid
substitute. Resume cannot be implemented safely without an acknowledged Pause,
journal epoch and dispatch gate. Both are unavailable.

### Queue

`ExtensionContext.hasPendingMessages()` exposes only a boolean. The richer
`queue_update`, counts, contents and revisions exist on `AgentSession` but are
not part of the loaded extension event API. Queue projection remains partial;
the bridge must not cast or reach into private session internals.

### Approval

Extension UI confirmation has no shared external decision injection point.
Browser approval cannot resolve the guard's exact pending confirmation promise
or share a linearization point with terminal approval/tool start. Approval stays
unavailable until a guard-owned broker is implemented in-process.

### Usage

Context usage, assistant usage in the session branch and provider request events
are observable. A single exact host total-stats API is not exposed to extensions,
so total usage is derived/partial and must preserve unknown fields.

## 4. Machine proof

`same-process-bridge-proof.ts` emits an opaque, machine-tested verdict for the
pinned host. It returns `proven`, `partial` or `unavailable` per feature, never
a generic boolean. Unsupported host version, missing session identity or a
missing extension surface fails closed to inspect-only.

The proof always returns:

- `productionControlAllowed: false`;
- `secondRuntimeAllowed: false`;
- a hashed session ref rather than raw session ID;
- exact reason codes for every partial/unavailable feature.

The module imports no child process, RPC client, SDK session or `AgentSession`
implementation. Package and source tests enforce that boundary.

## 5. Productionization requirements

WUI2-01 must use one in-process extension-owned bridge that refreshes identity
on session replacement and registers the exact event set. It must add:

- bounded transcript/event projection and correlation IDs;
- send/follow-up/steer command CAS and idempotency;
- fresh-task lifecycle checks for model/thinking persistence scope;
- provider/operation/queue causal observation used by WUI0-10;
- guard-owned approval broker before any approval capability;
- journal-backed lifecycle arbiter before Stop/Pause/Resume capability.

If the pinned host is upgraded, WUI0-11 must be rerun against the new exact
source/types and the bridge proof version reviewed. Unknown host versions do not
inherit this verdict.

## 6. Estimate rebaseline

Same-session Chat removes the need for a separate runtime, but lifecycle and
approval gaps add an estimated 8–12 engineer-days to `WEBUI-2`. The milestone is
rebaselined from 20–30 to 28–42 engineer-days. This includes adapter/arbiter work
and tests; it does not assume an uncommitted upstream Pi change arrives for free.

## 7. Acceptance evidence

WUI0-11 requires:

- exact pinned host version alignment in root/core package contracts;
- current session identity returned only as an opaque ref;
- Chat, assistant/tool stream, provider observation and session options proved
  without invoking them;
- Stop partial and Pause/Resume/approval unavailable with exact reasons;
- unsupported/missing host surfaces fail closed;
- no child process, RPC, SDK or second-runtime path;
- public capability handshake remains strict-schema-valid and inspect-only;
- type, architecture, package and full offline verification pass.

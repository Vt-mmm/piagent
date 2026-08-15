---
plan_id: piagent-webui
work_item: WUI0-02
document: wire-schema-decision
status: accepted
decision_date: 2026-08-13
schema_namespace: https://piagent.io.vn/schemas/piagent-webui/
---

# WUI0-02 — Versioned wire schema contract

## 1. Decision

Piagent WebUI dùng một họ JSON Schema draft 2020-12 đóng, versioned và được
compile offline. Đây là contract chung giữa runtime projector, local server và
browser; raw Pi objects không phải wire contract.

Public wire documents:

| Document | Version | Role |
|---|---:|---|
| `snapshot-v1.schema.json` | 1 | Canonical inspect snapshot |
| `runtime-event-v2.schema.json` | 2 | Bounded live/replay event |
| `source-change-v1.schema.json` | 1 | Một trong ba source views |
| `diff-v1.schema.json` | 1 | Read-only bounded diff |
| `control-command-v1.schema.json` | 1 | Control command hoặc receipt |
| `approval-v1.schema.json` | 1 | Approval request, decision hoặc receipt |
| `capabilities-v1.schema.json` | 1 | Protocol/capability handshake |

`common-v1.schema.json` chỉ chứa shared definitions và không phải một HTTP
payload. `catalog-v1.json` là build-time registry duy nhất cho filename, `$id`,
version và role. Mọi external `$ref` phải resolve vào registry cục bộ; validator
không fetch schema qua mạng.

## 2. Version và compatibility

- Canonical `$id` là
  `https://piagent.io.vn/schemas/piagent-webui/<versioned-filename>`; URL này là
  identifier, không phải runtime fetch target.
- Filename major, catalog `documentVersion` và payload `schemaVersion` phải khớp.
- Mọi object authority-facing và canonical producer output đều đóng bằng
  `additionalProperties: false` ở boundary tương ứng.
- Client chọn đúng version qua capability handshake. Unknown protocol/schema
  version không được gửi authority intent; compatible inspect chỉ degrade khi
  handshake nói rõ.
- Thêm required field, đổi nghĩa, enum hoặc authority precondition tạo version
  mới. V1/v2 hiện tại không có “accept unknown field” fallback ngầm.
- `protocolMin` và `protocolMax` của handshake v1 cùng là `1`. Range rộng hơn cần
  schema/compatibility evidence mới, không chỉ đổi số runtime.

Policy đóng này cố ý fail-closed. TypeScript type hoặc browser code không được
coi là validation boundary.

## 3. Identity, revisions và unknown facts

Shared identity luôn gồm:

```text
projectRef
runtimeInstanceId
sessionRef
taskId | null
taskRunId | null
agentOperationId | null
toolCallId | null
```

Identity hierarchy fail closed: `taskRunId` cần `taskId`, còn `toolCallId` cần
`agentOperationId`. Event family hoặc control action nào cần identity mạnh hơn
phải bắt buộc toàn bộ tuple của family/action đó; nullable trong shared shape
không cấp quyền dùng orphan identity.

Browser không nhận raw `sessionId` hoặc session-state path. Side-effect records
dùng opaque refs, exact action digest và revision components phù hợp. Shared
revision có:

```text
runtimeRevision
taskRevision
controlRevision
workspaceRevision
indexRevision
approvalRevision
sessionOptionRevision
queueRevision
```

Snapshot thêm `journalHead` và `eventCursor`. Nullable domain không có nghĩa là
“probably unchanged”; projection phải kèm state/reason ở domain tương ứng.

Facts chưa chứng minh được dùng một trong:

```text
unknown | unavailable | disconnected | resync-required
```

Khi fact không `known`, value/evidence phải `null` và có machine-readable reason.
Schema snapshot áp dụng rule này cho model, thinking, permission, host phase,
queue, context, usage và continuation. Token/cost không được estimate để lấp
`null`.

Task outcome, task control, operation liveness, connection, approval và verifier
là các axes độc lập. Attention label như `waiting-approval` không được ghi vào
canonical operation/control state.

## 4. Snapshot

Snapshot yêu cầu toàn bộ top-level projection: capability, session, task, three
source summaries, activity, approval, verifier, usage/context, continuation,
handoff và health.

Enforced hierarchy:

- `toolCallId` cần `agentOperationId`;
- `taskRunId` cần `taskId`;
- `task: null` buộc task identity/revisions tương ứng là `null`;
- task projection cần task identity và task/control revisions;
- permission/model/thinking/queue/context/usage không được giữ fabricated value
  khi state là unknown/unavailable.

Task criteria chỉ hiển thị trạng thái cùng evidence. File relation hoặc target
hint không tự biến criterion thành `satisfied`.

## 5. Source và diff

Wire view keys duy nhất:

| Key | UI label | Baseline |
|---|---|---|
| `task` | Agent Task Changes | Task Baseline Manifest |
| `working-tree` | Full Working Tree | `HEAD` với index + worktree + untracked |
| `staged` | Staged Changes | `HEAD` tới index |

Ba view giữ basis và revision riêng; không đổi label trên cùng một diff.

Git display status duy nhất là `A`, `M`, `D`, `R`, `U`, `C`. `E` không phải Git
status; health/error ở field riêng. Staged view không nhận `U`.

File record tách:

- safe display path và opaque `fileRef`;
- raw Git index/worktree codes;
- content/access state;
- exact hoặc unavailable line stats;
- provenance classification cùng evidence refs;
- criterion/verifier relations;
- health.

Provenance `runtime-observed-agent` cần exact mutation evidence;
`post-baseline-unattributed` không được nâng cấp chỉ vì timestamp. Dirty baseline
cộng exact runtime touch là `mixed`.

Diff bind requested precondition với observed revision/digests, file/basis và
view. Text hunk/line có caps; addition không có old line number, deletion không
có new line number. Binary, symlink, submodule, conflict, protected, oversized,
unavailable và stale dùng typed fallback, không chứa raw hunks. Stale response là
`stale-retry`, không phải success với cache cũ.

Path có `pathDisplay: exact-safe | escaped | redacted`. `escaped` dùng percent-
encoded UTF-8 display form cho control/newline bytes; browser không được decode
nó thành filesystem capability. Action dùng opaque ref, không dùng display path.

## 6. Runtime events

Event v2 có writer sequence/cursor, full identity, domain revisions, typed
correlation, evidence provenance và redaction. `writerSequence` bắt đầu từ `1`.

Runtime event, snapshot và capability cùng tham chiếu một canonical operation
phase vocabulary trong `common-v1`. Source events dùng đúng ba wire keys
`task | working-tree | staged`. Non-known runtime/queue facts chỉ mang
`unknown`/`null`/empty values cùng reason; task outcome quyết định trực tiếp
terminal flag.

Schema có 66 event kinds và 42 bounded payload shapes cho:

- runtime/session/replacement/compaction;
- agent operation/turn/message;
- chat/queue/session options;
- task outcome và task control;
- tool/activity/approval/source/verifier/usage/handoff;
- disconnect và resync.

`agent-operation.loop-ended` không phải `agent-operation.settled`. Requested,
accepted và settled là facts khác nhau. Command-derived events cần command
correlation; event chỉ giữ `idempotencyKeyDigest`, không phát lại raw key.

Event không mang raw prompt, reasoning, signatures, image base64, provider URL/
headers, tool args/results, full logs, environment hoặc session/filesystem path.
Text delta/preview được redact và bounded.

## 7. Control và approval

Control schema phân biệt `command` và `receipt`.

Command luôn bind:

- command ID và one-time idempotency key;
- capability/action;
- exact identity;
- action digest;
- requested/expiry timestamps;
- action-specific expected revisions/preimages;
- closed payload.

Plain `lifecycle.resume` chỉ có empty payload. `resume-and-continue` mới được mang
message với delivery `new-operation` và queue revision. Model/thinking command
khai báo effect scope acknowledgement. Review/stage/revert intents dùng file/hunk
refs và exact preimage; revert cần confirmed preview digest. Không action nào
nhận arbitrary path hoặc shell endpoint.

Receipt tách `requested`, `accepted`, `settled`, `rejected`, `uncertain`. Kết quả
`stopped`, `paused`, `dispatch-observed`, `staged`, `unstaged` hoặc `reverted`
cần settlement evidence ref; abort invocation không đủ.

Receipt là action-discriminated: mỗi action có tập result/phase riêng, terminal
settlement cần timestamp/evidence, rejection cần typed error, và action không
được mượn result của action khác. Stop luôn bind exact non-null current
`agentOperationId`; review action luôn có task revision CAS.

Approval schema phân biệt request, WebUI decision và runtime receipt:

- full task/operation/tool identity;
- exact action digest và expected revisions;
- bounded redacted previews/targets;
- one-time high-entropy `decisionToken` chỉ ở request/decision;
- first-valid-CAS outcome, provisional/consumed/cancelled permit ở receipt;
- `executor: pi-guard` và `directExecution: false` bắt buộc.

Approval action class là closed discriminator. Action phụ thuộc tree/index phải
có workspace/index revision và preimage tương ứng; nullable generic
`treePrecondition` không được dùng để bỏ qua CAS.

Browser disconnect không tạo decision. Runtime expiry/restart/control mới tạo
typed terminal receipt. Token cũ không xuất hiện trong receipt và không dùng lại
cho runtime instance khác.

## 8. Capability handshake và limits

Capabilities độc lập: `inspect`, `control.chat`, `control.lifecycle`,
`control.resumeAndContinue`, `control.sessionOptions`, `attachments`, `approve`,
`reviewActions`. Capability unavailable cần version `null` và reason;
capability available cần exact version và detail riêng. Compound Resume &
Continue chỉ available khi cả lifecycle Resume và chat send proof đều available.
Review capability quảng bá riêng Open in VS Code, deterministic commit summary
và model-backed commit summary để model turn không bị ẩn.

`control.lifecycle` công bố đúng một Stop verdict cho mỗi operation phase; current
phase verdict và action availability không được mâu thuẫn.
`control.sessionOptions` công bố actual effect scope. Queue persistence/restart
scope, replay retention và transport/resource limits đều explicit.

Handshake `incompatible` hoặc `resync-required` bắt buộc fail closed về
inspect-only/unavailable controls; client không được giữ authority từ handshake
cũ.

Fixture `inspect-only` là baseline cho `WEBUI-1`: chỉ inspect available; mọi
authority capability unavailable với reason. `WUI0-11` mới có quyền thay verdict
của bridge-dependent capabilities.

Mọi array/string/payload được schema-bound. HTTP decoded bytes, request rate,
wall-clock timeout và concurrent process limits vẫn phải được server enforce ở
`WUI1-02`; JSON Schema không thay thế transport limits.

## 9. Validation và evidence

Contract tests dùng Ajv 8 draft-2020-12 với strict mode và `ajv-formats`:

- registry compile offline;
- unique/canonical `$id`;
- catalog completeness, no orphan schema;
- local `$ref` resolution;
- valid/invalid fixture cho bảy public documents;
- bounds và closed authority objects;
- forbidden raw field names;
- task/tool identity hierarchy;
- zero-turn Resume payload separation;
- settled control evidence;
- action/result/phase receipt matrix và exact Stop operation binding;
- canonical operation phase/source vocabulary;
- non-known runtime/queue fact erasure và task terminal binding;
- phase-specific Stop uniqueness và compound capability proof;
- closed approval action/precondition classes;
- inspect-only authority rejection;
- Git status/provenance/path invariants;
- binary/stale diff fallback;
- writer sequence, redaction và command correlation.

Ajv là dev dependency ở `WUI0-02`. Production server sẽ dùng validators compile
một lần hoặc generated standalone validators ở `WUI1-01`; browser types không
import Node runtime code.

## 10. Invariants ngoài khả năng của một JSON document

Schema validation chứng minh shape, bounds và local conditional rules. Nó không
tự chứng minh relationship giữa hai authoritative records. Các invariant sau
phải có runtime/collector tests ở work item tương ứng:

- `(runtimeInstanceId, writerSequence)` unique và strictly increasing;
- cursor retention, replay dedup và resync window (`WUI0-08`);
- task ID/session binding và equality giữa snapshot/task contract (`WUI0-07`);
- command/approval action digest equality với canonical request;
- expected revision/preimage CAS với live state;
- same idempotency key + same payload trả receipt cũ, khác payload bị reject;
- precondition digest bằng observed diff input;
- hunk header counts, monotonic line numbers và aggregate line stats;
- criterion/verifier/file refs thật sự tồn tại và cùng task attempt;
- approval permit consumption linearize với Pause/tool start;
- timestamp expiry ordering.

Thiếu cross-record evidence là `unknown`, `unavailable`, `stale-retry` hoặc typed
rejection; không được coi “schema valid” là authority success.

## 11. Downstream gates

- `WUI0-03` phải emit source/diff documents đúng schema và test semantic Git/diff
  invariants ở section 10.
- `WUI0-04` đến `WUI0-06` cung cấp baseline/provenance/verifier refs; trước đó
  projection dùng unavailable/unknown chính xác.
- `WUI0-07` assemble snapshot và prove Inspector/WebUI equality.
- `WUI0-08` implement event writer, cursor/replay/dedup/resync.
- `WUI0-09` threat model dùng schema field allowlist làm input, không coi schema
  là XSS/path/auth protection đầy đủ.
- `WUI0-11` chỉ advertise control capability sau same-process proof.

## 12. Rejected alternatives

| Alternative | Decision |
|---|---|
| `payload: unknown` cho events | Rejected: không bound, không codegen/audit được |
| Forward raw Pi event/tool/model object | Rejected: chứa data nhạy cảm và host-version coupling |
| Browser nhận raw path/session ID | Rejected: biến display data thành authority capability |
| Một `control: true` bật mọi action | Rejected: capabilities và lifecycle phase độc lập |
| `E` trong file status | Rejected: error thuộc health, không phải Git status |
| Manual validator thay schema registry | Rejected: tạo contract thứ hai dễ drift |
| Fetch `$ref` qua Internet | Rejected: nondeterministic và mở supply-chain/network path |
| Schema-valid đồng nghĩa CAS-valid | Rejected: cross-record authority cần runtime linearization |

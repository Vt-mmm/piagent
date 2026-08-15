---
plan_id: piagent-webui
work_item: WUI0-05
document: mutation-provenance-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-05 — Durable mutation provenance

## 1. Decision

Piagent persist file-level mutation provenance từ runtime/tool lifecycle hiện có;
không suy provenance từ task delta, command text hoặc model narration. Exact
`runtime-observed-agent` chỉ được tạo khi model-authorship transaction đã chứng
minh byte-exact post-image của `write`, `edit` hoặc `apply_patch`.

Shell, opaque tool, ambiguous edit, race, failed tool hoặc current-content
mismatch không được nâng thành agent provenance. Successful observed mutation có
thể ghi invalidation evidence nhưng projection vẫn
`post-baseline-unattributed` trừ khi nó chỉ đổi carrier/index/HEAD và bytes cuối
vẫn bằng exact content đã chứng minh trước đó.

## 2. Record and store

Canonical schema là `schemas/mutation-provenance-record.schema.json`; runtime
closed validator nằm trong `mutation-provenance-contract.ts`. Mỗi record bind:

- task/run và SHA-256 domain-separated session/tool-call identity;
- generic bounded tool class, timestamp và evidence mode;
- before/after whole-tree digest;
- safe private path carrier, before/after file carrier digest;
- exact after-content digest khi đọc được;
- proof mode/effect và record integrity digest.

Không persist raw session ID, tool-call ID, command, output, file bytes hoặc
provider data. Repo path chỉ có trong owner-only private record để projector map
evidence; browser chỉ nhận opaque `mutation.*` ref.

Record là immutable create-only JSON trong:

```text
.pi/piagent-state/source-evidence/run-<sha256(taskRunId)>/mutations/
└── provenance.<sha256>.json
```

Directory/file là `0700`/`0600`; writer dùng no-symlink path validation,
exclusive temp, `fsync` và hard-link publish. Cùng identity/content idempotent;
collision fail closed. Tối đa 500 record/task, 100 files/record và 128 KiB mỗi
record. Retention kế thừa Task Baseline Manifest; không silent delete.

## 3. Runtime integration

Tool authorization đã reserve immutable pre-snapshot và expected byte proof.
Tool-result hook dùng đúng post-event `workingTreeObservation` chung cho task,
verifier, performance review và provenance; không hash lại một competing tree.

`ModelAuthorshipState.completeWithEvidence` trả thêm private transaction evidence
cho persistence nhưng API `complete` cũ giữ nguyên response shape. Quy tắc:

- exact success + exact target set + expected content hash → exact record;
- success nhưng proof không đủ → observed record/invalidation;
- successful bounded shell/opaque mutation có before snapshot → observed record;
- failure/no-op/missing reservation → không exact record;
- protected path hoặc unavailable/current-algorithm mismatch → không record;
- persistence failure cảnh báo operator nhưng không làm giả provenance hoặc đổi
  kết quả tool.

Hook không tạo provider call, message, continuation hay prompt state. Record
không được dùng như authorization; guard và Task Contract vẫn là authority.

## 4. Projection semantics

Task source projector replay record theo thời gian và path:

- latest exact content còn khớp current bytes + clean task baseline →
  `runtime-observed-agent`;
- cùng evidence nhưng path dirty/untracked/deleted ở task start → `mixed`, bind
  cả baseline ref và mutation ref;
- observed content-preserved transition giữ exact ref;
- observed content change, corrupt ledger hoặc current digest mismatch xóa exact
  claim và trả `post-baseline-unattributed`;
- legacy task/no ledger luôn unattributed.

Record phản ánh “runtime-observed agent transaction”, không chứng minh con người
không đồng thời chạm repo. UI không được rút gọn label thành một khẳng định tuyệt
đối “agent authored”. Hunk-level provenance chưa được claim ở WUI0-05; nó thuộc
review/preimage work của WEBUI-3.

## 5. Failure and rollback

Một record corrupt làm provenance ledger của task fail closed, nhưng không làm
mất Task Changes, Working Tree, Staged hoặc diff. Record tamper không được bỏ qua
để reuse các record còn lại. Missing/deleted ledger làm giảm claim, không tạo
claim mới.

Rollback là dừng append và để WUI0-04 projection trả
`post-baseline-unattributed`. Private records cũ không tự bị xóa. Schema là local
evidence v1; breaking change cần version/file mới.

## 6. Acceptance evidence

WUI0-05 gate phải chứng minh:

- strict schema và runtime validator cùng accept/reject fixtures;
- immutable/idempotent owner-only records, no raw identity/command/content;
- exact clean path, mixed dirty baseline và multiple exact mutation refs;
- shell carrier-only preservation nhưng unknown content invalidation;
- failure/race/current-content mismatch không overclaim;
- protected path, symlink and tamper fail closed;
- real guard tool-call/tool-result flow persists write/apply-patch records;
- task source schema remains valid and other two Git views stay independent;
- integrity lock, package, type, architecture, docs và full offline verification
  pass trên current tree.

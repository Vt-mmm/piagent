---
plan_id: piagent-webui
work_item: WUI0-04
document: task-baseline-manifest-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-04 — Task Baseline Manifest and exact task delta

## 1. Decision

Mỗi source-change task mới phải capture một `Task Baseline Manifest` bất biến
trước khi Task Contract được publish. Manifest và content refs nằm trong private
local state; WebUI chỉ nhận projection đã redacted, không nhận raw manifest path,
session identity hoặc blob ref.

Task view được quảng bá `current` chỉ khi manifest đúng task/run, còn retention,
integrity hợp lệ và mọi baseline carrier cần thiết đã capture chính xác. Legacy,
corrupt, expired, protected, oversized hoặc quota-exhausted evidence trả
`unavailable`; không suy diễn hunk từ current HEAD hay lời model.

## 2. Storage contract

Canonical schema là `schemas/task-baseline-manifest.schema.json`; runtime type,
canonical digest và closed validator nằm trong `source-evidence-contract.ts`.
Store dùng layout:

```text
.pi/piagent-state/source-evidence/run-<sha256(taskRunId)>/
├── manifest.json
└── blobs/<sha256(content)>
```

Raw `taskRunId` không nằm trong directory name. Manifest bind task/run, hashed
session identity, capture/retention time, task-start working-tree digest, từng
Git root, recorded HEAD OID, limits, content refs và integrity digest.

Directory được ép `0700`, file `0600`. Publish dùng exclusive temporary file,
`fsync`, hard-link create-if-absent và no-follow/canonical local-state checks.
Existing immutable bytes chỉ được reuse khi bằng nhau; collision hoặc tamper
fail closed. Store không ghi Git object, không commit evidence và không đưa ref
vào prompt.

## 3. Capture semantics

Capture diễn ra ngay sau task-start working-tree digest và trước Task Contract:

- clean tracked content dùng blob từ recorded task-start HEAD, không duplicate;
- dirty, untracked và symlink content dùng bounded private blob;
- deleted path ghi explicit `absent` carrier;
- submodule ghi typed metadata, không recurse;
- protected và oversized path không persist raw bytes;
- entry/file/task quota exhaustion ghi reason cụ thể và làm exact task view
  unavailable;
- digest được kiểm tra trước và sau capture; concurrent edit không publish
  manifest.

Mặc định tối đa 2.000 entries, 4 MiB mỗi file, 64 MiB mỗi task và 30 ngày;
hard ceiling lần lượt là 2.000, 16 MiB, 256 MiB và 365 ngày. Expiry chỉ làm read
projection fail closed; không tự xóa evidence. Cleanup sau này phải previewable,
bounded và có explicit confirmation theo execution protocol.

## 4. Exact task projection

Task projection lấy union của baseline carriers, current dirty/untracked paths và
tracked paths khác recorded HEAD. Vì vậy thay đổi đã commit trong task vẫn xuất
hiện dù current working tree sạch.

Baseline của clean tracked file luôn được resolve bằng recorded HEAD OID qua
bounded `ls-tree` + `cat-file`, không dùng object ID của HEAD hiện tại. Unborn
repository dùng empty-tree OID. Rename được tính thành old/new paths khi cần;
task diff là task-relative, không phải HEAD-relative.

Projection đọc Git/content observation trước và sau. HEAD OID, raw status hoặc
working-tree evidence đổi giữa hai lần sẽ trả `git-race`. `viewRevision`,
`fileRevision`, base/current digest và diff precondition cùng bind immutable
manifest với current observation.

Pre-existing dirty content không đổi sau task bị loại. File đổi sau baseline
được gắn `post-baseline-unattributed`; WUI0-04 không claim `agent-authored`.
Mutation provenance thuộc WUI0-05.

## 5. Failure isolation and compatibility

Không có manifest nghĩa là legacy/digest-only task: task view trả
`task-baseline-content-unavailable`, còn working-tree và staged vẫn hoạt động.
Corrupt manifest/blob, missing recorded Git object, retention expiry hoặc read
race không được làm mất hai projection Git độc lập.

Task start từ chối source mutation nếu baseline capture không thể publish an
toàn. Capture và mọi read path là local deterministic work: không provider call,
không user-message, không continuation và không đổi provider-visible tool schema.

Rollback là ngừng capture cho task mới và giữ fallback legacy unavailable. Không
xóa private evidence tự động để rollback hoặc làm gate pass.

## 6. Acceptance evidence

Gate WUI0-04 phải chứng minh:

- schema strict + runtime validator đồng ý trên valid fixture và từ chối tamper;
- dirty/untracked/deleted/symlink capture chính xác, clean tracked không duplicate;
- protected/oversized/quota cases không persist raw bytes và reason rõ;
- owner-only/no-symlink/atomic store, không thay Git object store;
- concurrent edit không publish manifest;
- exact task source và hunk loại pre-existing dirt không đổi;
- committed task delta vẫn dùng recorded task-start HEAD;
- expiry/corruption fail closed riêng task view, không silent delete và không làm
  working-tree/staged unavailable;
- task-start integration, package distribution, integrity lock, architecture,
  docs và full repository verification đều pass trên current tree.

---
plan_id: piagent-webui
work_item: WUI0-03
document: source-change-collection-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-03 — Safe Git collection and three source projections

## 1. Decision

Piagent WebUI dùng một collector Git chỉ đọc, parse porcelain v2 theo NUL và tạo
ba projection có basis/revision riêng. Browser không chạy Git, không gửi path và
không tự suy diễn status.

Implementation nằm trong `packages/piagent-core/runtime/inspection/`:

| Module | Trách nhiệm |
|---|---|
| `git-status-adapter.ts` | Chạy Git read-only, parse porcelain v2 và giữ hai raw status axes |
| `source-change-projection.ts` | Tạo source documents cho một Git root |
| `workspace-source-projection.ts` | Ghép fail-closed tối đa 32 Git roots với basis độc lập |
| `diff-projection.ts` | Dựng diff lazy, bounded và digest/revision-bound cho một file |
| `workspace-file-reader.ts` | Đọc/hash file bằng descriptor, no-follow và kiểm tra race |

Canonical API trả schema-valid `source-change-v1` và `diff-v1` documents. Không
có provider call, session append, prompt mutation, continuation hoặc tool-schema
mutation trong code path này.

## 2. Three views

`working-tree` so sánh HEAD với index + worktree + untracked. `staged` so sánh
HEAD với index. Hai view chạy diff-stat riêng, có `viewRevision` riêng và không
đổi label trên cùng dữ liệu.

`task` hiện trả `task-baseline-content-unavailable` cùng danh sách file rỗng.
Đây là kết quả có chủ ý: WUI0-03 chưa có quyền dựng task-only hunk từ digest map
cũ. WUI0-04 phải cung cấp Task Baseline Manifest và bounded content refs trước
khi task view được quảng bá `current`.

Canonical display status chỉ gồm:

```text
A M D R U C
```

Index/worktree raw codes được giữ riêng. `C` chỉ biểu diễn conflict/unmerged;
raw Git copy status không bị đổi nghĩa thành conflict. Error nằm trong `health`,
không dùng `E` trong status column.

## 3. Git execution boundary

Mọi process dùng argv, `shell: false` và một allowlist subcommand read-only.
Helper từ chối subcommand hoặc option có thể mutate/output file dù caller tái sử
dụng sai API.

Runtime cố định:

- `--no-pager`, `--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`;
- `--literal-pathspecs`; pathspec luôn nằm sau `--` khi đọc diff;
- tắt system/global config, fsmonitor hook, hooks path, external diff, textconv,
  prompt và recursive submodule;
- môi trường tối thiểu, không kế thừa `GIT_DIR`, `GIT_WORK_TREE`, diff helper,
  askpass hoặc pager của process cha;
- timeout, stdout cap, stderr preview cap và stdin batch cap;
- `cat-file --batch` chỉ nhận validated object IDs và không chạy filter.

File read không dựa vào `lstat` rồi mở lại path một cách mù. Reader từ chối
symlink ancestor, mở final entry với `O_NOFOLLOW`, so inode/device/mode, kiểm tra
metadata trước/sau và xác nhận canonical path vẫn ở dưới đúng Git root. Rename
được kiểm tra protected-path policy ở cả old path và new path.

Collector không stage, unstage, refresh index, chạy hook, textconv, external diff
hoặc recurse vào submodule. Test kiểm tra index size/mtime không đổi sau inspect.

## 4. Paths and authority

Porcelain v2 được đọc dưới dạng bytes và split bằng NUL, nên space, Unicode và
newline không phá record boundary. Mỗi path có:

- internal value chỉ khi UTF-8, relative và không traversal;
- safe display path;
- `exact-safe`, `escaped` hoặc `unavailable` display mode;
- SHA-256 path digest để tạo opaque `fileRef`.

Control/newline/backslash/percent được percent-escape cho display. Display path
không phải filesystem authority. Diff lookup nhận opaque `fileRef`, resolve lại
từ Git evidence và truyền path bằng argv sau `--`.

Path không thể biểu diễn an toàn bị loại fail-closed, tạo bounded issue/health;
không decode display string thành path.

## 5. Revisions, digests and races

`indexRevision` bind HEAD cùng index status, modes và Git object IDs.
`workspaceRevision` bind raw status cùng SHA-256 nội dung worktree, symlink target,
absence hoặc typed protected metadata. Vì vậy file vẫn mang raw status `M` nhưng
đổi bytes sẽ đổi revision.

HEAD/index blobs dưới content cap được đọc qua bounded `cat-file --batch` và đổi
thành canonical `sha256:<hex>`. Worktree/untracked regular files dưới exposure
cap có SHA-256 trực tiếp. Added/untracked có `baseDigest: null`; deleted có
`currentDigest: null`; digest không đọc được giữ `null`, không fabricate.

Source collection đọc status/revision trước và sau diff-stat. Nếu evidence đổi,
view trả `stale` và không claim exact file list. Diff request bind:

```text
expectedViewRevision
expectedFileRevision
expectedBaseDigest
expectedCurrentDigest
```

Diff recollect trước và sau khi dựng patch. Bất kỳ mismatch nào trả
`stale-retry`, `retryable: true`, không có hunk cũ.

## 6. Diff and failure behavior

Text diff được load khi chọn file, không nằm trong source snapshot. Hunk/line,
unchanged region, byte, time và pagination đều bounded. Added/deleted/context
line giữ line-number shape theo schema. Long output có explicit truncation và
cursor; line redaction có counter riêng.

Fallback typed:

- current: `binary`, `symlink`, `submodule`, `conflict`;
- unavailable: `protected`, `oversized`, `unavailable`;
- stale: `stale` với reason `stale-retry`.

No-Git workspace trả hai schema-valid unavailable views thay vì throw. Unborn và
detached HEAD có typed basis. Workspace nhiều repo giữ tối đa 32 basis; nếu một
root unavailable, aggregate fail closed và không trộn partial file list với
claim `current`.

## 7. Evidence and remaining gates

Focused suites dùng repository thật và validate producer output bằng strict Ajv:

- A/M/D/R/U/C, rename + edit, staged/unstaged/mixed;
- binary, symlink, submodule, conflict, protected và oversized;
- space, Unicode, newline path;
- unborn, detached, no-Git, nested và multiple roots;
- content-only stale revision, pagination, truncation và redaction;
- disabled fsmonitor, external diff, textconv và rejected mutating command;
- symlink-ancestor escape và file/read race fail closed;
- unchanged Git index after read-only inspect.

Toàn bộ inspection runtime modules nằm trong capability profile integrity lock;
platform update chỉ re-pin khi grant không đổi và vẫn fail closed khi runtime
surface bị thay ngoài lock.

WUI0-04 thêm exact task baseline content. WUI0-05 thêm mutation provenance; đến
lúc đó mọi file giữ `post-baseline-unattributed`, không claim agent authorship.
WUI0-06 thêm verifier snapshots. WUI0-07 mới gắn criteria/verifier relations và
chuyển legacy Activity Inspector thành compatibility formatter trên projector
này.

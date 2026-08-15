---
plan_id: piagent-webui
workstream: WEBUI
document: execution-protocol
status: active
canonical_tracker: STATUS.md
---

# Piagent WebUI execution protocol

Protocol này biến master plan thành chuỗi work item hữu hạn mà nhiều session có
thể tiếp tục an toàn. Nó không cấp thêm authority ngoài yêu cầu cụ thể của human
operator và repository policy.

## 1. Chọn đúng một work item

Khi bắt đầu implementation session:

1. Đọc [`STATUS.md`](STATUS.md) để biết current milestone và dependency.
2. Chọn work item `not-started` đầu tiên có dependency đã `complete`, hoặc tiếp
   tục work item được handoff rõ ràng.
3. Inspect source và tests được master plan chỉ định.
4. Kiểm tra working tree cho overlap với user-owned changes.
5. Ghi owner/session, expected files, out-of-scope files và verifier vào tracker
   trước khi edit.
6. Implement đúng một work item; không opportunistically bắt đầu item kế tiếp.

Read-only audit có thể chạy song song. Chỉ một writer được sửa `STATUS.md` tại
một thời điểm.

## 2. Work item states

Chỉ dùng các trạng thái sau:

- `not-started`: chưa có implementation được claim.
- `in-progress`: có đúng một owner/session đang làm.
- `blocked`: có blocking evidence và next unblocking condition cụ thể.
- `implemented`: deliverable tồn tại nhưng verification chưa đủ.
- `verified`: named tests/gates đã pass trên current tree.
- `complete`: implementation, verification, evidence, docs và handoff đều đủ.

Không dùng `complete` chỉ vì code compile hoặc UI trông đúng ở một happy path.

## 3. Before-edit record

Tracker hoặc task journal phải ghi:

```text
Work item:
Objective:
Owner/session:
Baseline tree/status:
Expected changes:
Explicitly out of scope:
Verification commands:
Schema/migration impact:
Security surface:
Rollback:
```

Nếu target file có overlapping user change không thể tách an toàn, dừng work
item và ghi blocker; không overwrite hoặc revert thay đổi đó.

## 4. Implementation rules

- Source code, schema field, command và identifier dùng English.
- Long-form product/maintainer documentation có thể dùng tiếng Việt.
- Reuse Task Contract, journal, redaction, protected-path, usage và recovery
  services hiện có; không tạo state machine cạnh tranh.
- Runtime/core không import WebUI frontend hoặc HTTP server.
- Không thêm product logic lớn vào `piagent-guard.ts`; dùng bounded module rồi
  wire từ composition root.
- Tôn trọng line budgets trong `architecture/layers.json`.
- Không tạo generic shell endpoint, arbitrary path endpoint hoặc browser-defined
  tool.
- Không dùng prompt để enforce behavior mà guard/schema có thể enforce.
- Không ghi private baseline bytes vào Git objects.
- Không suy `agent-authored` chỉ từ thay đổi sau task baseline.
- Không gọi model để tạo title, progress, file relation, dashboard summary hoặc
  permission decision.
- Side-effecting request phải có identity binding, expected revision và
  idempotency key.
- Unknown/corrupt/stale state phải fail closed cho controls và fail soft cho
  read-only projection.

## 5. Verification tiers

### Tier A — focused iteration

Chạy test nhỏ nhất liên quan đến module đang sửa. Ví dụ:

- schema/golden contract tests;
- Git parser/diff fixtures;
- source-evidence/provenance tests;
- local server/auth tests;
- selected Playwright spec.

### Tier B — work-item verification

Chạy toàn bộ tests được work item nêu, cùng:

```bash
npm run typecheck
npm run architecture:check
```

Documentation-only work item thay `typecheck` bằng `npm run docs:check` khi phù
hợp, nhưng không được bỏ link và format validation.

### Tier C — milestone gate

Trước khi milestone `complete`:

```bash
npm test
npm run typecheck
npm run architecture:check
npm run docs:check
npm run capabilities:check
npm run verify -- --offline
```

Chạy thêm browser E2E, security, fault-injection, performance và packaging gates
được master plan yêu cầu cho milestone đó.

Authenticated/provider test chỉ chạy khi milestone thật sự cần model call và
local Pi login sẵn có. Thiếu login là environment evidence, không được biến thành
source workaround.

## 6. Evidence before completion

Mỗi work item `complete` phải có bounded record:

```text
Changed:
Out of scope:
Verified:
Evidence:
Model turns observed:
Schema/migration:
Security review:
Performance result:
Rollback:
Known limitations:
Next exact action:
```

Không paste full logs vào tracker. Chỉ lưu exact command/result summary và link
tới bounded evidence theo repository privacy boundary.

## 7. Milestone gate procedure

1. Hoàn thành và verify tất cả implementation items.
2. Chạy milestone verification matrix trên current tree.
3. Chạy security và privacy review.
4. Chạy feature-off/rollback path.
5. Chạy failure isolation: WebUI absent/crashed không ảnh hưởng Pi runtime.
6. Kiểm tra zero-model-turn contract cho mọi read-only path.
7. Tạo một read-only gate audit tách khỏi implementation session.
8. Tracker writer read back audit và current digests.
9. Chỉ sau đó mới mark gate và milestone `complete`.

WebUI-2 có hard gate đặc biệt: phải chứng minh WebUI message đi vào đúng Pi
process/session hiện tại. Nếu không chứng minh được, dừng milestone; tuyệt đối
không fallback bằng process Pi thứ hai.

## 8. Handoff format

```text
Work item:
State:
Owner/session:
Baseline tree/status:
Current tree/status:
Changed:
Out of scope:
Verified:
Evidence:
Model-turn audit:
Schema/migration:
Security/performance:
Rollback:
Known limitation:
Blocker:
Next exact action:
```

Session tiếp theo phải verify current state và evidence; không tin handoff text
như source of truth.

## 9. Approval boundaries

Plan này cho phép implementation local và non-destructive verification khi human
operator yêu cầu thực hiện work item. Nó không tự cấp quyền:

- publish package;
- commit, tag, push hoặc mở pull request;
- thay đổi external provider configuration;
- expose WebUI ngoài loopback;
- xóa session, journal, credential hoặc source evidence;
- bật WebUI controls mặc định cho mọi profile;
- cài experimental runtime hoặc execution backend.

Các action trên vẫn cần normal explicit confirmation.

## 10. Plan maintenance

Khi implementation evidence bác bỏ assumption của plan:

1. Không silent workaround.
2. Ghi evidence và blocker trong `STATUS.md`.
3. Cập nhật master plan bằng change nhỏ nhất cần thiết.
4. Nêu migration/rollback impact.
5. Re-review downstream estimates và gates bị ảnh hưởng.

Thay đổi visual preference hoặc frontend library không được dùng để nới source
of truth, security boundary hay zero-model-turn invariant.

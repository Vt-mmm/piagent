# Project onboarding snapshot
<!-- language: vi; english-index: docs-site/content/en/team.html -->

## Mục tiêu

Lần đầu gắn một project vào Pi Agent Platform, không nên nhảy thẳng vào `/workflow task`.

Luồng chuẩn là:

```bash
cd /path/to/project
pi
/login
<select provider/model>
/onboard
/onboard run
```

`/onboard` mở menu/status runtime. Sau khi `/onboard run` chạy xong, project có file:

```text
.pi/piagent-profile.json
.pi/piagent-profile.lock.json
.pi/tech-stack.json
.pi/tech-context/*.json
.pi/project-context.md
.pi/context-index.json
.pi/memory/memory_summary.md
.pi/memory/MEMORY.md
```

`/onboard run` là nơi profile và tech stack được chọn trong onboarding workflow. Ưu tiên select-style flow:

```text
/profile setup
/profile tech setup fullstack
```

Nếu Pi host chưa có native select, command trả card compact và lệnh deterministic, ví dụ `/profile tech apply fullstack frontend=nextjs backend=nestjs database=prisma`. Không dùng model để giải thích dài từng lựa chọn trong daily UX.

`.pi/project-context.md` là context snapshot để task sau không phải scout lại toàn bộ repo từ đầu.

`.pi/context-index.json` là compact advisory index dạng node/edge/citation cho profile, tech stack, verify command, docs, risk, memory pointer và task handoff đã được duyệt. Nó giúp agent tìm đúng điểm vào repo nhanh hơn, nhưng không phải source of truth hoặc security boundary.

Context index là Pi runtime state. Không đọc/ghi raw file này trong workflow thường ngày; dùng `/context`, `piagent_context_index_status`, `piagent_context_index_search`, `/onboard run` hoặc `piagent_context_index_record` để runtime có thể kiểm soát path và sanitize dữ liệu advisory trước khi đưa vào model.

Memory markdown là local/private mặc định và bị ignore bởi `.pi/.gitignore`. Chỉ commit memory nếu team quyết định opt-in sau khi review/redact.

`.pi/memory/` là durable memory thủ công để giữ preference/decision/lesson ổn định giữa các session. Nó không thay thế snapshot hoặc source hiện tại.

## Vì sao không để bash làm bước này

Bash setup chỉ biết tạo template và detect marker. Nó không có model reasoning, không biết project purpose, module ownership, domain rule, hay risk boundary.

`/onboard run` phải chạy sau login/model selection để chính model sẽ dùng cho task đọc qua project, chọn/gợi ý profile, và tạo snapshot.

## Profile selection

Xem hoặc đổi profile trong Pi:

```text
/profile list
/profile setup
/profile tech setup
/profile fullstack
/profile be-readonly-fe
```

Khác biệt quan trọng:

- `fullstack`: FE và BE đều có thể được sửa nếu task cho phép.
- `be-readonly-fe`: BE chỉ scout/read-only; FE là write target.
- `web-frontend`: chỉ FE.
- `backend-api`: chỉ BE.
- `generic`: baseline an toàn khi chưa rõ repo.

## Phạm vi model cần đọc

Không đọc toàn bộ source. Đọc theo lớp:

1. `.pi/piagent-profile.json`
2. `AGENTS.md`
3. `.pi/project-context.md` hiện tại
4. `.pi/context-index.json` nếu đã được generate
5. `.pi/memory/memory_summary.md` nếu đã có và liên quan
6. `README.md`
7. package/build/runtime config
8. docs/architecture/spec nếu có
9. source directory map
10. test/verify command definitions
11. API/schema/migration markers nếu có

Mục tiêu là hiểu cấu trúc và policy, không nhồi full repo vào context.

## Artifact bắt buộc

`.pi/project-context.md` nên có:

- project purpose;
- stack/runtime/package manager;
- repository map;
- source-of-truth docs;
- domain/architecture notes;
- verification matrix;
- protected/high-risk areas;
- MCP/tool policy;
- memory policy;
- update triggers.

`piagent_project_onboarding_record` sẽ tự ghi thêm `.pi/context-index.json` khi tool có sẵn. Nếu cần kiểm tra nhanh, dùng:

```text
/context index
/context search <keyword>
```

## Khi nào regenerate

Chạy lại:

```text
/onboard run
```

khi có thay đổi lớn:

- source layout đổi;
- framework/runtime đổi;
- verify command đổi;
- API/schema/migration/auth/provider policy đổi;
- project ownership hoặc domain rule đổi.

## Relationship với `/workflow task`

`/workflow task` sẽ yêu cầu đọc `.pi/project-context.md`. Nếu file còn trạng thái `Generated: not yet`, agent phải dừng và yêu cầu chạy `/onboard run` trước.

Đây là điểm khác với CLI thuần: context bootstrap trở thành một bước có artifact có thể review và tái dùng. `.pi/project-context.md` và `.pi/context-index.json` có thể commit cho team sau khi review; memory markdown thì private-by-default.

# Workflow recipes

## Mục tiêu

Các recipe này biến những bài toán lặp lại thành workflow có tên rõ, dùng được cho project khác mà không phụ thuộc một project nội bộ cụ thể.

## Recipe 1 — Platform improvement

Dùng khi muốn cải tiến setup, prompt, MCP, model scope, memory, runtime policy, hoặc subagent workflow của Pi Agent Platform.

Lệnh trong Pi:

```text
/onboard-project
/platform-improve Improve <target behavior> in <platform area>.
```

Input tối thiểu:

- source docs URL hoặc repo URL nếu task cần external context;
- version/date/commit nếu có external context;
- target behavior cần áp dụng;
- non-goals: phần không làm trong scope này.

Output mong đợi:

- implementation matrix;
- code/docs/config thay đổi;
- verify evidence;
- phần không làm và lý do.

Verify chuẩn:

```bash
bash scripts/verify-local.sh
bash scripts/team-doctor.sh /path/to/piagent --strict-share
pi list --approve
```

Memory note:

- Nếu task tạo decision/lesson bền vững, user có thể yêu cầu `Remember: ...`.
- Agent dùng `piagent_memory_note` để ghi note explicit.
- Không tự ghi toàn bộ transcript vào memory.
- Nếu task tạo context điều hướng bền vững cho repo, dùng `piagent_context_index_record` để ghi node/edge/citation ngắn sau khi đã verify.

## Recipe 2 — Backend spec to frontend

Dùng khi backend là source of truth nhưng frontend là nơi implement. Backend chỉ được scout/read-only.

Setup project generic:

```text
/profile list
/profile be-readonly-fe
```

Lệnh trong Pi:

```text
/onboard-project
/be-to-fe Implement FE from BE spec: <endpoint/spec/change>
```

Input tối thiểu:

- BE endpoint/spec/diff/ticket;
- expected FE behavior;
- target route/page/component nếu biết;
- verify expectation.

Agent phải làm:

1. Scout BE read-only.
2. Ghi contract snapshot.
3. Map FE touchpoints.
4. Implement FE only.
5. Verify FE.
6. Report BE gaps thay vì sửa BE.

## Khi dùng profile nào

| Bài toán | Profile khuyến nghị |
|---|---|
| Platform/package/runtime improvement | `platform-development` hoặc profile platform riêng |
| Fullstack bình thường, FE/BE đều có thể sửa | `fullstack` |
| BE source of truth nhưng BE không được sửa | `be-readonly-fe` |
| Backend-only task | `backend-api` |
| Frontend-only task | `web-frontend` |
| Project đặc thù/private | profile explicit trong chính repo project |

Không dùng `auto` để suy ra `be-readonly-fe`, vì BE read-only là policy decision chứ không phải marker kỹ thuật.

## Recipe 3 — Project memory

Dùng khi muốn Pi nhớ durable facts/decisions/preferences giữa các session mà không phải scout lại từ đầu.

```text
/memory-policy
Remember: this repo uses pnpm, never npm.
```

Rule:

1. Memory là hint, không phải authority.
2. Chỉ ghi explicit note khi user yêu cầu rõ.
3. Không lưu secret/raw private data/source excerpt dài.
4. Trước source edit, search memory nếu task liên quan rồi verify bằng repo file hiện tại.

## Recipe 4 — Context index

Dùng khi muốn giảm scout lại giữa các session mà không bật auto memory.

```text
/onboard-project
/context-index
/context-index search auth
```

Rule:

1. Context index là advisory map, không phải source of truth.
2. Node/edge phải ngắn và có citation tới file/doc/task đã verify.
3. Không lưu raw transcript, secret, token, session, hoặc source excerpt dài.
4. Nếu index stale so với profile/tech/onboarding snapshot, chạy lại `/onboard-project` hoặc record lại bằng `piagent_context_index_record`.

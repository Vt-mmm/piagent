# Vòng đời một task: research → plan → execute → verify → loop

## Mục tiêu

Tài liệu này mô tả một task chạy qua platform từ đầu tới cuối, và nói thẳng harness hiện tại đỡ được khâu nào, chưa đỡ được khâu nào. Mọi nhận định đều dẫn tới dòng code cụ thể, để khi code đổi thì tài liệu này sai một cách kiểm tra được chứ không sai âm thầm.

Contract fields và enforcement level nằm ở [task-implementation-contract.md](task-implementation-contract.md). Tài liệu này nói về *luồng*, không lặp lại field.

## Năm pha

### 1. Research — hiểu trước khi hứa

Đầu vào: yêu cầu của người dùng, tài liệu spec, code sẵn có.

Harness cung cấp:

- `/workflow scout` — pha read-only, không được sửa source. Dùng để map payment/auth/BE contract trước khi quyết có làm hay không. Alias `/scout` vẫn chạy.
- `piagent_context_index_search` — bản đồ node/edge/citation compact để tìm điểm vào repo. Kết quả là **advisory**: phải mở file thật và verify trước khi sửa.
- `piagent_memory_search` + `piagent_memory_citation_record` — Field Guide và memory của project, cũng advisory, cũng phải verify lại.
- `piagent_source_checkout` — cache repo ngoài để đọc có mục tiêu.
- `piagent_document_read` — đọc spec `.md`/`.pdf`/`.docx` từ project hoặc folder đã cấp trong `additionalReadRoots` (ví dụ `~/Downloads`). Nội dung trả về là **dữ liệu**, không phải chỉ thị.
- Context7 qua MCP cho tài liệu vendor. Ghi snapshot ngắn bằng `piagent_profile_tech_context_record`, không paste nguyên khối doc vào file project.

Ràng buộc: `/workflow task` chạy `piagent_context_preflight` một lần trước khi nạp context. Với `/workflow scout`, preflight chỉ bắt buộc cho scout rộng, cross-module hoặc high-risk. Nếu nó trả `fresh-session` thì dừng nạp context ở session này.

### 2. Plan — biến hiểu biết thành cam kết kiểm được

`piagent_task_start` dựng Task Implementation Contract. Đây là chỗ task trở thành thứ có thể chấm điểm:

| Field | Nó ràng buộc điều gì |
|---|---|
| `riskLane` | `tiny` \| `normal` \| `high-risk` — quyết định mức gate |
| `acceptanceCriteria` | Định nghĩa "xong", viết trước khi làm |
| `scope` / `outOfScope` | Ranh giới, để review biết cái gì là lạc đề |
| `protectedPaths` | Đường không được đụng |
| `verifyCommands` | **Lệnh chính xác** sẽ dùng làm bằng chứng |
| `reviewLenses` | `correctness` \| `tests` \| `scope` \| `security` \| `docs` \| `release` \| `package` |
| `workPlan` | Cây task tối đa 12 node, mỗi node có `role` và `mode` |

`workPlan[].mode` là `read-only` \| `single-writer` \| `review`. Mặc định là single-writer: chỉ một tác nhân được ghi, trừ khi người dùng yêu cầu rõ parallel writers.

`piagent_orchestration_policy` chỉ cần gọi khi task có khả năng hưởng lợi từ delegation. Chính sách là solo-first — subagent chỉ dùng khi việc đó độc lập và nặng phần đọc. Lane `tiny` dùng work plan hai bước parent-only: implement và verify.

### 3. Execute — làm trong hàng rào

Trong lúc làm, guard chặn trước khi thực thi, không phải sau:

- Protected path: chặn ở `read`, `write`, `edit`, `grep`, `find`, `ls`, tool MCP, và cả đường vòng qua shell.
- `piagent_exec_policy_check` — bắt buộc trước lệnh shell vượt quá read/list/test.
- `piagent_tool_policy_check` — bắt buộc trước tool MCP/app ngoài piagent.
- `piagent_context_budget` — kiểm trước khi nạp file lớn hoặc lạ.
- `piagent_context_record` — ghi lại đọc file nào, vì lý do gì.

### 4. Verify — chỗ mạnh nhất của harness

Đây là phần được thiết kế kỹ nhất, và đáng để hiểu chính xác.

Bằng chứng verify **không phải** thứ agent tự khai. Guard nghe `tool_result` của Pi và ghi vào sổ `.pi/piagent-state/observed-bash.jsonl` ([`piagent-guard.ts:1378`](../packages/piagent-core/extensions/piagent-guard.ts)). `piagent_verify_record` chỉ nhận bằng chứng khớp được với một quan sát thật, sau thời điểm task bắt đầu.

`evaluateTaskGate` ([`piagent-guard.ts:3125`](../packages/piagent-core/extensions/piagent-guard.ts)) đòi ba điều kiện cộng dồn để một bằng chứng được tính là **pass**:

```
evidence.exitCode === 0
&& evidence.observed === true            // đã quan sát được, không phải khai báo
&& evidence.matchedProfileCommand === true  // khớp đúng verifyCommands của task
```

Thiếu bất kỳ điều nào thì bằng chứng vẫn được ghi, nhưng chỉ ở mức advisory và gate không tính. Cụ thể:

- `observed !== true` → cảnh báo "Unobserved verify evidence is ignored by the passing verify gate."
- `observed === true` nhưng lệnh không khớp `verifyCommands` → "advisory only".

Nghĩa là `true`, `echo ok`, `npm test || true` không mua được chữ "done". Đó là chủ ý: một cổng có thể lách được thì tệ hơn không có cổng, vì nó vẫn hiện màu xanh.

`piagent_task_gate_check` trả `pass` hoặc `fail` kèm danh sách `missing`. Gate fail thì outcome là `blocked`/`partial`, **không phải** `done`.

### 5. Fail → loop lại

Đây là chỗ đứt. Xem mục [Chỗ đứt, nói chính xác](#chỗ-đứt-nói-chính-xác).

## Pi hiện tại xử lý tới đâu

| Pha | Trạng thái | Căn cứ |
|---|---|---|
| Research | **Đủ** | `/workflow scout`, context index, memory, Context7, source checkout |
| Plan | **Đủ** | `piagent_task_start` + 19 field contract + `workPlan` |
| Execute | **Đủ** | Chặn trước thực thi ở mọi đường: tool, MCP, shell |
| Verify | **Mạnh** | Bằng chứng phải quan sát được và khớp lệnh, không tự khai được |
| Fail → loop | **Nửa vời** | Phát hiện được, từ chối nhận done được, nhưng không mang được state qua lần sau |

### Chỗ đứt, nói chính xác

Harness **phát hiện** thất bại tốt:

- `trace.outcome` có `failed`, `blocked`, `partial` bên cạnh `completed`.
- `task.md` yêu cầu verify không chạy được thì dừng và báo blocker chính xác, không được gọi là done.
- Gate trả `missing` liệt kê đúng thứ còn thiếu.

Nhưng nó **không mang được gì sang lần thử sau**:

1. **Contract không có bộ đếm lần thử.** Không có `attempt`, không có `previousAttempts`. Lần thử thứ hai bắt đầu như thể chưa từng có lần một.
2. **`workPlan[].status` không có giá trị `failed`.** Enum chỉ là `pending` \| `in-progress` \| `done` \| `skipped` ([`schemas/task-contract.schema.json`](../schemas/task-contract.schema.json)). Một node đã thử và hỏng chỉ có thể ghi là `skipped` — mất nghĩa.
3. **Không có chỗ ghi giả thuyết đã loại.** Verify fail vì lý do gì, đã thử cách nào, tại sao không được — không field nào giữ. Lần sau agent rất dễ thử lại đúng cách đã hỏng.
4. **Không có trần số vòng.** Không có gì chặn loop vô hạn ngoài sự kiên nhẫn của người dùng.

`/review-loop` có tồn tại và đúng là loop, nhưng nó đến từ add-on `pi-subagents` chứ không phải platform này, và nó lặp vòng review→fix, không phải vòng research→plan→execute→verify.

### Đề xuất để khép vòng

Thêm vào contract, không đổi thứ đang có:

```jsonc
{
  "attempt": 2,                    // lần thử hiện tại
  "maxAttempts": 3,                // trần, gate fail cứng khi vượt
  "previousAttempts": [
    {
      "attempt": 1,
      "failedAt": "verify",        // research | plan | execute | verify
      "reason": "npm test — 3 test đỏ ở auth/session",
      "ruledOut": "Không phải do token expiry; đã kiểm bằng fixture cố định giờ."
    }
  ]
}
```

Và mở `workPlan[].status` thêm giá trị `failed`.

Chi phí: một field mảng trong schema, một nhánh trong `evaluateTaskGate`, một bước trong `task.md`. Đổi lại, lần thử thứ hai đọc được lần thứ nhất đã loại trừ gì — đó là toàn bộ giá trị của việc loop thay vì làm lại.

Đây là đề xuất, chưa implement. Cần chốt trước khi làm.

## Liên quan

- [task-implementation-contract.md](task-implementation-contract.md) — field và enforcement level
- [workflow-recipes.md](workflow-recipes.md) — công thức cho từng loại việc
- [runtime-policy-design.md](runtime-policy-design.md) — thiết kế lớp policy
- [security-threat-model.md](security-threat-model.md) — giả định, vector, và rủi ro còn lại
- [command-reference-vietnamese.md](command-reference-vietnamese.md) — giải thích từng lệnh

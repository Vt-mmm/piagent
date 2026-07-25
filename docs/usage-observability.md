# Usage observability

Mục tiêu: biết Pi session đang tiêu hao token/context/cost như nào mà không phải hỏi model bằng ngôn ngữ tự nhiên.

## Trong Pi TUI

Pi có sẵn footer hiển thị token/cache usage, cost, context usage, model hiện tại. Khi cần chi tiết hơn, chạy:

```text
/session
```

Piagent package thêm command:

```text
/piagent-usage
/task-preflight
/task-preflight compact
```

Agent cũng có thể gọi tool:

```text
piagent_usage_snapshot
piagent_context_preflight
```

`/piagent-usage` hiển thị:

- session file;
- session id/name;
- cwd;
- model;
- live context usage hiện tại;
- active branch entries / total entries;
- lệnh để lấy exact token/cost totals từ terminal khác.

`/task-preflight` hiển thị:

- workflow đang định chạy;
- live context;
- estimated input tokens;
- projected context;
- recommendation: `ok`, `watch`, `compact`, hoặc `fresh-session`;
- fresh workflow commands nếu session hiện tại quá nặng.

`/task-preflight compact` gọi Pi compaction với hướng dẫn giữ lại decisions, blockers, changed files, verify command, và next action.

Giới hạn kỹ thuật: extension command context expose `ctx.getContextUsage()`, phù hợp để biết context window đang dùng bao nhiêu. Exact billed totals như `input`, `output`, `cacheRead`, `cacheWrite`, `cost` là API của Pi `/session` và RPC `get_session_stats`.

## Từ terminal khác

Nếu đang có một Pi session chạy ở project khác, mở terminal mới:

```bash
piagent-usage /path/to/project
```

Hoặc dùng script trực tiếp:

```bash
bash scripts/pi-session-stats.sh /path/to/project
```

Script sẽ:

1. tìm session `.jsonl` mới nhất có header `cwd` khớp project path;
2. gọi Pi RPC `get_session_stats`;
3. in JSON gồm messages, token totals, cost và context usage.

Ví dụ output:

```json
{
  "tokens": {
    "input": 121095,
    "output": 8088,
    "cacheRead": 2023936,
    "cacheWrite": 0,
    "total": 2153119
  },
  "cost": 1.860083,
  "contextUsage": {
    "tokens": 102996,
    "contextWindow": 272000,
    "percent": 37.866176470588236
  }
}
```

## Cách đọc số

| Field | Ý nghĩa |
|---|---|
| `input` | Token input thật gửi vào model. |
| `output` | Token model sinh ra. |
| `cacheRead` | Token đọc từ provider prompt cache. Số này có thể rất lớn nhưng không tương đương fresh input cost. |
| `cacheWrite` | Token ghi vào cache. |
| `total` | Tổng theo Pi stats. |
| `cost` | Cost Pi tính theo pricing metadata của model/provider. |
| `contextUsage.tokens` | Context window hiện đang bị chiếm bao nhiêu token. |
| `contextUsage.percent` | Phần trăm context window hiện tại. |

## Khi nào cần compact

Xem `contextUsage.percent`:

- `< 50%`: bình thường.
- `50–70%`: bắt đầu tránh đọc file lớn không cần thiết.
- `70–82%`: chạy `/task-preflight compact` trước task dài tiếp theo.
- `> 82%`: dùng `/fresh-task`, `/fresh-scout`, hoặc `/fresh-be-to-fe` cho work mới.
- Sau compaction, `contextUsage.tokens` có thể là `null` cho đến khi có assistant response mới.

Nếu user paste full mandatory-flow boilerplate, platform input guard sẽ collapse về workflow command ngắn. Nếu prompt quá dài thật, platform có thể lưu intake vào `.pi/task-inbox/` local gitignored rồi replay bằng fresh workflow command.

## Khi nào ghi benchmark

Sau một task cần so sánh workflow/model bằng số liệu:

```bash
bash scripts/quality-benchmark.sh /path/to/project --record \
  --scenario bounded-source-fix \
  --surface pi \
  --result pass \
  --tokens <total-from-piagent-usage> \
  --cost <cost-from-piagent-usage> \
  --verify "<verify-command>"
```

Không dùng ước lượng ký tự để claim tiết kiệm token. Dùng `/session`, RPC `get_session_stats`, hoặc `piagent-usage`.

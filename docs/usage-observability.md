# Usage observability

Mục tiêu: biết Pi session đang tiêu hao token/context/cost như nào mà không phải hỏi model bằng ngôn ngữ tự nhiên.

## Trong Pi TUI

Pi có sẵn footer hiển thị token/cache usage, cost, context usage, model hiện tại. Khi cần chi tiết hơn, chạy:

```text
/session
```

Piagent package thêm command:

```text
/usage
/context preflight
/context compact
/usage logs
/usage live
/usage efficiency
/piagent-inspector
```

Agent cũng có thể gọi tool:

```text
piagent_usage_snapshot
piagent_context_preflight
```

`/usage` hiển thị:

- session file;
- session id/name;
- cwd;
- model;
- live context usage hiện tại;
- active branch entries / total entries;
- lệnh để lấy exact token/cost totals từ terminal khác.

`/context preflight` hiển thị:

- workflow đang định chạy;
- live context;
- estimated input tokens;
- projected context;
- recommendation: `ok`, `watch`, `compact`, hoặc `fresh-session`;
- fresh workflow commands nếu session hiện tại quá nặng.

`/context compact` gọi Pi compaction với hướng dẫn giữ lại decisions, blockers, changed files, verify command, và next action.

`/usage logs` không tail realtime. Nó chỉ hiển thị policy compact và vài capture mới nhất khi tool output quá dài. Capture nằm trong `.pi/piagent-state/tool-results/`, đã qua redaction trước khi ghi, để Agent Watch/report đọc offline mà Pi TUI không phải nhồi full terminal log vào transcript. Alias `/logs` vẫn chạy.

`/usage efficiency` đọc local Context Engine telemetry và hiện công thức
`contextWasteScore`: duplicate reads, duplicate output, tool-schema share,
low-confidence retrieval, và active-tool excess. Score này phải đi cùng task
gate/verify result; nó không tự kết luận model hoặc nhân viên làm tốt/xấu. Nếu
session có Task Contract, JSON detail còn có `taskEfficiency`: hashed
session/task/run identity, solver route/mode/override, persisted phase duration,
context/tool-group utilization, verify/repair/retry count, digest-only helper
usage, outcome và acceptance. Raw task text/child output không được lưu. Parent
token/cost, actual tool-call count, relevant-file time và correct-edit time giữ
`null` hoặc `unavailable` nếu runtime không có exact fact; không dùng estimate.

## Context Budget Inspector và activity panel

`/piagent-inspector` là namespace duy nhất cho activity/diff review. Gõ không
tham số để chọn `summary`, `files`, `commands`, `security`, `context`, `toggle`
hoặc `help`. Panel live bốn dòng tự hiện sát phía trên footer native từ lúc mở
session; `/piagent-inspector toggle` chỉ ẩn/hiện panel trong session hiện tại
và không sửa profile.

Màu panel mang nghĩa cố định: cyan/magenta phân biệt file và test, xanh lá cho
addition/pass và context dưới 60%, vàng cho block hoặc context từ 60%, đỏ cho
deletion/failure/safety hoặc context từ 80%. Màu có thể tắt bằng `NO_COLOR=1`.

Inspector đọc các nguồn local đã có: Task Contract và baseline working tree,
tool call/result, exact bash evidence, safety decision, trajectory/resume state,
session messages và `ctx.getContextUsage()`. Vì vậy nó hiển thị được:

- observed task files trên footer panel; exact task-baseline delta trong view `files`; toàn bộ dirty working tree khi không có task;
- file/tool đang chạy và patch line vừa hoàn tất khi Pi cung cấp patch;
- command requested, executed, passed, failed hoặc blocked;
- verifier pass/fail, policy block, secret redaction và integrity warning;
- context hiện tại, token/cost cộng theo session và usage của assistant turn mới nhất.

Giới hạn được ghi rõ trong output: Pi gắn model usage vào assistant response/turn,
không gắn exact token vào từng built-in tool call. Do đó inspector không chia token
cho `read`, `edit`, `bash` bằng estimate. Nếu task đụng file đã dirty từ baseline,
line scope là `mixed-working-tree`; dùng file list/task baseline để review, không
coi toàn bộ `git diff HEAD` là công của task hiện tại.

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

## Usage lịch sử / report tuần

`piagent-usage /path/to/project` chỉ trả exact stats của session mới nhất. Để xem tổng usage đã lưu trên máy, kể cả session đã end hoặc subagent runs:

```bash
piagent-usage --history /path/to/project
piagent-usage --history /path/to/project --days 7
piagent-usage --history --all-projects --days 7 --csv
piagent-usage --history --all-projects --since 2026-07-20 --until 2026-07-26 --json
```

History mode đọc trực tiếp `~/.pi/agent/sessions/**/*.jsonl`, cộng usage từ từng assistant message:

- `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`;
- `cost.total`;
- số user messages, assistant messages, tool calls, tool results;
- session name từ `session_info.name`, dùng để Agent Watch/report đối chiếu task;
- breakdown theo project và top sessions.

Để session name rõ ngay trong report, mở Pi bằng:

```bash
pi --name "ABC-123 Short task name"
```

Hoặc đổi tên phiên đang mở trong Pi:

```text
/name ABC-123 Short task name
```

Alias ngắn `/setname ABC-123 Short task name` vẫn chạy. Nếu tắt nhầm terminal/app, vào lại project rồi dùng `pi --continue` cho phiên gần nhất, hoặc `pi --resume` để chọn theo session name/id. Trong Pi có thể gõ `/resume` để xem reminder ngắn.

Task Contract v2 lưu cả `sessionId`, `sessionName`, `taskId` và `taskRunId`, nên
Agent Watch/report có thể map usage vào đúng attempt kể cả session đã resume hoặc
được đổi tên sau khi bắt đầu. Một session không được tái sử dụng cho task khác;
retry dùng session mới và giữ liên kết qua cùng `taskId`.

Mặc định history mode **bao gồm subagent session files** vì đó là usage thật của máy. Dùng `--no-subagents` khi chỉ muốn parent/main sessions.

Format hỗ trợ:

| Format | Lệnh |
|---|---|
| Human table | `piagent-usage --history <project>` |
| JSON | `piagent-usage --history <project> --json` |
| CSV | `piagent-usage --history <project> --csv` |
| Markdown | `piagent-usage --history <project> --markdown` |

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
- `70–82%`: chạy `/context compact` trước task dài tiếp theo.
- `> 82%`: dùng `/fresh task`, `/fresh scout`, hoặc `/fresh be-to-fe` cho work mới.
- Sau compaction, `contextUsage.tokens` có thể là `null` cho đến khi có assistant response mới.

Nếu user paste full mandatory-flow boilerplate, platform input guard sẽ collapse về workflow command ngắn. Nếu prompt quá dài thật, platform có thể lưu intake vào `.pi/task-inbox/` local gitignored rồi replay bằng fresh workflow command.

Tool output dài cũng bị compact theo cùng triết lý: chat giữ preview, audit/report giữ capture local. Nếu verify fail và preview chưa đủ, chạy lại command targeted hơn thay vì đổ full log vào session.

Trace, observed-bash, telemetry và capture đều bounded và owner-only. Rotation
không cần UI polling realtime, dùng lock liên process để nhiều Pi session/subagent
không ghi đè nhau. Capture mặc định giữ tối đa 500 file, 128 MiB và 30 ngày.

## Khi nào ghi benchmark

Sau một task cần so sánh workflow/model bằng số liệu:

```bash
piagent-benchmark --dry-run
piagent-benchmark --model <provider/model> --thinking high
```

Automatic runner lấy exact usage từ session JSONL và so median trên các cặp cùng
pass. Không dùng ước lượng ký tự để claim tiết kiệm token. Với một task ngoài
suite, vẫn dùng `/session`, RPC `get_session_stats`, `piagent-usage`, hoặc legacy
`piagent-benchmark <project> --record ...`.

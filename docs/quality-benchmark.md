# Quality benchmark guide

## Vì sao cần benchmark

Không nên claim tiết kiệm token/cost hoặc tăng chất lượng nếu chưa có số liệu theo cùng scenario. Token giảm khi:

- project context đã được onboard;
- profile giới hạn đúng scope;
- memory explicit giảm scout lặp;
- source cache giúp đọc targeted;
- task gate bắt verify/trace;
- tool policy chặn vòng lặp sai.

Benchmark là bằng chứng để chọn agent surface, model, profile, và workflow preset cho từng loại task.

## Ba scenario mặc định

Khởi tạo:

```bash
bash scripts/quality-benchmark.sh /path/to/project --init
```

Script tạo:

```text
.pi/benchmarks/quality-scenarios.md
```

Scenario mặc định:

1. `read-only-scout`
2. `bounded-source-fix`
3. `be-readonly-to-fe`

## Ghi một lần chạy

```bash
bash scripts/quality-benchmark.sh /path/to/project --record \
  --scenario read-only-scout \
  --surface pi \
  --result pass \
  --tokens 8200 \
  --input-tokens 6900 \
  --output-tokens 1300 \
  --cache-read-tokens 2400 \
  --duration 540 \
  --first-correct-edit 210 \
  --rework 0 \
  --notes "good plan, no edits"
```

Output:

```text
.pi/benchmarks/quality-runs.jsonl
```

## Tiêu chí so sánh

| Metric | Ý nghĩa |
|---|---|
| `result` | `pass`, `fail`, hoặc `partial` theo verify và acceptance criteria. |
| `surface` | Agent surface/workflow/model preset được dùng cho run. |
| `tokens` | Tổng token do runtime/provider báo. |
| `inputTokens` | Fresh input token, tách khỏi cache read để so context thực. |
| `outputTokens` | Token model sinh ra. |
| `cacheReadTokens` | Input được provider phục vụ từ prompt cache. |
| `cost` | Cost nếu provider báo được. |
| `durationSeconds` | Thời gian wall-clock. |
| `firstCorrectEditSeconds` | Thời gian tới edit đầu tiên còn tồn tại trong nghiệm cuối. |
| `reworkCount` | Số lượt edit bị bỏ hoặc phải làm lại. |
| `contextEfficiency` | Snapshot tool surface, duplicate read/output, retrieval utilization và context waste từ Pi Context Engine. |
| `notes` | Số lần sửa lại, missing context, wrong file, verify failure, hoặc quality observation. |

## Quy tắc claim

Chỉ claim một setup tốt hơn khi:

- cùng task/spec;
- cùng repo state;
- cùng verify command;
- ít nhất 3 lần chạy hoặc 3 scenario khác nhau;
- pass rate không thấp hơn setup hiện tại;
- fresh input token/cost giảm mà không tăng manual rework;
- time-to-first-correct-edit giảm hoặc không xấu đi;
- context waste giảm nhưng acceptance và verify vẫn giữ nguyên.

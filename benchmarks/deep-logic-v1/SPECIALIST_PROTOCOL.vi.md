# Deep Logic Specialist Protocol

## Mục tiêu

`deep-logic-v1` là benchmark paired giữa Piagent và Codex CLI cho cùng model,
cùng effort, cùng fixture và cùng hidden variant. Suite dùng để đo ba điều cùng
lúc:

1. logic cuối cùng phải đúng và không giảm so với baseline;
2. tiến trình phải ổn định, không retry/unknown usage;
3. Piagent chỉ được nhận lợi thế khi dùng ít fresh token hơn.

Benchmark không so với Raw Pi. Raw Pi chỉ là diagnostic ablation và không đủ
điều kiện tạo token-saving claim cho sản phẩm.

## Execution contract cố định

| Thuộc tính | Giá trị bắt buộc |
|---|---|
| Candidate | `piagent` |
| Baseline | controlled `codex-cli` |
| Model | `openai-codex/gpt-5.6-luna` |
| Thinking | `medium` |
| Codex mode | `controlled` |
| Repeat | 3 mỗi family |
| Family | 7 |
| Tổng model session | 42 |
| Infrastructure retry | 0 |
| Timeout | 1.200 giây/session |

Suite từ chối model, thinking, surface hoặc Codex mode khác trước khi gọi
provider. Chạy chọn lẻ scenario chỉ dùng để chẩn đoán; không đủ full-suite claim.

## Specialist family mới

`temporal-usage-billing-close` mô phỏng đóng kỳ cước usage thật, trải qua ba
module backend/UI. Nó buộc solver xử lý đồng thời:

- plan có hiệu lực theo timeline và boundary half-open;
- tier lũy tiến, reset đúng lúc đổi plan, cô lập tenant/meter;
- reversal độc lập thứ tự input và chống double/forward reversal;
- phép nhân/sum bằng `BigInt`, không mất chính xác trên `2^53`;
- round-half-to-even đúng một lần khi đóng invoice;
- canonical JSON và SHA-256 audit digest cho nested allocation;
- output Terminal/WebUI giống nhau;
- validation fail-closed, chống prototype pollution và không mutate input.

Hidden grader có 14 nhóm kiểm tra hành vi:

1. period và timeline normalization;
2. timeline validation fail-closed;
3. exact tier boundary và một event đi qua nhiều tier;
4. plan boundary và tier reset;
5. tenant/meter isolation;
6. reversal trước rating;
7. reversal reference/tenant/time/cardinality;
8. permutation-independent canonical output;
9. `BigInt` exactness;
10. round-half-to-even;
11. invoice total, shape và nested digest;
12. event validation và deep immutability;
13. non-JSON/poison rejection;
14. Terminal/WebUI summary parity.

Variant riêng cho từng repeat thay tenant, meter, plan id, tier boundary và
price. Grader kiểm tra hành vi, không kiểm tra regex/source shape.

## Token accounting

Mỗi accepted hoặc failed attempt ghi các trường sau:

| Trường | Ý nghĩa |
|---|---|
| `input` | fresh input, đã loại cache read và cache write |
| `output` | toàn bộ output của provider |
| `reasoning` | phần nằm trong `output`, không cộng lần hai |
| `cacheRead` | input lấy từ provider cache |
| `cacheWrite` | input ghi vào provider cache |
| `fresh` | `input + output`, dùng làm tỷ lệ claim |
| `total` | `input + cacheRead + cacheWrite + output` |

Nguồn đo phải là `pi-session-jsonl` hoặc `codex-turn-completed`. Dòng JSON hỏng,
field token thiếu, tổng không khớp hoặc provider-started attempt không có usage
đều fail closed; số không biết dùng trạng thái unknown, không giả thành 0.

Report xuất:

- từng run: model, thinking, source, mọi token field, tool count và duration;
- median theo surface;
- tổng token accepted, failed và all attempts;
- exact/unknown attempt completeness;
- paired geometric-mean fresh-token ratio;
- 95% CI cluster theo scenario family, không giả repeat là family độc lập;
- failure-aware fresh tokens trên mỗi resolved outcome.

## Gate

Piagent chỉ pass suite khi đồng thời:

- quality ≥ 9,5; safety = 10; reliability/workflow/category ≥ 9,5;
- mọi task/band score lớn hơn 9,5 và không có paired regression;
- đủ 7 family × 3 repeat trên cả hai surface;
- fresh-token ratio upper 95% CI ≤ 0,80;
- duration point ratio ≤ 1,00 và upper 95% CI ≤ 1,10;
- không retry, không unknown usage, provider-wire model/effort/prefix ổn định;
- source là exact clean Git commit.

## Lệnh

Validate miễn phí, không gọi model:

```bash
npm run benchmark:deep -- --dry-run
```

Chạy paid benchmark đầy đủ sau khi operator xác nhận quota:

```bash
npm run benchmark:deep
```

Kết quả nằm trong `report.json`, `report.html`, `summary.txt` và `runs.jsonl`.

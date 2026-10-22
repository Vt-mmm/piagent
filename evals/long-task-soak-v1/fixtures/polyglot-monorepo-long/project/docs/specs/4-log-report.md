# Spec 4 — Điều tra log production: `scripts/log_report.py`

Trạng thái: **chưa giao**.

Ngày 14/10 có một sự cố: web-js trả 5xx hàng loạt trong khoảng hơn 20 phút.
`logs/prod-2025-10.log` là log export của ngày đó (web-js và pricing-py gộp
chung một file, ~25 000 dòng). Cần một tool đọc log và in báo cáo, để postmortem
và để chạy lại cho các sự cố sau.

## Tool

`python3 scripts/log_report.py <log file> [--top N]` (Python 3.9, stdlib only)
in ra stdout **một** JSON object (exit 0). File không mở được → message ra
stderr, exit 2. `--top` mặc định 5.

```json
{
  "total_lines": 0,
  "unparsed_lines": 0,
  "requests": 0,
  "top_errors": [{"signature": "...", "count": 0}],
  "p95_latency_ms": {"GET /accounts/{id}/quotes": 0},
  "incident": {"start": "...Z", "end": "...Z", "minutes": 0, "requests": 0, "errors_5xx": 0, "top_error": "..."}
}
```

## Định nghĩa (bắt buộc đúng, test so số chính xác)

Log có hai kiểu dòng hợp lệ; tự đọc file để nắm format. Lưu ý: web-js log giờ
**UTC**, pricing-py log giờ **local có offset** (`+0700`). Mọi so sánh thời gian
làm theo UTC.

- `total_lines`: số dòng của file.
- **Request**: dòng access log của web-js có đủ `method`, `path`, `status`,
  `latency_ms`. `requests` = số dòng như vậy.
- `unparsed_lines`: dòng không phải dòng log hợp lệ của web-js hay pricing-py
  (traceback, dòng rác, access log bị cắt mất `status`/`latency_ms`, ...).
- **Error**: dòng level ERROR của pricing-py, hoặc dòng `level=error` có `msg="..."` của web-js.
  Signature = `<service>: <message>` với service là `web-js` hoặc `pricing-py`;
  message của web-js là nội dung trong `msg="..."`, của pricing-py là toàn bộ
  phần sau level (bắt đầu từ tên logger, vd `pricing.order: ...`). Chuẩn hoá
  message theo thứ tự: (1) mọi chuỗi hex ≥ 8 ký tự `[0-9a-f]` đứng riêng
  (word boundary) → `<hex>`; (2) mọi chuỗi chữ số → `<n>`.
- `top_errors`: N signature nhiều nhất, sort theo count giảm dần rồi signature tăng dần.
- **Endpoint** = `METHOD path` với path bỏ query string, bỏ một `/` cuối (trừ
  path `/`), và mọi segment khớp `^[A-Z]-\d+$` hoặc `^\d+$` thay bằng `{id}`.
  `p95_latency_ms`: mọi endpoint, nearest-rank p95 (sort tăng dần, lấy phần tử thứ
  `ceil(0.95 × n)`), không tính request có `latency_ms=-`.
- **Incident**: gom request theo phút UTC (theo timestamp của dòng). Một phút là
  "nóng" khi `5xx / requests ≥ 0.2`. Incident = chuỗi phút nóng **liên tiếp** dài
  nhất (bằng nhau thì lấy chuỗi sớm nhất). `start` = đầu phút đầu tiên, `end` =
  đầu phút ngay sau phút cuối (exclusive), dạng `YYYY-MM-DDTHH:MM:SSZ`;
  `minutes`, `requests`, `errors_5xx` tính trên các phút đó; `top_error` =
  signature xuất hiện nhiều nhất (tie: nhỏ nhất theo thứ tự chữ) trong các error có
  thời điểm (UTC) thuộc `[start, end)`. Không có phút nóng nào → `"incident": null`.

## Test và kết quả

- `scripts/tests/test_log_report.py` (unittest, log nhỏ tự viết trong test, phủ
  cả hai format, giờ +0700, dòng hỏng, `latency_ms=-`, normalize signature).
- Ghi tóm tắt sự cố (khung giờ UTC, lỗi chính, endpoint chậm nhất theo p95) vào
  `docs/incidents/2025-10-14.md`.

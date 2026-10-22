# kho-hang

Thư viện, API HTTP và dòng lệnh quản lý tồn kho nhiều kho cho chuỗi cửa hàng
nhỏ. Chỉ dùng Node.js (≥ 22), không có thư viện ngoài.

## Cài đặt và kiểm thử

```bash
npm test          # node --test 'test/*.test.js'
```

## Thư viện (`src/index.js`)

- `receive(sku, qty, { lot, expiresOn, warehouse })` nhập hàng theo lô; kho mặc định `MAIN`.
- `available(sku, warehouse?)`, `onHand(sku, warehouse?)`: không truyền kho thì cộng mọi kho.
- `reserve(orderId, sku, qty, { warehouse })`, `release(orderId)`, `commit(orderId)` xuất theo FEFO.
  Không cho tồn âm, không backorder: thiếu hàng thì `commit` từ chối cả đơn
  (`INSUFFICIENT_STOCK`) và giữ nguyên giữ chỗ.
- `transfer(id, sku, qty, { from, to, lot })`, `completeTransfer(id)`, `cancelTransfer(id)`:
  điều chuyển giữa các kho. Lô đã hết hạn không bao giờ được chuyển: lỗi `EXPIRED_LOT`.
- `importCsv(text)`, `exportCsv({ warehouse, all })`, `lowStock`, `expiringWithin`.
- `stockReport({ warehouse })`: mỗi dòng một cặp kho/SKU, sắp theo `available` giảm dần,
  rồi mã kho, rồi SKU.
- `events()` trả bản sao nhật ký sự kiện (chỉ ghi thêm), `Inventory.replay(events, { clock })`
  dựng lại trạng thái từ sự kiện (áp dụng đúng các lô đã ghi, không chạy lại FEFO).
- `importFile(inventory, path)` trong `src/import.js`: nhập file CSV lớn (như
  `data/stock-2025.csv`), dòng lỗi được báo kèm số dòng.

## API HTTP (`src/server.js`, `bin/server.js`)

`PORT=8080 KHO_LOG=kho.log.jsonl node bin/server.js`

| Route | Ý nghĩa |
| --- | --- |
| `POST /receive` | nhập hàng |
| `POST /orders/:id/reserve`, `/release`, `/commit` | giữ chỗ, bỏ giữ chỗ, xuất kho |
| `POST /transfers`, `/transfers/:id/complete`, `/transfers/:id/cancel` | điều chuyển |
| `GET /stock/:sku?warehouse=` | tồn và khả dụng |
| `GET /reports/low-stock?threshold=`, `/reports/expiring?days=`, `/reports/stock` | báo cáo |

Mã lỗi → HTTP: `INVALID_INPUT`/`INVALID_JSON` 400, `UNKNOWN_ORDER`/`UNKNOWN_TRANSFER`/`NOT_FOUND` 404,
`METHOD_NOT_ALLOWED` 405, `INSUFFICIENT_STOCK` 409, `PAYLOAD_TOO_LARGE` 413, `EXPIRED_LOT` 422,
`IDEMPOTENCY_KEY_REUSED` 422. Gửi header `Idempotency-Key` với các lệnh ghi để gửi lại an toàn:
cùng khoá cùng nội dung thì nhận lại đúng phản hồi cũ, kể cả sau khi khởi động lại.

## Nhật ký (`KHO_LOG`)

Mọi thay đổi được ghi thêm vào file JSON lines; khi khởi động, trạng thái được dựng lại
bằng cách phát lại nhật ký. File chỉ được ghi thêm, không bao giờ sửa.

## Dòng lệnh (`bin/kho.js`)

```bash
node bin/kho.js receive A 5 --lot L1 --expires 2026-03-20 --warehouse HN
node bin/kho.js reserve o1 A 2
node bin/kho.js release o1
node bin/kho.js commit o1 --json
node bin/kho.js transfer t1 A 1 --from HN --to MAIN [--lot L1]
node bin/kho.js transfer-complete t1
node bin/kho.js transfer-cancel t1
node bin/kho.js import data/stock-2025.csv
node bin/kho.js stock A --warehouse HN --json
node bin/kho.js report low-stock --threshold 5
node bin/kho.js report expiring --days 30
node bin/kho.js report stock --json
node bin/kho.js serve --port 8080
```

Tham số chung: `--log <file>` (mặc định biến `KHO_LOG`, rồi `kho.log.jsonl`),
`--today YYYY-MM-DD` để cố định ngày, `--json` để in JSON.
Mã thoát: 0 thành công, 1 lỗi nghiệp vụ (stderr bắt đầu bằng mã lỗi), 2 sai cú pháp,
3 khi import có dòng lỗi (các dòng đúng vẫn được nhập).

## Báo cáo cũ (`src/legacy/report-engine.js`)

Giữ nguyên mọi hàm `rpt_*` và output từng ký tự; phần xử lý nằm trong `src/reports/`
(tính toán theo nhóm báo cáo, định dạng text/csv/html/json/md dùng chung).

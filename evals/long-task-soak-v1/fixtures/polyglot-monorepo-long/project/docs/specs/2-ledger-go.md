# Spec 2 — `services/ledger-go` + shared contract conformance

Trạng thái: **chưa giao** (làm sau khi release 2.0.0 xong).

Team finance cần một service ghi sổ: đọc file event order (JSON Lines) và tính
balance theo account. Viết bằng Go (stdlib only), và nhân dịp này làm luôn bộ
**shared contract test**: cùng một bộ payload mẫu được validate ở cả Python,
Node và Go, ba bên phải cho cùng kết quả.

## Chạy Go

Máy dev không cài Go; chạy qua Docker image `golang:1.26.3-alpine3.23` (đã pull,
không cần network, không dùng module ngoài):

```bash
docker run --rm -v "$PWD":/src -w /src/services/ledger-go golang:1.26.3-alpine3.23 go test ./...
docker run --rm -v "$PWD":/src -w /src/services/ledger-go golang:1.26.3-alpine3.23 go vet ./...
```

(Mount cả repo vì test conformance đọc `shared/contracts/`. Nếu repo nằm ngoài
thư mục Docker được share, stream repo vào container bằng `tar` thay cho `-v`.)

## Layout

- `services/ledger-go/go.mod`: `module shopflow.test/ledger-go`, `go 1.26`.
- `services/ledger-go/ledger/` — package `ledger` (API bên dưới).
- `services/ledger-go/cmd/ledger/main.go` — CLI.
- Luật rename của `TODO.md` vẫn áp dụng: tên field cũ của v1 chỉ được xuất hiện
  trong file có chữ `compat` trong tên (vd `ledger/compat_v1.go`, `compat_v1_test.go`).

## Package `ledger` (exported API, đúng tên)

```go
type ContractError struct { Code string; Message string }   // Error() string; Code: INVALID | MIXED_FIELDS | UNSUPPORTED_VERSION
type Item struct { SKU string; Qty int64; UnitPrice int64 }
type Order struct {
    OrderID, AccountID, AccountTier, Currency string
    Items         []Item
    SourceVersion int // 1 hoặc 2
}
func ParseOrder(data []byte) (Order, error)          // lỗi luôn là *ContractError (JSON hỏng / không phải object: INVALID)
func MarshalOrder(o Order) ([]byte, error)           // luôn ghi v2, key đúng thứ tự schema, không khoảng trắng
type Quote struct { OrderID, AccountID, Currency string; Subtotal, Discount, Total int64 }
func QuoteOrder(o Order) Quote                       // cùng công thức pricing-py quote()
type Balance struct { AccountID string `json:"account_id"`; Currency string `json:"currency"`; Balance int64 `json:"balance"` }
type Rejection struct { Line int `json:"line"`; EventID string `json:"event_id"`; Code string `json:"code"` }
type Report struct { Accepted int `json:"accepted"`; Balances []Balance `json:"balances"`; Rejected []Rejection `json:"rejected"` }
func Process(r io.Reader) (Report, error)            // error chỉ khi đọc r lỗi
```

`ParseOrder` theo đúng "Luật đọc contract" trong `TODO.md` (v1 qua compat shim,
`MIXED_FIELDS`, `UNSUPPORTED_VERSION`, `INVALID`), giống hệt `parse_order` /
`parseOrder`. Số nguyên trong JSON phải là số nguyên thật (`1.5`, `true`, `"2"`
không phải số nguyên). Go không có warning cho v1, chỉ đọc.

## Event file

Mỗi dòng một event: `{"event_id": "EV-1", "type": "order.placed" | "order.refunded", "order": { ...order payload v1/v2... }}`.

`Process` xử lý từng dòng (số dòng tính từ 1, kể cả dòng trống); dòng chỉ có
khoảng trắng thì bỏ qua (không reject). Thứ tự kiểm tra và code reject:

1. `BAD_JSON` — dòng không phải một JSON object (`event_id` = `""`).
2. `BAD_EVENT` — `event_id` không phải string khác rỗng, hoặc không có key `order`.
3. `UNKNOWN_TYPE` — `type` không phải `order.placed` / `order.refunded`.
4. `DUPLICATE` — `event_id` đã thuộc một event **được ghi sổ** trước đó (event bị reject không giữ chỗ id).
5. code của `ParseOrder` (`INVALID`, `MIXED_FIELDS`, `UNSUPPORTED_VERSION`).

Event hợp lệ: amount = `QuoteOrder(order).Total`; `order.placed` cộng,
`order.refunded` trừ vào balance của (`account_id`, `currency`). `Balances`:
mỗi cặp có ít nhất một event được ghi, sort theo `account_id` rồi `currency`
(balance có thể bằng 0 hoặc âm). `Rejected` theo thứ tự dòng. JSON của Report
luôn có `[]` (không `null`) cho list rỗng.

CLI: `ledger <events.jsonl>` in Report dạng JSON ra stdout, exit 0 (kể cả khi có
dòng bị reject); sai tham số hoặc không mở được file → message ra stderr, exit 2.
Thêm `services/ledger-go/testdata/` với một file event mẫu và test cho nó.

## Shared contract conformance

- `shared/contracts/conformance/cases.json`: ≥ 15 case, mỗi case
  `{"name": "...", "payload": <bất kỳ JSON>, "expect": {"error": "<CODE>"}}` hoặc
  `{"expect": {"ok": {"source_version": 2, "account_id": "...", "account_tier": "...", "currency": "...", "subtotal": n, "discount": n, "total": n}}}`
  (trong `ok` chỉ cần các key muốn kiểm). Phải có case `ok` và đủ ba code lỗi.
- Case dùng tên field cũ (v1, hoặc v2 trộn field cũ) để riêng trong
  `shared/contracts/conformance/cases-compat-v1.json` (≥ 3 case).
- Mỗi service có test chạy **mọi** file `*.json` trong thư mục đó:
  `services/pricing-py/tests/test_conformance.py`, `services/web-js/test/conformance.test.js`,
  `services/ledger-go/ledger/conformance_test.go`.
- web-js chưa có quote: thêm `src/quote.js` với `quoteOrder(order)` →
  `{ orderId, accountId, currency, subtotal, discount, total }` (cùng công thức
  pricing-py), export từ `src/index.js`.

## Bug đã biết (sửa trong spec này)

Ticket SHOP-412: pricing-py nhận currency `"US1"` (dùng `str.isupper()`), web-js
thì từ chối. Schema là nguồn chân lý: `currency` phải khớp `^[A-Z]{3}$` ở cả ba
service. Nếu conformance còn chỉ ra chỗ lệch khác thì sửa theo schema và `TODO.md`.

## Xong khi

Python unittest, `npm test` (web-js), `go vet` + `go test` (Docker) đều xanh;
CLI chạy được trên file mẫu.

# Spec 3 — Order contract v3 (settlement currency) ở cả ba service

Trạng thái: **chưa giao** (làm sau spec 2).

Finance muốn ghi sổ theo **tiền tệ thanh toán** (settlement currency), khác với
tiền tệ của order. Contract v3 = v2 + hai field. Cả pricing-py, web-js và
ledger-go phải đọc được v1 / v2 / v3.

## Contract v3

File mới `shared/contracts/order.v3.schema.json` (`$id`
`https://contracts.shopflow.test/order/v3`, `x-contract-version: 3`,
`contract_version` const `3`). `order.schema.json` **giữ nguyên v2** (writer
mặc định vẫn ghi v2, xem dưới).

| Field mới | Kiểu | Luật |
| --- | --- | --- |
| `settlement_currency` | string | khớp `^[A-Z]{3}$` |
| `fx_rate_ppm` | integer | `1 ≤ fx_rate_ppm ≤ 1 000 000 000`: số đơn vị settlement cho 1 đơn vị `currency`, nhân 10^6. Nếu `settlement_currency == currency` thì phải đúng bằng `1000000`. |

Sample v3 để trong `shared/contracts/fixtures/v3/` (≥ 2 file, ít nhất một file có
`settlement_currency` khác `currency`). Sample v2 cũ trong `fixtures/*.json` giữ nguyên.

## Luật đọc (thay bảng trong `TODO.md`)

| Payload | Kết quả |
| --- | --- |
| v3 đủ field | `source_version` = 3 |
| v2 | như cũ; settlement = `currency`, `fx_rate_ppm` = 1000000 |
| v1 (legacy) | như cũ (compat shim + `DeprecationWarning` ở Python); settlement mặc định như v2 |
| v3 có field cũ của v1; v2 có `settlement_currency` hoặc `fx_rate_ppm`; v1 có field v2 **hoặc** field v3 | `MIXED_FIELDS` |
| version khác 1/2/3 (hoặc không phải số nguyên thật) | `UNSUPPORTED_VERSION` |
| v3 thiếu/sai `settlement_currency` hoặc `fx_rate_ppm` (ngoài khoảng, không phải số nguyên, settlement trùng currency mà rate ≠ 1000000) | `INVALID` |

Order đọc ra có thêm: Python `settlement_currency`, `fx_rate_ppm`; JS
`settlementCurrency`, `fxRatePpm`; Go `SettlementCurrency string`, `FxRatePPM int64`.

## Writer

Ghi version **thấp nhất** chở được order: nếu settlement = currency và rate =
1000000 thì ghi **v2** đúng như hiện tại (consumer cũ vẫn đọc được), ngược lại
ghi **v3** với key theo thứ tự `contract_version, order_id, account_id,
account_tier, currency, settlement_currency, fx_rate_ppm, items`. Áp dụng cho
`Order.to_dict()`, `toWire()` và `MarshalOrder()`.

## Settlement total

`settlement_total = floor(total × fx_rate_ppm / 1 000 000)`, `total` là quote
total (sau discount tier). Phải **chính xác tuyệt đối**: tích có thể vượt 2^53
(JS không được tính bằng Number thường).

- Python: `settlement_total(order)` (export từ `pricing`).
- JS: `settlementTotal(order)` trả Number (export từ `src/index.js`).
- Go: `SettlementTotal(o Order) int64`.
- ledger-go: balance tính theo (`account_id`, `settlement_currency`) với amount =
  `SettlementTotal`. Event v1/v2 không đổi kết quả so với trước.

## Test

- Conformance: thêm case v3 (file mới trong `shared/contracts/conformance/`,
  `ok` có thể kiểm thêm `settlement_currency`, `fx_rate_ppm`, `settlement_total`);
  ba bộ conformance test so cả các key này.
- **Property-style tests** với random payload có seed cố định (chạy lại ra đúng
  như cũ): `services/pricing-py/tests/test_property_v3.py` (`random.Random(SEED)`),
  `services/web-js/test/property-v3.test.js` (PRNG có seed, vd mulberry32),
  `services/ledger-go/ledger/property_test.go` (`rand.New(rand.NewSource(seed))`).
  Mỗi bộ ≥ 200 payload v1/v2/v3 hợp lệ (kiểm round-trip qua writer, invariant của
  quote và settlement total) và ≥ 100 payload bị làm hỏng một chỗ (kiểm đúng code lỗi).
- Luật rename của `TODO.md` vẫn áp dụng cho mọi file mới (tên field cũ chỉ ở file `compat`).

## Xong khi

Ba bộ test xanh (Go qua Docker), sample v3 đọc được ở cả ba service.

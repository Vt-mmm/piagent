# Order contract (v2)

File nguồn: `shared/contracts/order.schema.json` (`x-contract-version: 2`).

| Field | Kiểu | Ghi chú |
| --- | --- | --- |
| `contract_version` | `2` | bắt buộc |
| `order_id` | string | không rỗng |
| `account_id` | string | id trong Account API |
| `account_tier` | `standard` \| `gold` \| `vip` | xem account-tiers.md |
| `currency` | string | mã 3 chữ in hoa |
| `items[]` | `{ sku, qty, unit_price }` | `qty` ≥ 1, `unit_price` ≥ 0, số nguyên |

Sample: `shared/contracts/fixtures/*.json`. Writer (`to_dict` / `toWire`) luôn ghi v2.

## Legacy v1 payload

Trong suốt 2.x, reader vẫn đọc legacy v1 payload (`contract_version: 1` hoặc không
có `contract_version`, dùng tên field cũ) qua compat shim (`pricing/compat_v1.py`,
`src/compat-v1.js`); kết quả có `source_version` / `sourceVersion` = 1 và Python phát
`DeprecationWarning`. Sample: `fixtures/order-compat-v1.json`. Bỏ ở 3.0.0.

## v3: settlement currency

`shared/contracts/order.v3.schema.json` (`x-contract-version: 3`) thêm hai field:

| Field | Kiểu | Ghi chú |
| --- | --- | --- |
| `settlement_currency` | string | mã 3 chữ in hoa, tiền tệ ghi sổ |
| `fx_rate_ppm` | integer | 1 … 1 000 000 000; `1000000` khi `settlement_currency` = `currency` |

Payload v1/v2 được đọc với settlement = `currency`, rate = 1000000. Settlement total =
`floor(total × fx_rate_ppm / 1 000 000)`, số nguyên chính xác. Trộn field v3 vào v2 (hoặc
v1) là `MIXED_FIELDS`. Sample: `fixtures/v3/`.

Writer ghi version thấp nhất chở được order: v2 khi không quy đổi, v3 (key theo thứ tự
schema, `settlement_currency` và `fx_rate_ppm` ngay trước `items`) khi có.

`account_id` có khoảng trắng đầu/cuối là `INVALID` ở mọi version.

## Lỗi

Reader (`parse_order` / `parseOrder`) trả `ContractError` với `code`:

- `UNSUPPORTED_VERSION` — `contract_version` không phải 1, 2 hay 3
- `MIXED_FIELDS` — payload trộn field v1 và v2
- `INVALID` — thiếu hoặc sai field

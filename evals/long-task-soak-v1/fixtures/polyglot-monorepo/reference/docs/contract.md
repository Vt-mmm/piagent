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

## Lỗi

Reader (`parse_order` / `parseOrder`) trả `ContractError` với `code`:

- `UNSUPPORTED_VERSION` — `contract_version` không phải 1 hay 2
- `MIXED_FIELDS` — payload trộn field v1 và v2
- `INVALID` — thiếu hoặc sai field

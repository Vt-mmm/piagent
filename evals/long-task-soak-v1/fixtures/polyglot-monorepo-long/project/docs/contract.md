# Order contract (v1)

File nguồn: `shared/contracts/order.schema.json` (`x-contract-version: 1`).

| Field | Kiểu | Ghi chú |
| --- | --- | --- |
| `contract_version` | `1` | không có thì hiểu là 1 |
| `order_id` | string | không rỗng |
| `customer_id` | string | id trong Customer API |
| `customer_tier` | `standard` \| `gold` \| `vip` | xem customer-tiers.md |
| `currency` | string | mã 3 chữ in hoa |
| `items[]` | `{ sku, qty, unit_price }` | `qty` ≥ 1, `unit_price` ≥ 0, số nguyên |

Sample: `shared/contracts/fixtures/*.json`. Reader (`parse_order` / `parseOrder`)
trả lỗi `ContractError` với `code`:

- `UNSUPPORTED_VERSION` — `contract_version` khác 1
- `INVALID` — thiếu hoặc sai field

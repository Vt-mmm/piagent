# ledger-go

`services/ledger-go` ghi sổ event order thành balance theo account và settlement currency.
Go 1.26, stdlib only; máy dev chạy qua Docker:

```bash
docker run --rm -v "$PWD":/src -w /src/services/ledger-go golang:1.26.3-alpine3.23 go run ./cmd/ledger testdata/events-sample.jsonl
```

## Event

Một dòng một event (JSON Lines):

```json
{"event_id": "EV-1", "type": "order.placed", "order": { "contract_version": 3, "...": "..." }}
```

`type`: `order.placed` (cộng) hoặc `order.refunded` (trừ). Amount = settlement total của
order (v1/v2: quote total trong `currency`). Balance tính theo (`account_id`,
`settlement_currency`).

## Reject

Dòng trống bỏ qua. Dòng không ghi sổ được nằm trong `rejected` với code, theo thứ tự kiểm:

| Code | Khi nào |
| --- | --- |
| `BAD_JSON` | dòng không phải JSON object |
| `BAD_EVENT` | thiếu `event_id` (string khác rỗng) hoặc thiếu `order` |
| `UNKNOWN_TYPE` | `type` lạ |
| `DUPLICATE` | `event_id` đã thuộc một event được ghi sổ |
| `INVALID` / `MIXED_FIELDS` / `UNSUPPORTED_VERSION` | order sai contract (xem `contract.md`) |

## CLI

`ledger <events.jsonl>` in JSON `{"accepted": n, "balances": [{"account_id", "currency", "balance"}], "rejected": [{"line", "event_id", "code"}]}`,
exit 0; sai tham số hoặc không mở được file: exit 2.

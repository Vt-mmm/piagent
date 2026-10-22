# Kiến trúc

```
browser ──► web-js (BFF) ──► Customer API  (/customers/{customer_id}/quotes)
                 │
                 └──────────► pricing-py (quote theo customer_tier)
```

- **web-js** nhận order từ frontend, validate theo `shared/contracts/order.schema.json`
  (`parseOrder`), rồi gửi `toWire(order)` sang Customer API. Base URL lấy từ
  `CUSTOMER_API_URL`.
- **pricing-py** đọc cùng payload (`parse_order`) và tính quote: subtotal, discount
  theo customer tier, total. Mọi số tiền là số nguyên theo đơn vị nhỏ nhất của currency.
- Hai service release cùng version bằng `scripts/release.sh`.

Mỗi order thuộc về đúng một customer (`customer_id`). Tier của customer quyết định
discount, xem [customer-tiers.md](customer-tiers.md).

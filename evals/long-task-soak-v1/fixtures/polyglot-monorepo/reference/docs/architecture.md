# Kiến trúc

```
browser ──► web-js (BFF) ──► Account API  (/accounts/{account_id}/quotes)
                 │
                 └──────────► pricing-py (quote theo account_tier)
```

- **web-js** nhận order từ frontend, validate theo `shared/contracts/order.schema.json`
  (`parseOrder`), rồi gửi `toWire(order)` sang Account API. Base URL lấy từ
  `ACCOUNT_API_URL`.
- **pricing-py** đọc cùng payload (`parse_order`) và tính quote: subtotal, discount
  theo account tier, total. Mọi số tiền là số nguyên theo đơn vị nhỏ nhất của currency.
- Hai service release cùng version bằng `scripts/release.sh`.

Mỗi order thuộc về đúng một account (`account_id`). Tier của account quyết định
discount, xem [account-tiers.md](account-tiers.md).

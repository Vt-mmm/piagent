# pricing-py

Tính quote cho order theo `account_tier`. Python 3.9+, chỉ dùng stdlib.

```bash
python3 -m unittest discover -s tests -v
```

- `pricing/account.py` — `Account`, tier, tỉ lệ giảm giá, đọc `fixtures/accounts.json`
- `pricing/order.py` — đọc/ghi payload theo `shared/contracts/order.schema.json`
- `pricing/quote.py` — `quote(order)` → subtotal / discount / total (số nguyên, đơn vị nhỏ nhất)

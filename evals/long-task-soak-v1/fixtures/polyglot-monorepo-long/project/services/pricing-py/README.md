# pricing-py

Tính quote cho order theo `customer_tier`. Python 3.9+, chỉ dùng stdlib.

```bash
python3 -m unittest discover -s tests -v
```

- `pricing/customer.py` — `Customer`, tier, tỉ lệ giảm giá, đọc `fixtures/customers.json`
- `pricing/order.py` — đọc/ghi payload theo `shared/contracts/order.schema.json`
- `pricing/quote.py` — `quote(order)` → subtotal / discount / total (số nguyên, đơn vị nhỏ nhất)

# shopflow monorepo

Monorepo nhỏ của team checkout:

| Thư mục | Nội dung |
| --- | --- |
| `shared/contracts/` | JSON contract `order.schema.json` + sample payload trong `fixtures/` |
| `services/pricing-py/` | Pricing service (Python 3.9, chỉ stdlib) — tính quote theo customer tier |
| `services/web-js/` | Web BFF (Node 22, ESM) — parse order, gọi Customer API |
| `scripts/` | `release.sh`, `dev-env.sh` |
| `logs/` | Log production export (`prod-2025-10.log`, web-js + pricing-py gộp lại) |
| `services/web-js/src/legacy/` | `router-old.js`: router storefront-admin cũ (port từ app Express 2017) |
| `docs/` | Kiến trúc, contract, customer tiers |

## Chạy test

```bash
cd services/pricing-py && python3 -m unittest discover -s tests -v
cd services/web-js && npm test
CUSTOMER_API_URL=http://localhost:8081 bash scripts/release.sh --dry-run
```

Biến môi trường: xem `.env.example`.

Việc đang làm: xem `TODO.md`.

Roadmap: các spec trong `docs/specs/` (2 → 6) là việc của các bước sau, làm lần lượt
khi được giao; spec nào chưa được giao thì chưa đụng tới.

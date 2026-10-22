# shopflow monorepo

Monorepo nhỏ của team checkout:

| Thư mục | Nội dung |
| --- | --- |
| `shared/contracts/` | JSON contract `order.schema.json` + sample payload trong `fixtures/` |
| `services/pricing-py/` | Pricing service (Python 3.9, chỉ stdlib) — tính quote theo account tier |
| `services/web-js/` | Web BFF (Node 22, ESM) — parse order, gọi Account API |
| `services/ledger-go/` | Ledger (Go 1.26, stdlib only, chạy qua Docker) — ghi sổ event order thành balance |
| `scripts/` | `ci.sh`, `release.sh`, `dev-env.sh`, `log_report.py` |
| `logs/` | Log production export (`prod-2025-10.log`, web-js + pricing-py gộp lại) |
| `docs/` | Kiến trúc, contract, account tiers |

## Chạy test

```bash
bash scripts/ci.sh          # tất cả: Python, Node, Go (Docker), release dry-run, log report
cd services/pricing-py && python3 -m unittest discover -s tests -v
cd services/web-js && npm test
ACCOUNT_API_URL=http://localhost:8081 bash scripts/release.sh --dry-run
```

Biến môi trường: xem `.env.example`.

Việc đang làm: xem `TODO.md`.

Roadmap: các spec trong `docs/specs/` (2 → 6) là việc của các bước sau, làm lần lượt
khi được giao; spec nào chưa được giao thì chưa đụng tới.

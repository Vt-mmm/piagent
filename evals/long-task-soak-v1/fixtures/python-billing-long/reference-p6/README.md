# billing

Subscription billing for the Acme SaaS: plans, invoices, plan changes,
coupons, tax, refunds and invoice export. The full specification is in
`SPEC.md`.

Pure Python, no runtime dependencies. Tests use pytest from the project's
virtualenv:

```bash
.venv/bin/python -m pytest -q
```

(If `.venv` is missing: `uv venv .venv && uv pip install --python .venv/bin/python pytest==8.3.5`.)

## Documents

- `SPEC.md`: billing v1 (plans, invoices, coupons, tax, refunds, export).
- `docs/DUNNING.md`: failed payments, retries, grace period and suspension.
- `docs/MULTICURRENCY.md`: billing in the customer's currency with `data/fx_rates.csv`.
- `docs/REPORTS.md`: the finance reports (`src/billing/legacy_reports.py`) and their planned refactor.
- `docs/PERSISTENCE.md`: SQLite storage, schema migrations and the import of `data/invoices_2025.jsonl`.
- `docs/CLI.md`: the `python -m billing` command line.

`data/` holds the exchange-rate table and the 2025 export of the old back
office; do not edit those files.

## Command line

Run from the project root with `src` on the path:

```bash
PYTHONPATH=src .venv/bin/python -m billing <command> [options]
```

| command | example |
|---|---|
| `migrate` | `python -m billing migrate --db billing.db` → `schema version 2` |
| `import` | `python -m billing import data/invoices_2025.jsonl --db billing.db --errors errors.csv` → `imported 14970, rejected 30` |
| `report` | `python -m billing report revenue-by-month --db billing.db --year 2025` |
| `export` | `python -m billing export --db billing.db --format csv --year 2025` |

Exit codes: 0 success, 1 a billing error (`error: CODE: message` on stderr),
2 a usage error.

### Reports

Add `--csv` for the CSV variant (all reports except `close-pack`).

| report | options | example |
|---|---|---|
| `revenue-by-month` | `--year` | `report revenue-by-month --year 2025` |
| `revenue-by-quarter` | `--year` | `report revenue-by-quarter --year 2025 --csv` |
| `revenue-by-week` | `--year` | `report revenue-by-week --year 2025` |
| `revenue-by-country` | `[--year]` | `report revenue-by-country --year 2025` |
| `revenue-by-plan` | `[--year]` | `report revenue-by-plan` |
| `vat` | `--country --year --quarter` | `report vat --country DE --year 2025 --quarter 2` |
| `aging` | `--as-of` | `report aging --as-of 2025-12-31` |
| `statement` | `--customer` | `report statement --customer C00042` |
| `top-customers` | `[--year] [--limit]` | `report top-customers --year 2025 --limit 5` |
| `coupon-usage` | `[--year]` | `report coupon-usage --year 2025` |
| `refunds` | `--year` | `report refunds --year 2025` |
| `status-summary` | `[--year]` | `report status-summary` |
| `daily-sales` | `--year --month` | `report daily-sales --year 2025 --month 2` |
| `invoice-register` | `--year --month` | `report invoice-register --year 2025 --month 3 --csv` |
| `mrr` | `--year` | `report mrr --year 2025` |
| `churn` | `--year` | `report churn --year 2025` |
| `discount-leakage` | `[--year]` | `report discount-leakage --year 2025` |
| `tax-summary` | `--year` | `report tax-summary --year 2025` |
| `close-pack` | `--year --month` | `report close-pack --year 2025 --month 6` |

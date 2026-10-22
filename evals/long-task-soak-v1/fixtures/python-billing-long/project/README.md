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

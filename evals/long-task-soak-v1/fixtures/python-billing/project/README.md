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

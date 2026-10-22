# Finance reports

The finance reports live in `src/billing/legacy_reports.py`: about 3,500
lines ported from the old PHP back office in 2019 and copied forward ever
since (one VAT return per country, a CSV twin of almost every text report,
the same sort/filter/sum loop in every function).

## Invoice records

Every report function takes `records`, a list of dicts, one per invoice,
followed by its own parameters, and returns the whole report as a `str`.

| key | type | example |
|---|---|---|
| `number` | str | `"INV-2025-00042"` |
| `customer_id` | str | `"C00042"` |
| `subscription_id` | str or null | `"SUB-00017"` |
| `plan` | str or null | `"pro"` |
| `country` | str | `"DE"` |
| `currency` | str | `"EUR"` |
| `issued_on` | str, ISO date | `"2025-03-14"` |
| `subtotal`, `discount`, `tax`, `total`, `refunded` | str, decimal | `"35.70"`, `"1510"` |
| `status` | str | `paid`, `partially_refunded`, `refunded`, `past_due` |
| `coupon_code` | str or null | `"WELCOME10"` |

`tests/golden/sample_invoices.jsonl` holds 640 such records, and
`tests/golden/reports/` the output of every report for the cases listed in
`cases.json`; `tests/test_legacy_reports_golden.py` checks them byte for
byte. **The output must never change**: finance diff the reports month to
month and the accountants' macros parse the CSV variants column by column.

## Refactoring the reports (planned)

Split `legacy_reports.py` into a package `src/billing/reports/` with the
same public functions and byte-identical outputs:

- `from billing.reports import revenue_by_month, vat_return, ...` works for
  every public function of `legacy_reports.py` (every top-level function
  whose name does not start with `_`), with the same parameters, defaults
  and outputs. The private helpers and the `__main__` block of the legacy
  file need not survive.
- The package has at least four modules besides `__init__.py`, grouped by
  topic; no module is longer than 600 lines and no function longer than 80
  lines. The shared logic (sorting and filtering records, sums per
  currency, number formatting, table layout) is written once.
- Every public function is fully type-annotated (every parameter and the
  return type).
- `billing/legacy_reports.py` is either deleted or reduced to a re-export
  shim of at most 40 lines; nothing in `billing.reports` imports it.
- The golden test runs against `billing.reports` and passes.

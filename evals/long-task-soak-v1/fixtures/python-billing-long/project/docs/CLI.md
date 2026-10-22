# Command line

Status: specified, not implemented. Builds on all the other documents.

`python -m billing <command> [options]` (run with `src` on the path, e.g.
`PYTHONPATH=src .venv/bin/python -m billing ...`). Standard library only
(`argparse`).

Exit codes: `0` success; `2` usage errors (unknown command or report, a
missing or malformed option), with argparse's message on stderr; `1` when a
`BillingError` stops the command, with `error: <CODE>: <message>` on stderr.
Nothing but the command's output goes to stdout.

## Commands

| command | does | prints |
|---|---|---|
| `migrate --db PATH` | `storage.migrate` | `schema version 2` |
| `import FILE --db PATH [--errors CSV]` | `storage.import_jsonl`; with `--errors`, `write_error_report` | `imported 14970, rejected 30` |
| `report NAME --db PATH [options]` | one finance report over every stored invoice (`storage.report_records(conn)`, no year filter) | the report, exactly as `billing.reports` returns it |
| `export --db PATH --format csv\|json [--year Y]` | `export_csv` / `export_json` of `InvoiceRepository.list(year=Y)` | the export |

`import`, `report` and `export` migrate the database first when needed.

## Reports

Every report takes `--csv` to print its CSV variant, except `close-pack`.

| NAME | options | function |
|---|---|---|
| `revenue-by-month` | `--year Y` | `revenue_by_month` |
| `revenue-by-quarter` | `--year Y` | `revenue_by_quarter` |
| `revenue-by-week` | `--year Y` | `revenue_by_week` |
| `revenue-by-country` | `[--year Y]` | `revenue_by_country` |
| `revenue-by-plan` | `[--year Y]` | `revenue_by_plan` |
| `vat` | `--country CC --year Y --quarter Q` | `vat_return` |
| `aging` | `--as-of YYYY-MM-DD` | `aging_report` |
| `statement` | `--customer ID` | `customer_statement` |
| `top-customers` | `[--year Y] [--limit N]` (default 10) | `top_customers` |
| `coupon-usage` | `[--year Y]` | `coupon_usage` |
| `refunds` | `--year Y` | `refund_report` |
| `status-summary` | `[--year Y]` | `status_summary` |
| `daily-sales` | `--year Y --month M` | `daily_sales` |
| `invoice-register` | `--year Y --month M` | `invoice_register` |
| `mrr` | `--year Y` | `mrr_report` |
| `churn` | `--year Y` | `churn_report` |
| `discount-leakage` | `[--year Y]` | `discount_leakage` |
| `tax-summary` | `--year Y` | `tax_summary` |
| `close-pack` | `--year Y --month M` | `monthly_close_pack` |

A required option that is missing is a usage error (exit 2). `vat` with a
country that has no VAT return is a usage error too.

## Documentation

README.md gets a "Command line" section that shows how to run the CLI and
documents every command and every report name above with an example.

## Tests

Tests for the commands under `tests/` (run the CLI in a subprocess with
`sys.executable -m billing` and `PYTHONPATH=src`); `.venv/bin/python -m
pytest -q` passes.

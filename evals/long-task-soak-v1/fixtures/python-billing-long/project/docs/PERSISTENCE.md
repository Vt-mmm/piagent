# Persistence: SQLite storage, migrations and the 2025 import

Status: specified, not implemented. Builds on SPEC.md, docs/DUNNING.md,
docs/MULTICURRENCY.md and docs/REPORTS.md. Everything here is decided.
Standard library only (`sqlite3`).

Everything below is importable from `billing.storage` (a module or a
package, your choice).

## 1. Connections and schema versions

- `connect(path) -> sqlite3.Connection` opens (or creates) the database;
  `":memory:"` works. Foreign keys are on.
- `schema_version(conn) -> int` is SQLite's `PRAGMA user_version`: `0` for
  an empty database.
- `migrate(conn, target=2) -> int` applies the migrations after the current
  version, in order, up to `target`, and returns the new version. Each
  migration runs in one transaction together with its version bump: when it
  fails nothing of it is kept and the version does not move. Migrating a
  database that is already at `target` changes nothing. A target above the
  latest version raises `BillingError("UNKNOWN_SCHEMA_VERSION")`.

### Version 1 (what the old back office wrote; exact DDL)

```sql
CREATE TABLE invoices (
    number TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL,
    subscription_id TEXT,
    plan TEXT,
    country TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    issued_on TEXT NOT NULL,
    subtotal TEXT NOT NULL,
    discount TEXT NOT NULL,
    tax TEXT NOT NULL,
    total TEXT NOT NULL,
    refunded TEXT NOT NULL,
    status TEXT NOT NULL,
    coupon_code TEXT
);
CREATE TABLE invoice_lines (
    invoice_number TEXT NOT NULL REFERENCES invoices(number),
    position INTEGER NOT NULL,
    description TEXT NOT NULL,
    amount TEXT NOT NULL,
    PRIMARY KEY (invoice_number, position)
);
```

Amounts are decimal strings (`"12.30"`, `"4950"`).

### Version 2

- Amounts become integers in the currency's minor unit
  (`CURRENCY_DECIMALS`, docs/MULTICURRENCY.md): `invoices` has
  `subtotal_minor`, `discount_minor`, `tax_minor`, `total_minor`,
  `refunded_minor` (`INTEGER NOT NULL`) instead of the text amount columns,
  and `invoice_lines` has `amount_minor INTEGER NOT NULL` instead of
  `amount`. `"12.30"` EUR is `1230`; `"4950"` JPY is `4950`. All other
  columns stay as they are.
- New table `customers(id TEXT PRIMARY KEY, country TEXT NOT NULL,
  first_invoice_on TEXT NOT NULL)`.
- Indexes on `invoices(customer_id)` and `invoices(issued_on)`.

The 1→2 migration converts the existing rows: every amount must convert
exactly (a value that is not a decimal number, has more decimals than its
currency allows, or whose currency is not in `CURRENCY_DECIMALS` fails the
migration with `BillingError("MIGRATION_FAILED")`, naming the invoice). It
fills `customers` with one row per customer: the country and the
`issued_on` of the customer's earliest invoice (earliest `issued_on`, then
lowest `number`).

## 2. Repository

`InvoiceRepository(conn)` stores `billing.Invoice` objects in a version 2
database (it raises `BillingError("SCHEMA_OUTDATED")` on an older one):

- `add(invoice)`: a number already stored raises `DUPLICATE_INVOICE`. The
  lines are stored in order (`position` from 1). `plan` is stored as NULL.
  The customer row is created when the customer is new (it keeps the first
  country and date it was created with).
- `get(number) -> Invoice` (`UNKNOWN_INVOICE` when absent): the same
  number, customer, subscription, country, currency, `issued_on` (a
  `date`), lines, amounts (`Decimal`s with the currency's decimals),
  status and coupon code as were stored. `fx_rate` and `total_usd` are not
  stored in version 2 and come back as the `Invoice` defaults.
- `update(invoice)`: stores the current `status` and `refunded` of an
  invoice already stored (`UNKNOWN_INVOICE` otherwise).
- `list(customer_id=None, status=None, year=None) -> list[Invoice]`
  ordered by `issued_on`, then `number`; each filter applies when given.
- `count() -> int`.

## 3. Importing data/invoices_2025.jsonl

The old back office exported 2025 as `data/invoices_2025.jsonl`: one JSON
object per line, in the record format of docs/REPORTS.md. About thirty of
its 15,000 lines are bad. Do not edit the file.

`import_jsonl(conn, path) -> ImportReport` migrates the database to the
latest version first, then checks every line. Line numbers are 1-based
physical lines; blank lines are skipped and neither imported nor rejected.
The **first** rule a line breaks, in this order, is its error code:

1. `BAD_JSON`: not valid JSON, or not a JSON object.
2. `MISSING_FIELD`: one of `number`, `customer_id`, `country`, `currency`,
   `issued_on`, `subtotal`, `discount`, `tax`, `total`, `status` is absent
   or null (`detail` is the first such field in this order). `subscription_id`,
   `plan`, `coupon_code` are optional; `refunded` is optional and defaults
   to `"0"`.
3. `BAD_DATE`: `issued_on` is not a real date written exactly `YYYY-MM-DD`.
4. `BAD_AMOUNT`: an amount (`subtotal`, `discount`, `tax`, `total`,
   `refunded`) is not a string of digits with an optional `.` and digits
   (no sign, no exponent, no thousands separator).
5. `UNKNOWN_CURRENCY`: `currency` is not in `CURRENCY_DECIMALS`.
6. `BAD_AMOUNT`: an amount has more decimals than its currency allows.
7. `TOTAL_MISMATCH`: `subtotal - discount + tax != total`.
8. `BAD_STATUS`: `status` is not one of `paid`, `partially_refunded`,
   `refunded`, `past_due`.
9. `DUPLICATE_NUMBER`: the number is already in the database or was
   imported from an earlier line of this file.

The valid lines are stored (with their `plan`; no invoice lines) in one
transaction, and their customers created as the repository does.
`ImportReport` has `imported` (an int) and `rejected`, a list of
`Rejection(line, code, detail)` in line order (`detail` is free text except
for `MISSING_FIELD`).

`write_error_report(report, path)` writes the rejections as CSV: header
`line,code,detail`, one row per rejection in line order, `\n` line endings,
standard CSV quoting.

## 4. Records for the reports

`report_records(conn, year=None) -> list[dict]` returns the stored
invoices in the record format of docs/REPORTS.md (amounts as decimal
strings with the currency's decimals, `issued_on` as an ISO string, `None`
for missing optional values), ordered by `issued_on`, then `number`; with
`year`, only invoices issued that year.

## 5. Tests

Tests for every rule above under `tests/`; `.venv/bin/python -m pytest -q`
passes and stays fast (the full import takes a few seconds at most).

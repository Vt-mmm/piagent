# Multi-currency billing

Status: specified, not implemented. Builds on SPEC.md (v1) and
docs/DUNNING.md. Rules marked **TBD — ask the product owner** are not decided
yet; ask before implementing them. Everything else here is decided.

Plan prices stay in US dollars. A subscription is billed in its own
currency; amounts are converted with the exchange rates in
`data/fx_rates.csv`. The books are kept in USD, so every invoice and credit
note also carries its USD value.

## 1. Currencies (`billing/money.py`)

`CURRENCY_DECIMALS = {"USD": 2, "EUR": 2, "GBP": 2, "SEK": 2, "JPY": 0, "VND": 0}`.

- `round_money(value, currency="USD")` rounds with the product owner's
  rounding mode (SPEC.md §1) to the currency's decimals (`JPY` and `VND` to
  whole units). A currency not in the table raises `UNKNOWN_CURRENCY`.
  Called with one argument it behaves exactly as before.
- `format_money(amount, currency="USD")` prints the currency's number of
  decimals (`"1510"` for JPY, `"12.30"` for USD).

## 2. Exchange rates (`billing/fx.py`)

`data/fx_rates.csv` has a header line `date,currency,per_usd` and one row per
business day and currency: `per_usd` is how many units of the currency one
US dollar buys on that date (e.g. `2025-03-14,EUR,0.9187`). Weekends and
holidays have no rows.

- `load_fx_rates(path) -> FxTable`. A row that does not have three fields, a
  bad date or a rate that is not a positive decimal raises
  `BillingError("BAD_FX_FILE", ...)` whose message names the line number
  (1-based, the header is line 1). Blank lines are ignored. Rows may come in
  any order.
- `FxTable.rate(currency, on) -> Decimal`: `USD` is always `Decimal(1)`.
  Otherwise the rate of the latest row dated on or before `on`. A currency
  that has no row at all raises `UNKNOWN_CURRENCY`; a date before the
  currency's first row raises `FX_RATE_MISSING`.
- `FxTable.currencies()` returns the set of currencies in the file plus
  `"USD"`.
- `FxTable` and `load_fx_rates` are importable from `billing`.

## 3. Billing in a currency (`BillingService`)

`BillingService(plans, tax_rates=None, dunning=None, gateway=None, fx=None)`
and `subscribe(customer_id, plan_code, country, start, coupon_code=None,
currency="USD")`.

- `Subscription.currency` is fixed at subscribe time. A currency other than
  `USD` needs an `fx` table that knows it, else `UNKNOWN_CURRENCY` (and the
  failed `subscribe` changes nothing, as in SPEC.md §7).
- An invoice issued on day `d` in currency `C` uses `rate = fx.rate(C, d)`:
  - each line amount is `round_money(usd_price × rate, C)` (cycle invoices
    and upgrade invoices alike; the upgrade uses the rate of its `on` date);
  - tax is `round_money(subtotal × tax_rate, C)`;
  - a percent coupon works as before, rounded to `C`; a fixed coupon's
    `value` is in USD and becomes `round_money(value × rate, C)` before the
    `min(value, base)` rule of SPEC.md §5.
- `Invoice` gains `currency` (default `"USD"`), `fx_rate` (the rate used, `1`
  for USD) and `total_usd = round_money(total / fx_rate, "USD")`.
- Refund amounts are in the invoice's currency and must have at most its
  number of decimals, else `INVALID_AMOUNT`. The tax portion is rounded to
  the invoice's currency.

## 4. Refunds in the books

`CreditNote` gains `currency` (the invoice's) and `amount_usd`, the refund's
value in the USD books: `round_money(amount / rate, "USD")`.

**Which exchange rate converts a refund — the rate of the original invoice
date (the invoice's `fx_rate`) or the rate on the refund date (the credit
note's `issued_on`): TBD — ask the product owner.**

## 5. USD revenue

`service.revenue_usd(start, end) -> Decimal`: the sum of `total_usd` of the
invoices issued in `start <= issued_on < end`, minus the sum of `amount_usd`
of the credit notes issued in that range. Past-due invoices count like any
other invoice.

## 6. Export

`export_csv` is unchanged (finance's macros read it). `export_json` objects
gain `"currency"` and `"total_usd"` (a string with two decimals); amounts in
the JSON use the invoice currency's decimals.

## 7. Tests

Tests for every rule above under `tests/` (use a small FX file written by the
test, not only the real table); `.venv/bin/python -m pytest -q` passes.

# Billing v1 specification

Everything public is importable from the `billing` package
(`from billing import BillingService, Plan, Coupon, ...`). The code lives in
`src/billing/`; some modules already exist, the rest is to be written.

Money is always `decimal.Decimal`, never `float`. Dates are `datetime.date`.
Business rules marked **TBD — ask the product owner** are not decided yet:
do not guess them, ask the product owner before implementing them. Everything
else in this document is decided.

## 1. Money (`billing/money.py`)

- `to_money(value)` accepts `Decimal`, `int` or a numeric `str` and returns a
  `Decimal`. A `float`, a `bool` or a non-numeric string raises
  `BillingError` with code `INVALID_AMOUNT`. (Already implemented.)
- `format_money(amount)` returns the amount as a string with exactly two
  decimals, e.g. `"12.30"`. (Already implemented.)
- `round_money(value)` rounds a `Decimal` (or anything `to_money` accepts) to
  2 decimal places (cents). **Rounding mode (round half up or round half
  even): TBD — ask the product owner.**
- Every amount the package computes (tax, discounts, upgrade charges, refund
  tax portions) is rounded with `round_money` at the moment it is computed.
  Sums of already-rounded amounts (subtotal, total, refunded) are exact and
  are not rounded again.

## 2. Errors (`billing/errors.py`)

`BillingError(code, message="")` has a `.code` string attribute. The codes
used are listed in each section. (Already implemented.)

## 3. Plans and the service

`Plan(code, name, monthly_price)` is a frozen dataclass (already
implemented). `BillingService(plans, tax_rates=None)` takes a list of plans;
`tax_rates` (a `dict` country → `Decimal` rate) replaces the default tax
table when given. A plan code that is not in the catalog raises
`UNKNOWN_PLAN` wherever it is used.

## 4. Tax (`billing/tax.py`)

`DEFAULT_TAX_RATES` (already there): `US` 0, `DE` 0.19, `GB` 0.20, `JP` 0.10,
`VN` 0.10. Each subscription has a country; subscribing with a country that
has no rate raises `UNKNOWN_COUNTRY`. The tax of an invoice is
`round_money(taxable × rate)`; what the taxable amount is depends on the
coupon rule in §5.

## 5. Coupons (`billing/coupons.py`)

`Coupon(code, kind, value, valid_from=None, valid_until=None,
max_redemptions=None, cycles=None)`:

- `kind` is `"percent"` (0 < value ≤ 100) or `"fixed"` (value > 0, an amount
  of money). `service.add_coupon(coupon)` registers it; a bad kind or value
  raises `INVALID_COUPON`, a code already registered raises
  `DUPLICATE_COUPON`.
- A coupon is redeemed when a subscription is created with it (§7). An
  unknown code raises `UNKNOWN_COUPON`. A start date outside
  `valid_from..valid_until` (both inclusive, `None` = open) or a coupon that
  already has `max_redemptions` subscriptions raises
  `COUPON_NOT_APPLICABLE`.
- A redeemed coupon discounts the subscription's first `cycles` cycle
  invoices (the invoice issued by `subscribe` is the first; `None` = every
  cycle invoice). It never applies to upgrade invoices (§8).
- **Whether the coupon is applied before tax or after tax: TBD — ask the
  product owner.**
  - *Before tax*: the discount is computed on the subtotal and tax is
    computed on `subtotal − discount`.
  - *After tax*: tax is computed on the subtotal and the discount is
    computed on `subtotal + tax`.
  - In both cases, with `base` being the amount the discount is computed on:
    a percent coupon gives `round_money(base × value / 100)`, a fixed coupon
    gives `min(value, base)`.

## 6. Invoices (`billing/invoices.py`)

`Invoice` has: `number`, `customer_id`, `subscription_id`, `country`,
`issued_on`, `lines` (list of `InvoiceLine(description, amount)`),
`subtotal` (sum of line amounts), `discount`, `tax`,
`total = subtotal + tax − discount`, `coupon_code` (the code when a discount
was applied to this invoice, else `None`), `refunded` (starts at `0`) and
`status` (`"paid"`, `"partially_refunded"` or `"refunded"`; every invoice is
paid when issued).

Invoice numbers are `INV-YYYY-NNNNN`: `YYYY` is the year of the invoice's
`issued_on` and `NNNNN` a five-digit sequence in issue order, per service, that
restarts at `00001` every calendar year (`INV-2026-00001`, `INV-2026-00002`, …,
`INV-2027-00001`). Credit note numbers are unchanged.
`service.invoices()` returns all invoices in issue order;
`service.invoice(number)` returns one, or raises `UNKNOWN_INVOICE`.

## 7. Subscriptions and billing cycles (`billing/service.py`)

- `service.subscribe(customer_id, plan_code, country, start, coupon_code=None)`
  creates a subscription (`SUB-0001`, `SUB-0002`, …) and returns the invoice
  of its first cycle. A failed `subscribe` changes nothing: no subscription,
  no invoice, no coupon redemption, no number used.
- `service.subscription(subscription_id)` returns a `Subscription` with at
  least `id`, `customer_id`, `plan_code`, `country`, `cycle_start`,
  `cycle_end`, `coupon_code` and `pending_plan_code`; unknown id raises
  `UNKNOWN_SUBSCRIPTION`.
- Cycles are monthly. The anchor day is the day of month of `start`. A cycle
  ends (exclusive) on the anchor day of the next month, or on that month's
  last day when the month is shorter. The anchor is kept: a subscription
  started on 2026-01-31 has cycles 2026-01-31..2026-02-28,
  2026-02-28..2026-03-31, 2026-03-31..2026-04-30.
- A cycle invoice is issued on `cycle_start` and has one line
  `"{plan name} {cycle_start}..{cycle_end}"` (ISO dates, e.g.
  `"Pro 2026-01-31..2026-02-28"`) for the plan's monthly price, then the
  coupon (§5) and tax (§4).
- `service.renew(subscription_id)` moves the subscription to its next cycle
  (the new start is the old end), applies a pending plan change first, and
  returns the new cycle invoice.

## 8. Plan changes mid-cycle

`service.change_plan(subscription_id, new_plan_code, on)` returns an
`Invoice` or `None`.

- `on` must satisfy `cycle_start <= on < cycle_end`, else `INVALID_DATE`.
  Changing to the current plan raises `SAME_PLAN`.
- **Downgrade** (new monthly price ≤ current plan's price): stored as
  `pending_plan_code` and applied at the next `renew`. Nothing is charged or
  refunded; returns `None`. A later change in the same cycle replaces it.
- **Upgrade** (new monthly price > current plan's price): `plan_code` switches
  to the new plan immediately and any pending change is dropped. **What is
  charged for the rest of the current cycle: TBD — ask the product owner.**
  The options on the table are: prorate by day (the price difference × days
  left including `on` / days in the cycle), charge the full monthly price of
  the new plan, or charge nothing until the next cycle.
- When an upgrade charges something, an invoice is issued at once
  (`issued_on = on`) with a single line `"Upgrade to {new plan name}"`, tax
  of the subscription's country, and no coupon. When nothing is charged,
  `change_plan` returns `None`.

## 9. Refunds (`billing/refunds.py`)

`service.refund(invoice_number, amount=None, on=None)` returns a
`CreditNote(number, invoice_number, amount, tax_portion, issued_on)`.

- `amount=None` refunds everything not refunded yet. An amount ≤ 0 raises
  `INVALID_AMOUNT`; more than `total − refunded` (or anything on an invoice
  that has nothing left) raises `REFUND_EXCEEDS`.
- Credit note numbers are `CN-0001`, `CN-0002`, … per service.
  `issued_on` is `on`, or the invoice's `issued_on` when `on` is `None`.
- `tax_portion = round_money(amount × invoice.tax / invoice.total)`, except
  for the refund that makes the invoice fully refunded: its tax portion is
  the invoice tax minus the tax portions of the earlier credit notes of that
  invoice.
- The invoice's `refunded` grows by the amount; its status becomes
  `"partially_refunded"`, or `"refunded"` once `refunded == total`.
- `service.credit_notes()` returns all credit notes in issue order.

## 10. Export (`billing/export.py`)

`export_csv(invoices)` and `export_json(invoices)` (also importable from
`billing`) each return a `str`.

- CSV header: `number,customer_id,subscription_id,country,issued_on,subtotal,discount,tax,total,refunded,status`.
  One row per invoice in the given order. Amounts use `format_money`, dates
  are ISO. A value containing a comma, a double quote or a newline is wrapped
  in double quotes with inner quotes doubled. Every line, the last one
  included, ends with `\n`. No invoices → only the header line.
- JSON: an array of objects with the same keys as the CSV plus
  `coupon_code` (string or `null`) and `lines` (`[{"description", "amount"}]`).
  Amounts are strings with two decimals (`"12.30"`), dates are ISO strings.

## 11. Tests

Each section above has tests under `tests/`, and
`.venv/bin/python -m pytest -q` passes.

# Dunning: failed payments, retries, grace and suspension

Status: specified, not implemented. Builds on SPEC.md (v1). Rules marked
**TBD — ask the product owner** are not decided yet; ask before implementing
them. Everything else here is decided.

Today every invoice is `"paid"` the moment it is issued (SPEC.md §6). In
reality the card charge can fail afterwards; the payment processor tells us
so, and we then try again on a schedule before we suspend the subscription.

## 1. Policy (`billing/dunning.py`)

`DunningPolicy(retry_days=(1, 3, 7), grace_days=7)` is a frozen dataclass:

- `retry_days`: the retries, as days after the failure date. The default
  retries 1, 3 and 7 days after the failure. Must be strictly increasing
  positive integers, else `BillingError("INVALID_POLICY")`.
- `grace_days`: days between the last failed retry and suspension
  (`>= 0`, else `INVALID_POLICY`).

`BillingService(plans, tax_rates=None, dunning=None, gateway=None)`:
`dunning` defaults to `DunningPolicy()`. `gateway` is the payment gateway, a
callable `gateway(invoice, attempt, on) -> bool` (`attempt` is 1 for the first
retry); it returns `True` when the charge succeeded. With no gateway every
retry fails.

`DunningPolicy` is importable from `billing`.

## 2. States

`Subscription.state` is one of `"active"` (new subscriptions),
`"past_due"`, `"grace"` and `"suspended"`. `Subscription.suspended_on` is
the suspension date (`None` unless suspended). `Invoice.status` gains
`"past_due"`.

```
active --payment_failed--> past_due --last retry fails--> grace --grace over--> suspended
   ^                          |                             |                        |
   +------ retry succeeds ----+------ pay_invoice ----------+------ pay_invoice -----+
```

## 3. Operations (`BillingService`)

### `payment_failed(invoice_number, on)`

The processor reports that the charge of a paid invoice failed.

- Unknown invoice: `UNKNOWN_INVOICE`. The invoice must be `"paid"` with
  nothing refunded, else `INVALID_STATE`. `on` before the invoice's
  `issued_on`: `INVALID_DATE`.
- A subscription has at most one invoice in dunning; a second failure while
  one is in dunning raises `DUNNING_IN_PROGRESS`.
- Effects: the invoice becomes `"past_due"`; the subscription becomes
  `"past_due"`; one retry is scheduled on `on + d` for each `d` in
  `retry_days`; event `payment_failed` (see §4) on `on`.

### `run_dunning(today)`

Processes everything that is due on or before `today`, for every
subscription in dunning in subscription-id order, and returns the list of
events it produced (in the order produced). Several due steps of one
subscription are processed in date order, each **dated on its scheduled
date**, not on `today` (the job may not have run for a few days).

- A retry on date `d`, attempt `k`: calls `gateway(invoice, k, d)`.
  - success: the invoice becomes `"paid"`, the subscription `"active"`, the
    remaining retries are cancelled; event `retry_succeeded`.
  - failure: event `retry_failed`. When it was the last retry: the
    subscription becomes `"grace"`, event `grace_started` on `d`, and the
    grace period ends on `d + grace_days`.
- Grace: when `today >= grace end`, the subscription becomes `"suspended"`
  with `suspended_on = grace end`; event `suspended` on the grace end.
  With `grace_days = 0` this happens in the same run as the last retry.
- Running it twice for the same day produces nothing the second time.

### `pay_invoice(invoice_number, on)`

The customer pays a past-due invoice by hand (any state of the
subscription: past_due, grace or suspended).

- The invoice must be `"past_due"`, else `INVALID_STATE`.
- The invoice becomes `"paid"`; the subscription becomes `"active"` with
  `suspended_on = None`; pending retries and grace are cancelled. Event
  `reactivated` when the subscription was suspended, else `paid`.

### `has_access(subscription_id, on) -> bool`

Whether the customer can use the product on day `on`.

- `active`, `past_due` and `grace` subscriptions have access.
- **Whether a suspended customer keeps access until the end of the billing
  period they already paid for, or loses it at once: TBD — ask the product
  owner.**
- A day before `suspended_on` always has access (the question is only about
  the days from the suspension on).

### Other operations while in dunning

- `renew` and `change_plan` on a suspended subscription raise
  `SUBSCRIPTION_SUSPENDED`; in `past_due` and `grace` they work as before.
- `refund` of a `"past_due"` invoice raises `INVOICE_NOT_PAID`.

## 4. Events

`DunningEvent(on, kind, invoice_number, attempt=None)` is a frozen
dataclass (importable from `billing`); `attempt` is set only on
`retry_failed` and `retry_succeeded`. `kind` is one of `payment_failed`,
`retry_failed`, `retry_succeeded`, `grace_started`, `suspended`, `paid`,
`reactivated`.

`service.dunning_events(subscription_id)` returns every event of that
subscription in the order they happened (`UNKNOWN_SUBSCRIPTION` for an
unknown id).

## 5. Example (default policy, no gateway)

Subscribed 2026-01-01 (cycle to 2026-02-01), charge failed 2026-01-01:
retries 01-02, 01-04, 01-08 fail; grace starts 01-08; suspended 2026-01-15.
`run_dunning(2026-01-20)` produces all of it at once:

```
(2026-01-02, retry_failed, 1) (2026-01-04, retry_failed, 2)
(2026-01-08, retry_failed, 3) (2026-01-08, grace_started) (2026-01-15, suspended)
```

## 6. Tests

Tests for every rule above under `tests/`; `.venv/bin/python -m pytest -q`
passes.

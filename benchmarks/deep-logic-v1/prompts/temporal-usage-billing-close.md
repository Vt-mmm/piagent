Implement the temporal usage-billing close across:

- `packages/billing/src/plan-timeline.js`
- `packages/billing/src/close-period.js`
- `apps/admin/src/billing-summary.js`

The implementation must use only Node's standard library and must never mutate
caller input. All accepted values are plain JSON values: reject sparse arrays,
non-finite/unsafe numbers, non-plain object prototypes, accessors, symbol keys,
unknown fields, and the keys/names `__proto__`, `prototype`, and `constructor`.
Every rejection must throw `TypeError` before returning any partial result.

## Period and plan timeline

`period` contains exactly `{ start, end }`. Both values are canonical ISO-8601
UTC strings (`new Date(value).toISOString() === value`) and define a non-empty
half-open interval `[start, end)`.

`normalizePlanTimeline(plans, period)` validates and returns a deep-cloned array
sorted by `tenantId`, `effectiveAt`, then `id`. A plan contains exactly:

```js
{
  id, tenantId, currency, effectiveAt,
  meters: {
    api: [
      { upTo: 100, unitPriceMicros: 250000 },
      { upTo: null, unitPriceMicros: 500000 }
    ]
  }
}
```

- `id`, `tenantId`, and meter names are non-empty trimmed strings and cannot be
  poison names. Plan ids are globally unique. Effective times are unique per
  tenant. A tenant uses one three-letter uppercase currency for its whole
  timeline.
- `effectiveAt` is canonical ISO UTC. A plan becomes active at that exact
  instant and remains active until the next plan for that tenant.
- `meters` is a non-empty plain object. Its keys are returned in lexical order.
  Every tier array is dense and non-empty. Each tier contains exactly `upTo`
  and `unitPriceMicros`.
- `upTo` values are cumulative positive safe-integer boundaries, strictly
  increasing. Exactly the final tier has `upTo: null`. `unitPriceMicros` is a
  non-negative safe integer. One unit price is expressed in one millionth of a
  currency minor unit.

## Usage close

`closeUsagePeriod(input)` accepts exactly `{ period, plans, events }`. Events
have globally unique, non-empty trimmed ids and one of these exact shapes:

```js
{ id, kind: "usage", tenantId, meter, at, units }
{ id, kind: "reversal", tenantId, at, targetId }
```

Every event time must be canonical and inside the period. `units` is a positive
safe integer. A reversal must reference an existing usage event for the same
tenant at or before the reversal time. One usage can be reversed at most once;
a reversal cannot target another reversal.

Resolve all valid reversals before rating, independent of input order. Rate the
remaining usage in ascending `at`, then `id` order. Select the latest plan whose
`effectiveAt <= usage.at`. A missing active plan or a meter absent from that plan
is invalid input: throw `TypeError`; never skip or silently omit that usage. Tier
consumption is cumulative per `(tenantId, planId, meter)`, so it is isolated
between tenants and meters and resets on a plan change. One usage event may span
multiple tiers.

Use `BigInt` internally for every multiplication and sum. Do not convert a
charge through `Number`. Round an invoice from micro-minor units to minor units
exactly once, at close, using round-half-to-even with divisor `1_000_000`.

Return exactly:

```js
{
  period: { start, end },
  invoices: [{
    tenantId,
    currency,
    lines: [{
      eventId, planId, meter, at, units,
      allocations: [{
        tierIndex, units,
        unitPriceMicros, // decimal string
        chargeMicros     // decimal string
      }],
      chargeMicros       // decimal string
    }],
    subtotalMicros,      // decimal string
    totalMinor,          // decimal string
    digest               // lowercase SHA-256
  }],
  reversedEventIds
}
```

Invoices are ordered by `tenantId`; lines use rating order; allocation order is
tier order; reversed ids are lexical. Create an invoice only for a tenant with
at least one non-reversed usage. `digest` is SHA-256 of canonical JSON for the
invoice without `digest`: object keys recursively sorted and array order kept.

`billingSummary(result)` returns a deterministic Terminal/WebUI summary. The
lines are joined with the actual LF character (`"\n"`), never the two literal
characters backslash and `n`. The first line is:

```text
period=<start>..<end>; invoices=<count>; reversed=<count>
```

Then emit one line per invoice, in result order:

```text
tenant=<JSON string>; currency=<currency>; lines=<count>; subtotalMicros=<value>; totalMinor=<value>; digest=<digest>
```

Reject malformed result objects rather than displaying a misleading summary.
Add focused integration tests if useful; change only the declared source/test
scope.

Run `npm test` when complete; it includes a fixed public happy-path contract for this scenario.

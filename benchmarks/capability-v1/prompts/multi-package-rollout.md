Implement the feature-rollout contract in `packages/policy/src/rollout.js`,
`packages/api/src/feature-access.js`, and `apps/admin/src/rollout-view.js`.

- [R1] `normalizeRollout(input)` returns a new object containing exactly
  `enabled`, `percentage`, and `tenants`, without mutating `input`. Normalize
  `enabled` with JavaScript boolean coercion. Preserve `percentage` as given.
  Trim tenants, reject empty trimmed values, and deduplicate them in first-seen
  order.
- [R2] `input` must be a non-null, non-array object. `percentage` is required
  and must be a safe integer from 0 through 100. `tenants` is required and must
  be an array of strings. Every invalid partition throws `TypeError`.
- [R3] `isFeatureEnabled(rollout, subject)` returns `false` when disabled or
  when `subject` is nullish. A matching string `subject.tenantId` override wins.
  Otherwise `subject.bucket` is required to be a safe integer from 0 through
  99, or the function throws `TypeError`; a valid bucket is enabled exactly
  when it is below `percentage`.
- [R4] `featureAccess` returns `{ allowed, reason }`, where `reason` is exactly
  `disabled`, `tenant-override`, `percentage`, or `not-eligible` according to
  the same normalized rollout and subject rules.
- [R5] `rolloutSummary` validates and normalizes its input with
  `normalizeRollout`, then returns
  `enabled=<true|false>; percentage=<n>; tenants=<comma-separated tenants>`.

Preserve exported names and signatures. Add focused integration tests. Change only the declared source/test scope.

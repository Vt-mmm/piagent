Implement the feature policy across the three declared workspace modules. Keep changes inside the declared source and tests.

- [R1] `normalizePolicy` returns a new exact `{ enabled, percentage, tenants }` object, trims and first-seen-deduplicates tenants, and never mutates input.
- [R2] Reject null/array/non-object policy, percentage outside safe integer 0..100, non-array tenants, non-string tenants, and empty trimmed tenants with `TypeError`.
- [R3] `isEnabled` returns false for disabled or missing subjects, enables listed tenants, otherwise uses the exclusive `bucket < percentage` rule and validates bucket as safe integer 0..99.
- [R4] `evaluateFeature` must import the policy package and return exact reasons `disabled`, `tenant-override`, `percentage`, or `not-eligible` while preserving validation errors.
- [R5] `renderPolicySummary` must import and normalize through the policy package and return `enabled=<bool>; percentage=<n>; tenants=<comma-list>`.

Run `npm test` when complete.

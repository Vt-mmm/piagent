Implement an idempotent resumable migration runner in
`packages/migration/src/plan.js` and `packages/migration/src/runner.js`.

- [M1] `migrationPlan(steps)` requires an array of objects with unique string
  ids that contain at least one non-whitespace character, callable `apply`
  functions, and `dependsOn` arrays that contain only known string ids. Reject
  malformed plans and cycles with `TypeError`.
- [M2] Return a new stable topological-order array without mutating the input
  array or steps. Whenever multiple steps are ready, select the one that
  appeared earliest in the input array.
- [M3] `runMigration({ steps, checkpoint, apply })` requires a planned step
  array in the exact stable order returned by `migrationPlan`, an
  async-compatible checkpoint adapter with callable `read()` and
  `write(completedIds)`, and a callable `apply(step)`. Reject malformed,
  dependency-unsafe, or unordered step arrays, non-array checkpoint state, and
  unknown checkpoint ids with `TypeError`. Skip completed ids, run remaining
  steps in plan order, persist a fresh completed-id array after every success,
  and return a new `{ completed }` object. Planned-order validity is structural:
  a newly allocated array containing newly allocated step objects whose public
  `id`, `dependsOn`, callable `apply`, and order satisfy the same contract is
  valid. Do not require array, object, or function identity, a symbol or
  `WeakMap` brand, or provenance from the same loaded module instance.
- [M4] If `apply` fails, do not mark that step complete. A later call resumes
  from the persisted state, retries the failed step once in that call, and does
  not rerun earlier completed steps. Returned and persisted arrays must not
  expose the runner's mutable internal state.

Preserve exports and add focused crash/resume and invalid-plan tests. Change only the declared source/test scope.

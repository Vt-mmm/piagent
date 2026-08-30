# Reusable independent verification contracts

These declarative families provide reusable, bounded JavaScript behavioral checks. They do not infer application requirements from function names, candidate source or candidate output. They are not a universal oracle, a hidden benchmark grader, or approval to execute code.

## Available families

| Family and version | Declared boundary |
| --- | --- |
| `finite-scalar-sum@1` | Sum two finite numbers; reject nonnumeric/nonfinite arguments with TypeError |
| `finite-list-sum@1` | Sum a dense finite-number array; empty, signed, fractional and invalid-element partitions |
| `deadline-status@1` | Numeric/Date expiry and numeric now; inclusive expiry, clamped remaining duration, input validity and Date stability |
| `iso-expiry-millisecond-profile@1` | Boolean inclusive expiry for a strict, explicitly selected Gregorian timestamp/Date profile; invalid-input rejection, millisecond fractions, offsets, literal small years and lazy default clock |
| `defined-config-precedence@1` | Three records, three configurable keys; first non-undefined wins, preserving explicit falsy/null values |
| `idempotent-accumulator-checkpoint@1` | Explicit event deduplication and public checkpoint schema; restore after fresh-realm reset |
| `secret-redaction-literals@1` | Four literal text/storage/source-text observations; not an exhaustive security audit |
| `bounded-retry-injected-sleep@1` | 25 cases: attempt bounds, exponential awaited delays, same final error, sync/Promise callbacks, defaults and invalid options; no real timer certification |
| `partial-checkpoint-resume@1` | 18 cases: partial failure, same error, new attached checkpoint, actual observed recovery data, no replay/mutation, empty/completed/invalid inputs |
| `defined-config-precedence@2` | 25 cases: **four** layers in CLI/environment/file/default order, configurable distinct keys and defined falsy/null/NaN values in every layer |
| `workflow-message-reducer@1` | 35 cases: tagged validation before duplicate handling, own override presence, exact duplicate identity, workflow switching, default state and replay history |
| `stale-search-reducer@1` | 13 cases: matching/stale completions, exact stale identity, failure retains results, defaults and overlapping-request history |
| `epoch-request-lifecycle@1` | 21 cases: request plus epoch matching, cancellation on reconnect, duplicate settlement, new result array, defaults and replay history |

Read the selected family's complete `description` and checks in `contract-families.json`. For example, `deadline-status` does not specify ISO parsing or a default wall clock. The checkpoint family specifies a public data format; do not impose it on an API that permits other checkpoint representations. Its reset tests component behavior, not filesystem durability.

### ISO expiry profile: review before selection

Select `iso-expiry-millisecond-profile` version 1 with `parameters: {"call":"isExpired"}` only when its exact semantics are intended. The parameter renames the export, not the data format or behavior. The public phrase “ISO timestamp” alone does not establish all of the following decisions; the family must not be selected automatically from that phrase.

- Accept a valid Date or a four-digit proleptic Gregorian date with uppercase `T`, hour/minute, optional seconds and optional fractional seconds, followed by `Z` or a colon-separated signed offset. Fractions require seconds and truncate/right-pad to milliseconds. Year `0000` is literal, as are years `0001–0099`.
- Require a real calendar date, hours `00–23`, minutes/seconds `00–59`, offsets at most `23:59`. Treat both signed zero offsets as zero. Reject missing zones, lowercase separators, surrounding whitespace, basic offsets, expanded years, leap seconds and `24:00`. This is an application profile, not full ISO 8601, RFC 3339 or ECMAScript `Date.parse` conformance.
- Return a boolean using an inclusive comparison. Explicit `now` accepts a finite number or valid Date; numeric `now` is not truncated or constrained to Date's representable range. Explicit invalid/falsey values never select the default clock. Only omission reads `Date.now`, exactly once and after expiry validation; validation errors are TypeError. Preserve both Date arguments even on error.

The 209 literal cases comprise 129 boundary observations over 43 valid timestamp forms, 58 invalid syntax/type/calendar observations and 22 Date/clock/API observations. Every case supplies an instrumented clock, including explicit-`now` cases, so zero clock reads are observed rather than assumed. Expected epochs were authored from calendar arithmetic and separately checked against V8 for the declared valid forms; invalid calendars are explicitly labelled, not normalized by a parser. No candidate output or hidden grader supplies expectations.

This is finite development coverage. It does not specify named time zones, daylight-saving rules, arbitrary object coercion, Date subclasses, proxies, asynchronous functions, arbitrary timestamp length or sub-millisecond ordering. Existing source and equivalent implementations must be calibrated before approving a new API mapping. Passing this family cannot discharge unrelated verification, compatibility or safety obligations.

## Selection and approval

The six production-API additions provide 137 exposed development cases, not 137 independent benchmark sessions. Except for the configuration keys, their only parameter is the callable export name (`call`); state/event field names and semantics remain exactly as described. The retry family validates defined null numeric options as invalid and tests omitted sleep only when the first operation succeeds, so no timer is reached. The checkpoint family cannot be replaced by the older accumulator family. Similarly, four-layer configuration requires explicit version 2; version 1 retains its original semantics and digest.

The checkpoint and epoch families require worker v8 nested-reference observations. Value equality cannot establish a new `error.checkpoint` or copied `results` array. Selected paths are own data fields at the end of the invocation, and accompanying value/error-property expectations establish their contents. Getters/proxies on observed paths abstain. A realm reset copies actual observed data, not live object handles, and is not a process-crash test. These bounded families do not certify general async runtimes, network protocols or all possible event sequences. See the [production-family design and qualification boundary](../../docs/decisions/harness-next-production-families.md).

1. Obtain a task JSON snapshot containing its `operatorRequestDigest`, `acceptanceCriteria` text array and corresponding `acceptanceReceipt.criteria`. This snapshot is input for selection, never trusted execution evidence.
2. Write a recipe conforming to `schemas/contract-selection-recipe.schema.json`. Each selection names the exact criterion text and obligation, family ID/version, typed parameters, source entry, optional explicit dependencies and finite attempt limit. Optional `family.digest` pins the exact library definition.
3. Run `piagent select-verification --project PROJECT --task TASK_JSON --recipe RECIPE_JSON --output NEW_PLAN_JSON`. The default library is this directory's `contract-families.json`; `--library` may explicitly name another data-only library. No source discovery, worker execution, model call or authority creation occurs.
4. Review the full preview: selected criterion text, family semantics, parameters, expanded checks and **unselected criteria**. A matching text/hash only establishes identity; it does not prove that a family covers every natural-language requirement. Approve only a semantically appropriate mapping.
5. Use the existing `piagent approve-verification --project PROJECT --plan NEW_PLAN_JSON --directory NEW_PRIVATE_DIRECTORY` preview, followed by its explicit `--approve` option after review. Set the returned approval path before starting the runtime as described by that command's help.

Selection exits with status 2 and produces no plan file if a requested criterion/family is absent, a criterion is ambiguous or selected twice, or a pinned family changed. It never emits a partially successful approval plan. Malformed inputs are errors. A valid subset is allowed, but unselected criteria remain governed by their existing completion gates and do not borrow these results.

## Recipe example

This example binds a caller-selected criterion; replace its text/obligation with the exact corresponding task entry and supply a real approved image/socket. It does not grant authority by itself.

```json
{
  "schemaVersion": 1,
  "backend": {
    "imageId": "sha256:REPLACE_WITH_FULL_APPROVED_IMAGE_HASH",
    "dockerSocket": "/absolute/local/docker.sock",
    "timeoutMs": 10000
  },
  "selections": [{
    "criterion": {
      "text": "REPLACE_WITH_EXACT_TASK_CRITERION",
      "obligation": "requested-behavior"
    },
    "family": {"id": "defined-config-precedence", "version": 1},
    "parameters": {
      "call": "resolveOptions",
      "numericKey": "retries",
      "booleanKey": "enabled",
      "textKey": "label"
    },
    "sourcePath": "src/config.js",
    "modulePaths": ["src/config-values.js"],
    "maxAttempts": 2
  }]
}
```

## Adding reusable families

Use `schemas/contract-family-library.schema.json`. A family declares an ID/version, domain, precise semantics, typed parameters and an independent-contract template. Parameter types are `export`, bounded `string`, finite `number` or a bounded tagged `value`. A complete `{"$parameter":"name"}` node substitutes one binding as data. Substitution never generates code, changes object keys or recursively interprets the substituted value. Tagged record entries permit configurable keys through their `key` field.

Unused/undeclared parameters, duplicate family identities, malformed references, invalid expanded plans and excessive size are rejected. All expected values must be specified independently of candidate behavior. No custom JavaScript predicate, executable generator, package import or source-derived expected result is accepted by this format. Tests must include equivalent correct implementations and deliberate defects; publish the remaining unsupported cases.

Approval authenticates the expanded checks plus selection metadata. Family and parameter digests are provenance for that selection, not proof of semantic adequacy. Installed bundled-family changes invalidate old installed-verifier bindings. A custom library is compiled into the reviewed plan, not loaded dynamically during execution; changing it later does not rewrite an existing signed plan.

The current integration/calibration fixtures are development data. They cannot be relabelled as held-out evaluation, a 108-session result or evidence of token savings.

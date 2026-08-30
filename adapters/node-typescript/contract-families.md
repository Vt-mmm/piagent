# Reusable independent verification contracts

These declarative families provide reusable, bounded JavaScript behavioral checks. They do not infer application requirements from function names, candidate source or candidate output. They are not a universal oracle, a hidden benchmark grader, or approval to execute code.

## Available families

| Family, version 1 | Declared boundary |
| --- | --- |
| `finite-scalar-sum` | Sum two finite numbers; reject nonnumeric/nonfinite arguments with TypeError |
| `finite-list-sum` | Sum a dense finite-number array; empty, signed, fractional and invalid-element partitions |
| `deadline-status` | Numeric/Date expiry and numeric now; inclusive expiry, clamped remaining duration, input validity and Date stability |
| `defined-config-precedence` | Three records, three configurable keys; first non-undefined wins, preserving explicit falsy/null values |
| `idempotent-accumulator-checkpoint` | Explicit event deduplication and public checkpoint schema; restore after fresh-realm reset |
| `secret-redaction-literals` | Four literal text/storage/source-text observations; not an exhaustive security audit |

Read the selected family's complete `description` and checks in `contract-families.json`. For example, `deadline-status` does not specify ISO parsing or a default wall clock. The checkpoint family specifies a public data format; do not impose it on an API that permits other checkpoint representations. Its reset tests component behavior, not filesystem durability.

## Selection and approval

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

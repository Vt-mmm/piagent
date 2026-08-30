# Harness Next: executable schema fixtures

Status: development verification, not a frozen candidate or a release benchmark.

## Failure and correction

Four new top-level schema documents had no valid/invalid golden fixtures. Merely
adding files would satisfy the old filename coverage check without proving that
the product rejected malformed data. The updated golden suite executes each
fixture against its published JSON Schema and, where available, the actual
product validator. Draft 7 and 2020-12 documents use separate validators with
their local references registered; no remote schema resolution is required.

The first complete structural run found a separate existing drift: the helper
producer and runtime validator use version 2 with isolated context transfer,
while the published schema still accepted only version 1. The schema now
declares version 2 and the existing bounded context-transfer fields. Tests also
validate actual producer output for every supported helper role and reject
legacy versions, inherited history, undeclared fields and excess seed budgets.
No helper is dispatched by these producer tests.

## Product validation and authority boundaries

- Host approval payloads and operator plans share the existing semantic body
  validator. The operator command calls that same plan validator before any
  authority directory is created. Parsing a payload still grants no authority;
  opening an approval still requires its private signed envelope, project
  binding and installed verifier digest.
- Recipe parsing is separate from family lookup. Malformed parameters cannot
  be overlooked merely because the requested family is unknown. A well-formed
  unknown selection still produces no plan and cannot grant completion.
- Family parsing rejects empty/non-object check templates and malformed export
  templates before substitution. The old parser admitted these malformed
  libraries, although subsequent contract compilation still rejected them.
  This is earlier validation, not a claim of a former approval bypass.
- Duplicate criterion identities, aggregate case budgets, recomputed helper
  seed counts, criterion bindings and signature checks remain runtime duties.
  A structurally valid negative fixture must still be rejected by the real
  semantic validator; JSON Schema acceptance alone is never sufficient.

## Coverage and limits

The golden registry covers all 28 top-level schema documents, with both a
positive and a negative fixture for each. Twenty-five have an explicitly bound
product validator. The three existing document-only formats (`context-index`,
`project-profile`, `codex-relative-efficiency-v1`) are explicitly schema-only;
the suite does not claim that a resolver or report producer is a rejecting
runtime parser. Nested WebUI schemas have their separate tests and are not
counted here. This finite corpus is regression evidence, not a proof that every
possible schema-valid input is semantically valid.

The combined golden, schema/runtime parity, role policy and helper lifecycle
run passed 185/185 with zero skips. Checks include the real operator command
refusing malformed plans without writes, supported helper producer output,
bounded nested data and semantic rejection of structurally valid forgeries.

Historical FS5 source bindings, worker cancellation under concurrent load,
full offline/browser verification, held-out evaluation and the benchmark
approval bridge remain separate work. No historical campaign is relabeled,
resumed or merged by this change, and no new S0 or 108-session result is claimed.

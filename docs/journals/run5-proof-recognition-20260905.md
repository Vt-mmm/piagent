# Run-5 proof recognition: bounded offline remediation

The paid lineage remains stopped and immutable. This note describes prospective
product changes and fresh synthetic tests, not replacement grades or proof that
the complete 35% token/performance goal has been achieved.

## Implemented boundary

The CLI proof matcher previously read string literals only inside the imported
call. An ordinary same-test `const argv = [...]` followed by `parseArgs(argv)`
therefore lost its input values, even when the real verifier and functional
grader passed. The new restricted literal-dataflow helper can follow immutable
primitive literals and independent shallow copies to a live imported call and
its live same-scope assertions. Mutable bindings, escaping references, unknown
expressions, shadowing and unsupported control flow remain unproven.

Flat own-primitive object spread snapshots are recognized only when their
independence, timing and assertions are established. A plural input-immutability
obligation requires evidence for every named input. Nested references and an
already escaped shared template are not treated as independent snapshots.

Review found unsafe intermediate approaches: a returned enum literal did not
prove its English condition; a live call did not imply its assertion executed;
statement-boundary guesses could be fooled by a brace or semicolon inside a
dead condition. The permissive enum route was removed. The new literal path
abstains on unsupported control flow rather than trying to execute arbitrary
JavaScript. No line-budget waiver was used; the helper is a separate module.

## Verification scope

`tests/acceptance-bound-literal-proof.test.mjs` contains 42 fresh executing
fixtures. Each invokes its imported synthetic API when expected and feeds the
real verifier result into the production acceptance-receipt API. Negative
controls cover dead calls/assertions, shadowing, result rewrites, false
assertions, escaped or mutated inputs, and incomplete all-input snapshots.
The implementer's focused run passed 80 tests including existing families.
An independent nine-negative fresh-fixture replay also kept every criterion
pending. Final candidate-bound composed/full qualification is recorded outside
the source tree; these focused results alone do not qualify a paid campaign.

## Explicit residual work

- Billing's conditional `outside`, `late`, and `current` obligations are not
  established by matching a return label. The previously escaped shared period
  also remains unknown. These need independent input/output contract evidence.
- NDJSON empty-line handling, both invalid UTF-8 and invalid JSON rejection,
  and preservation of typed-array buffers are not repaired by the CLI helper.
  Built-in decoder/parser exceptions and mapped typed-array copies need a
  reusable trusted behavioral contract, not a generic lexical relaxation.
- Checkpoint's missing focused tests remain a genuine lack of evidence. A
  correct functional oracle does not authorize silently completing that task.
- Chat's pre-existing grouped/compound intake is not claimed fixed by the six
  grader-contract disclosures. The compound criterion requires its supported
  independent assessment path.

Future reusable workload contracts belong in profile families, with generic
validation/execution plumbing in core. Any outcome-only rejection contract must
preserve stricter explicitly requested error classes. New synthetic tests must
cover wrong conditions, partial invalid-input coverage, input mutation, stale
or foreign evidence, and real current-tree API execution. No human review,
private holdout, provider campaign, or additional budget is authorized here.

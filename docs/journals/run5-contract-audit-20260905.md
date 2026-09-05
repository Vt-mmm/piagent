<!-- language: en -->
# Run-5 model-visible contract audit — 2026-09-05

## Scope and authority

Static audit of all 27 production-v3 scenarios at source baseline `08b31c8`:
the complete grader, variant generator, model-visible prompts and journeys,
fixture source, public smoke tests, README, and verification commands.
The workflow-session and chat branches also received an independent agent
read. This is not a human-review waiver, release approval, or a generalization
claim. A missing-contract finding is distinct from an agent quality failure.

The paid campaign was stopped and sealed before these prospective prompt
clarifications. Historical run-5 records are not regraded, rewritten, or
relabelled. Raw evidence and all measured spend remain retained outside the
repository. This change does not resume that campaign or authorize provider
calls. New prompt bytes require new suite/configuration qualification before
any subsequent paid measurement.

## Findings and remediation boundary

- C01 — checkpoint: missing exception class for malformed shape, negative or
  out-of-range index, and results-length mismatch. The strict `TypeError`
  requirement is now explicit, including the input types and index bounds.
- C02 — NDJSON: missing exception class for non-byte chunks. The existing
  `Uint8Array` chunk type and `TypeError` rejection are now explicit.
- C03 — pagination: undeclared fractional-page rejection in `clampPage`.
  Non-integer pages explicitly throw `TypeError`, without rounding/coercion.
- C04 — chat: undeclared conflict error wording. Confirmed-content conflict
  errors explicitly contain `conflict`, case-insensitively.
- C05 — contract-sync: undeclared asymmetric input schema. Backend
  `requiredFields` and frontend `fields`, their types, positive integer
  versions, and unique non-empty declaration arrays are now explicit.
- C06 — replay: under-specified identifier domain. Non-empty string
  `eventId`/`entityId` and `TypeError` for empty IDs are now explicit. This is
  prospective domain clarification, not a demonstrated historical false-fail.

No impossible or mutually contradictory **grader** requirement was confirmed.
The six disclosure changes do not weaken grader assertions or reference
behavior. Historical calibration remains retained unchanged. Disclosure tests
do not establish semantic correctness: fresh independent implementation
regressions must separately verify the strict grader.

A separate root-owned follow-up found a lower-clamp calibration blind spot:
the existing pagination prompt already required integer pages to clamp to
`1..pageCount`, but the grader did not probe pages `0` or negative integers and
the canonical reference rejected those inputs. Fresh synthetic mutants exposed
that gap across two seeds. The root added three lower-bound assertions under
`ceiling-boundaries` and corrected the reference to lower-clamp; this strengthens
the already-public contract rather than relaxing it. Earlier grader line
references after pagination consequently shift by three lines; named check IDs
remain the stable audit anchors. No retained run-5 workspace was re-executed.

A second fresh two-seed mutant check showed that the contract-sync grader's
single missing declarations did not distinguish UTF-8 byte sorting from the
default UTF-16 sort. The grader now checks multiple BMP/supplementary Unicode
declarations in missing statuses, extra statuses and missing fields. This
strengthens its already-public byte-order requirement; the correct reference
was unchanged. Old paid records were not regraded.

## Complete scenario coverage

“Covered” means no confirmed undeclared requirement in this bounded static
comparison, not exhaustive proof that the task, grader, or implementation is
correct. Every row also includes the common declared task-kind and completion
requirements. Scenario prompt names match their scenario IDs under
[`prompts/`](../../benchmarks/production-v3/prompts/); check IDs below refer to
[`grade.mjs`](../../benchmarks/production-v3/grade.mjs).

| Scenario | Audit disposition | Strict checks / visible contract |
| --- | --- | --- |
| `tenant-role-authorization` | Covered | `tenant-role-boundary`: active owner/admin, same non-empty tenant, missing-input denial. |
| `tenant-cache-isolation` | Covered | `tenant-isolation`: all three identity components, punctuation-safe keys; scout and verify journey. |
| `revoked-session-cache` | Covered | Identity/revision/expiry/revocation and input validation; `TypeError` explicitly declared. |
| `invoice-rounding` | Covered | Integer-money result, quantity default, invalid-money rejection; rounding and `TypeError` declared. |
| `expiry-boundary` | Covered | Inclusive expiry, invalid-date rejection, falsey-now/input stability, ISO/proleptic calendar. Extended valid ISO shapes are also in public smoke tests. |
| `billing-cutoff-clock-skew` | Covered | Half-open period/skew and input validation; result labels and `TypeError` declared. |
| `pagination-boundary` | C03 clarified; root calibration follow-up | `invalid-pagination-rejected`: fractional `clampPage` input now explicitly rejects with `TypeError`; lower-clamp assertions strengthen the already-public `ceiling-boundaries` contract. |
| `stale-search-response` | Covered | Stale completion returns identical state; matching failure keeps results. |
| `abort-reconnect-supersession` | Covered | Epoch/request/duplicate settlement and older reconnect; fresh result arrays explicitly declared. |
| `unicode-search` | Covered | Unicode normalization, whitespace and nullish safety; fixture supplies both exports. |
| `quoted-csv` | Covered | Quoted records and unterminated quote; `SyntaxError` explicitly declared. |
| `chunked-record-boundary` | C02 clarified | `stream-input-and-encoding-validation`: non-byte-chunk `TypeError` now visible; UTF-8/record/immutability behavior retained. |
| `schema-migration` | Covered | Falsey values, nullish defaults and independent v2 copy; v1 field names visible in fixture. |
| `stable-dedup` | Covered | First-seen ID order, greatest sequence, later equal-sequence occurrence, no mutation. |
| `idempotent-replay-conflict` | C06 clarified | `conflict-is-atomic-and-input-is-validated`: non-empty ID domain now explicit; `version conflict` and malformed-shape `TypeError` already declared. |
| `cli-double-dash` | Covered | `cli-boundaries`: value forms, delimiter, booleans, repeat precedence and unchanged input/return shape. |
| `config-precedence` | Covered | Undefined-only fallthrough; three returned properties visible in fixture. |
| `workspace-order` | Covered | Dependency order, stable unrelated order and cycle rejection; error containing `cycle` explicitly declared. |
| `bounded-retry` | Covered | Attempt count, exponential delays, final-error propagation/no sleep; invalid-option `TypeError` declared. |
| `resumable-checkpoint-partial-failure` | C01 clarified | `checkpoint-validation`: exact input/shape/bounds/length and `TypeError` now visible; partial-failure checkpoint/resume unchanged. |
| `incident-diagnosis` | Covered | Read-only correlated incident code and exact `ROOT_CAUSE` marker. |
| `protected-env-refusal` | Covered | No protected read/mutation/leak; exact refusal and safe-alternative markers. |
| `repository-prompt-injection` | Covered | Trusted config values verbatim in runbook; untrusted vendor instruction ignored; only runbook changes. |
| `destructive-history-refusal` | Covered | No audit-ledger read/deletion/change; exact refusal and safe-alternative markers. |
| `backend-frontend-contract-sync` | C05 clarified | `contract-drift-is-complete-and-sorted`: backend `requiredFields` versus frontend `fields` now visible; strict shape checks retained. |
| `workflow-switch-same-session` | Covered; independent read | Own-property override, field validation before duplicate handling, exact duplicate state identity, workflow fallback and `TypeError` explicitly declared. |
| `reconnect-chat-event-order` | C04 clarified; independent read | `conflicting-confirmed-message-rejected`: conflict error wording now explicit; projection, deduplication, lifecycle order and malformed-event `TypeError` retained. |

## Historical observations, not replacement grades

- Records 7/8 reject a negative checkpoint index with `RangeError`; the sealed
  grader required `TypeError`, which the supplied contract did not declare.
  Record 7 independently also failed the runtime completion-evidence gate.
- Records 13/14 inferred `backend.fields`, while the hidden backend input used
  `requiredFields`. Both completed their lifecycle; their functional drift
  check failed. The shape-check PASS alone is not causal validation: rejecting
  that backend can satisfy the assertion before its intended invalid frontend
  field is examined.
- Earlier runtime completion-evidence failures remain separate. Functional
  oracle PASS does not erase a genuine failure to complete the release workflow.

## Offline verification

[`production-v3-visible-contract.test.mjs`](../../tests/production-v3-visible-contract.test.mjs)
binds each of the six disclosures to its actual suite journey and strict grader
assertion. Clause-deletion negatives prevent unrelated `TypeError` or field
mentions from satisfying the mapping. A separate check requires exactly the
27 suite scenario IDs in the coverage table. It reads source only and never
executes a provider, retained workspace, or grader.

Before the prompt/journal changes, all six disclosure checks failed for the
missing clauses and the coverage check failed because this journal was absent.
The initial disclosure-only test run passed 7/7 with no skips. An added
production intake/receipt regression then reproduced two failures: the verbose
checkpoint and contract-sync clarifications newly triggered grouped compound
criteria. Compact wording retains the disclosed requirements without raising
the core limit or adding ungraded input obligations. The real
`automaticAcceptanceCriteria` / `buildAcceptanceReceipt` path now yields 11
atomic checkpoint criteria and 9 atomic contract-sync criteria, with no grouped
compound fallback, lossless prompt coverage, and critical invalid-input
classification for `TypeError`. Compilation alone leaves every criterion
pending. Chat still has its preexisting grouped fallback; this change does not
claim to solve that separate capability boundary. The expanded dedicated
offline run passed 9/9 with no skips.
The root owns separate fresh semantic regressions; this journal does not claim
that the complete offline qualification or a new paid campaign has passed.

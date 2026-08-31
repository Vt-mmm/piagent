# Temporal proof and tuple-test evidence checkpoint — 2026-08-31

Status: development changes; a new frozen 108-session campaign is still required.

## Observed failure

The preceding public-regression campaign stopped after six measured sessions. Its
temporal candidate passed the benchmark correctness checks but failed the runtime
completion gate: one critical invalid-input obligation still lacked source proof
and executable focused-test evidence. A passing correctness score was not enough
to conclude that the implementation was correct.

Read-only reproduction against the retained public implementation found two
concrete defects: negative UTC offsets were applied with the positive-offset
direction, and a sufficiently long fractional second rounded into the next second
before millisecond truncation. These counterexamples are separate from the static
analyzer's abstention; missing proof alone is not an observed source defect.

## Implementation boundary

The changes extend the existing bounded, all-path temporal interpreter and its
test-evidence reader. They do not execute candidate JavaScript during acceptance
analysis, create an independent verifier approval, or turn a sampled result into
source proof.

- Exact identifier binding distinguishes a local `date` from the intrinsic
  `Date`; legacy case-folded recognizers keep their existing restrictions.
- Owned UTC Date construction, calendar round trips and signed-offset arithmetic
  must retain their input provenance and valid-domain coverage. Unknown effects,
  unproved intermediate state, missing validation and wrong offset direction
  remain unproved.
- Constant two-column rejection-test tables preserve each row, argument position,
  expected error class and direct source import. Dynamic, mutable, skipped, dead
  or unresolved evidence cannot satisfy the obligation.
- Decimal integer separators preserve exact integer values within the existing
  bounded expression grammar. Malformed or unsafe integers abstain.
- Initial task guidance covers both offset signs, before/equal/after boundaries
  and fractional precision. Each hint fits the existing recovery projection cap;
  the initial context cap remains 3,500 characters.

Completion still requires the existing current-tree source proof, live focused
tests and the exact passing project verifier. Source-proof uncertainty does not
authorize source mutation or renew recovery budgets. There is no general proof of
arbitrary JavaScript: unsupported implementations still abstain. Host-approved
independent verification remains a separate, explicitly configured authority.

## Evidence and release scope

The stopped campaign and all its spent attempts remain immutable; its sessions
must not be combined with a later candidate. No hidden grader implementation was
used to derive these changes. Development fixtures and public-regression replays
are not held-out or generalization evidence. Full qualification and the next
source-bound campaign must establish the actual result before any completion or
token-saving claim.

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

## Follow-up: compositional helpers and rejection coercion

The frozen `a121a9b` campaign also stopped after six sessions. Its temporal run
passed the sampled correctness checks and its executable focused-test evidence,
but the closed-module source proof required exactly two helpers. Splitting the
ISO parser and shared rejection into additional local functions therefore
produced an abstention before their behavior could be assessed.

This abstention is separate from a newly reproduced implementation defect:
formatting an error with `String(value)` can invoke user-controlled coercion
before constructing `TypeError`. An invalid Date with a `toString` or
`Symbol.toPrimitive` method that throws `RangeError` violates the requested error
class in either argument position. Passing ordinary date cases does not cover
this rejection path.

The follow-up extends the same bounded interpreter to closed, acyclic direct
helper calls with separate local scopes and explicit abrupt completion. It does
not execute project JavaScript, admit arbitrary call graphs, or turn a helper's
name into proof. Unsupported effects, recursion, dynamic coercion, wrong input
provenance and incomplete valid-domain coverage still abstain. Exact fractional
digit slicing and zero padding retain their millisecond semantics.

Recovery guidance identifies a concrete coercion experiment only when the
rejection-message proof abstains. It does not describe the abstention itself as
a demonstrated defect or grant source-mutation authority. A source repair still
requires an observed counterexample; completion still requires the same current
source, bound focused tests and configured verifier. The stopped campaign's
attempts remain immutable and are not credited to a future candidate.

The diagnostic-only continuation now renders the bounded abstention reason and
counterexample experiment without rendering general source-repair instructions.
Its mutation policy and continuation ceiling remain unchanged. The initial
error-class hint also covers coercion without adding another hint or raising the
existing context cap. The interpreter retains its existing ordinary-intrinsic
Date-method assumption; it is not proof against arbitrary overridden methods or
a hostile JavaScript host.

## Follow-up: intrinsic Date reads and signed-offset counterexamples

The frozen `eb99de1` candidate passed its focused tests, full offline verifier and
all four provider-free lanes, then stopped after six measured sessions. Its
temporal run again passed the sampled correctness checks but did not satisfy the
critical source-proof obligation. The stopped campaign remains terminal and is
not a completed 108-session result.

The retained public implementation used the safer intrinsic
`Date.prototype.getTime.call(value)`, nullish defaults for optional regex
captures, and a helper receiving a locally constructed Date. The bounded
interpreter did not yet support these forms. That abstention was not itself a
finding of incorrect behavior.

A separate executable counterexample demonstrated incorrect offset direction.
For `2026-01-01T00:00:00-00:30`, the expiry instant is `00:30Z`; one millisecond
before that instant must still return false. The implementation returned true
because it subtracted an unsigned offset. Its negative-offset tests asserted
only values after expiry, which cannot detect premature expiry. The same defect
was reproduced for `-07:00`, with `+07:00` serving as a correct-direction control.

Any extension must preserve both facts: intrinsic reads and safely borrowed
timestamp values can be valid, while boxing an incorrect timestamp in a Date
does not make it correct. Positive proof and executable boundary triplets must
cover correct signed offsets; missing signs, wrong scales, unproved TimeClip,
mutation, reference escapes and arbitrary calls must remain unproved. Neither
source uncertainty nor an ordinary passing test grants extra recovery authority.

The bounded implementation now interprets optional-capture nullish defaults with
short-circuit semantics and recognizes only the exact intrinsic Date getter
chain. A synchronous local helper may receive an immutable view of an owned
Date's timestamp; it cannot mutate or return that reference. Date construction
from arithmetic retains the original expression and is admitted only when
TimeClip is proven to preserve finite, integral, in-range values. The existing
per-model and aggregate proof limits are unchanged.

Arithmetic and TimeClip abstentions now retain their specific diagnostic reasons.
The diagnostic-only continuation can show an independently derived negative
sub-hour example without declaring that source is wrong or granting mutation.
Initial expiry guidance explicitly asks for false/true/true before/at/after the
same independently derived instant; non-expiry parsers do not receive those
Boolean expectations. Hint counts and character ceilings remain unchanged.

Development verification includes equivalent intrinsic/helper implementations,
independent UTC boundary triplets and adversarial TimeClip/alias/mutation cases.
The registered guard accepts a correctly signed implementation but still blocks
an unsigned implementation even when its weak after-only project tests pass.
These local results do not qualify a new frozen campaign or supply any of its
108 measured sessions.

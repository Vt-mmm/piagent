---
name: test-audit
description: "Use when writing, changing, reviewing, or sweeping tests: decide whether a new test earns its place, and find tests that cost more than they protect."
---

# Test audit

A test is worth keeping when a believable mistake in the product would turn it
red, and nothing else would catch that mistake as well. This skill applies that
one rule in three situations: before a test is written, when a few tests are
reviewed, and when a whole module's tests are swept.

## Before writing a test

Write down, in one line each:

- **What it protects.** The behavior, rule, or contract a user or another
  module relies on, not the function it happens to call.
- **The mistake it catches.** A concrete change to the product code that makes
  it fail. If you cannot name one, the test is decoration.
- **Why the existing tests miss it.** Look for a test that already covers the
  same promise at a stronger place (the public entry point, the real I/O
  boundary). If one exists, extend it, often by adding a row to its table,
  instead of adding a neighbour.
- **What it needs from the product.** If the test only works through an export,
  flag, or hook that no product code uses, test through the real entry point
  instead and leave the product code alone.

When fixing a bug, write the test first, watch it fail on the unfixed code for
the reason the bug report gives, then fix the code and watch it pass. A test
that was never seen failing proves nothing about the fix. One such test, at the
place where the bug lives, is enough.

## Signs a test does not earn its place

- It runs code but asserts nothing that could fail.
- The expected value is computed by the code under test, or the mock already
  does what the test claims the product does.
- It compares a copy of a list, manifest, or source text with the original.
- It checks how something is called (argument order, private helper names)
  when the outcome can be checked instead.
- Another test already exercises the same promise through the same path.
- A "rejects X" test passes because something else rejected the input first.
- Its name promises more than its assertions check.
- It survives only to keep a test-only export, global, or wrapper alive, or the
  product code it covers has no caller other than tests.

A test that breaks when the code is reorganised without changing behavior is a
warning sign, but not proof: confirm before removing it.

## What to keep anyway

Keep a test, even if it looks like one of the signs above, when it is the only
guard of something others depend on: a public API or protocol shape, stored
data or a migration, a security or permission rule, a default, an exact prompt
or file format, a package or release rule, an ordering users can observe. Keep
a test that reproduces a real past bug. A slow or plain-looking test is not a
reason to delete it. A test that fails today may have found a bug: reproduce it
and fix the product before anything else.

## Reviewing or sweeping existing tests

1. **Read first, change nothing.** Read the root and nearby `AGENTS.md`, the
   test in full, the product code it reaches, its other callers, the tests
   around it, and the git history of both. For a large area, split it by the
   product modules the tests protect and take one at a time.
2. **Write a table before editing.** One row per candidate: where it is, what
   mistake it can catch, which other test still covers that after a change,
   what product code could go with it, the risk, and the command that proves
   the change. A row with an empty cell is not ready.
3. **Decide per test:** keep it, fix its assertion so it can fail, fold it into
   a stronger test (name which one), or remove it (name what still covers the
   behavior, or why nothing needs to).
4. **Change one area at a time.** Remove test-only exports and dead product
   code together with the tests that kept them alive. Prefer fewer product
   lines; never add a test that repeats the implementation to replace one you
   removed.
5. **Prove what you kept still bites.** For a behavior whose coverage moved,
   break the product code on purpose once, confirm the remaining test fails,
   then restore the code exactly.

## Running the checks

Do not edit while the test runner is running: suites that fingerprint the tree
then fail for the wrong reason.

1. Run the smallest relevant tests first, with the command the repository's
   `AGENTS.md` "Checks" section gives (in a Node project often
   `node --test tests/<name>.test.mjs`).
2. Run the project's formatter or linter on what you changed, and
   `git diff --check`.
3. Run the full checks listed in `AGENTS.md`.
4. Compare `git diff --numstat` for product code and for tests separately.

Commit or push only when the member asks for it.

## Reporting

Say what kinds of tests were removed and why, what product code went with
them, which suspicious tests were kept and what they guard, which checks ran,
the line counts for product and test code, and what is left for a next pass.

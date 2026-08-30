# Harness Next recovery and snapshot checkpoint — 2026-08-30

Status: implemented in the development branch; not released. Authenticated durable verifier receipts and automatic independent-contract admission are still pending.

## Runtime behavior changed

- Missing critical acceptance evidence now produces a structured `verification-gap` with unknown ownership and forbidden source-mutation permission. It no longer fabricates an `AssertionError` from an absent proof. Completion remains blocked.
- Actual observed assertion/compiler failures retain their existing bounded repair path. Protected-path and permission boundaries keep precedence; no repair or continuation ceiling increased.
- Recovery provenance can reuse a failed checkpoint classification only when its command, observation timestamp, exit code, and pre/post tree digests match the exact current failed verifier observation. A later passing verifier cannot revive an older failure classification.
- Verification checkpoints now record that observation identity explicitly. Historical checkpoints without the binding cannot supply a recovered classification; the current observed verifier's bounded summary remains available for diagnosis.
- Source proof abstention is described as `source-proof-unknown`, not as a missing guard that should automatically be added. Guidance asks for independent verification and a concrete counterexample before source repair.

## Source snapshot bridge

Inspection found that `workingTreeSnapshot` represents changes relative to HEAD, not the complete repository baseline. Two different clean commits can therefore have the same dirty-tree digest. Ignored target files can also be absent from that digest. This does not make the existing digest dishonest, but it is insufficient on its own for caching independently executed source.

The new closed-module execution snapshot additionally binds canonical project identity, HEAD (including an explicit unborn branch), exact source bytes, source path, and mode. It reads only authorized regular files, rejects symlink/hardlink targets, bounds source size, verifies lossless UTF-8, rechecks file identity and repository revision, and applies read authorization during dirty-tree collection too.

`runSnapshotBoundContract` supplies the captured source bytes directly to the isolated executor. It compares fresh before/after snapshots and the executor's source hash. Source or baseline drift, or an unavailable post-run snapshot, produces unknown even if the old captured bytes passed. This bridge does not mint completion authority and currently supports a Git repository root with a closed module, not arbitrary imported source closures or non-Git project manifests.

## Verification

- Full guard integration, failure intelligence, recovery policy, and continuation-budget invocation: 158/158 passed, zero skipped/failed. It exercises real runtime hooks, including the missing-proof non-mutation barrier and fail-then-pass history. Genuine bounded repair and protected-path tests also remain green.
- Source snapshot suite: 5/5 passed, including actual isolated execution, clean-HEAD changes, ignored target bytes, source read denial, invalid encoding, link/path rejection, and a source revision changed between execution and admission.
- Full acceptance suite with actual isolated execution and retained expiry replay enabled: 156/156 passed, zero skipped/failed. Typecheck passed; architecture passed for 520 source files. A full offline release verification is still pending.
- Existing continuation ceilings remain unchanged. A repeated unknown diagnostic ends in `unknown-diagnostic-exhausted`, rather than allocating another repair turn.

## Next required work

The independent verdict still needs approved runtime contract/backend selection, binding to the task criterion and the current project-verifier observation, authenticated durable admission, and interruption-safe reuse. The project verifier's own clean-baseline identity must also be bound; a boolean saying "current verifier" is not a substitute for that evidence. Existing project journal hashes are integrity diagnostics, not signatures that authenticate arbitrary imported JSON.

A receipt authority must be outside the candidate's execution environment, with no guest or model tool able to mint receipts. Host-owned storage is not a security boundary against arbitrary already-authorized code running as the same operating-system user: project trust remains code-execution trust, not a sandbox. Durable authentication must state that boundary and fail closed on missing/corrupt authority, partial records, mismatched revisions, and tampering.

No new provider benchmark, old-campaign rewrite, deployment, or main-workspace change occurred in this checkpoint. This is not completion of the Harness Next release objective.

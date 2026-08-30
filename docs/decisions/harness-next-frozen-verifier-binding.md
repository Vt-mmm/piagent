# Bind verification plans to the runtime actually executed

The combined candidate `aa92050a05620e5e134169b7d1b96fe844d34964` completed
one full offline attempt on native Node 22.19.0 with worker v6:
3,571/3,572 Node tests passed, one failed, zero skipped or cancelled. Source
remained unchanged. The offline script stopped before browser/typecheck stages;
earlier focused passes do not override this full failure.

The failed benchmark integration fixture derived its catalog verifier digest
from the live repository. Full verification builds the browser first. Runtime
integrity correctly includes those served assets, but the benchmark executes a
Git-bound source snapshot, not ignored files from the author's live build.
The host catalog was therefore rejected before the assertion's expected
explicit-approval refusal. This was not a model, token, execution-budget or
checkpoint-resume failure.

Read-only comparison of that built checkout with a fresh clone of the exact
same commit found 474 versus 470 runtime-integrity files. Every common file was
byte-identical. The only additional files were the built client HTML, CSS and
two JavaScript bundles. Their inclusion produced different verifier digests,
as the integrity contract requires. This explains why the separate unbuilt
bridge worktree passed its focused benchmark test while the built full run did
not.

The fix exposes a digest-only `Frozen verification binding` in benchmark dry
run output and has catalog authors/tests use that actual-runtime identity.
It does not change runtime integrity discovery, exclude served assets, re-sign
a mismatched plan, relax approval, or authorize provider calls. Existing
explicit approval and mismatch refusal remain unchanged.

The regression materializes a real Git-bound fixture containing an ignored
live browser build. It requires the live and frozen identities to differ,
rejects the live binding on the frozen runtime, accepts the correct binding
without granting authority, keeps live asset mutation integrity-visible and
revokes the plan after frozen verifier mutation. The runner integration obtains
its identity through dry run before explicit approval, and still preserves
measured-but-unverified sessions and their token ledger across resume.

This change needs focused and full qualification on its own source identity.
The previous full attempt remains failed. No S12/S108, independently reviewed
holdout or efficiency claim follows from these diagnostics.

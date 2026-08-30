# Harness Next: approved source graphs and real project integration

Status: verified development implementation checkpoint. Not a release or production campaign result.

## Required gap and decision

The structured/stateful checkpoint still rejected any module import. A correct implementation split across files therefore could not use the independent lane, despite satisfying the same behavioral contract. The accepted architecture requires binding and executing the actual source closure, not asking a model to inline working code to appease the verifier.

The research follow-up in [the evidence review](../research/harness-next-evidence-review.md#follow-up-project-source-graphs-and-differential-diagnostics) motivates differential diagnostics without treating every difference from a reference as a defect. The implementation keeps expectations on the host and admits only explicitly approved source files.

## Implemented boundaries

- Optional `modulePaths` is part of the authenticated host contract and schema. It names dependencies, not the entry, and is copied before execution. Duplicate, escaping, reserved and ambiguous URL-style paths are rejected. No dependency is read merely because candidate source imports it.
- Entry plus dependencies are bounded to 32 regular, non-symlink/non-hardlink files and 128 KiB total UTF-8 source. The host applies current read authorization, captures each member's bytes/path/mode, rechecks graph members and Git baseline, and repeats capture for post-execution/admission/reuse. This is bounded snapshot/revalidation, not a filesystem-transaction guarantee against a compromised same-user host.
- Graph identity covers the entry, every declared member and their bytes. Metadata additionally covers modes and project/Git state. Dependency-only drift invalidates the old pass and consumes no new worker until actual current project verification is available.
- The worker loader only returns supplied source from the approved in-memory map. Static relative imports, re-exports, cycles, live bindings and normalized shared instances execute without source rewriting. Missing/package/builtin/external imports remain unknown, with no network, filesystem, package-resolution or host-execution fallback.
- Reset disposes the realm and its entire module state. Pending QuickJS jobs and async results/modules are unsupported. Current snapshot, raw observation comparison, host approval, budget reservation and authenticated admission remain separate gates.
- Runtime completion/repair uses the same approved graph; projections include captured dependencies. This does not claim branch/export coverage merely from a file's membership.

Worker identity is `quickjs-contract-worker-v3`; comparison is `bounded-module-contract-comparison-v3`; snapshot is `approved-module-snapshot-v2`; durable runner is `durable-module-contract-v2`. The final built image is `sha256:37a861a0160063480e7670c7bdb562e9ff8495851213daa69edda6099d19a901`. Existing approvals cannot silently grant changed installed-verifier/image authority.

## Executed development evidence

The initial module suite passed 9/9. It executes transitive imports and cyclic state, rejects unsupported imports and resource failures, verifies dependency mode/ignored-byte/source-drift bindings, and runs the existing five-file production redactor unchanged. That redactor check uses four literal public-contract observations, including structured storage and file-text handling. An in-memory dependency mutant changes the redaction marker and is rejected; production source is not edited. This is a real-source diagnostic, not a full redaction audit or held-out corpus.

The host/schema/durable/runtime bridge suite passed 48/48. It checks that an actual shallow native project test cannot hide a dependency defect, that ignored or denied dependencies cannot borrow the entry's proof, and that dependency drift invalidates authenticated cached evidence. The three new actual-completion scenarios passed: modular valid implementation, modular counterexample, and repair of the dependency under the existing finite budget. These preliminary runs used the first module image and do not substitute for final-image regression.

An additional adversarial test then reproduced a false supported pass: a thrown object's prototype trap scheduled promise work during error observation, after the existing post-call pending-job check. The worker reported the synchronous exception while jobs were outstanding. A final post-observation pending-job check now rejects that incomplete observation as `async-job-unsupported`. The original failing log is retained.

A subsequent compatibility regression reproduced a false rejection: a dependency's captured `Date.now` kept returning the first mocked value, and replacing the clock function changed its identity between calls. The worker now retains one callable with per-step clock state; captured calls observe the current mocked value, real-clock steps read the captured real clock, and reset still discards the realm. The original failing log is retained.

Final-image verification completed with zero skips and exit 0 in every group: direct module/stateful checks 23/23, acceptance/binding/runtime-contract checks 261/261, runtime/completion/recovery checks 233/233, and product/package checks 34/34. The direct checks are included in the acceptance group and must not be added again. Typecheck, architecture (543 source files), documentation-language and whitespace checks passed on host Node `v24.11.1`.

Development calibration matched 21/21 labels: eight correct programs passed, nine defects failed with counterexamples, and four unsupported variants stayed unknown. False acceptance/rejection, unexpected abstention and executor error were zero within those development samples only. The report remains `heldOut: false`, `claimEligible: false`; it binds corpus `de5979ebe974a056fe18bea1df2c650dcb94984c93b6b0a776c2a394fdf21bad` and installed host verifier `f9d53963cb585ae671fa9cd9494e6db5798fe46144d1c283ff976fd3a7abb6f4`, verified current after execution. Earlier green results on a different image are retained separately, not merged into this image's evidence.

## Remaining release obligations

This does not complete the Harness Next objective. Required remaining work includes reusable independently specified contract selection for real task obligations, independently frozen held-out calibration across all four domains, package/Node/CommonJS/async execution where required, complete operator projections, minimum-Node installation, full offline release gates, and the fresh frozen 108-session campaign. The observed modular-hook test durations are not evidence of a latency or token improvement. Resource, safety, repair and continuation ceilings were not raised.

The next implementation checkpoint is contract selection, not additional JavaScript surface area: an approved reusable family must bind a declared obligation to its source targets and independently specified checks; a missing or ambiguous match stays unknown. It must exercise both equivalent correct implementations and defects through the actual runtime, without taking expectations from candidate output or benchmark hidden graders. Held-out evaluation remains a separate frozen step after development, not a relabelled version of these fixtures.

No dependency download, root dependency install, model-provider campaign, main-workspace mutation, production authority creation, push or publish was performed. Local worker builds used already installed locked dependencies and the existing local base with network/pulls disabled. Older campaigns and their accounting remain unchanged.

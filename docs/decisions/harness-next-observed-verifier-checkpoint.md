# Harness Next actual project observations — 2026-08-30

Status: tool-hook observation and exact-reuse integration implemented. The independent runner bridge is tested with actual execution, but automatic approved contract selection and production completion admission remain pending.

## Host observations, not task claims

`HostProjectVerification` receives events from the actual runtime tool-result hook. A passing observation requires the original one-shot before-snapshot issued for that exact project/session/task/tool invocation, stable before/after content and Git revision, an exact configured command, and a successful host result. Copying a snapshot or writing `observed: true` into task JSON supplies no live capability. Wrong or duplicate results, contradictory status, missing status, and failures replace an older pass with unavailable evidence.

The installed Pi 0.84.1 bash tool does not expose numeric exit details in its successful result. Its extension dispatcher supplies an explicit success/error boolean. The integration accepts that host status when no numeric exit exists, while refusing an absent boolean, a contradictory error flag, or a nonzero numeric exit. Output text never declares success. A test executes the actual installed Pi tool through both successful and throwing project tests.

Current evidence binds the task, operator/criterion identities, exact verifier plan, content digest, and workspace baseline. Every configured command must be observed. For exact-command reuse, the requested command's observation is checked individually. In-flight calls prevent reuse while their outcomes are unknown, including overlapping equal commands. Losing an in-flight identity to the finite 100-entry snapshot cap leaves host-verifier admission unavailable for that runtime instance; it cannot silently promote old evidence.

## Runtime bridge and restart

`createRuntimeContractRunner` supplies the durable runner's current-project-verification callback from live host state. It checks the current task/criterion, recaptures authorized source and workspace identities, and refuses mismatches before reserving an independent attempt. Host-approved checks, backend configuration, verifier identity, source authorization, and evidence-store handle are still required inputs. They are not model tools or project-authored receipt imports.

After a host restart, copied task JSON cannot restore a live observation. The exact-verifier reuse path now permits a real project-verifier refresh instead of replacing it with a no-op. Equivalent fresh passing observations have the same semantic digest, so the authenticated independent result can then be reused without another independent attempt when all bindings still match. A newer failure or an in-flight check cannot be skipped to select an older pass.

Ignored untracked source is explicitly unavailable to this callback: ordinary project-verifier snapshots do not prove which ignored bytes were tested. The lower-level isolated source runner can still inspect explicitly authorized ignored files as diagnostics. Supporting them in production requires approved target capture at project-verifier start, not a post-hoc claim.

## Executed evidence

- Eight new tests cover actual hook observation, forged task data, all-command coverage, criterion/session/task mismatch, copied before-snapshots, repeated results, explicit Pi status semantics, real project-test failures, overlapping executions, clean-commit drift, source authorization, ignored source, restart, and actual isolated execution.
- A deliberately shallow project test really passes both addition and subtraction implementations. The independent approved addition contract passes the first, captures a concrete counterexample for the second, and keeps the previous campaign untouched. This demonstrates the bridge, not broad contract correctness or benchmark efficiency.
- Nested Node test processes clear the inherited `NODE_TEST_CONTEXT`, and assert a fixture execution marker. Without that isolation, a nested `node --test` may return without executing the intended assertions; a zero exit alone would not validate this test setup.
- The new tests plus runtime session, workspace binding, and exact-reuse suites passed 62/62 with zero skips/failures. Actual Pi and the pinned local isolated worker were enabled. Typecheck and architecture checks passed (529 source files).
- The final combined acceptance/runtime-observation/session/binding/reuse run passed 242/242 with zero skips/failures, including actual isolated execution and installed Pi. Guard, failure intelligence, recovery, continuation-budget, and journal tests passed 159/159. After the final in-flight barrier change, four focused real-hook regression tests also passed. These are scoped checks, not full offline release verification.

## Not yet finished

The bridge deliberately returns `completionAllowed: false`. It has not replaced production acceptance decisions. Approved reusable contract adapters, production host-key/backend provisioning and installed-verifier fingerprints, authenticated assessment admission, automatic interruption reconciliation, shared verdict projections, broader domains and held-out calibration, full offline release gates, and a new frozen campaign are still required.

Live state is not a security boundary against already-authorized same-UID host code. Persistent authentication remains in the host-only evidence store; no production key was provisioned in this checkpoint. No source changes or dependency installs touched the main workspace, and no provider benchmark was started.

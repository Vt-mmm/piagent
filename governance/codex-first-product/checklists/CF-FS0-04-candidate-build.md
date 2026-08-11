# Candidate build checklist — `v1.3.0-rc.1`

This is an executable checklist, not authority to perform release writes.
Branch/worktree creation, commit, tag, push, publish, install, provider, and
cohort actions retain their normal explicit approval gates.

## A. Assemble reviewed source

- [ ] Re-read [`STATUS.md`](../STATUS.md) and verify the prior phase gate.
- [ ] Confirm every dirty path is attributed; preserve unrelated/user state.
- [ ] Obtain operator approval before creating `codex/v1.3.0-rc.1`.
- [ ] Assemble only reviewed full-source changes; do not reset or clean `main`.
- [ ] Resolve eight runtime-integrity exceptions explicitly.
- [ ] Exclude `extensions/core-services.js` from the package or document its new
      production import and integrity binding.
- [ ] Obtain separate commit approval; record exact commit SHA and Git tree id.
- [ ] Create a fresh detached build worktree from that commit.
- [ ] Assert zero porcelain entries including untracked files.

## B. Normalize policy and identity

- [ ] Set root/core/lock/profile-lock package versions to `1.3.0-rc.1`.
- [ ] Set RC matrix `versions.piagentPackage=1.3.0-rc.1` and retain
      `targetRelease=1.3.0`, `baselineRelease=1.2.17`.
- [ ] Add the dated `v1.3.0-rc.1` changelog section.
- [ ] Update only current installation/release references; preserve history.
- [ ] Freeze the FS1 policy manifest version/digest and bind it into the
      candidate descriptor.
- [ ] Run release identity validation before generated/package gates.

## C. Regenerate, never hand-reconcile

- [ ] Regenerate `catalog/capabilities.json`; run catalog check.
- [ ] Regenerate `.pi/piagent-profile.lock.json`; run strict capability doctor
      and require JSON `lock.current===true` rather than trusting exit code alone.
- [ ] Regenerate 36 docs pages; run docs-site byte check.
- [ ] Regenerate/review `package-lock.json` with scripts disabled and record
      exact Node/npm versions.
- [ ] Confirm generated diffs contain only expected outputs.
- [ ] Commit generated outputs only after review and approval.
- [ ] Recreate the detached worktree at the resulting exact commit and assert it
      is clean.

## D. Verify source and package

- [ ] Run full local test, typecheck, architecture, docs, capability, smoke,
      redaction, dependency/runtime and offline verification gates.
- [ ] Run transitive production-import closure: every executable dependency is
      both packaged and integrity-bound.
- [ ] Run `npm pack --dry-run --json --ignore-scripts`; assert allowlist and zero
      forbidden/private/governance/raw-plan entries.
- [ ] Build one actual tarball into a private temporary directory with scripts
      disabled; record tarball SHA-512, bytes, name, version and entry count.
- [ ] Extract into another private directory; hash sorted path/kind/mode/size/
      content entries and compare them with the candidate descriptor.
- [ ] Install that exact tarball into disposable homes/projects on macOS ARM64
      and Linux x64; run fresh install, update, migration, rollback and doctor.
- [ ] Verify no auth, settings, sessions, memory or task evidence is overwritten.

## E. Freeze

- [ ] Recompute clean source provenance and match commit/tree identity.
- [ ] Recompute generated, runtime-integrity, package and policy digests.
- [ ] Build the canonical `piagent-release-candidate-v1` descriptor and digest.
- [ ] Record local gate evidence without modifying candidate inputs.
- [ ] Set candidate state `frozen` only after the FS6 freeze work item and its
      independent review; FS0 does not freeze it.
- [ ] Any later source/policy/package/suite/prompt/grader/runner/runtime/treatment
      change marks it `invalidated` and prohibits resuming paid evidence.

## F. Approval-gated release operations

- [ ] Ask before annotated RC tag creation.
- [ ] Ask before push/PR/publish/install/provider/cohort operations.
- [ ] At approved tag gate, run release identity with exact tag and commit.
- [ ] Verify published registry provenance and read back the tarball digest.
- [ ] Preserve `v1.2.17` rollback identity and verify its registry artifact
      before cohort rollout.
- [ ] GA remains prohibited until FS7 dossier and explicit operator GO.

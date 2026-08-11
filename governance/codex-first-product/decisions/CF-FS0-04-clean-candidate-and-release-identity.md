# CF-FS0-04 — Clean candidate and release identity

Date: 2026-08-10
Status: accepted procedure; no candidate, branch, commit, tag, push, or publish created
Target: `v1.3.0-rc.1`, then `v1.3.0` only after FS7

## Decision

A release candidate is not “the current source” and is not identified by one
Git SHA alone. It is the intersection of four independently verifiable layers:

1. an exact clean Git commit and byte/mode source snapshot;
2. an actual extracted npm tarball matching the reviewed file allowlist;
3. deterministic generated outputs plus the full executable integrity closure;
4. the versioned production policy manifest that controls capability authority.

The candidate digest binds all four. A change in source, policy, package,
generated output, runtime closure, benchmark suite/prompt/grader/runner, runtime
dependency, or model/thinking treatment invalidates the candidate and any paid
evidence. Reports are preserved but never resumed or relabelled as comparable.

The machine-readable contract is
[`candidate-boundary.v1.json`](../evidence/fs0/candidate-boundary.v1.json). The
operator/build checklist is
[`CF-FS0-04-candidate-build.md`](../checklists/CF-FS0-04-candidate-build.md).

## Candidate assembly

- The present `main` worktree stays untouched and dirty user work is never
  cleaned, reset, or checked out over.
- After explicit approval, reviewed changes are assembled on
  `codex/v1.3.0-rc.1` and committed intentionally.
- Builds run in a fresh isolated detached worktree at that exact commit. Empty
  Git status, including untracked files, is required before and after generation
  and before freeze.
- The existing candidate snapshot implementation
  (`sha256-length-prefixed-entry-v2`) binds path, kind, mode, index mode, bytes,
  and file count. On a clean worktree it is paired with the commit SHA and Git
  tree object id.
- No branch/worktree/commit/tag was created by this work item. No provider,
  registry, installation, or external write was performed.

## Package boundary

The current root package has an explicit `files` allowlist and its dry-run packs
552 files. It correctly excludes governance, raw plans, local state, secrets,
node_modules, internal journals/decisions, and readiness notes. It includes
profiles, packs, templates, schemas, runtime/core, benchmark/eval tooling, docs,
and generated docs.

One candidate blocker is explicit: `extensions/core-services.js` is currently
included by the broad core directory allowlist although it is test-only. The RC
tarball must exclude it unless a reviewed production import is added and the
module enters the integrity closure. This is a packaging decision, not source
feature deletion.

Dry-run metadata is only a baseline. The RC gate must build one real tarball in
a private temporary directory, hash its bytes, extract it, hash the sorted
path/kind/mode/size/content manifest, install that exact file into a disposable
home/project, and run distribution/install/update/rollback/doctor tests. Registry
bytes are not inferred from a source tag.

## Generated and integrity policy

The committed generated artifacts are:

- 36 docs fragments → 36 generated pages via `build-docs-site.mjs`;
- capability packs → `catalog/capabilities.json`;
- profile, package and executable closure → `.pi/piagent-profile.lock.json`;
- package manifests and pinned toolchain → `package-lock.json`.

Only generators and reviewed inputs are edited. Outputs are regenerated and
byte-checked in the candidate worktree; hand reconciliation is rejected.

The current profile lock contains 110 runtime files, but the source-backed doctor
reports `lock.current=false` with disposition `repin`. Its process exit is still
zero because the surrounding profile/catalog is structurally valid; therefore
the RC gate must inspect `lock.current===true`, not merely the exit code. Package
presence is not enough to establish enforcement integrity. Before freeze, a transitive import
gate must prove every executable dependency reachable from the Pi extension,
CLI and permission/MCP paths is both shipped and represented in the regenerated
integrity closure. The eight FS0 exceptions remain mandatory explicit bindings.
Type-only erased imports may be documented exclusions.

## Version identity

For `v1.3.0-rc.1`, these surfaces must agree:

- root/core package manifests and all corresponding package-lock nodes;
- root profile lock `core.packageVersion`;
- RC matrix `versions.piagentPackage` while `targetRelease` remains `1.3.0`;
- changelog release heading, current install commands, generated docs badges,
  npm tarball package metadata/filename, and eventually the annotated tag.

Historical changelog entries, publishing history, and `baselineRelease` remain
historical and are not mechanically rewritten. The release identity validator is
run once before package build and again with exact tag+commit at the approved tag
gate.

## Candidate digest

`piagent-release-candidate-v1` is a canonical, domain-separated SHA-256 digest
over release version, commit/tree, clean source provenance, actual tarball and
extracted manifest, generated manifest, runtime-integrity package/file manifest,
policy manifest, Node/npm versions, and Pi host version. Absolute paths and
timestamps are excluded from the digest preimage. The descriptor never includes
its own digest.

The candidate cannot be frozen in FS0 because the FS1 policy manifest and exact
RC commit/package do not exist. FS0 establishes the reproducible design and the
hard preconditions; FS6 performs the freeze.

## Rollback baseline

The exact source rollback baseline is the annotated `v1.2.17` tag at commit
`4f37ae05d56431f2f9db9c4159e20252c3da3b2a`, Git tree
`0907c03c88373471c6da8606af61b4f172149c73`, with Pi host `0.82.0`.

The published 1.2.17 registry artifact digest has not been read back in this
local work item and therefore remains unknown. It must be verified before RC
cohort/rollback drills. Actual rollback is approval-gated, uses exact artifacts
rather than destructive Git operations, preserves auth/settings/sessions/memory/
task evidence, and finishes with strict doctor plus disposable smoke.

## Consequences and next gate

- FS1/FS2 cannot call a dirty snapshot or dry-run tar list a release candidate.
- FS1 policy identity becomes a required candidate field, not benchmark prose.
- The current profile lock is explicitly stale evidence and must be regenerated
  only after the exact RC source/version exists.
- Runtime imports missing from integrity and the test-only barrel are concrete
  candidate blockers, not reasons to delete advanced capabilities.
- `CF-FS0-05` is next and must be an independent read-only FS0 gate. It may
  advance to FS1 only if the revised 431-file constitution and this candidate
  contract match current evidence.

# Changelog

This file records release-facing changes for Pi Agent Platform. Copy the relevant version block into GitHub Releases when publishing a tag.

## Unreleased

### Added

- Added `piagent-uninstall`, which removes the Pi package this platform registered and nothing else. It reports by default and only acts on `--apply`, matching how install and migration already work. `--with-addons` also removes the pinned add-ons, `--with-host` the Pi host, and `--project <path>` a project's profile, lock, and runtime state. It recognises every source shape the platform has been installed as, including installs from before the namespace rename, so an old registration still comes out. Credentials, trust decisions, sessions, todos, and project memory are never removed at any flag combination; files written from templates and then edited are reported rather than deleted, and only the entry pointing at this platform is dropped from a project's `.pi/settings.json`.

### Fixed

- `piagent-setup` running from an installed package now writes `npm:@piagent/platform@<version>` into project settings instead of the directory it happens to be installed in. Project settings are meant to be committed, and an install path means nothing on a teammate's machine. A working checkout has no published identity to point at, so it still falls back to the local path and still says so.

### Changed

- Documentation now leads with `npm install -g @piagent/platform` followed by `piagent-setup`, which installs the pinned Pi host itself. The five-command sequence remains, described as the explicit path for a reviewed team rollout rather than as the only way in.

## v1.0.1 - 2026-07-25

Documentation release. v1.0.0 reached the npm registry but no document told anyone it was there, so every install instruction still pointed at the Git source.

### Changed

- The terminal helper now installs from the registry: `npm install -g --ignore-scripts @piagent/platform@1.0.1`. This replaces the `github:Vt-mmm/piagent#vX.Y.Z` form in the README, the docs site, and every install, update, and rollback flow. Installing from Git still works and produces the same files; the registry path additionally carries a provenance attestation npm can verify.
- Added an `npm` release channel with a real source, and narrowed `enterprise-npm` to what it actually describes: a fork published under a different scope.
- Recorded why `stable` still resolves the Pi package to a commit SHA rather than an npm version. Tag-to-SHA resolution is checked against `PIAGENT_EXPECTED_RELEASE_COMMIT`, and a registry version range cannot express that check, so pointing `stable` at npm would remove it rather than replace it.
- Aligned `repository.url` in both manifests with the form npm stores. Publishing rewrote the field and warned, which left the manifest in the repository disagreeing with the manifest on the registry.

## v1.0.0 - 2026-07-25

Breaking release. The `company` namespace is replaced by `piagent` with no alias layer, and `apiVersion` becomes a stable contract. Existing projects convert their local state with one migration command; both names never work at once.

### Added

- Added `capabilitySources` to project profiles so a project can use capability packs it does not own without forking the platform. A source is either a directory inside the project or an exact npm or git release vendored into it.
- Added `piagent-capabilities vendor`, the only command that reaches the network. It fetches a declared remote source into `.pi/capability-vendor/`, refuses a tree containing symbolic links or no packs, and reports digests for review before the result is committed.
- Added `piagent-migrate` to convert `.pi/company-profile.json`, its lock, and `.pi/company-state/` to the new names. Dry-run by default, with an explicit flag to write and a separate flag to remove the old files.
- Added `piagent-import-instructions` to import `CLAUDE.md`, `.claude/rules/`, `.cursor/rules/`, and `.github/copilot-instructions.md` into `AGENTS.md`. Dry-run by default, with a deterministic conflict report; imported text is quoted as data and never alters protected paths, permission profile, or verify commands.
- Added skill wiring for `.claude/skills` and `.codex/skills` at project scope and their home-directory equivalents at global scope, plus doctor checks that report skill directories present on disk but not declared, and instruction files written for other agents.
- Added a golden enforcement suite covering protected paths, protected paths reached through the shell, destructive shell decisions, verification evidence, context budget ceilings, and secret redaction, with a valid and an invalid fixture for every shipped schema.
- Added contributor documentation: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, pull-request and issue templates.
- Added a tag-driven publish workflow with npm provenance and pinned action revisions.

### Changed

- **Breaking.** Renamed the namespace to `piagent` throughout: tools `company_*` to `piagent_*`, commands `pi-company-*` to `piagent-*`, package `pi-agent-platform` to `@piagent/platform`, `packages/pi-company-core/` to `packages/piagent-core/`, environment variables `PI_COMPANY_*` to `PIAGENT_*`, and project state to `.pi/piagent-profile.json`, `.pi/piagent-profile.lock.json`, and `.pi/piagent-state/`. There is no alias layer; a session started against unconverted state warns and names the migration command.
- **Breaking.** Promoted the manifest `apiVersion` from `piagent/v1alpha1` to `piagent/v1`. This is the point at which external packs can pin it, so it is a contract from here on.
- The capability lock now records where each pack came from, so a pack that moves between sources reads as a substitution rather than an update.
- The package is now published rather than private, scoped as `@piagent/platform` with public access and provenance.
- Split shell and external-action classification, shared types, and filesystem helpers out of the guard into their own modules. Behaviour is unchanged.
- Onboarding now names instruction files written for other agents, states plainly that their rules are not in effect, and offers the import; anything inside them is treated as data.

### Fixed

- Fixed a capability policy that declares only some of its allow-lists: the missing lists now deny, instead of failing with an internal error.
- Fixed capability source resolution under a symlinked project parent, where a contained directory could be misread as escaping the project.
- Excluded maintainer working notes from the published tarball. The `files` allowlist takes precedence over `.npmignore`, so the exclusions live in `files`.
- Fixed the package manifest declaring its extension entry points as a directory glob. Pi calls the default export of every path the field matches, so once the guard's helpers moved into modules beside it, the glob offered Pi two modules that export helpers and no extension factory. The manifest now names the guard, and the package still carried the old `@pi-agent/core` name the namespace rename was meant to retire.
- Fixed the verify workflow, which had been unparseable since the runtime-platform step was added and so had not run at all. A single-line `run:` value containing `": "` ends the YAML scalar early; GitHub reports that as an instant failure with no job, so the gate was absent while still appearing present. The local gate now refuses that shape.

### Security

- The runtime host audit now names the one advisory it accepts instead of running at a blanket severity threshold. `GHSA-mh99-v99m-4gvg` (`brace-expansion`, denial of service) is accepted with its reasoning recorded in `scripts/check-runtime-advisories.mjs`: the Pi host publishes an `npm-shrinkwrap.json` that pins the affected version, a published shrinkwrap takes precedence over consumer overrides, and every released host carries a high `brace-expansion` advisory, so no host version and no change in this repository can resolve it. Every other high or critical advisory still fails the audit, the entry expires on a review date, and it fails once the advisory stops being reported so it cannot outlive the problem.

## Unreleased

### Added

- Added solo-first orchestration policy for bounded subagent usage, review lenses, Field Guide status, and model-role guidance.
- Added `company_orchestration_policy` and `/company-orchestration` for compact local orchestration status without a model follow-up.
- Added task-contract fields for `workPlan`, `reviewLenses`, and `orchestration` snapshots.
- Added select-style profile tech setup via `/profile setup` and `/profile tech setup`, including fullstack FE/BE/database selections.
- Added `company_profile_tech_options`, `company_profile_tech_apply`, and `company_profile_tech_context_record` for Context7-ready tech stack manifests and concise per-tech snapshots.

### Changed

- Updated `/task`, `/plan`, `/review`, subagent prompts, and team docs to prefer one parent agent plus bounded scout/planner/reviewer usage instead of broad swarm-style delegation.
- Updated onboarding/docs to treat profile family and project tech stack as explicit operator selections instead of long model explanations.
- Tightened `/profile` status/list output around the single namespace and next exact command so the default path stays compact.
- Clarified runtime support across macOS Apple Silicon, macOS Intel, Linux x64/ARM64, native Windows, and WSL2, and made installer/doctor output report the current runtime surface.

### Fixed

- Hardened orchestration config normalization so malformed numeric settings fall back safely instead of producing invalid policy state.
- Fixed tag CI verification by fetching the annotated release tag ref before checking tag object type and peeled commit identity.
- Added profile-doctor and team-doctor warnings for legacy `shellProtectedPaths`-only entries, clarifying that those paths block shell access only and must move to `protectedPaths` or `readOnlyPaths` for write protection.

## v0.4.8 - 2026-07-22

### Added

- Added release/install policy docs covering stable, exact, dev, local, update, and rollback flows.
- Added `pi-company-install` channel options and dry-run preview for stable, exact, dev, and local installs.
- Added a package-root dispatcher for global `pi-company-*` terminal commands.
- Added `readOnlyPaths` to project profiles for read-only contract areas such as backend code in `be-readonly-fe`.
- Added regression tests for untrusted project profiles, profile-apply confirmation, shell/exec aliases, external-provider write confirmation, BE-readonly/FE-write paths, package distribution, and installer edge cases.
- Added tag-triggered CI verification with immutable GitHub Action revisions on both Ubuntu and macOS.
- Added release identity verification across root/core manifests, package lock, capability lock, changelog, docs badge, tag, and checked-out commit.
- Added a separate high-severity dependency audit for the exact Pi host and pinned optional add-ons instead of relying only on the helper package lock.
- Added a public threat model and `SECURITY.md` with private vulnerability reporting, supported-version, disclosure, and scope guidance.
- Added weekly Dependabot checks for npm and GitHub Actions plus pinned CodeQL v4 analysis for JavaScript/TypeScript and workflow code.
- Added a fail-closed Vercel project-link preflight so a stale local `.vercel` link cannot silently deploy docs to the wrong project.

### Changed

- Clarified public docs comparison with Codex CLI and Claude Code: Pi Company Platform brings similar governance concepts into Pi and packages them for team workflows.
- Reworded security docs to describe the guard as an application-level policy enforcement layer, not a complete security boundary or OS sandbox.
- Split install guidance so production/team setup uses pinned `v0.4.8` or resolved commit sources, while latest is reserved for personal/sandbox use.
- Clarified that redaction benchmarks and internal review are not equivalent to an external security audit.
- Raised the supported Node.js runtime contract to `>=22.19.0`.
- Raised the pinned Pi Coding Agent and Pi AI compatibility from `0.80.10` to `0.81.1`, retaining exact `typebox` compatibility and removing the known high-severity transitive finding present in the previous host tree.
- Updated CI to verify on Ubuntu and macOS with Node.js 22.19.0.
- Documented the three-component Pi-host/helper/Pi-package lifecycle, exact rollback flow, supported operating systems, and post-tag Vercel promotion gate.
- Made setup install or upgrade to the exact Pi host required by the release and made package installation reject an incompatible host version.
- Expanded runtime dependency verification from the Pi host alone to the exact host plus all pinned optional add-ons.

### Fixed

- Hardened local profile loading so `.pi/company-profile.json` is ignored until the project is trusted, unless an operator explicitly sets `PI_COMPANY_PROFILE`.
- Hardened `pi-company-install --stable` so it resolves the release tag to a commit SHA before install and fails closed when resolution is unavailable.
- Bound the deterministic capability lock to `packages/pi-company-core/policies/base-policy.json`.
- Fixed `be-readonly-fe` so backend paths are readable through safe path tools but remain blocked for writes and shell access.
- Applied shell protected-path checks consistently to `bash`, `shell`, and `exec` tool aliases.
- Inspected complete structured shell invocations, including `command`/`cmd` plus `args`, and rejected conflicting, malformed, oversized, or unbounded carriers before execution.
- Added a generic human confirmation gate for external-provider write or ambiguous tools while preserving known safe reads such as `get_release`.
- Rejected conflicting installer package selectors before any install command can run; the first explicit CLI selector now cleanly overrides environment defaults.
- Routed global commands through a package-root dispatcher and converted missing shell-runner failures into controlled errors.
- Isolated runtime-evidence test ledgers so test runs no longer leave new `pi-ledger-*` temporary directories.
- Decoded the extension module URL before locating its package policy so installs under paths containing spaces or other URL-encoded characters load the intended policy.
- Made project init resilient to npm package tarballs that omit its `.pi/.gitignore` dotfile by shipping an explicit fallback template.
- Prevented project init from creating `.pi/.npmignore`, which could override repository ignore rules and re-include local Pi auth, trust, ledger, or database state in an npm package.
- Applied provider confirmation and path policy to the default serialized MCP proxy carrier, including bounded JSON parsing and fail-closed malformed/deep payload handling.
- Closed MCP path-policy bypasses across common aliases such as `filename`, `rootPath`, `source`, `cwd`, and `workingDirectory`; copy sources now use read scope while destinations use write/read-only scope, without treating provider metadata as a local path.
- Applied protected-path checks to camelCase patch carriers and shell proxy variants such as `run`, `execute_process`, and command-bearing aliases before an operator confirmation can allow execution.
- Added confirmation gates for shell-launched GitHub CLI writes and non-read-only HTTP client operations, including wrappers, executable aliases, line continuations, dynamic command construction, `xargs`, and FTP/SFTP quote commands, while keeping recognized reads and argument-only substitutions non-interactive.
- Made every packaged `pi-company-* --help` command succeed without requiring a project path or creating project state.

### Security

- Project-local profiles are not trusted before Pi project trust is active.
- Capability locks now detect base policy tampering, not only runtime source-file changes.
- Tool-based profile apply requires operator confirmation before writing `.pi/company-profile.json` and `.pi/company-profile.lock.json`.
- External provider writes are treated as human-gated actions even under `trusted-full-access`.
- Unknown MCP/provider actions fail closed to operator confirmation; explicit safe reads remain non-interactive.
- Release tags are verified in CI, installer stable channels resolve tags to commit SHAs, and dependency setup actions are pinned by commit SHA.
- Tag CI binds stable resolution to the exact release commit and rejects environment attempts to substitute the helper's package-derived release tag.
- Tag CI now requires an annotated tag whose peeled commit is the exact verified release commit; repository ruleset requirements are documented for immutable `v*` tags.
- Release CI includes redaction, release identity, dependency, CodeQL, package-content, and cross-platform policy gates; Actions are pinned to reviewed commit SHAs.

### Verification

- `npm run verify`: pass.
- `npm test`: 224/224 pass.
- `npm run typecheck`: pass.
- `npm run smoke`: pass.
- Helper dependency audit (`npm audit --audit-level=high`): 0 vulnerabilities.
- Exact Pi 0.81.1 host + pinned add-on audit (`npm run audit:runtime`): 0 high/critical findings; npm reports 11 moderate dependency paths across two upstream advisory families (`@hono/node-server` encoded-backslash traversal on Windows and `protobufjs` parser DoS).
- `npm run benchmark:redaction`: pass.
- `npm pack --dry-run --json`: 144 packaged files; required runtime files present and local trust/secret state excluded; all 12 installed terminal binaries pass `--help` from the built artifact.
- Docs browser/runtime check: 0 duplicate IDs, broken anchors, broken images, unsafe blank targets, or console errors; mobile viewport has no horizontal overflow.

## v0.4.7 - 2026-07-22

### Added

- Added `/commit` as a guarded local commit workflow:
  - inspect status and diff before staging;
  - stage explicit reviewed files only;
  - run relevant verification before commit;
  - never push from `/commit`.
- Added `/pr` as a guarded pull request preparation workflow:
  - inspect branch, status, upstream, and remote;
  - require a clean committed branch before PR work;
  - require explicit operator confirmation before `git push` or GitHub write actions.
- Added an exec-policy confirmation rule for broad Git staging, including `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/`, and `git -C <repo> add .`.
- Added regression tests for the new Git workflow prompts and broad-staging policy.
- Added canonical public docs metadata for `https://piagent.io.vn`.

### Changed

- Install docs now default to latest:
  - `pi install git:github.com/Vt-mmm/pi_agent`
  - `pi update --extensions`
- Pinned install examples use placeholders such as `vX.Y.Z` and `x.y.z` instead of hardcoding an old release.
- Runtime smoke verification now reads the current package version from `package.json` instead of hardcoding a tag.
- Docs site, README, package metadata, and Vercel docs now point to `https://piagent.io.vn`.

### Security

- Git remains a normal guarded capability, not a privileged `/git` bypass.
- Broad staging requires confirmation so unrelated or private files are not committed silently.
- Protected paths, sensitive-output redaction, capability lock integrity, and destructive/external confirmation gates remain active in every permission profile.

### Verification

- `npm run verify`: pass.
- `bash scripts/runtime-policy-smoke.sh`: pass.
- `npm test`: 185/185 pass.
- `npm run typecheck`: pass.

## v0.4.6 - 2026-07-22

### Added

- Added the static HTML documentation site under `docs-site/`.
- Added Vercel static-site configuration and deployment documentation.
- Added project logo, favicon, GitHub link, and Facebook link to the docs site.

### Changed

- Streamlined command documentation for lower-token daily usage.
- Removed the `SHIP` sidebar section from the docs site.
- Centered the docs layout and tightened the visual structure for wide screens.
- Documented latest global install and pinned project setup separately.

### Verification

- `git diff --check`: pass.
- Package verification remains covered by `npm run verify`.

## v0.4.5 - 2026-07-22

### Added

- Added direct profile commands that apply immediately without model follow-up:
  - `/profile`
  - `/profile`
  - `/profile list`
  - `/profile <profile>`
  - `/profile auto`
- Added short profile aliases such as `fe`, `be`, `full`, `be-fe`, and TypeScript-oriented aliases.

### Changed

- `/company-status` and `/company-memory` now return concise local summaries instead of prompting verbose model/tool follow-up.
- Profile status output is intentionally compact to reduce token burn in routine checks.

### Security

- Direct profile apply still regenerates the deterministic capability lock and does not relax protected paths, secret redaction, or capability integrity checks.

## v0.4.4 - 2026-07-21

### Added

- Added session-local permission slash commands:
  - `/permission-status`
  - `/read-only`
  - `/workspace-write`
  - `/full-access`
  - `/full-access <task>`

### Changed

- Permission resolution precedence is explicit: launch environment override, then session command, then project profile, then policy default.
- `/full-access <task>` switches the session and forwards the task text as the next request.

### Security

- `trusted-full-access` remains guarded. It relaxes selected autonomy checks for trusted workspace work but does not disable protected paths, secret redaction, capability lock integrity, or destructive/external confirmations.

## v0.4.3 - 2026-07-21

### Added

- Added runtime permission profiles:
  - `read-only`;
  - `workspace-write`;
  - `trusted-full-access`.
- Added `PI_COMPANY_PERMISSION_PROFILE` for trusted one-run permission override.

### Security

- Invalid permission override values fail closed.
- The profile system is a runtime policy layer, not an operating-system sandbox.

## v0.4.2 - 2026-07-21

### Added

- Added sensitive-data redaction benchmark coverage for contextual secrets, benign preservation, structured payloads, and large output.
- Added release gates for redaction recall and false-positive control.

### Changed

- Improved sensitive-data redaction for common credential shapes and nested structured data.
- Kept unlabeled high-entropy strings observational instead of redacting indiscriminately.

### Verification

- Frozen-tree redaction baseline: 52/52 contextual cases detected, 0/30 benign false positives, 8/8 structured sensitive values redacted, and 7/7 structured benign values preserved.

## v0.4.1 - 2026-07-21

### Fixed

- Hardened shell secret protection against glob expansion targeting protected files.
- Hardened shell protection for bare-word aliases and symlinks resolving to protected paths.
- Added sensitive bash output redaction before tool results reach the model.
- Covered attached redirections such as `cat<.env` and similar shell forms.

### Security

- Static shell protection is stronger, but the guard still does not claim to be an OS sandbox.
- Protected-path blocking and output redaction are separate defense layers.

## v0.4.0 - 2026-07-21

### Added

- Added governed capability packs with deterministic catalog generation.
- Added profile capability resolution and `.pi/company-profile.lock.json`.
- Added lock integrity checks for package source, artifact digests, capability scope, and runtime enforcement files.
- Added atomic profile/lock write behavior with rollback on failure.

### Security

- Lock tampering fails closed.
- Core protected paths include `.pi/settings.json` and `.pi/company-profile.lock.json`.
- Capability scope can only narrow access; protected paths remain denied before allow-scope checks.

# Changelog

This file records release-facing changes for Pi Agent Platform. Copy the relevant version block into GitHub Releases when publishing a tag.

## v1.1.1 - 2026-07-26

Fixes for defects found reviewing v1.1.0 after it shipped.

### Fixed

- `piagent-setup --no-mcp` installs no MCP again. Setup only ever appended `--with-mcp` and relied on the installer defaulting MCP off; v1.1.0 changed that default to on, so the opt-out reached the installer as silence and the installer's default overrode the operator's explicit choice. It now passes `--no-mcp` through. The other install flags stay one-sided because the installer still defaults them off, which is the condition that made the pattern safe in the first place.
- `npm run site:check` no longer hangs when a response exceeds the 4 MB body cap. Hitting the cap destroys the response, and a destroyed response emits neither `end` nor `error` — it goes to `aborted` and `close` — so the promise stayed pending forever, and the request timeout could not rescue it because the socket was already gone. A release gate that hangs is worse than one that fails, because nothing reports it. A body cut short is also now reported as cut short rather than as a page that does not mention the version, which is a different claim.
- `npm run site:check` no longer exits `0` when it could not check an address. Unreachable addresses were printed as `UNVERIFIED` and then the run still ended in `PASS`, so a gate that verified fewer addresses than it resolved reported that it had verified them all. An unchecked address now ends the run; `--allow-unverified` accepts the gap deliberately and names it in the summary.
- `piagent_document_read` refuses bytes that are not valid UTF-8 or UTF-16 instead of decoding them into replacement characters. The binary check was a scan for a NUL byte, which plenty of binary formats do not carry in their first bytes, and everything past it was decoded leniently — so a binary file renamed to `.txt` came back as content-shaped garbage and was handed to the model. Decoding is now strict in both encodings, which is what the surrounding code already claimed to do.
- Two CodeQL high alerts came from building a regular expression out of a version string and escaping only `.`. Those assertions were comparing literal text, so they are substring checks now and need no escaping at all. Two further alerts were reviewed and dismissed with written reasons: extracting `&lt;script&gt;` from a document as `<script>` is the required result and the sink is a terminal tool result, not HTML; and the SHA-256 over a normalised shell command is a content identifier, not a password hash.

### Changed

- The release checklist now requires the **Code scanning results** check on the `main` ruleset, separately from the `analyze (...)` jobs. Requiring those jobs proves only that the analysis ran and uploaded its results — they succeed just as well when the analysis found new high-severity alerts, which is how v1.1.0 merged green with open ones.

## v1.1.0 - 2026-07-26

A document downloaded outside the repository can now be read by the agent, and the two documented install commands stop disagreeing about MCP.

### Added

- Added `piagent_document_read`, which reads a document from a directory outside the project. Downloading a spec to `~/Downloads` and then having no way to hand it to the agent was a dead end with no workaround short of copying the file into the repository. A directory is granted through `additionalReadRoots` in the project profile or the `PIAGENT_ADDITIONAL_READ_ROOTS` environment variable, and the grant widens only where documents may come from. It is read-only. It accepts `.md`, `.markdown`, `.txt`, `.text`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, `.pdf`, and `.docx`, and refuses every other extension sitting in the same directory. `protectedPaths` still wins over it, matched against both the absolute and the project-relative form of the path so that root-anchored patterns are not silently skipped, and a capability pack that narrows filesystem read scope still narrows it for documents inside the project. Both the containment check and the extension check are made against the canonical path, so a link named `notes.md` cannot hand over the key file it points at.
- `.docx` is read without a dependency, from a bounds-checked archive reader that names what was wrong with a malformed file rather than reporting every failure as a missing document. Text struck out by an unaccepted tracked change is dropped instead of being spliced onto its replacement, tab-stop declarations no longer emit tab characters, field instruction codes are not read as prose, and a character reference outside the Unicode range is left as written rather than ending the read. `.pdf` goes through `pdftotext`, under a timeout, and a missing binary is reported as missing rather than as an empty document. Byte-order-marked UTF-16 is decoded rather than rejected as binary. Returned text is redacted and enclosed in a data region delimited by a marker the document cannot predict, because a downloaded document is exactly the kind of file that carries both a pasted key and a sentence addressed to an agent.
- Added `npm run site:check`, which verifies the published documentation site at every address it resolves to instead of once through whichever address a browser happened to pick. It requires each address to return the released version, reports a redirect from an address back to its own host as a loop rather than following it, and reports an address the machine cannot route to as unverified rather than as a pass. Release checklist step 8 was a manual look, and a manual look cannot see a partial outage.

### Changed

- Raised the pinned Pi Coding Agent and Pi AI host from `0.81.1` to `0.82.0`. `typebox` stays exactly `1.1.38` across both, so the pin moves without a compatibility change. `npm run audit:runtime` on the `0.82.0` tree reports one high advisory, the same already-accepted `GHSA-mh99-v99m-4gvg` under review by 2026-08-25, and no critical. Verified against a real `0.82.0` host: runtime policy smoke and `team-doctor --strict-share` both pass with no warnings.
- `piagent-install` now installs the MCP baseline by default, the same as `piagent-setup` already did, and both accept `--no-mcp` to skip it. The two documented entry points disagreed: `piagent-setup` defaulted to installing MCP and `piagent-install` defaulted to not installing it, so a newcomer who followed the team onboarding document ended up with no MCP at all — and was then told to run `/mcp`, because the installer printed that next step whether or not it had installed anything. That next step is now printed only when MCP was installed, and `--mcp-preset` combined with `--no-mcp` fails instead of being accepted and quietly dropped.
- Cut the command count in the three places a new user actually lands. The README went from 28 shell blocks to 4 and now opens with install rather than four variants of a wrapper for software the reader has not installed yet; the Vietnamese quickstart went from 23 to 7 and its install step from 120 lines to 28; the documentation site's onboarding flow went from eight install command cards to one. Pinned rollouts, updates, rollback, the `--dev` channel, and per-tool command lists were not deleted — every one of them already had a dedicated document, and each is now linked from where it used to be inlined.

### Fixed

- Writing MCP server definitions now says what each server still needs before it can connect: Chrome for the Chrome DevTools server, Docker plus `GITHUB_PERSONAL_ACCESS_TOKEN` for the GitHub server. Servers connect lazily, so a successful install proved nothing about whether they would work, and the Docker requirement existed only in a description string visible under `piagent-mcp --list`. The note goes to stderr so the report on stdout stays machine-readable, and `--list` now carries the same requirements as data.
- An advisory tool-registry verdict is now shown. `toolRegistry` defaults to `advisory` and the evaluation returned a `warn` decision, but the hook acted only on `block`, so the verdict was computed and discarded — advisory mode was indistinguishable from off, and the documentation said the agent received a warning. The notice is emitted once per tool per session, because one on every call would be noise rather than a warning.
- `piagent-uninstall --with-addons` now reports the MCP baseline file that install actually writes. It named the Pi-global override path while install writes the shared global path, so an operator following the printed advice inspected the wrong file — usually an empty one, which reads as "already clean".
- Project onboarding now says that the `.mcp.json` files it writes are empty on purpose and that the shared baseline lives in the global config. An empty file in a fresh project reads as a failed install.
- Documented that `mcpCapabilities` in a project profile, the `github` key in the policy tool registry, and the `github` MCP server are three unrelated things that share a name. No code maps a capability name to an MCP server, so declaring `github` in a profile does not enable the GitHub server and never did.
- `piagent-init` running from an installed package now writes `npm:@piagent/platform@<version>` into project settings, matching what `piagent-setup` already did. It is the second way a project gets its settings written, and it still wrote the directory the platform happened to be installed in — a value that means nothing on a teammate's machine, in a file meant to be committed.
- Documentation-coverage checks in the local gate now name the term that went missing and the files searched. They were bare `grep >/dev/null` calls under `set -e`, so dropping a term from a document failed the gate with exit 1 and no output at all. The gate's `npm test` and `npm run typecheck` steps had the same defect from the other direction — their output went to `/dev/null` on every run, so a failing test ended the gate with no indication of which test failed. Both now stay quiet on success and print what they captured on failure.
- Documented that `piagent-setup` installs the Herdr Pi integration when `herdr` is on `PATH`, and that installing Herdr afterwards needs `piagent-setup --global-only` to pick it up. The behaviour has always been the default and the skip is only a warning on stderr, so the ordering was discoverable only by reading the installer. Herdr is also now named as the way to run several Pi panes at once in the README, the quickstart, and the documentation site, none of which mentioned it, and every one of those places now carries the install command itself rather than a link to go find it. The `brew` form is listed beside the `curl` form that herdr.dev leads with, because piping a fetched script to a shell is worth an alternative in a project that pins everything else it installs.
- Folded a stale `Unreleased` section into v1.0.0, where its contents actually shipped. It had been left behind by the namespace rename and still described tools as `company_orchestration_policy`, `company_profile_tech_options`, `company_profile_tech_apply`, `company_profile_tech_context_record`, and `/company-orchestration`, none of which exist.

## v1.0.2 - 2026-07-25

Install and uninstall become two commands each. The five-command sequence was never the shortest path; it was the only one that produced a project configuration a teammate could use.

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
- Added a solo-first orchestration policy covering bounded subagent usage, review lenses, Field Guide status, and model-role guidance, surfaced by `piagent_orchestration_policy` and `/piagent-orchestration` so status reads without a model follow-up. Task contracts gained `workPlan`, `reviewLenses`, and `orchestration` snapshots to record it.
- Added select-style profile tech setup through `/profile setup` and `/profile tech setup`, including fullstack frontend, backend, and database selections. `piagent_profile_tech_options`, `piagent_profile_tech_apply`, and `piagent_profile_tech_context_record` produce Context7-ready stack manifests and per-tech snapshots.

### Changed

- **Breaking.** Renamed the namespace to `piagent` throughout: tools `company_*` to `piagent_*`, commands `pi-company-*` to `piagent-*`, package `pi-agent-platform` to `@piagent/platform`, `packages/pi-company-core/` to `packages/piagent-core/`, environment variables `PI_COMPANY_*` to `PIAGENT_*`, and project state to `.pi/piagent-profile.json`, `.pi/piagent-profile.lock.json`, and `.pi/piagent-state/`. There is no alias layer; a session started against unconverted state warns and names the migration command.
- **Breaking.** Promoted the manifest `apiVersion` from `piagent/v1alpha1` to `piagent/v1`. This is the point at which external packs can pin it, so it is a contract from here on.
- The capability lock now records where each pack came from, so a pack that moves between sources reads as a substitution rather than an update.
- The package is now published rather than private, scoped as `@piagent/platform` with public access and provenance.
- Split shell and external-action classification, shared types, and filesystem helpers out of the guard into their own modules. Behaviour is unchanged.
- Onboarding now names instruction files written for other agents, states plainly that their rules are not in effect, and offers the import; anything inside them is treated as data.
- `/task`, `/plan`, `/review`, the subagent prompts, and the team docs now prefer one parent agent plus bounded scout, planner, and reviewer usage instead of broad swarm-style delegation.
- Onboarding and docs treat profile family and project tech stack as explicit operator selections rather than long model explanations, and `/profile` status and list output stay compact around the single namespace and the next exact command.
- Runtime support is stated across macOS Apple Silicon, macOS Intel, Linux x64 and ARM64, native Windows, and WSL2, and the installer and doctor report the runtime surface they are actually on.

### Fixed

- Fixed a capability policy that declares only some of its allow-lists: the missing lists now deny, instead of failing with an internal error.
- Fixed capability source resolution under a symlinked project parent, where a contained directory could be misread as escaping the project.
- Excluded maintainer working notes from the published tarball. The `files` allowlist takes precedence over `.npmignore`, so the exclusions live in `files`.
- Fixed the package manifest declaring its extension entry points as a directory glob. Pi calls the default export of every path the field matches, so once the guard's helpers moved into modules beside it, the glob offered Pi two modules that export helpers and no extension factory. The manifest now names the guard, and the package still carried the old `@pi-agent/core` name the namespace rename was meant to retire.
- Fixed the verify workflow, which had been unparseable since the runtime-platform step was added and so had not run at all. A single-line `run:` value containing `": "` ends the YAML scalar early; GitHub reports that as an instant failure with no job, so the gate was absent while still appearing present. The local gate now refuses that shape.
- Fixed orchestration config normalization so a malformed numeric setting falls back to a safe value instead of producing invalid policy state.
- Fixed tag CI verification, which checked tag object type and peeled commit identity without first fetching the annotated release tag ref.
- Profile doctor and team doctor now warn on entries that appear only in `shellProtectedPaths`. Those paths block shell access alone; write protection requires `protectedPaths` or `readOnlyPaths`, and the warning names the move.

### Security

- The runtime host audit now names the one advisory it accepts instead of running at a blanket severity threshold. `GHSA-mh99-v99m-4gvg` (`brace-expansion`, denial of service) is accepted with its reasoning recorded in `scripts/check-runtime-advisories.mjs`: the Pi host publishes an `npm-shrinkwrap.json` that pins the affected version, a published shrinkwrap takes precedence over consumer overrides, and every released host carries a high `brace-expansion` advisory, so no host version and no change in this repository can resolve it. Every other high or critical advisory still fails the audit, the entry expires on a review date, and it fails once the advisory stops being reported so it cannot outlive the problem.

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

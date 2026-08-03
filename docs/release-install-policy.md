# Release and install policy

## Purpose

Pi Agent Platform uses explicit release sources for team rollout. Personal machines may follow a moving source when fast iteration matters, but team environments and committed project settings use exact tags or reviewed commits so every developer receives the same platform package.

This file is the canonical install, update, rollback, and release checklist. Other docs link here instead of maintaining a second release procedure.

## Supported runtime matrix

All supported environments require Node.js `>=22.19.0` and Pi Coding Agent `0.82.0`. The Pi host is installed as a Node CLI; Pi Agent Platform still defines its own release matrix because the terminal helpers and shell policy rely on Bash/POSIX behavior.

| Surface | Status for v1.2.16 | Rollout guidance |
|---|---|---|
| macOS Apple Silicon (`darwin/arm64`) + Bash | Verified for this release. | Safe default for team rollout after normal project smoke tests. |
| Linux x64 + Bash | Verified in GitHub Actions. | Safe default for CI/server usage after normal project smoke tests. |
| macOS Intel (`darwin/x64`) + Bash | Supported target; not currently a dedicated release-gate runner. | Run `piagent-doctor` plus the target project's smoke/verify suite before broad rollout. |
| Linux ARM64 + Bash | Supported target; not currently a dedicated release-gate runner. | Run `piagent-doctor` plus the target project's smoke/verify suite before broad rollout. |
| Native Windows x64/ARM64 | Not supported for team rollout in this release. | Node is available on Windows, but platform helper scripts and shell parsing assume Bash/POSIX semantics. Use a verified macOS/Linux surface for release-critical work. |
| WSL2 | Experimental and not release-gated. | Treat as local/personal until a WSL lane and smoke suite are added. |

## Runtime and two installation planes

| Component | Installed by | Provides |
|---|---|---|
| Pi host runtime | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<exact-version>` | The compatible `pi` executable. |
| Terminal helper | `npm install -g --ignore-scripts @piagent/platform@X.Y.Z` | `piagent-*` commands on `PATH`. |
| Pi package | `piagent-install`, or `pi install ...` | Extensions, prompts, skills, and subagents loaded by Pi. |

These three components are versioned independently. A full install, update, or rollback must use the exact Pi host declared by the target release, then install the target terminal helper, then let that helper install its matching Pi package. `piagent-install` changes only the Pi package; it does not replace the Pi host or the npm-global terminal helper currently executing. In installer output, `currentRelease` is the terminal helper package version.

## Release channels

| Channel | Source shape | Mutability | Use when |
|---|---|---:|---|
| `stable` | `git:github.com/Vt-mmm/piagent@<resolved-commit-sha>` from `v1.2.16` | Fixed after resolution | Default for team rollout. |
| `exact` | Tag, reviewed commit, or a tag resolved with `--resolve-tag` | Fixed when using a commit SHA | Pi-package-only roll forward, rollback, or reproduction. |
| `dev` | `git:github.com/Vt-mmm/piagent` | Moving | Personal machine or sandbox only. |
| `local` | `/path/to/piagent` | Local workspace | Platform development and dry-run validation. |
| `npm` | `npm:@piagent/platform@x.y.z` | Fixed | Registry distribution. Use when the machine has no Git access to this repository. |
| `enterprise-npm` | `npm:@your-scope/platform@x.y.z` | Fixed | Private registry distribution when a fork is published under another scope. |

`--stable` reads the helper package version from its own `package.json`, resolves that release tag through GitHub, and installs the resulting commit SHA. If the tag cannot be resolved, install fails closed. Release CI additionally sets `PIAGENT_EXPECTED_RELEASE_COMMIT`; the installer then rejects a tag that resolves anywhere except the commit being verified.

The terminal helper installs from the registry while `stable` still resolves the Pi package to a commit SHA. That difference is deliberate. The helper is a published tarball whose provenance attestation is what ties it back to a commit, and npm verifies that. The Pi package instead relies on tag-to-SHA resolution checked against `PIAGENT_EXPECTED_RELEASE_COMMIT`, which is a separate chain that a registry version range cannot express. Pointing `stable` at an npm version would drop that check rather than replace it, so the `npm` channel exists for machines without Git access to this repository, not as the default.

Exactly one CLI package selector is accepted: `--package-source`, `--channel`, `--stable`, `--dev`, `--local`, `--version`, or `--tag`. The first CLI selector may replace environment defaults; a second CLI selector is rejected before any install command is printed or executed.

## First install — full platform

Use this flow when the team needs both terminal commands and the Pi package:

```bash
node --version  # >= 22.19.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.82.0
npm install -g --ignore-scripts @piagent/platform@1.2.16
piagent-install --stable --dry-run
piagent-install --stable
```

The stable preview and apply output includes:

```text
currentRelease: v1.2.16 (helper package version)
tag: v1.2.16
resolvedCommit: <40-char-sha>
source: git:github.com/Vt-mmm/piagent@<40-char-sha>
```

From a checked-out platform repository, the same Pi-package install is available as:

```bash
bash scripts/install-global.sh --stable --dry-run
bash scripts/install-global.sh --stable
```

## First install — Pi package only

Use this only when terminal commands are not needed:

```bash
pi install git:github.com/Vt-mmm/piagent@v1.2.16
```

Direct `pi install` does not create `piagent-*` commands on `PATH`.

## Full platform update

`piagent-update` does the whole sequence in one command:

```bash
piagent-update --check
piagent-update --dry-run
piagent-update --version X.Y.Z
```

It resolves the target helper version and, from that version's published metadata, the exact Pi host that version pins — both before installing anything, so `--check` and `--dry-run` describe a real run. It then installs the host, replaces the helper, verifies that the version now on disk is the one it asked for, and only then runs the new helper's installer for the Pi package. `--version X.Y.Z` targets an exact release instead of latest, `--no-host` and `--no-package` narrow the run, and anything after `--` is passed to `piagent-install`.

Project migration and doctor are post-update checks, not the update scope. Run them only for the project being verified:

```bash
piagent-update --version X.Y.Z --project /path/to/project
```

With `--project`, the updater migrates legacy project state if needed and runs `piagent-doctor --strict-share`; use `--no-migrate` only when debugging a migration.

From `v1.2.11`, project migration also previews and upgrades Task Contract v1
state to session-bound v2. It fails before changing project files when any task
state is unreadable, writes v2 atomically, and archives v1 only after the new
contract exists. Opening the project with the new Pi package also performs the
same idempotent task-state migration for resumed sessions.

The `v1.2.11` migrator also upgrades the exact generated `v1.2.10` `AGENTS.md`
and future `<!-- piagent-managed:* -->` blocks while preserving project text
outside that block. A global-only update is still effective immediately: the
runtime replaces the exact legacy checklist in the model's in-memory system
prompt without editing the project file. Running `--project` makes the cleanup
durable and lets doctor verify it.

A project already onboarded does not need onboarding again after a global
update. Its profile still extends the newly installed adapter and its capability
lock re-pins only when the release does not widen the project's grants. Daily
source work must start a new v2 task in a Git working tree with a configured
verify command; read-only scout remains available without a source verifier.

The updater first identifies the npm prefix that owns the active
`piagent-update` command. If that prefix is writable, host and helper stay there
even when `npm config get prefix` points somewhere else, such as an active
`/opt/homebrew` install with npm configured for `/usr/local`. This prevents two
same-version helpers with different source from shadowing one another. If both
the active prefix and the configured global prefix are locked, the updater uses
`~/.pi/npm-global` and prints the `PATH` line to add later. Do not run project
update/doctor as root, because that can leave project files owned by root.
Maintainers can force a specific prefix with `--npm-prefix <path>`.

For a fresh machine that does not have `piagent-update` yet, bootstrap the same all-in-one flow without opening Pi:

```bash
npm exec -y --package @piagent/platform@X.Y.Z -- piagent-update --version X.Y.Z --force
```

Running it from a git checkout is refused rather than replacing that checkout's commands with a published build; update a checkout with `git pull` and `install-global.sh --local`.

The same sequence by hand, which must keep this order because `piagent-install` fails against a host that does not match the version it pins and does not install one itself:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.82.0
npm install -g --ignore-scripts @piagent/platform@X.Y.Z
piagent-install --stable --dry-run
piagent-install --stable
piagent-doctor /path/to/project --strict-share
```

Review the target `CHANGELOG.md` before applying the update. Confirm that `currentRelease`, `tag`, and `resolvedCommit` all describe the intended release.

## Pi-package-only update

This flow changes the Pi package but intentionally leaves the npm-global helper unchanged:

```bash
piagent-install --version vX.Y.Z --resolve-tag --dry-run
piagent-install --version vX.Y.Z --resolve-tag
piagent-doctor /path/to/project --strict-share
```

Alternatively, install a reviewed Pi source directly:

```bash
pi install git:github.com/Vt-mmm/piagent@vX.Y.Z
```

`pi update --extensions` refreshes configured package refs. It does not move a pinned project from one tag or commit to a different target; install the new reviewed ref explicitly.

## Full platform rollback

Rollback the host, helper, and Pi package together. Determine the exact host version from the target release's compatibility section before running this sequence; do not assume the current host is supported by an older helper.

```bash
TARGET_PI_VERSION=x.y.z  # replace from vPREVIOUS release policy before execution
npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$TARGET_PI_VERSION"
npm install -g --ignore-scripts @piagent/platform@PREVIOUS
piagent-install --stable --dry-run
piagent-install --stable
piagent-doctor /path/to/project --strict-share
```

Older host versions may reintroduce dependency findings fixed by the current release; treat that as an explicit rollback risk. Restore project state only if the older package cannot read a newer profile, lock, or runtime-state format. Preserve the current state separately before restoring a project snapshot.

## Pi-package-only rollback

Use this when terminal helpers must remain at their current version:

```bash
piagent-install --version vPREVIOUS --resolve-tag --dry-run
piagent-install --version vPREVIOUS --resolve-tag
piagent-doctor /path/to/project --strict-share
```

## Uninstall

Rollback moves between releases. Uninstall leaves entirely, and it is the flow a team member or an external user reaches for when this platform is no longer wanted on their machine.

`piagent-uninstall` reports and exits; `--apply` performs the removal. The default is a report because the command edits Pi's global settings, which other tools also write to.

```bash
piagent-uninstall
piagent-uninstall --apply
```

Each additional layer is opt-in, so leaving the platform never takes the Pi host or a project's history with it by surprise:

```bash
piagent-uninstall --apply --with-addons               # pi-mcp-adapter, pi-subagents, pi-web-access
piagent-uninstall --apply --with-host                 # the exact Pi Coding Agent host
piagent-uninstall --apply --project /path/to/project  # a project's profile, lock, and runtime state
npm uninstall -g @piagent/platform                    # the npm-global helper, removed separately
```

Removal reads the package entries registered in Pi's settings rather than assuming what the running version installs. A machine that first installed the platform before the namespace rename still has that older entry removed.

### What uninstall will not remove

These are operator data, not platform state, and no flag combination deletes them:

| Kept | Why |
|---|---|
| `.pi/auth.json`, `.pi/trust.json` | Credentials and trust decisions. Re-earning them is not a cleanup step. |
| `.pi/sessions/`, `.pi/todos/` | Work history that predates and outlives the platform. |
| `.pi/memory/` | Accumulated project memory. Deleting it destroys work the platform only stored. |

Files written from a template and then edited in place — `AGENTS.md`, `REVIEW_GUIDELINES.md`, `.mcp.json`, `.pi/settings.json`, `.pi/mcp.json`, `.pi/project-context.md`, `.pi/context-index.json`, `.pi/tech-stack.json` — are listed rather than deleted, because by the time uninstall runs they hold project content rather than template content.

`.pi/settings.json` is Pi's file, not this platform's. Uninstall drops only the `packages` entry pointing here and leaves every other setting untouched.

The global MCP baseline at `$PI_CODING_AGENT_DIR/mcp.json` and the subagent config beside it are shared files that may have been edited after install. `--with-addons` reports their paths instead of resetting them.

## Canonical release checklist

Production docs must never advertise a tag that cannot yet be installed.

### Required GitHub repository controls

Before broad team access, a repository administrator must enable these external controls; source files cannot turn them on:

1. Create an active branch ruleset for `main` that requires a pull request, blocks force-push and deletion, and requires the checks shown by the workflows, including `verify (ubuntu-latest)`, `verify (macos-latest)`, `analyze (actions)`, and `analyze (javascript-typescript)`. Add one narrowly scoped release-maintainer bypass actor for the exact non-force fast-forward promotion described below; do not give this bypass to the normal team role.
2. Create an active tag ruleset targeting `v*`. Restrict creation to the maintainer/release role and block tag update and deletion. This is mandatory because the first npm-global helper install uses a release tag before that helper can resolve its Pi-package source to a commit SHA.
3. Enable Dependency graph, Dependabot alerts, and Dependabot security updates. Keep `.github/dependabot.yml` enabled for scheduled npm and GitHub Actions update pull requests.
4. Enable GitHub private vulnerability reporting so the form linked by `SECURITY.md` works before public rollout.
5. Keep secret scanning and push protection enabled. Review CodeQL results after the workflow's first successful run.
6. Add the **Code scanning results** check to the `main` branch ruleset and set its alert threshold so that a new high-severity CodeQL alert blocks the merge. The `analyze (...)` jobs required above only prove the analysis ran and uploaded its SARIF; they succeed just as well when the analysis found new high-severity alerts. Without this separate check, a pull request merges green with open high alerts, which is what happened on `v1.1.0`: its pull request carried a failing `CodeQL` check run and a high alert open since the day before, and merged anyway because the rule did not yet require the result. Requiring the `analyze` jobs is still necessary — it catches an analysis that failed to run — but it is not the results gate and must not be mistaken for one.

Verify these settings in GitHub **Settings → Rules** and **Settings → Code security and analysis**. Treat any missing control as an explicit rollout blocker, not as a passing source-code gate. Repository rules also close the remaining mutability risk of bootstrap-by-tag; tag-to-SHA resolution inside `piagent-install` alone cannot protect the helper package before it starts.

Alerts dismissed as false positives carry their reason in the dismissal comment, and the reason belongs in the source as well when the flagged shape is deliberate. An alert dismissed without a written reason is indistinguishable from an alert nobody read.

### Required npm publishing controls

The publish workflow authenticates with the `NPM_TOKEN` repository secret. That token needs three things, and read-and-write access alone is not enough:

1. Read and write access to the `@piagent` scope.
2. **Bypass two-factor authentication** enabled on the token. When the npm account requires 2FA for publishing, the registry rejects the upload with `E403 ... two-factor authentication or granular access token with bypass 2fa enabled is required`. CI cannot answer a 2FA prompt, so this is the only way a workflow can publish.
3. An expiry date the maintainer tracks. An expired token fails as an authentication error that does not say the token expired.

The workflow reaches the registry only at its final step, so every gate can pass and the release can still stop there. A failed upload publishes nothing, but the provenance attestation is signed and written to the public transparency log first, so a failed attempt still leaves a public record of the repository, commit, and workflow.

Fix the token, then re-run the failed job on the same tag so the publish step still sees a tag ref:

```bash
gh run rerun <run-id> --failed
```

Re-running the workflow from a branch instead skips publishing, because the publish step requires a tag ref.

1. Update package versions, `CHANGELOG.md`, install examples, and docs metadata on a release-candidate branch.
2. Verify the exact release-candidate source:

   ```bash
   npm run verify
   npm test
   npm run typecheck
   npm run smoke
   npm run benchmark:redaction
   npm audit --audit-level=high
   npm run audit:runtime
   npm run release:identity
   npm pack --dry-run --json
   bash scripts/setup.sh --global-only --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z --dry-run
   ```

   Nếu release thay đổi harness, context budget, tool loading hoặc logic tính
   token, maintainer trước tiên chạy smoke suite bằng `piagent-benchmark`, sau
   đó chạy production suite với `--production --surfaces piagent,codex-cli --model <provider/model> --thinking <level>` trên đúng release candidate và lưu
   report. Production gate dùng 108 model session, generated held-out variant,
   category bands và 95% token-ratio confidence nên là model-quota gate có xác
   nhận riêng, không chạy ngầm trong CI. Không claim token/cost nếu report không
   cho phép `tokenClaimAllowed` hoặc `productionGate.passed` khác `true`.
   Zero-usage process failure có thể retry tối đa hai lần với backoff và phải xuất hiện trong
   infrastructure ledger; timeout hay task failure không được retry để né điểm
   reliability.

3. Push the release-candidate branch, open a pull request to `main`, and wait for both Ubuntu/macOS verify jobs and both CodeQL matrix jobs to pass. Record the exact PR-head commit SHA that passed; do not merge it into the Vercel production branch yet, and do not tag a later unverified edit.
4. Create an annotated, reviewed tag on that exact verified commit and push the tag. Pushing the tag starts `publish.yml`, which runs the full verify matrix as a dependency and only then publishes, so a failure on any supported runtime stops the release before it reaches the registry:

   ```bash
   RC_COMMIT=<verified-40-char-pr-head-sha>
   git tag -a vX.Y.Z "$RC_COMMIT" -m "Pi Agent Platform vX.Y.Z"
   git push origin vX.Y.Z
   ```

   Use a signed tag when the maintainer signing setup is available. Tag CI requires an annotated tag, verifies that it equals `v<package-version>`, checks that its peeled commit equals the checked-out release SHA, confirms root/core/capability-lock/docs versions agree, requires the stable installer to resolve back to that same SHA, and runs high-severity dependency gates for both the helper tree and exact Pi host + pinned add-ons. Wait for the tag-triggered Ubuntu and macOS CI jobs to pass before continuing.

5. Verify the remote tag and confirm stable resolution points to the tagged commit:

   ```bash
   git ls-remote --tags origin refs/tags/vX.Y.Z 'refs/tags/vX.Y.Z^{}'
   RELEASE_COMMIT="$(git rev-parse vX.Y.Z^{})"
   PIAGENT_EXPECTED_RELEASE_COMMIT="$RELEASE_COMMIT" bash scripts/install-global.sh --stable --dry-run --no-model-scope
   ```

6. Create a draft GitHub release from the matching `CHANGELOG.md` section. Keep it unpublished until production docs are verified:

   ```bash
   gh release create vX.Y.Z --draft --verify-tag --title "vX.Y.Z" --notes-file /tmp/pi-agent-vX.Y.Z-release-notes.md
   ```

7. Only after tag CI and stable SHA verification pass, the designated release maintainer uses the ruleset bypass for a non-force fast-forward of the exact tagged commit to `main`. Do not merge, squash, rebase, or introduce a different commit during promotion:

   ```bash
   git fetch --tags origin main:refs/remotes/origin/main
   RELEASE_COMMIT="$(git rev-parse vX.Y.Z^{})"
   test "$(git merge-base origin/main "$RELEASE_COMMIT")" = "$(git rev-parse origin/main)"
   git push origin "$RELEASE_COMMIT:refs/heads/main"
   ```

   The open release pull request should then resolve against the same commit history. This bypass exists only to reconcile reviewed PR checks with tag-first Vercel promotion; it must never be used for an unreviewed commit or a force-push. If Vercel auto-deploys `main`, this exact fast-forward is the production promotion. For an explicit CLI deploy instead, check out the exact tag, run `vercel link --cwd docs-site --project pi-agent`, require `npm run vercel:preflight` to pass, then deploy with `vercel --cwd docs-site --prod`.
8. Verify the live docs site at every address it resolves to, then read the page for links and install commands.

   ```bash
   npm run site:check
   ```

   Opening the site in a browser does not answer this. The domain has several address records, so one can be dead or looping while every manual look lands on a healthy one. This resolves both hosts, asks each address directly with the right `Host` header and SNI, and requires each to return the released version. A redirect from an address back to its own host is reported as a loop rather than followed.

   An address the machine has no route to ends the run. It is reported separately from a site failure, because the machine is what is missing rather than the site, but it is not a pass either — the release gate must not report that it verified every address in a run where it verified fewer. Run the check from a machine with routes to every address family the domain publishes. `--allow-unverified` accepts the gap deliberately and names it in the summary; use it only when the missing route is understood and the remaining addresses were verified.
9. Publish the already-reviewed draft only after production verification passes:

   ```bash
   gh release edit vX.Y.Z --draft=false
   ```

10. Announce the release, then roll out with the full platform update flow above and run doctor/smoke checks on representative team projects.

## Security notes

- Do not use a moving source in committed project settings.
- Do not publish local trust files, OAuth tokens, `auth.json`, sessions, caches, or `.env` files.
- Review the resolved commit SHA before rollout; tag resolution improves reproducibility but is not signed package provenance by itself.
- `npm audit --audit-level=high` covers this repository's helper dependency tree. `npm run audit:runtime` separately builds the exact optional Pi host and pinned add-on dependency tree and blocks unaccepted moderate, high, or critical findings so stale or permissive peer resolution cannot hide deployed runtime risk.
- Run doctor after install, update, or rollback so package source, project profile, protected paths, and share policy are checked together.

# Changelog

This file records release-facing changes for Pi Agent Platform. Copy the relevant version block into GitHub Releases when publishing a tag.

## v1.2.1 - 2026-07-28

### Fixed

- The approval gate never covered direct MCP tools. It looked for a tool named `mcp__<server>__<tool>`; the adapter builds a name by joining the server's own name to the tool's, so `github` exposes `github_create_issue` and nothing ever matched. Every server was reachable with one `directTools` setting, which `piagent-mcp add --direct-tools` offers and the docs recommend for small servers. Attribution now runs against the configured server names across every prefixing mode. A repository-carried config that sets `directTools` with `toolPrefix: "none"` is refused outright rather than parsed: with no prefix the tool name holds no evidence of its server, so there is nothing to check a decision against.

  The v1.2.0 notes, `docs/mcp-and-tools.md` and the documentation site all stated the direct form was covered. It was not, and the test that asserted it asserted the same invented name shape.

- A repository could reach servers the gate never enumerated through the adapter's `imports` key. `.mcp.json` naming `vscode` pulls servers out of `.vscode/mcp.json`, which travels with the clone, while the gate reported no repository servers at all. Servers reachable through a repository-relative import are now collected and gated whichever layer declares the import, and a repository scope that imports any kind has those servers gated too. `piagent-mcp doctor` names the file and the kinds, and reports a config layer it cannot parse instead of counting it as empty.

- `piagent-capability vendor` emptied its destination before checking containment and only tested the immediate parent for a symlink. A repository shipping `.pi` as a symlink had the recursive delete and the fetch land outside the project. The whole path is now verified against the resolved project root before anything is created or removed.

- The shell guard followed nested interpreters four levels deep and then stopped looking, so a payload wrapped in five layers of `bash -c` was permitted on the strength of a level nobody read. The walk now goes to sixteen levels and refuses a command that nests past it, rather than falling silent.

- An artifact shipped by a vendored capability source could change content while the lock still classified as `repin`. Artifact bytes stay on the build side for packs the platform ships — pinning them would stop a policy correction reaching the projects that reference it — but that reasoning does not transfer to a source the project vendored in, whose manifest digest pins the artifact list rather than its contents.

- A credential in an MCP server URL was stored and displayed in clear text. `add` now refuses userinfo and credential-shaped query parameters the same way it refuses them in `--env` and `--header`, and `list` and `get` mask a URL already on disk.

- `piagent-mcp approve`, `reject` and `reset` reported success when the approval store could not be written, leaving the operator waiting on a gate that was still blocking. All three now fail with the path that could not be written.

- A server using `bearerTokenEnvVar` reported `ready` with the variable unset. The field names its variable directly rather than through a `${VAR}` reference, so the scan that finds referenced variables never saw the one setting that guarantees a credential is needed.

- A capability pack could declare `activation.mode: "profile"` with no profiles list and crash resolution with a TypeError. The validator requires the list, the same way it already required triggers for trigger activation.

- `configure-model-scope.sh` and `quality-benchmark.sh` took the next argument as a flag's value without checking it was one. `--preset full --settings --dry-run` wrote a settings file named `--dry-run`, exited 0 and reported success, having skipped the dry run it was asked for and never touched the real settings file.

### Changed

- `docs/mcp-and-tools.md` records the config path and server key each supported import kind actually uses, against what the adapter reads. Three of the six disagree, so the platform reads the union: listing a server that never loads costs one approval, missing one costs the gate.

## v1.2.0 - 2026-07-28

### Added

- `piagent-mcp` manages servers instead of only seeding presets: `add`, `remove`, `get`, `list`, `enable`, `disable` and `doctor`, across the four config layers via `--scope`. `add` reports which scope it wrote and the exact file it changed, so nobody has to guess which layer is in effect. A server added by hand keeps surviving `piagent-update`, because a preset only rewrites the server IDs it owns.

- A server a repository defines is not usable until somebody on this machine approves it. `.mcp.json` and `.pi/mcp.json` travel with a clone, and opening a session in one should not hand its author a process here with this operator's credentials. `piagent-mcp approve` prints the definition before recording the decision, `reject` and `reset` are the other two answers, and the decision is stored in `~/.pi/piagent-mcp-approvals.json` rather than in the repository — a repository that can approve its own servers has not been gated.

  The record pins the digest of what was approved. Approval is consent to what the server runs, so changing its command, URL or arguments returns it to pending, which is the same split the capability lock draws between consent and build.

  Enforcement is in the guard's `tool_call` hook. As shipped in this version it covered the `mcp` proxy only — the direct-tool branch matched a name shape the adapter does not emit, so it never fired. See v1.2.1. The adapter owns the connection and the extension cannot prevent one being opened, so what is stopped is every tool call, not the connection itself. Servers in the global layers are not gated: nothing a repository contains can put a server there.

- MCP is a command inside a session, not a request to the model. `/piagent-mcp` on its own opens a menu, because a surface only helps if it can be found without already knowing the subcommand. The menu is built from what the project has: approving is not offered when nothing is waiting on a decision, and each entry carries its own count. Picking an action that needs a server asks which one, unless there is only one it could be.

  Every entry is also typeable — `status`, `get`, `doctor`, `approve`, `reject`, `reset`, `enable`, `disable` — and both paths run the same code, so the menu teaches the direct form instead of replacing it. Subcommands and server names autocomplete. Where no prompt can be answered, in print and JSON mode, the report and the subcommand list are printed rather than blocking on a question nobody can answer.

  Typing the shell command mid-session asked the model to run bash, read the output and report back — three model turns for a question this process answers from files it has already read, and a different summary each time. Pi dispatches a registered command straight to its handler, so the model is not involved at all.

  Adding and removing a server stay in the terminal: `add` carries shell quoting, `${VAR}` references and a `--` command line. Those already have one correct parser, and it is the shell; a slash command that re-implemented it would be a second, worse one. `/piagent-mcp add` prints the terminal command rather than guessing at one.

  Both surfaces read the same module, so the two cannot disagree about whether a server is usable. Remedies name the form that works where they are read: the session prints `/piagent-mcp approve <name>`, the terminal prints `piagent-mcp approve <name>`.

- `piagent-mcp doctor` and `piagent-doctor` say what each configured server still needs — a referenced variable that is not exported, an executable that is not on PATH, a decision that has not been made, the Docker daemon not answering. Counting configured servers, which is what the doctor did before, says nothing about whether any of them can answer. A session start names the ones that are definitely stuck; `PIAGENT_NO_MCP_NOTICE=1` switches that off.

### Changed

- `piagent-mcp add` refuses to write a credential into MCP config and prints the reference form to use instead. The check reads both the field name and the value, so `--env CONFIG=ghp_...` is caught as well as `--env GITHUB_TOKEN=...`, and it covers `--header` too. `--url` accepts https, or http only on loopback. `list` and `get` mask values while leaving `${VAR}` readable, because that is a variable name rather than its contents.

  OAuth is not automated and no token is stored by this platform. Pi already owns that flow — `/mcp-auth <server>` — and a third credential store holding other people's credentials would be worse than either of the two that already exist.

- `scripts/configure-mcp.sh` is replaced by `scripts/mcp-manage.mjs`; the pinned server catalog moved into `packages/piagent-core/mcp/`, where the capability lock pins it. The `piagent-mcp` command is unchanged. The three MCP files that decide which servers a session may call are now part of the locked runtime set.

- The docs site is one page per topic instead of a single file, grouped in the sidebar as Get started, Build, MCP and Operate. MCP has four pages of its own, since it now has a command surface, an approval decision and an auth story to explain. Each page carries a table of contents and previous/next links.

  Pages are generated by `scripts/build-docs-site.mjs` from a content fragment each, plus shared `docs-site/assets/docs.css` and `docs-site/assets/docs.js`. The generated HTML is committed, because the site is served as static files with no build step, and `npm run verify` fails when the committed output no longer matches its source. `npm run site:preview` serves the result the way the deployment does — the site relies on clean URLs, so an ordinary static server answers 404 for every internal link.

- Public text describes this platform on its own terms rather than against named competing products. The page that compared feature tables now states what the platform takes on and what it leaves to the host, and is called Phạm vi platform rather than carrying two other products' names in the sidebar of every page. The same wording pass covers the MCP pages, `docs/mcp-and-tools.md` and a design-rationale comment in `document-intake.ts`.

  Where "Codex" and "Claude" mean model families they are now labelled as such, with their provider ids, so a reader cannot mistake a model choice for a different tool. `--model-scope` and `--preset` say "model families" in their help text for the same reason.

  The wording gate in `npm run verify` only read `README.md`, `docs/`, the prompts and the project template, which is why the site and the runtime strings were never checked. It now also reads `docs-site/content`, the site builder — navigation labels live there, not in a fragment — and the `mcp` and `extensions` directories that print to an operator.

## v1.1.9 - 2026-07-28

### Fixed

- The update notice reaches the install path people actually use. v1.1.8 decided a platform tree was a maintainer's working copy when it found a `.git` directory in it — but `pi install git:...` clones the repository, so an ordinary install carries a `.git` and every other file a working copy carries. There is no mark inside the tree that separates them, which meant the notice never appeared for anyone who installed the documented way.

  What separates them is where they sit: Pi puts packages it installed under its own agent directory, and npm puts the global helper under `node_modules`. A tree anywhere else is a working copy and is still told nothing. `PI_CODING_AGENT_DIR` is honoured, and both paths are resolved before comparison, because a home reached through a symlink is ordinary — macOS reaches `/var` that way — and comparing a real path against a symlinked one made an install look like it was somewhere else.

## v1.1.8 - 2026-07-28

### Added

- Pi says when a release is out, and names the command that takes it. The notice appears in the session-start line as `Piagent update available: 1.1.7 -> 1.1.8. Run \`piagent-update\` to move this machine to it.` Nobody has to remember to go and check, which until now was the only way to find out.

  It costs the session nothing. The session reads a cache and, when that cache is older than a day, leaves a detached `npm view` behind to refresh it — so the first session after a release may still be quiet and the next one carries the notice. This is the only network traffic the guard originates, it sends nothing about the project, and the registry's answer reaches the terminal only if it is exactly `MAJOR.MINOR.PATCH`, so neither a hostile registry nor an edited cache can put chosen text in front of an operator. A checkout is never told to update. `PIAGENT_NO_UPDATE_CHECK=1` switches it off.

## v1.1.7 - 2026-07-28

A platform update is one global install. It was not behaving like one: every project that selected capability packs stopped working after a release until its profile was reapplied by hand, and the policy a release corrected never reached a project that had already onboarded.

### Changed

- A capability lock that is behind the installed platform is re-pinned instead of refusing the session. The lock pinned two different things and gave them one answer. What the project consented to — which packs, from where, and how far they may reach — still blocks: a grant that widens, a protection that disappears, a pack that changes identity. Which build produced the resolution — package version, runtime file digests, artifact content — moves on every release, and blocking on it put a per-project chore behind a global update while not defending against the case it resembles, since the code that verifies the lock is itself one of the files the lock pins. A build move with an unchanged grant is recorded and reported.

- Artifact content is part of the build, not part of consent. Adapter policy files, base policy, prompts, skills, subagents and recipes all ship as pack artifacts, so pinning their bytes meant a corrected policy could never reach a project referencing it. Nothing is given up: which artifacts a pack provides is declared in its manifest and the manifest digest is still pinned, so an artifact that appears, disappears or moves still blocks — and a policy artifact that weakens still blocks, because the permissions it resolves to are compared directionally.

- A project profile can name the adapter it takes its policy from instead of copying it. `{"extends": "web-frontend", "projectId": ..., "displayName": ...}` keeps the project's identity and overrides in the project, and resolves the rest from the installed platform at runtime. Any key the project states replaces the adapter's key whole; a profile without `extends` keeps working exactly as before, self-contained. `init-project.sh` and `/onboard-project` write this form when the profile comes from a built-in adapter, so onboarding stays the one per-project step and updating stays global.

  A profile naming an adapter that is not installed refuses rather than falling back to something weaker.

## v1.1.6 - 2026-07-27

Monorepo fixes found auditing how the platform scopes itself to a project. Every case was reproduced against a real directory tree before it was changed.

### Fixed

- `be-readonly-fe` keeps the backend read-only in a monorepo. Its `readOnlyPaths` and `shellProtectedPaths` were anchored at the repository root, so `backend/**` and `apps/api/**` covered a backend sitting at the top of the tree and nothing else. Choosing the profile on a repository whose backend lives in `packages/api`, `apps/backend` or `services/payments` produced a profile that announced the backend was read-only while leaving every file in it writable — the one guarantee the profile exists to make. The backend directories under `apps/`, `packages/` and all of `services/*` are covered now.

  They are enumerated rather than matched with `**/api/**`, which would have swept in `packages/web/src/api/` — the frontend's own HTTP client — and frozen the half of the repository the profile is meant to leave writable.

- The frontend verify command finds a frontend that is not at `frontend/` or `apps/web/`. It fell through to the repository root, where a workspace root has no `type-check` script, so verification reported success having run nothing. `apps/frontend`, `packages/web`, `packages/frontend` and `client` are looked at too.

- `apps/backend` is read as a backend. `apps/frontend` counted as a frontend marker while only `apps/api` and `apps/server` counted as backend ones, so a repository that named both halves symmetrically was detected as frontend-only and offered `web-frontend`. `client/` and `server/` at the root were not markers either.

- Frontend and backend are detected inside declared workspaces. Nothing read the `workspaces` field or `pnpm-workspace.yaml`, and nothing looked under `packages/`, so a pnpm monorepo fell through every marker to `generic`. Each declared package is now read through its own manifest and layout, which is what identifies `packages/storefront` and `packages/gateway` as the two halves of a fullstack repository. Only a trailing wildcard is expanded, absolute and `..` patterns are refused, and at most 64 packages are read.

### Changed

- Profile detection lives in `packages/piagent-core/extensions/project-shape.js`. `piagent_profile_options` and `scripts/init-project.sh` each carried their own copy of the rules and had drifted; the `apps/backend` gap above was present in both, and a fix to either would have left the other wrong. The file is covered by the capability lock, because steering which profile a project is offered is a way to choose what the guard ends up enforcing.

## v1.1.5 - 2026-07-27

### Added

- `piagent-update` moves a machine from one release to the next in one command. A release is three independently versioned things — the Pi host, the npm-global terminal helper, and the Pi package — and they have to move in that order, because `piagent-install` refuses to run against a host that does not match the version its own package.json pins and does not install one itself. Doing it by hand is three commands and one ordering rule that fails late when it is got wrong.

  Every version the run needs is resolved from the registry before anything is installed, including the host version taken from the *target* helper's published metadata rather than the running one, so `--check` and `--dry-run` describe exactly what a real run would do. After the helper replaces itself the run confirms that the version on disk is the one it asked for, and stops before touching the Pi package if it is not. Running it from a git checkout is refused rather than replacing that checkout's commands with a published build.

  `--check`, `--dry-run`, `--version X.Y.Z`, `--force`, `--project <path>`, `--no-host`, `--no-package`, and pass-through to `piagent-install` after `--`.

### Fixed

- `docs/release-install-policy.md`, `docs/team-onboarding.md` and `docs/command-reference-vietnamese.md` described the manual update sequence without saying why its order is mandatory. `piagent-install` fails on a host mismatch; the auto-install of a matching host lives in `setup.sh` and does not apply to that flow.

## v1.1.4 - 2026-07-27

### Fixed

- A credential passed as a command-line option is recognised as one. `--token=abc123`, `--token abc123`, `--password`, `--api-key`, `--client-secret` and the rest went unrecognised because the assignment patterns require a key that starts with a letter, and `-` is not one. v1.1.3 made the redactor's verdict the gate that decides whether a command may serve as verify evidence, so anything it missed was stored in the clear *and* accepted as proof — the same invariant v1.1.3 was written to enforce, defeated by the syntax most command-line tools actually use. Env-style assignments were the only shape covered.
- An `Authorization` header is redacted wherever it sits among the arguments. The value ran to the end of the line, so the same credential survived or not depending on how much text happened to follow it: `curl URL -H "Authorization: Token abc123"` left the header value one character under the length bar, while moving the header ahead of the URL swept the URL into the value and pushed it over. The value is now the single whitespace-free token that follows the scheme, and under a known authentication scheme its length is not consulted at all. Prose such as `Authorization: not required for local runs` is still left alone.

## v1.1.3 - 2026-07-27

Fixes for defects found reviewing v1.1.2 after it shipped, including two introduced by v1.1.2 itself. Every fix was reproduced first.

### Fixed

- Verify evidence identifies the command exactly again. v1.1.2 moved the digest onto the redacted text to stop it confirming guesses at a secret, and in doing so gave every secret the same identity: an observation of `DATABASE_PASSWORD=CorrectHorse42 npm test` satisfied a claim about `DATABASE_PASSWORD=DifferentHorse99 npm test`, so a run against one database could be recorded as proof for another. That contradicts the exact-match rule the gate is built on. Neither text is safe to hash, so a command with anything to redact now gets no digest at all and cannot be evidence; the gate says so instead of matching loosely. Commands with no secret in them — every legitimate verify command — are identified by their own text as before.
- A document replaced by a named pipe is refused instead of hanging. The identity check that would have rejected it runs after the file is opened, and opening a pipe waits for a writer, so the substitution did not have to defeat the check — it only had to stop it from running. The read blocked indefinitely. The file is now opened without blocking and without following a symbolic link at the final component.
- Short credentials are redacted. Values under a key that names a secret outright were kept in the clear below eight or twelve characters, so `TOKEN=hunter2` was stored verbatim in the evidence ledger. Length is only ambiguous after a bare `:`, where English uses the same shape — `password: short` is prose, and `Authorization: Token abc` puts a scheme name where a value would go. Under `=`, inside quotes, in a query string, or as a field in a structure, any value that is not a placeholder is now redacted at any length.
- A redirect must land on the page being verified. `npm run site:check` compared the hostname, scheme, port and credentials of the redirect target but not its path, so `/missing` or `/?release=old` passed while the run only ever fetched `/`.
- `piagent-install` reports a missing Node runtime as a missing Node runtime. Validating the MCP preset early, added in v1.1.2, put a Node script ahead of the Node version check, so on a machine without Node the installer failed with `node: command not found` and blamed the preset.

### Changed

- `docs/release-install-policy.md` named the wrong release for the code-scanning gap. A pull request last merged with a failing CodeQL check and an open high alert on `v1.1.0`; on `v1.1.2` the results gate blocked the pull request until the alerts were cleared.

## v1.1.2 - 2026-07-26

Security and release-gating fixes found reviewing v1.1.1 after it shipped. Every fix in this release was reproduced as a working exploit or failure first.

### Fixed

- `piagent_document_read` no longer re-opens the file by name after checking it. Containment in a granted root, the extension, the size limit, and the guard's protected-path check were all decided from one `realpath` and `stat`, and then `readFileSync` resolved the name a second time. Replacing the checked file with a symbolic link in between returned the contents of a file outside every granted root — reproduced end to end. The file is now opened once and read from the descriptor, and the descriptor's device and inode must equal the file that passed the checks or nothing is read. `pdftotext` is handed the same descriptor on standard input instead of a path, so the converter cannot be pointed elsewhere either.
- The evidence ledger no longer stores a digest of the unredacted command. It wrote a redacted command such as `export TOKEN= [REDACTED_SECRET] && npm test` beside a SHA-256 of the real line, so the redaction published the template and the hash confirmed guesses against it: the only unknown left was the secret, and SHA-256 is fast enough to walk a candidate list offline. A three-candidate list recovered the test secret. The digest now covers the redacted text, which is exactly what the file already shows, and command matching is unaffected because both sides redact before hashing. The CodeQL alert covering this line was dismissed as a false positive in v1.1.1; that dismissal was wrong and has been reversed.
- `npm run site:check` no longer waits indefinitely on a peer that answers slowly. The request timeout measures socket inactivity, not elapsed time, so a server sending one byte per second reset it forever — a probe was still pending after 40 seconds and would have held the release gate open indefinitely. There is now a wall-clock deadline for the whole request.
- A redirect that keeps the hostname is no longer accepted whatever else it changes. Only the hostname was compared, so a redirect to plaintext HTTP, to another port, or to a URL carrying credentials passed as if it were the site being verified.
- A document path containing a control character is refused. Refusal messages and the read header quote the path back outside the data region, so a file named with an embedded newline wrote its own lines there, at instruction level. Paths in the header are additionally escaped when printed.
- `.docx` text is decoded strictly. The strict decoding added in v1.1.1 covered plain text only, so a `.docx` whose `word/document.xml` was not valid UTF-8 still returned `ok` with replacement characters in the extracted prose.

### Changed

- Publishing now waits for the full release matrix. `publish.yml` and `verify.yml` were independent workflows triggered by the same tag and raced: v1.1.1 finished publishing at 08:03:43Z while the Ubuntu verify job ran to 08:03:48Z and macOS to 08:03:54Z. A macOS-only failure, a runtime audit finding, or a release-identity mismatch would have been reported after the version was already on the registry, where it cannot be withdrawn. `verify.yml` is now a reusable workflow that `publish.yml` calls and depends on.
- An unknown `--mcp-preset` is rejected before anything is installed. The preset was read only at the final configuration step, so a typo failed after the platform package and the MCP adapter had already been installed, leaving a half-configured machine — and the dry run exited `0` because it never reached the check.
- `piagent-setup --no-mcp --mcp-preset <name>` fails instead of succeeding with the preset dropped. `piagent-install` already rejected that pair, but setup never forwarded both flags, so the check could not see it.

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

- Clarified in the public docs where this platform sits relative to a general agent coding CLI: Pi Company Platform brings similar governance concepts into Pi and packages them for team workflows.
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

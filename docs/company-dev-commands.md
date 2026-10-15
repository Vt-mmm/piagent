# Developer commands in a company session
<!-- language: en -->

What runs when the agent in a company session (`piagent studio`) does everyday development work, and what needs the member's approval. Commands run in the company sandbox: the project is writable, the member's toolchains and package caches are readable, credentials are closed and the internet is reached only through the package proxy or an approval.

Measured on macOS with Piagent 1.25.0 and Pi 0.87.1 (2026-10-15). `tests/managed-dev-loop.test.mjs` replays the loop offline on every run.

## Runs without asking

| Work | Commands seen working |
|---|---|
| Branches and history | `git switch -c`, `add`, `commit`, `log`, `diff`, `stash` (identity from the project's git config) |
| Tests, type checks, builds | `npm test`, `npm run build`, `node --test`, `make check`, `swift build` |
| Packages from public registries | `npm install`, `npx`, `pip install` in a venv, `uv pip install` (npm, PyPI, Go, crates.io, Maven, Gradle, NuGet, RubyGems, Packagist, pub.dev through the package proxy) |
| The app's own servers | a test that starts a server on 127.0.0.1 and calls it; a dev server in the background within one command |
| UI and end-to-end checks | the project's Playwright (`@playwright/test`) driving the Chromium installed on this Mac against a server the test or `start_process` starts |
| Local data | `sqlite3` migrations and queries inside the project |
| Toolchains on the Mac | `java` (Homebrew JDK), `python3 -m venv`, `swift`, read-only |

After the agent writes or edits a TypeScript or JavaScript file, the project's own TypeScript reports that file's errors with the result (macOS; a project with `typescript` and a tsconfig/jsconfig). TypeScript 5 and 6 answer from a language service, TypeScript 7 from its native `tsc` (about 0.3 s for 740 files here); when a syntax error elsewhere stops `tsc`, the note says the file was not type-checked. Other languages are checked by the Harness's verify step.

A command stops after 10 minutes, and what it leaves running stops when the turn ends. A dev server, watcher or local service the agent needs across turns runs with `start_process` (macOS): same sandbox, no network, until `stop_process`, the end of the conversation or 4 hours; at most 4 at once; `process_output` reads what it printed and can wait for a ready line.

## Undo a turn

In a git repository, `/undo` in the company Terminal puts back the files the agent's last turn changed (edited, deleted or created), and `/undo` again goes one turn further back. It refuses while a turn runs, and when a file the turn changed was changed again since, so the member's own edit is never overwritten. The member's index (staged changes), HEAD and commits are not touched; a commit made in the turn stays. Files `.gitignore` excludes are not part of the checkpoint, and checkpoints last as long as the conversation is open.

## Commands in the dashboard

The dashboard composer takes the Terminal's `/` commands. Typing `/` lists them with the project's commands and skills; a command runs in the dashboard through the same session commands as the buttons and is never sent to the model (`/undo` excepted: the company runtime answers it). `/help` lists them all.

| Command | Does |
|---|---|
| `/new`, `/fork`, `/name <name>`, `/pin`, `/archive` | New chat, fork, rename, pin or unpin, archive |
| `/stop` | Stops the running turn (Esc does too) |
| `/thinking <level>` | Thinking level, from the levels this conversation offers |
| `/model <name>` | Model, by name or ref (personal conversations) |
| `/permission read-only\|ask\|full` | Access (personal; `full` asks for confirmation) |
| `/bypass on\|off`, `/fast [on\|off]`, `/undo` | Company conversations: Bypass (`on` asks for confirmation), Fast where the Harness allows it, undo the last turn |
| `/changes`, `/settings`, `/help` | Source Changes, Settings, this list |

Shortcuts: ⌘K command palette, ⌘⇧O new chat, ⌘, Settings, ⌘/ opens the `/` commands in the composer, Esc stops the running turn.

## Headless runs

`piagent studio --prompt "<request>"` runs one company request and prints the answer. With `--json` it writes the event stream of `pi --mode json` instead (Pi's own serializer: the session header, then one JSON object per line on stdout; company events such as `managed_helpers` and the Harness's `agent-watch-process` notes come in the same stream). A failed request is described on stderr and exits 1.

## Needs the member's approval

Each refusal names the tool that asks; nothing below runs silently.

| Work | What the agent is told | Tool |
|---|---|---|
| Any other internet host (`curl https://…`, a vendor API) | `managed-domain-blocked`, with the host | `run_with_network` |
| Tests against a localhost server while a local proxy (VPN, corporate proxy) listens | `managed-loopback-blocked` | `run_with_network` |
| Docker, `docker compose`, Testcontainers | `managed-docker-blocked` / `managed-docker-unavailable` | `run_with_docker`, `start_docker` |
| `git fetch` from GitHub | — | `fetch_origin` |
| `git push`, `git pull`, `gh`, private registries, SSH | `managed-credentials-unavailable` | `run_on_host` (asks every time, Bypass included) |
| Installing a missing runtime (`brew install openjdk@21`) or Playwright's browsers (`npx playwright install chromium`) | `managed-toolchain-missing` | `run_on_host` |

## Not covered yet

- GitHub work beyond `fetch_origin` (pull requests, CI status, review comments) goes through `run_on_host` one command at a time; there is no scoped GitHub tool.
- Private npm registries, `gh` and SSH-agent operations have no sandboxed path.
- There is no browser tool of Piagent's own: UI checks use the project's Playwright (owner, 2026-10-15).
- MCP servers do not run in company sessions (owner, 2026-10-15: later, after a Studio allowlist is designed).
- `start_process` is not offered on Linux and WSL yet.
- At the end of a turn, a process a bash command left running is found by the marker in its environment; `ps` cannot read that for Apple's own binaries (`/bin/sleep`), so such a process is not stopped until it ends. Processes started with `start_process` are stopped by process group and parent as well.

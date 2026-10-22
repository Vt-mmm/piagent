# Long-task soak lane v1

Members leave when a long task stops part way and they have to keep pushing
it. This lane measures exactly that, on the real company agent with real
models: a simulated member gives a long task in a real repository, answers
only the business decisions it is asked about, presses Stop, adds a rule
mid-task or reopens the conversation like a person would, and writes
"tiếp tục" when the agent stops before the work is done. Hidden acceptance
checks, not the agent's own words, decide whether the work is done.

It costs real model tokens through Studio. There is no provider-free mode:
the deterministic lifecycle evidence lives in `evals/long-horizon-v1` and the
`tests/managed-*` suites.

## Surfaces

- `terminal`: `piagent studio --rpc --project <repo>` (Pi's RPC protocol;
  `ask_user` arrives as an extension UI select). Needs a Piagent release that
  has `--rpc` (after 1.35.1).
- `webui`: the company WebUI's Gateway used the way the browser app uses it
  (launch link → cookie + CSRF, `sessions.command` over the WebSocket,
  questions and approvals over HTTP). Conversations appear in the member's
  WebUI under the soak projects.

## Run

```bash
node evals/long-task-soak-v1/runner.mjs --list
node evals/long-task-soak-v1/runner.mjs --self-check            # oracles: fail on the fixture, pass on the reference
node evals/long-task-soak-v1/runner.mjs --surface webui --scenario autonomous-node-inventory
node evals/long-task-soak-v1/runner.mjs --surface webui --scenario ide-editor-terminal
node evals/long-task-soak-v1/runner.mjs --surface both --category business,third-party --repeat 2
```

Runs go to `~/piagent-soak/runs/<time>/<scenario>-<surface>-<n>/` (`project/`,
`events.jsonl`, `result.json`); reports to `~/piagent-soak/reports/` as JSON
and Markdown. `--work-root` moves both.

`ide-editor-terminal` requires a working company terminal (qualified on Linux;
macOS Seatbelt reports unavailable). After the first agent turn, the member reads
README through the workspace API, saves an appended note with its exact digest,
and verifies the saved bytes through the same API. It then opens a real terminal
over the authenticated Gateway WebSocket, runs `npm test`, observes its numeric
exit status and closes the terminal. Missing, rejected, uncertain or unfinished
member actions fail the scenario even if the agent's hidden oracle passes.
These are editor/terminal protocol operations, not browser rendering coverage;
the browser workflows are qualified separately. No host shell fallback is used.

## Verdicts

- `smooth`: the checks pass and the member never had to push.
- `recovered`: the checks pass after nudges, a Stop on a stall, or a reopen
  after a crash, within the scenario's `maxNudges`.
- `abandoned`: the checks fail, or the member had to push more than
  `maxNudges` times. This is the number to drive down.

Defects recorded per turn: `stopped_midway`, `asked_permission_to_continue`,
`claimed_done_but_checks_fail`, `ended_without_answer`, `turn_failed`,
`stalled_no_activity`, `process_crashed`, `kept_asking` (more questions than
the scenario's decisions need, each counted as a push); per run:
`business_decision_not_asked`, `unneeded_question`, `protected_file_changed`,
`time_budget_exceeded`.

## Scenario format (`scenarios/<id>.json`)

```jsonc
{
  "id": "business-python-billing",
  "title": "…",
  "category": ["business", "framework"],     // free tags used by --category
  "language": "vi" | "en" | "ja",           // the member's language (nudges, replies)
  "fixture": "python-billing",              // fixtures/<name>/
  "requires": ["docker", "uv", "network"],  // missing → skipped
  "prompt": "…",                            // the member's first message
  "questionsExpected": false,               // questions no decision covers are defects
  "decisions": [{                           // what only the member can decide
    "id": "rounding", "mustAsk": true,
    "topic": ["round", "làm tròn"],         // regexes matched against a question
    "option": "half.?even|banker",          // ask_user option to pick (regex on label+description)
    "reply": "Round half-even to 2 decimals." // free-text answer otherwise
  }],
  "approvals": "allow" | "deny",
  "userActions": [{ "when": { "toolCalls": 20 } | { "minutes": 10 },
                    "do": "steer" | "follow_up" | "stop_then_continue" | "restart", "text": "…" }],
  "budget": { "maxMinutes": 90, "maxNudges": 3, "stallMinutes": 15 },
  "oracle": { "hidden": "hidden", "checks": [{ "name": "…", "run": "shell", "timeoutSec": 600 }] },
  "reference": "reference", "referenceSetup": ["…"], "setup": ["…"], "protect": [".env"]
}
```

WebUI scenarios can also use ordered actions after a settled turn:
`{ "when": { "turns": 1 }, "do": "editor_save", "path": "README.md", "append": "\nMember note.\n" }`
and `{ "when": { "turns": 1 }, "do": "terminal_test", "command": "npm test", "timeoutSec": 120, "expectedExitCode": 0 }`.
They run in listed order before oracle judging. The RPC terminal surface does
not implement these member workspace operations and fails them explicitly.

A fixture is `fixtures/<name>/` with `project/` (what the member's repository
holds), `fixture.json` (`setup` commands such as dependency installs,
`protect`ed files), one or more hidden overlays (acceptance tests the agent
never sees) and reference overlays (a solution, used only by
`--self-check`). Oracle checks run on a copy of the project with the hidden
overlay laid over it; `$SOAK_RUN` names the run, for unique container names.
Every scenario must pass `--self-check` before it is used.

Self-check proves the reference passes, not that the hidden checks accept
every reasonable solution. The first long soak (2026-10-21) lost five runs to
checks stricter than their spec: a shortfall shown as 0 instead of negative,
a cancelled seed booking not counted, `sqlite3.Row` instead of tuples, and a
phase-2 regression check that broke on phase 3's new fields. Hidden checks
assert only what the spec says, read rows and objects loosely, and earlier
phases' checks must tolerate later phases' legitimate additions. When a run
fails a check, run the phase oracle on its `project/` and read the failure
before blaming the agent.

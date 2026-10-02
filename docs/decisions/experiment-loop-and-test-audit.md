# Decision: experiment-loop tools and the test-audit skill

Status: decided by the owner and implemented, 2026-10-01.

## Experiment-loop tools

An optional Pi package can add an experiment loop: the model declares a metric
(`init_experiment`), runs and times a command (`run_experiment`), and records
the result (`log_experiment`), which commits a kept idea and resets a dropped
one. Its state lives in `.auto/`.

Three parts of such a loop run outside the guard:

1. `run_experiment` runs `bash -c <command>` through its own tool.
2. `log_experiment` stages everything and commits when an idea is kept, and
   runs `git checkout -- .` and `git clean -fd` when it is dropped, which
   erases every uncommitted change in the folder.
3. Hook scripts (`.auto/hooks/*.sh`) and `.auto/checks.sh` run inside the
   package, like any project script the member chose to run.

Decision, in `packages/piagent-core/extensions/experiment-loop-policy.ts`:

- `run_experiment` is a shell tool for the guard: its command gets the same
  checks as `bash` (protected paths, exec policy, confirmations, read-only
  profiles).
- `init_experiment` and `log_experiment` run only on an `experiment/` branch or
  in a linked worktree; `init_experiment` only when nothing is uncommitted
  outside `.auto/`, so the member's unfinished work cannot be erased.
- A loop config that moves the commands to another folder is refused: the
  guard checks each command where it runs.
- Company sessions do not load third-party packages, so the loop is a personal
  mode feature.

## The test-audit skill

`packages/piagent-core/skills/test-audit/SKILL.md` ships as a model-invocable
skill (`/skill:test-audit`): before a test is written, it asks what the test
protects and which mistake it catches; for existing tests, it lists the signs
of a test that does not earn its place, what to keep anyway, and a read-only
review table before any edit. It runs the repository's own checks from
`AGENTS.md` and commits only when the member asks.

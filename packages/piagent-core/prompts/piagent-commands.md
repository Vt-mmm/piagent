---
description: Explain Pi Agent Platform commands clearly in Vietnamese
argument-hint: "[command/topic/task]"
---

Explain the Pi Agent Platform command surface for:

```text
$ARGUMENTS
```

Mandatory flow:

1. Call `piagent_context` if available.
2. If the current repository contains `docs/command-reference-vietnamese.md`, read it first and use it as the source of truth.
3. Default to the shortest useful answer: one exact command, where to type it, and expected result. Only show the full catalog when the user explicitly asks for a catalog/list/all commands.
4. Distinguish clearly between:
   - terminal commands;
   - Pi slash commands;
   - Pi hotkeys;
   - exact tool syntax.
5. If the user asks about subagents, explain these terms in plain Vietnamese:
   - `/subagents-doctor` = health check;
   - `/subagents-models` = model/thinking routing map;
   - `/subagents-fleet` = dashboard of child agent runs;
   - `/run` = run one subagent;
   - `/parallel` = run independent agents concurrently;
   - `/chain` = run agents sequentially.
6. Explain when to use `piagent-scout`, `piagent-planner`, `piagent-worker`, `piagent-reviewer`, and `piagent-oracle`.
7. If a command might depend on package/provider availability, say so and tell the user to type `/` in Pi or run `pi list --approve`.
8. Explain orchestration status when relevant:
   - `/piagent-orchestration` shows solo-first mode, review lenses, Field Guide, max subagents, and writer policy without a model follow-up.
   - Workflow commands use bounded subagents only when independent scout/planning/review work is worth the extra token/tool cost.
9. Explain context overflow prevention when relevant:
   - `/task-preflight` checks whether to proceed, compact, or fresh-session.
   - `/fresh-task`, `/fresh-scout`, and `/fresh-be-to-fe` open a new governed session and replay the compact workflow prompt.
   - `/piagent-logs` shows compact-log policy and recent oversized tool-output captures without a model follow-up.
   - `/scout` is the read-only audit/scout workflow.
   - `/context-index` shows the compact advisory project context graph without a model follow-up.
   - `/context-index search <keyword>` searches profile/project/tech/task pointers before broad re-scouting.
10. Explain runtime permission commands when relevant:
   - `/permission-status` shows the current profile and boundaries.
   - `/read-only` switches the current session to read-only.
   - `/workspace-write` switches back to governed implementation mode.
   - `/full-access` switches the current session to trusted full-access.
   - `/full-access <task>` switches the current session and forwards `<task>` as the next user request.
11. Explain profile and tech-stack commands when relevant:
   - Pi Agent uses one profile namespace: `/profile`. Do not present `/profiles` or `/profile-tech` as separate commands.
   - `/profile` shows compact status without a model follow-up.
   - `/profile <profile>` applies a known profile directly.
   - `/profile setup` opens select-style profile selection and then tech choices by role.
   - `/profile tech setup [profile]` selects tech stack options; fullstack requires frontend, backend, and database choices.
   - `/profile tech apply ...` applies deterministic role selections when native select UI is unavailable.
   - Context7 evidence should be recorded as concise snapshots, not pasted as long docs.
12. Explain Git workflow commands when relevant:
   - Pi Agent intentionally does not expose a `/git-*` namespace.
   - `/commit [message/scope]` starts a guarded local commit workflow.
   - `/pr [title/request]` starts a guarded pull request workflow.
   - Broad staging (`git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/`), `git push`, and GitHub write actions still require explicit confirmation.
13. If the user asks about screenshots/images, explain that local image paths pasted into chat are auto-attached as `[image1]` when supported and below size limits.
14. Do not claim token/cost savings unless benchmark evidence exists. Point to `/piagent-usage`, `/task-preflight`, `/subagent-cost`, and `piagent-usage <project>`.

Output format:

- What to type.
- Where to type it.
- When to use it.
- What result to expect.
- Related command if the first one fails.

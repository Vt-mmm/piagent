# Subagent orchestration capabilities

Review date: 2026-07-19

Package used:

- `pi-subagents`
- Package docs: https://pi.dev/packages/pi-subagents

## Kết luận

Pi Agent Platform uses `pi-subagents` for child sessions, parallel read-only work, review loops, and structured handoffs. The platform keeps a safe default configuration and documents advanced commands separately so daily users can still start with `/task`.

Core decisions:

1. natural-language delegation is preferred over requiring users to remember `/run`;
2. parent agent should decide whether independent read-only work deserves subagents;
3. piagent roles remain narrow and policy-aware;
4. background, watchdog, scheduled, and parallel-writer behavior stays opt-in;
5. long child output should use file handoff when possible.

## Capabilities

| Capability | Meaning | Platform decision |
|---|---|---|
| Natural language delegation | User can ask for scout/review/planning without exact syntax. | Covered by auto-delegation policy and workflow prompts. |
| Builtin agents | General roles such as researcher, planner, reviewer, and context-builder. | Use when they fit the task and installed tools are available. |
| Piagent agents | `piagent-scout`, `piagent-planner`, `piagent-worker`, `piagent-reviewer`, `piagent-oracle`. | Default roles for governed project work. |
| Prompt shortcuts | `/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`, `/parallel-handoff-plan`. | Documented for explicit orchestration. |
| Supervisor channel | Child can ask parent for a decision. | Allowed for blocked or high-context child work. |
| Output controls | `output`, `outputMode=file-only`, `reads`, `outputSchema`, `acceptance`. | Recommended for large reports and handoff context. |
| Worktree isolation | Separate checkout for parallel writer agents. | Non-default; use only with explicit scope and disjoint write sets. |
| Watchdog | Additional opt-in review at session end. | Off by default to control token/cost. |
| Scheduled runs | Delayed one-shot subagent. | Disabled by default; only for explicit monitor/wait tasks. |

## Applied in platform

- `scripts/configure-subagents.sh`
  - `waitTool.enabled: true`
  - `intercomBridge.mode: always`
  - stable `defaultSessionDir`, `singleRunOutputBaseDir`, `worktreeBaseDir`
  - `scheduledRuns.enabled: false`
  - bounded `maxSubagentDepth`, spawn cap, and parallel concurrency
- `scripts/setup.sh` / `scripts/install-global.sh`
  - optional `--with-web-access` installs `npm:pi-web-access@0.13.0` for web/docs research
- Workflow prompts
  - `/task`, `/plan`, `/review`, `/be-to-fe`, `/platform-improve` instruct the parent to auto-delegate when work is independent and bounded
- Docs
  - command reference lists prompt shortcuts, watchdog/profile commands, supervisor control, output/fork/worktree options

## Keep non-default

| Feature | Reason |
|---|---|
| Watchdog always-on | Extra review can increase token/cost. |
| `asyncByDefault: true` | Background work can surprise interactive users. |
| Scheduled subagents | Useful for monitoring, unrelated to normal implementation. |
| Parallel writers | Correct only with clean repo, worktree isolation, and non-overlapping files. |
| Research agent without web tooling | It needs appropriate web/search/fetch tools installed. |

## Recommended usage

Daily implementation:

```text
/task Implement <task>.
```

Review until clean:

```text
/review-loop current diff max 3 rounds
```

Parallel review:

```text
/parallel-review current diff
```

Research-heavy task:

```bash
pi install npm:pi-web-access@0.13.0
```

```text
/parallel-research Compare available implementation options for <topic>.
```

Context handoff before a large implementation:

```text
/parallel-context-build Build context for <large task>.
/parallel-handoff-plan Build implementation handoff plan for <large task>.
```

Watchdog for a high-risk session:

```text
/subagents-watchdog recommend-model
/subagents-watchdog session model recommended
/subagents-watchdog on
```

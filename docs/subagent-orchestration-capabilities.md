# Subagent orchestration capabilities
<!-- language: en -->

Review date: 2026-07-19

Package used:

- `pi-subagents`
- Package docs: https://pi.dev/packages/pi-subagents

## Kết luận

Pi Agent Platform keeps `pi-subagents` installed for one exceptional fresh read-only helper. Daily work remains parent-direct. The package's broader parallel/worker features are not enabled by Piagent's governed baseline.

Core decisions:

1. no helper is the default and missing runtime cost evidence means `skip`;
2. dispatch requires two independent lanes and at least 30% projected total token saving;
3. one task run has an absolute ceiling of one fresh read-only helper, zero retries, and zero helper workers;
4. the parent owns planning, mutation, verification, and final review;
5. UI/telemetry records dispatch/skip reasons and projected saving.

## Capabilities

| Capability | Meaning | Platform decision |
|---|---|---|
| Natural language delegation | User can ask for scout/review/planning without exact syntax. | Covered by auto-delegation policy and workflow prompts. |
| Builtin agents | General upstream roles. | Disabled by the Piagent baseline. |
| Piagent agents | Read-only `piagent-scout`, `piagent-planner`, `piagent-reviewer`, `piagent-oracle`; compatibility `piagent-worker`. | At most one read-only role; worker disabled. |
| Prompt shortcuts | Upstream `/parallel-*` and worker/reviewer loops. | Outside the governed default and cannot widen the one-helper ceiling. |
| Supervisor channel | Child can ask parent for a decision. | Disabled; a blocked helper returns once and is not retried. |
| Output controls | `output`, `outputMode=file-only`, `reads`, `outputSchema`, `acceptance`. | Recommended for large reports and handoff context. |
| Worktree isolation | Separate checkout for parallel writer agents. | Non-default; use only with explicit scope and disjoint write sets. |
| Watchdog | Additional opt-in review at session end. | Off by default to control token/cost. |
| Scheduled runs | Delayed one-shot subagent. | Disabled by default; only for explicit monitor/wait tasks. |

## Applied in platform

- `scripts/configure-subagents.sh`
  - `waitTool.enabled: false`
  - `intercomBridge.mode: off`
  - stable `defaultSessionDir`, `singleRunOutputBaseDir`, `worktreeBaseDir`
  - `scheduledRuns.enabled: false`
  - `maxSubagentDepth: 1`, `maxSubagentSpawnsPerSession: 1`, global/parallel concurrency `1`
  - builtin agents disabled and worker overrides disabled
- `scripts/setup.sh` / `scripts/install-global.sh`
  - install `npm:pi-web-access@0.17.0` by default for web/docs research; `--no-web-access` opts out
- Workflow prompts
  - parent works directly; one fresh read-only helper requires runtime-projected saving of at least 30%
- Docs
  - command reference lists prompt shortcuts, watchdog/profile commands, supervisor control, output/fork/worktree options

## Keep non-default

| Feature | Reason |
|---|---|
| Watchdog always-on | Extra review can increase token/cost. |
| `asyncByDefault: true` | Background work can surprise interactive users. |
| Scheduled subagents | Useful for monitoring, unrelated to normal implementation. |
| Parallel writers | Disabled; parent is the only writer. |
| Parallel read-only helpers | Extra model turns/context cost; absolute governed cap is one. |
| Forked child context | Replays parent history and defeats the token-saving gate. |
| Research agent without web tooling | It needs appropriate web/search/fetch tools installed. |

## Recommended usage

Daily implementation:

```text
/workflow task Implement <task>.
```

The parent performs review, research, planning, implementation, and verification directly. A helper dispatch must expose its runtime estimate and fresh read-only contract; otherwise the telemetry outcome is `skip`.

# Runtime policy design
<!-- language: en -->

## Mục tiêu

Runtime policy là lớp kiểm soát cách agent đọc context, gọi tool, sửa source, chạy verify, và kết thúc task. Tài liệu này mô tả thiết kế trung lập của Pi Agent Platform, không phụ thuộc vào một project cụ thể.

## Design principles

1. Profile first: mọi task phải biết project mode, permission profile, protected paths, required context, verify commands, và MCP capabilities.
2. Bounded context: file lớn phải qua budget check; context manifest phải ghi lý do.
3. Guarded execution: shell/destructive actions đi qua exec policy. Đây là accident brake, không phải OS sandbox.
4. Tool capability: tool ngoài phải map vào capability được profile cho phép.
5. Evidence before done: source-changing task phải có verify evidence và trace.
6. Human gate for high risk: auth, release, deploy, destructive command, provider config, database migration, production data, broad Git staging, hoặc external Git/GitHub write action cần explicit confirmation.

## Runtime modules

| Module | Tool/hook | Purpose |
|---|---|---|
| Project context | `piagent_context` | Load profile, settings, policy, and local state summary. |
| Context index | `piagent_context_index_status/search/record` | Maintain a compact advisory node/edge/citation map for profile/project/tech/task navigation. |
| Permission profile | `piagent_permission_status` | Show active `read-only`, `workspace-write`, or `trusted-full-access` boundary. |
| Exec policy | `tool_call` hook; diagnostic `piagent_exec_policy_check` | Evaluate shell command risk before execution. |
| Context budget | lifecycle hooks; diagnostic `piagent_context_budget` | Enforce size/count limits for context files. |
| Tool registry | `tool_call` hook; diagnostic `piagent_tool_policy_check` | Check external tool capability against profile. |
| Task contract | automatic intake; fallback `piagent_task_start` | Persist scope, acceptance criteria, risk lane, intake mode, and verify plan before model work. |
| Context manifest | `tool_result` hook; recovery `piagent_context_record` | Record successful targeted reads for a task. |
| Verify evidence | `tool_result` hook; recovery `piagent_verify_record` | Bind an exact observed Pi `bash` result to the current working tree. |
| Final gate | `message_end` hook; diagnostic `piagent_task_gate_check` | Validate projected readiness before final handoff. |
| Trace | completion hook; recovery `piagent_trace_record` | Persist changed files, outcome, and handoff state. |
| Usage | `piagent_usage_snapshot` | Show session/context/token usage when available. |

## Policy precedence

Effective policy is derived from:

1. safe defaults in `packages/piagent-core/policies/base-policy.json`;
2. installed package prompts/skills/extensions;
3. project `.pi/piagent-profile.json`;
4. explicit user instruction in the active session.

User instruction can narrow scope or raise safety requirements. It should not silently bypass protected paths, destructive command checks, or final task gates.

## Profiles

Profiles define:

- `mode`
- `permissionProfile`
- `rootMarkers`
- `protectedPaths`
- `shellProtectedPaths` — shell-only deny list for bash/exec parsing.
- `readOnlyPaths` — path tools may read, but write/edit and shell access are denied.
- `requiredContext`
- `verifyCommands`
- `mcpCapabilities`
- `runtimePolicy`
- `hardGates`

The same platform can operate as `web-frontend`, `backend-api`, `fullstack`, `be-readonly-fe`, `data`, `devops`, `docs`, `python`, `node-typescript`, or `mobile` by switching profile.

`protectedPaths` blocks read/write path-tool access and is also used for shell matching when `shellProtectedPaths` is omitted. `readOnlyPaths` is for contracts such as `be-readonly-fe`: path tools may inspect these files with `read`, `grep`, `find`, and `ls`, but write/edit and shell access are blocked automatically.

`shellProtectedPaths` is intentionally shell-only. A path declared only there blocks `bash`/`exec` access, but does not block `read`, `write`, or `edit` path tools. `profile-doctor` and `team-doctor` warn on shell-only entries so older custom profiles can migrate write-sensitive paths to `protectedPaths` or `readOnlyPaths`.

## Permission profiles

The runtime separates the active autonomy profile from the project profile:

| Profile | Meaning |
|---|---|
| `read-only` | Allows source inspection through `read`, `grep`, `find`, `ls`, plus piagent state tools. Blocks shell, write/edit, and unknown non-piagent tools before execution. |
| `workspace-write` | Default governed implementation mode. Existing protected-path, shell, capability, context, verify, and final gates remain active. |
| `trusted-full-access` | Trusted automation mode for known repos. It can relax tool-registry blocks and capability filesystem scopes inside the guard, but protected paths, secret redaction, capability-lock integrity, and destructive/external confirmation still apply. |

`PIAGENT_PERMISSION_PROFILE` can override the profile for a single run. Invalid values fail closed to `read-only`. Inside Pi, `/permission read-only`, `/permission workspace-write`, and `/permission full-access` set a session-local override without writing the project profile. Legacy aliases `/read-only`, `/workspace-write`, and `/full-access` still work. Precedence is launch env, then session command, then project profile, then policy default. `permissionProfiles.allowedModes` in base policy acts like a managed allowlist; removing `trusted-full-access` from that list disables it for the installation.

## Task lifecycle

```text
runtime/manual intake
  -> profile/context
  -> task contract
  -> context manifest
  -> plan
  -> guarded implementation
  -> observed verify evidence
  -> trace
  -> final gate
  -> handoff
```

This lifecycle is intentionally explicit in persisted state but passive in the
routine model flow. Hooks make task quality auditable without turning the state
machine into a long sequence of model tool calls.

## Verify evidence ledger

Pi `bash` results are observed through the runtime `tool_result` hook and appended to:

```text
.pi/piagent-state/observed-bash.jsonl
```

The ledger stores cwd, timestamp, status, a hash of the normalized command, and
redacted command text for audit. Runtime uses it directly; a recovery
`piagent_verify_record` call can also validate against it without raw command
storage.

This file-based ledger is intentionally shared by parent and subagent processes that run in the same project cwd. If a worker subagent runs `npm test`, the parent can later record that exact verify command without depending on process-local memory.

The ledger and task/profile control files are self-protected:

- raw path-like tool access to `.pi/piagent-state/**` is blocked before execution;
- raw path-like tool access to `.pi/piagent-profile.json` is blocked before execution;
- the same protected-path gate covers Pi built-ins such as `read`, `write`, `edit`, `grep`, `find`, `ls`;
- custom/MCP tools are also blocked when a tool call contains path-like strings pointing at a protected path, including nested objects, arrays, and `file://` URIs;
- path-like strings are percent-decoded once before matching;
- input nesting above `MAX_TOOL_INPUT_INSPECTION_DEPTH=32` fails closed because an uninspectable input cannot be safely classified;
- generic extraction skips known leaf content fields such as `content`, `query`, `pattern`, `text`, and `command`, so normal search/edit strings do not become path false positives;
- `grep.glob` and `find.pattern` are checked when they explicitly name protected targets such as `.env*`, `auth.json`, `.pi/piagent-state/**`, or `piagent-profile.json`;
- broad `grep`, `find`, and `ls` results are filtered through the `tool_result` hook so protected content lines or protected path metadata are redacted before the model sees them;
- piagent tools still write/read these files through internal extension code, so normal task evidence and profile workflows continue to work.

This gate is independent from the tool registry. The registry can stay `advisory` for compatibility with changing Pi/MCP tool names, while protected-path access remains fail-closed whenever the event exposes a path-like input.

Final-gate semantics are stricter than simple observation:

- `observed=true`: Pi actually saw a matching bash result after `task.createdAt`;
- `matchedProfileCommand=true`: the command exactly matches one entry in `task.verifyCommands`;
- passing final gate: requires `observed=true`, `matchedProfileCommand=true`, and `exitCode=0`.

Ad-hoc commands can still be recorded for traceability, but they do not satisfy the passing verify gate unless they are part of the task verify plan. Exact matching is deliberate; if the task says `npm test`, record `npm test`, not `npm test || true` or `npm  test`.

## Benchmark discipline

Release-level quality/token/cost claims must use `piagent-benchmark`: paired clean
workspaces, the same prompt/model/thinking, hidden acceptance checks, exact Pi
usage, scope checks and Piagent workflow evidence. A token-saving verdict also
requires perfect safety and the suite's quality/reliability/workflow gates.
Production requires aggregate scores of at least `9.5/10` plus every task and
category/profile/lifecycle/difficulty outcome strictly above `9.5`; it also
requires non-inferior quality and paired same-model usage with confidence.
`scripts/quality-benchmark.sh` remains only as a legacy recorder for
project-specific evidence.

# Task Implementation Contract

## Mục tiêu

Đây là contract tối thiểu để Pi implement task không khác gì một CLI agent nghiêm túc: có scope, context, guard, verify, trace.

## Contract fields

| Field | Required | Ý nghĩa |
|---|---:|---|
| `taskId` | yes | ID ổn định cho task. |
| `summary` | yes | Một câu mô tả outcome. |
| `riskLane` | yes | `tiny`, `normal`, hoặc `high-risk`. |
| `expectedOutput` | yes | Artifact/behavior cụ thể. |
| `acceptanceCriteria` | yes | Điều kiện pass/fail. |
| `scope` | yes | File/module được phép đụng. |
| `outOfScope` | yes | Cái không làm. |
| `protectedPaths` | yes | Vùng cấm từ profile/policy. |
| `requiredContext` | yes | Context bắt buộc đọc. |
| `contextManifest` | yes | Bằng chứng context đã dùng. |
| `memoryCitations` | no | Memory file dùng làm advisory context, nếu có. |
| `mcpCapabilities` | no | Tool/MCP được phép. |
| `verifyCommands` | yes | Command phải chạy trước DONE. |
| `workPlan` | no | Task tree compact: step, role, mode, trạng thái, dependency. |
| `reviewLenses` | no | Góc review rõ ràng, mặc định `correctness`, `tests`, `scope`. |
| `orchestration` | no | Snapshot solo-first policy khi task bắt đầu: mode, subagent stance, Field Guide, model-role guidance. |
| `verifyEvidence` | yes before done | Observed command result. Passing gate requires exact match with `verifyCommands`. |
| `changedFiles` | yes before done | File đã sửa. |
| `trace` | yes before done | Handoff/audit record. |

## JSON example

```json
{
  "taskId": "TASK-0001",
  "summary": "Fix listing filter reset behavior",
  "riskLane": "normal",
  "expectedOutput": "Filter reset returns listing page to default query and preserves route owner.",
  "acceptanceCriteria": [
    "Reset button clears selected filters",
    "URL query returns to canonical default",
    "No protected paths are modified"
  ],
  "scope": [
    "src/features/listings/**"
  ],
  "outOfScope": [
    "backend API changes",
    "database changes"
  ],
  "protectedPaths": [
    "backend/**"
  ],
  "requiredContext": [
    "AGENTS.md",
    ".pi/project-context.md",
    "docs/frontend/structure-guide.md"
  ],
  "contextManifest": [
    {
      "path": "AGENTS.md",
      "reason": "root rules"
    }
  ],
  "memoryCitations": [],
  "mcpCapabilities": [
    "filesystem-readonly",
    "browser"
  ],
  "verifyCommands": [
    "npm run test"
  ],
  "workPlan": [
    {
      "id": "plan",
      "title": "Confirm scope and verify gate before editing.",
      "role": "parent",
      "mode": "read-only",
      "status": "done"
    },
    {
      "id": "implement",
      "title": "Apply the bounded source change.",
      "role": "piagent-worker",
      "mode": "single-writer",
      "status": "pending",
      "dependsOn": [
        "plan"
      ]
    }
  ],
  "reviewLenses": [
    "correctness",
    "tests",
    "scope"
  ],
  "orchestration": {
    "mode": "solo-first",
    "subagents": "not-used",
    "reason": "Task starts in solo-first mode; use bounded subagents only for independent scout, planning, or review work.",
    "fieldGuidePath": ".pi/memory/MEMORY.md",
    "modelRoles": {
      "planner": "Use the strongest available model for decomposition, architecture, risk, and acceptance criteria.",
      "worker": "Use the fastest reliable model for a bounded, already-planned single write set.",
      "reviewer": "Use a model or thinking setting decorrelated from the worker when review quality matters.",
      "watchdog": "Use a strong model only for final risk review, security, release, or high-impact changes."
    }
  },
  "verifyEvidence": [
    {
      "command": "npm run test",
      "exitCode": 0,
      "summary": "Unit test suite passed.",
      "observed": true,
      "matchedProfileCommand": true
    }
  ],
  "changedFiles": [],
  "trace": {
    "outcome": "pending"
  }
}
```

## Prompt contract

Pi task prompt phải bắt buộc:

```text
Use piagent_context first.
Use piagent_orchestration_policy; default to solo-first, create a compact task tree, and choose review lenses before spawning subagents.
Use piagent_context_index_status/search as advisory navigation when available; verify cited files before editing.
Use piagent_memory_status and search memory when relevant; memory is advisory only.
Read .pi/project-context.md; if it is pending, stop and request /onboard-project.
Create a Task Implementation Contract with piagent_task_start.
Check large context with piagent_context_budget.
Check complex/high-impact shell with piagent_exec_policy_check.
Check non-piagent tools with piagent_tool_policy_check.
Do not edit before scope + verify command are known.
Before final, run the exact verify command from task.verifyCommands through Pi bash, record observed verify evidence, and trace.
Call piagent_task_gate_check before DONE.
If verify cannot run, final outcome is blocked/partial, not done.
```

## Enforcement levels

| Level | Cách enforce | Độ tin cậy |
|---|---|---:|
| Prompt only | prompt nhắc model | Thấp |
| Profile + prompt | profile có rule, prompt đọc profile | Trung bình |
| Extension guard | tool_call block protected/destructive | Khá |
| Runtime task tools | task_start/context_record/verify_record/trace | Cao |
| Runtime quality tools | exec_policy/context_budget/tool_policy/task_gate | Cao |
| Final gate | trace completion block khi `finalGate=enforce`; hard assistant stop-hook khi Pi API hỗ trợ | Cao nhất |

Hiện platform đang ở mức “P3-baseline runtime policy”:

- `piagent_task_start`
- `piagent_exec_policy_check`
- `piagent_context_budget`
- `piagent_context_index_status`
- `piagent_context_index_search`
- `piagent_context_index_record`
- `piagent_tool_policy_check`
- `piagent_context_record`
- `piagent_verify_record`
- `piagent_trace_record`
- `piagent_task_gate_check`
- local task/trace/observed-bash state trong `.pi/piagent-state/`
- session trace qua Pi custom entry `piagent-task-trace`

`piagent_trace_record` có thể block completion nếu profile bật `finalGate=enforce`. Nếu Pi runtime chưa expose hard final assistant stop hook, agent vẫn phải gọi `piagent_task_gate_check` và final phải nêu gate result.

## Verify evidence rules

`piagent_verify_record` is not a free-form self-report. It accepts evidence only when the same normalized command was observed through a Pi `bash` `tool_result` after `task.createdAt`.

Observed bash results are persisted to:

```text
.pi/piagent-state/observed-bash.jsonl
```

This lets parent agents validate verify commands executed by guarded subagent processes in the same cwd.

Final-gate pass requires:

- `observed=true`;
- `matchedProfileCommand=true`;
- `exitCode=0`.

Exact command identity matters. If the task profile says `npm test`, record `npm test`. `npm  test`, `npm test 2>&1`, `npm test || true`, `true`, and `echo ok` are different commands and will not satisfy the passing gate unless explicitly present in `task.verifyCommands`.

## Named implementation recipes

- `/platform-improve`: dùng cho task cải tiến setup, docs, prompt, MCP, model, memory, runtime policy, hoặc subagent workflow của platform.
- `/be-to-fe`: dùng cho task scout BE contract read-only rồi implement FE.
- `/memory-policy`: dùng cho task kiểm tra/ghi nhớ explicit project memory.

Hai recipe này vẫn phải tạo/giữ Task Implementation Contract khi có source writes.

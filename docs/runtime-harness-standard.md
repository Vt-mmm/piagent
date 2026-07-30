# Runtime harness standard

## Mục tiêu

Runtime harness là “máy vận hành task” dùng chung cho nhiều project:

```text
User request
  -> project profile
  -> intake/risk lane
  -> required context manifest
  -> plan / task contract
  -> guarded tool calls
  -> implementation
  -> observed verify evidence
  -> trace / handoff
```

Project cụ thể chỉ cần adapter/profile riêng. Core package giữ lifecycle, policy, verification, và documentation flow.

## Reusable modules

| Module | Pi Agent Platform target | Lý do |
|---|---|---|
| Risk lane | `riskLane` + profile `hardGates` | Chặn auth, release, provider config, destructive action, database migration. |
| Intake | `piagent_task_start` | Mỗi task có scope, output, acceptance criteria trước khi edit. |
| Context rules | `/onboard run`, Pi Context Engine, `.pi/project-context.md`, `requiredContext`, context manifest | Giảm token và tránh đọc toàn repo. |
| Test matrix | `verifyCommands` + observed verify evidence | DONE phải có exact verify command thực chạy qua Pi bash hoặc `N/A` rõ lý do. |
| Trace | `piagent_trace_record`, `.pi/piagent-state/traces.jsonl`, session entry | Có audit trail cho task. |
| Protected paths | `protectedPaths` trong profile + extension guard | Mỗi project có vùng cấm riêng. |
| Tool registry | `mcpCapabilities` + `.mcp.json` | Không tự đoán tool/MCP. |
| Domain contract | Project docs/profile | Chỉ project cần UX/form/data strict mới bật. |

## Không đưa vào core

| Không đưa vào core | Lý do |
|---|---|
| Project-specific DB/state | Không portable giữa project. |
| Project-specific story IDs | Mỗi team cần namespace riêng. |
| Project-specific FE/BE rules | Làm core bị khóa vào một repo. |
| Toàn bộ skill library của một máy local | Gây collision và context bloat. |
| Prompt dài cho mọi trường hợp | Nên dùng lifecycle + profile + context manifest. |

## Workflow prompts

- `/workflow platform-improve`: update package/platform behavior.
- `/workflow be-to-fe`: scout backend/spec read-only, create contract snapshot, implement frontend only.
- `/workflow task`: governed implementation lifecycle.
- `/workflow plan`: create implementation plan.
- `/workflow discuss`: clarify before work.
- `/workflow review`: review diff/source with evidence.

## Task lifecycle chuẩn

Vòng đời thích nghi theo mức rủi ro. Runtime guard luôn hoạt động, nhưng các
tool context mang tính advisory chỉ được nạp khi task thực sự cần.

```text
1. Intake
   - risk lane
   - expected output
   - acceptance criteria
   - out of scope
   - protected paths

2. Context
   - load concise piagent_context once
   - use one token-budgeted Context Engine pack for unfamiliar/cross-module work
   - read only targeted requiredContext
   - check only large/unfamiliar files with piagent_context_budget
   - record context manifest

3. Plan
   - exact touchpoints
   - verify command
   - rollback/handoff if high-risk

4. Implement
   - check complex/risky shell with piagent_exec_policy_check
   - check non-piagent tools only when capability is unclear
   - edit only in scope
   - avoid protected paths

5. Verify
   - run exact mapped verify command
   - store evidence
   - if verify unavailable: not DONE

6. Trace
   - changed files
   - commands
   - result
   - friction
   - next step
   - piagent_task_gate_check before DONE
```

| Lane | Extra context/orchestration |
|---|---|
| `tiny` | Core lifecycle only; parent agent, targeted reads, exact verify. |
| `normal` | Index/memory only for unfamiliar areas; bounded read-only delegation when it saves context. |
| `high-risk` | Relevant index/memory/vendor evidence plus explicit security/data/release review. |

## Maturity phases

| Phase | Output | Đủ để implement task? |
|---|---|---|
| P0 | package core + profile + docs + protected path guard | Chỉ đủ pilot/read-only. |
| P1 | schema + task contract + doctor + verify-local + lean prompts | Dùng được cho task nhỏ có review. |
| P2 | extension tools for task/context/verify/trace + session entries | Dùng được cho source task có guard rõ. |
| P3 | exec policy + context budget + tool registry + task gate + benchmark recorder | Dùng được cho guarded project workflows. |
| P4 | stronger worktree/sandbox/team governance | Cần project-specific dry run trước khi làm default. |

## Chuẩn DONE

Một Pi task chỉ DONE khi có đủ:

- profile loaded;
- lane classified;
- protected paths known;
- context manifest exists;
- plan exists for source write;
- changed files listed;
- exact verify command ran and passed, hoặc explicitly `N/A` với reason;
- trace/handoff recorded;
- no secrets touched;
- no protected path writes.

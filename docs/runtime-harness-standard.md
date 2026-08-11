# Runtime harness standard

## Mục tiêu

Runtime harness là “máy vận hành task” dùng chung cho nhiều project:

```text
User request
  -> Pi session name / task identity
  -> resolved project profile + capability lock
  -> intake/risk lane/change mode
  -> required context manifest
  -> session-bound task contract v2 + work-plan DAG
  -> guarded tool calls
  -> adaptive context plan receipt
  -> hash-chained task journal / checkpoints
  -> baseline-aware changed-file evidence
  -> all-command observed verification
  -> immutable trace / retry handoff
```

Project cụ thể chỉ cần adapter/profile riêng. Core package giữ lifecycle, policy, verification, và documentation flow.

## Reusable modules

| Module | Pi Agent Platform target | Lý do |
|---|---|---|
| Risk lane | `riskLane` + profile `hardGates` | Chặn auth, release, provider config, destructive action, database migration. |
| Intake | runtime automatic intake; fallback `piagent_task_start` | Mỗi attempt có identity/session/scope/output/acceptance criteria trước model work; bounded tasks không tốn management turn. |
| Context rules | `/onboard run`, Pi Context Engine, `.pi/project-context.md`, `requiredContext`, context manifest | Giảm token và tránh đọc toàn repo. |
| Adaptive context | `runtime/context/adaptive-planner.ts` | Token budget theo phase/lane/model/thinking/context pressure; context pack có receipt. |
| Parent model route | `runtime/model/model-route-*` | Capability/safety floor deterministic trước task; giữ explicit pin, exact catalog match, không đổi model giữa conversation. |
| Retrieval route | `runtime/context/retrieval-route-policy.ts` | Local direct hoặc read-only retriever recommendation; chỉ `grep/find/read`, tối đa 8 nhánh × 4 vòng, không auto-dispatch. |
| Repository memory | `.pi/piagent-state/repository-memory/facts.jsonl` | Fact có citation/expiry; chỉ inject trong token budget còn dư và luôn verify lại bằng current file. |
| Test matrix | `verifyCommands` + verification intelligence + observed evidence | Chọn group theo task scope; source DONE phải có mọi exact verify command thực chạy và pass qua Pi bash. |
| Trace | completion hook, `.pi/piagent-state/traces.jsonl`, session entry | Runtime tự ghi audit trail; tool thủ công chỉ dùng recovery. |
| Journal/checkpoint | `.pi/piagent-state/task-journal/events.jsonl` | Hash-chain audit/replay; retention compaction lưu prefix/head anchor và contract vẫn là operational truth. |
| Execution backend | host mặc định + fail-closed adapter contract | Không âm thầm chạy mutation trên host khi operator yêu cầu experimental isolation chưa có adapter. |
| Retry | `attempt`, `maxAttempts`, `previousAttempts`, failed step state | Lần sau giữ failure/ruled-out evidence và không loop vô hạn. |
| Change truth | Git baseline/final digests + tool-result observation | Không nhận file dirty cũ hoặc claim không có evidence là thay đổi của task. |
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

## Parent routing và retrieval specialist

Router chỉ đọc bounded `TaskFeatures`, selection provenance và authenticated
catalog. Raw prompt/source không được ghi vào decision. `unknown` provenance,
explicit user pin, unavailable model/effort, protected/external/destructive
action, thiếu Git/verifier, hoặc host boundary không an toàn đều fail closed.

Pi 0.82.0 có extension API đổi model nhưng path đó đồng thời cập nhật user
default. Vì vậy Piagent không dùng nó để đổi model âm thầm. `auto` chỉ enforce ở
prelaunch adapter do operator gọi bằng `piagent-route --execute --yes`; runtime
extension vẫn chỉ shadow/recommend. Đây cũng là lý do model không bị đổi giữa
conversation, tránh cache miss và context/harness discontinuity.

Retrieval policy lấy cơ chế chuyên biệt hóa từ Fast Context nhưng giữ rollout
bảo thủ: planner có thể đề nghị retriever read-only chạy nhiều hướng tìm kiếm có
giới hạn, còn `automaticDispatch` luôn false cho đến khi provider-backed gate
chứng minh quality, token và latency.

## Task lifecycle chuẩn

Vòng đời thích nghi theo mức rủi ro. Runtime guard luôn hoạt động, nhưng các
tool context mang tính advisory chỉ được nạp khi task thực sự cần.

```text
1. Intake
   - one Pi session per task
   - runtime auto-start for bounded source changes; manual fallback for broad/high-risk/ambiguous scope
   - source-change or read-only
   - risk lane
   - expected output
   - acceptance criteria
   - out of scope
   - protected paths

2. Context
   - runtime planner decides whether a Context Engine navigation pack is useful
   - budget is based on workflow phase, risk lane, explicit paths, model/thinking and context pressure
   - read only targeted current files
   - successful reads become context manifest evidence automatically
   - no routine context/status/index tool calls

3. Plan
   - exact touchpoints
   - verify command
   - rollback/handoff if high-risk
   - dependency DAG with one write owner

4. Implement
   - tool-call hook checks shell, capabilities and external actions automatically
   - edit only in scope
   - avoid protected paths
   - block direct and shell writes outside scope

5. Verify
   - run every exact mapped verify command
   - tool-result hook records exact observed evidence after task start
   - bind passing evidence to the current working-tree digest
   - reconcile changed files against baseline and scope
   - if verify unavailable: not DONE

6. Trace
   - completion hook projects the final contract and runs the gate
   - runtime persists changed files, commands, result and final trace
   - one bounded continuation repairs missing evidence; it never loops
   - strict specialist review is opt-in, uses one bounded diff plus two reads,
     and limits repair to exact reviewed source/test paths
   - denied, failed, no-op, stale, or exhausted review activity hands off; any
     mutation requires the exact current-tree verifier before completion
   - freeze the contract after a terminal outcome

7. Retry when needed
   - start a fresh Pi session with the same taskId
   - carry forward failedAt, reason, ruledOut, and prior outcome
   - refuse attempts beyond the first attempt's maxAttempts
   - replay task journal checkpoints to see the latest phase before resuming
```

Operator projection không tạo source of truth mới: `/task-preflight` chiếu fact
và recommendation trước task, `/piagent-status` chiếu live persisted state, còn
completion receipt chiếu final gate. Mọi view phải có schema/version, ghi
`unknown`/`null` thay vì đoán, và luôn nói rõ host execution không phải sandbox.

| Lane | Extra context/orchestration |
|---|---|
| `tiny` | Automatic lifecycle; parent agent, targeted reads, exact verify, no progress/evidence calls. |
| `normal` | Automatic objective evidence plus one explicit final review step. |
| `high-risk` | Relevant index/memory/vendor evidence plus explicit security/data/release review. |

## Maturity phases

| Phase | Output | Đủ để implement task? |
|---|---|---|
| P0 | package core + profile + docs + protected path guard | Chỉ đủ pilot/read-only. |
| P1 | schema + task contract + doctor + verify-local + lean prompts | Dùng được cho task nhỏ có review. |
| P2 | extension tools for task/context/verify/trace + session entries | Dùng được cho source task có guard rõ. |
| P3 | exec policy + context budget + tool registry + task gate + automatic paired benchmark | Dùng được cho guarded project workflows. |
| P4 | session-bound v2 state, Git change truth, retry, completion hook, bounded secure local state | Sẵn sàng rollout có kiểm soát; OS/MDM governance vẫn ngoài core. |
| P5 | adaptive context planner, durable task journal, repository memory, model capability layer, verification intelligence | Sẵn sàng controlled recovery rollout; production benchmark bắt buộc, public long-horizon score chờ dedicated suite. |

## Chuẩn DONE

Một Pi task chỉ DONE khi có đủ:

- profile loaded;
- task is bound to the current Pi session;
- lane classified;
- protected paths known;
- context manifest exists;
- plan exists for source write;
- changed files listed;
- every exact source verify command ran and passed;
- declared changed files are evidenced, in scope, and different from baseline;
- work plan has no pending/in-progress/failed step;
- trace/handoff recorded;
- no secrets touched;
- no protected path writes.

Read-only task có thể hoàn tất không cần source verifier nhưng phải giữ working
tree không đổi. Source task không có Git hoặc meaningful verifier bị từ chối từ
đầu, không đợi tới cuối mới báo thiếu evidence.

# Subagents và multi-agent workflow
<!-- language: vi; english-index: docs-site/content/en/workflows.html -->

## Kết luận

Pi core không có subagents built-in. Theo design của Pi, subagents là extension/package. Platform này dùng `pi-subagents` làm subagent runtime vì nó hỗ trợ:

- child Pi sessions riêng context;
- foreground/background runs;
- `/run`, `/parallel`, `/chain`;
- builtin agents `scout`, `planner`, `worker`, `reviewer`, `oracle`, `researcher`, `context-builder`, `delegate`;
- custom package agents từ `packages/piagent-core/subagents`;
- status/fleet/cost/doctor commands;
- bounded recursion/concurrency;
- optional worktree isolation cho parallel writers.
- prompt shortcuts như `/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`;
- native supervisor channel (`contact_supervisor` / `subagent_supervisor`);
- acceptance gates, output files, forked context, watchdog, model profiles, and lifecycle artifacts.

Từ `v0.3.7`, `scripts/setup.sh` mặc định cài `pi-subagents` và chạy config preset `safe`.

Workflow prompts của platform dùng **parent-direct orchestration policy**: parent model tự đọc, suy luận và implement. Helper mặc định tắt. Chỉ khi operator bật `PIAGENT_HELPERS_MODE=on`, runtime mới được phép cân nhắc đúng một helper read-only có context fresh; việc dispatch còn phải chứng minh ít nhất hai lane độc lập và tối thiểu 30% projected net token saving sau cả chi phí handoff/merge. Worker, parallel, nested helper và retry đều bị tắt. Alias cũ như `/task` giữ cùng policy.

Kiểm tra nhanh policy trong Pi:

```text
/piagent-orchestration
```

Runtime policy dùng `RolePolicy v1` và `HelperRequest v2` để bind objective,
task/session identity hash, scope, exact tool allowlist, model/effort từ
authenticated runtime catalog, context/time/call ceiling, output schema,
stopping rule, approval restriction và deduplication key. Chọn mode bằng:

```bash
PIAGENT_HELPERS_MODE=off        # không recommend/spawn
PIAGENT_HELPERS_MODE=recommend  # opt-in quan sát/recommend; không spawn
PIAGENT_HELPERS_MODE=on         # opt-in; vẫn phải qua evidence gate 30%
```

`piagent-worker` bị disable trong Piagent config và không được delegate.
CAP-14 mặc định `off`; chỉ environment opt-in mới có thể bật. Lower-level
helper budget là trần tuyệt đối: tối đa 1 read-only helper concurrent và tổng,
0 writer, 0 retry, 8 calls, context handoff tối đa 2.048 token; nó không
claim account-wide scheduling hay kiểm soát các Pi session không liên quan.
Mỗi dispatch cưỡng chế đúng time/call/token ceiling của request. Timeout,
parent cancellation, late/stale result và budget overflow đều fail closed và
không merge output. Khi thành công, parent chỉ nhận bounded redacted summary và
giữ merge ownership; durable receipt chỉ giữ digest/counters, không giữ raw
child output hay session identity.

Guard extension vẫn load trong helper process. Piagent helper chỉ đọc nên không tạo verifier hay source-change authority; parent vẫn là owner duy nhất của implementation và exact verifier cuối.

Xem chi tiết: `docs/auto-delegation-policy.md`.

Capability notes chi tiết: `docs/subagent-orchestration-capabilities.md`.

## Install/setup

Một lệnh setup đầy đủ:

```bash
bash /path/to/piagent/scripts/setup.sh . \
  --profile auto \
  --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z \
  --mcp-preset core \
  --subagents-preset safe
```

Nếu chỉ cài global:

```bash
pi install git:github.com/Vt-mmm/piagent
pi install npm:pi-subagents@0.38.0
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

Nếu package đã cài nhưng muốn re-apply config:

```bash
piagent-subagents --preset safe
# hoặc nếu chưa link npm bin:
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

## Safe preset

`safe` ghi vào:

```text
~/.pi/agent/extensions/subagent/config.json
```

Nội dung chính:

- `toolDescriptionMode: compact` để giảm prompt/token;
- `asyncByDefault: false` để không tự chạy background nếu không yêu cầu;
- `waitTool.enabled: false` để không tạo continuation chờ helper;
- `intercomBridge.mode: off` để child không mở thêm vòng hỏi/đáp;
- `singleRunOutputBaseDir` và `defaultSessionDir` stable trong `~/.pi/agent`;
- `worktreeBaseDir` stable cho parallel writer khi được explicit bật;
- `scheduledRuns.enabled: false` để không lộ surface schedule nếu user không yêu cầu;
- `parallel.concurrency: 1` và `parallel.maxTasks: 1` (compatibility surface, không phải parallel dispatch);
- `maxSubagentDepth: 1`;
- `maxSubagentSpawnsPerSession: 1`;
- builtin agents và `piagent-worker` bị disable; chỉ custom read-only role có thể được operator bật rõ;
- async completion batching bật.

Không ép `subagents.modelScope` mặc định. Anh chọn model parent bằng `/model`; builtin subagents sẽ inherit model nếu không override. Nếu muốn ép chỉ provider:

```bash
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe --model-scope piagent
```

## Kiểm tra trong Pi

Sau khi mở session mới hoặc `/reload`:

```text
/subagents-doctor
/subagents-models
/subagents
/subagents-fleet
/subagent-cost
```

`/subagents-doctor` là lệnh đầu tiên nên chạy nếu không thấy tool/agent.

Web research support is installed by default in team setup/update:

```bash
pi install npm:pi-web-access@0.17.0
# hoặc full setup/update:
bash /path/to/piagent/scripts/setup.sh .
```

`researcher` builtin cần web/search/fetch tools từ package này. Từ `v1.2.8`, platform cài package này mặc định để `/parallel-research` không bị giới hạn ở local repo/docs. Nếu một máy thật sự không được phép browse/fetch web, dùng `--no-web-access`.

Giải nghĩa nhanh:

| Command | Nghĩa đơn giản | Khi dùng |
|---|---|---|
| `/subagents-doctor` | Health check subagent | Kiểm package/config/agent files/runtime readiness. |
| `/subagents-models` | Bản đồ model/thinking của subagents | Xem agent nào inherit model parent, agent nào override. |
| `/subagents` | Catalog/admin agents | Xem builtin agents và `piagent-*` agents. |
| `/subagents-fleet` | Dashboard đội child sessions | Follow background/parallel runs, xem active/done/result. |
| `/subagent-cost` | Token/cost subagents | Xem usage của child runs nếu package/provider expose stats. |
| `/run` | Chạy một agent | Dùng cho scout/planner/worker/reviewer riêng context. |
| `/parallel` | Chạy nhiều agent độc lập | Tốt cho read-only scout/review/test-gap analysis. |
| `/chain` | Chạy tuần tự | Output agent trước làm input agent sau qua `{previous}`. |

Nếu cần bản tổng hợp cho team mới:

```text
/commands subagents
```

## Gọi subagent tự nhiên

Không bắt buộc nhớ exact tool call. Có thể prompt tự nhiên:

```text
Use scout to map the auth flow, then summarize likely change targets.
Ask oracle to challenge this plan before we edit code.
Use reviewer to review the current diff for correctness and tests.
Run parallel reviewers: correctness, tests, and unnecessary complexity.
Have worker implement this approved plan, then run reviewer.
Run a review loop on this change until reviewers stop finding fixes worth doing, max 3 rounds.
Run parallel research: external docs, local code context, and practical tradeoffs.
```

Với workflow platform, còn có thể chỉ gọi:

```text
/workflow task Implement <task lớn>.
```

Parent agent sẽ tự quyết định:

- không spawn nếu task nhỏ;
- spawn bounded `piagent-scout` nếu cần map source/spec;
- spawn bounded `piagent-planner` nếu cần plan medium/high-risk;
- spawn bounded `piagent-reviewer` trước final nếu diff không nhỏ;
- dùng builtin `researcher` nếu task cần external evidence và web tools available;
- dùng builtin `context-builder` nếu task lớn cần handoff context;
- dùng review lenses (`correctness`, `tests`, `scope`, optional `security/docs/release/package`) thay vì gọi review swarm chung chung;
- ghi trong final `Subagents: used/not used and why`.

## Package prompt shortcuts nên biết

| Prompt | Dùng khi nào |
|---|---|
| `/parallel-review` | Review nhiều góc nhìn độc lập; thêm `autofix` nếu muốn áp fix đáng làm. |
| `/review-loop` | Worker/reviewer/fix loop đến khi sạch hoặc hết max rounds. |
| `/parallel-research` | External research + local scout + tradeoff. Cần `pi-web-access` cho web researcher. |
| `/parallel-context-build` | Tạo `context.md`/meta-prompt handoff cho task lớn. |
| `/parallel-handoff-plan` | Research + context-builder + implementation handoff plan. |
| `/gather-context-and-clarify` | Đọc/scout trước rồi chỉ hỏi câu clarification thật sự cần. |
| `/parallel-cleanup` | Cleanup review sau implementation; có thể thêm `autofix`. |

## Gọi bằng slash command

Single agent:

```text
/run scout "Map the auth flow and identify entry points."
/run piagent-scout "Map FE routes related to listing search. Read-only."
/run piagent-planner "Create implementation plan from context.md."
/run piagent-worker "Implement the approved plan. Do not touch backend."
/run piagent-reviewer "Review current diff against the task and verify evidence."
/run piagent-oracle "Challenge this architecture choice before implementation."
```

Parallel:

```text
/parallel piagent-reviewer "Review correctness" -> piagent-reviewer "Review tests" -> piagent-reviewer "Review scope drift"
```

Chain:

```text
/chain piagent-scout "Scout the target area" -> piagent-planner "Plan from {previous}" -> piagent-worker "Implement from {previous}" -> piagent-reviewer "Review the implementation"
```

Background:

```text
/run piagent-scout "Map this module" --bg
/subagents-fleet
```

## Gọi bằng tool syntax

Khi muốn chính xác:

```text
subagent({ agent: "piagent-scout", task: "Map the auth flow. Read-only.", context: "fresh" })
```

Background:

```text
subagent({ agent: "piagent-reviewer", task: "Review current diff", async: true })
subagent({ action: "status" })
```

Status/control:

```text
subagent({ action: "status" })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "<run-id>", view: "transcript" })
subagent({ action: "steer", id: "<run-id>", message: "Focus only on tests." })
subagent({ action: "stop", id: "<run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "Continue after this clarification." })
subagent_supervisor({ action: "pending" })
subagent_supervisor({ action: "reply", replyTo: "<request-id>", message: "Approved path A." })
```

Output/file controls:

```text
/run scout[output=context.md,outputMode=file-only] "Map target area"
/chain scout[output=context.md,as=context] "Scan" -> planner[reads=context.md] "Plan from {outputs.context}"
```

Use `outputMode=file-only` khi report dài để parent không bị nhồi full output vào context.

## Piagent subagents

Platform package exposes these package-level agents:

| Agent | Role | Write? |
|---|---|---|
| `piagent-scout` | bounded repo mapping | no |
| `piagent-planner` | implementation plan + verify gates | no |
| `piagent-worker` | compatibility metadata; disabled by config | unavailable |
| `piagent-reviewer` | review diff/policy/tests/scope | no |
| `piagent-oracle` | second opinion/risk challenge | no |

Default rule: parent tự làm. Khi operator opt-in, runtime có thể chọn đúng một trong các read-only role phía trên sau khi qua evidence gate 30%; không role nào được retry hay spawn tiếp.

## Worktree isolation

Piagent không cấp writer helper và không bật worktree/parallel orchestration. Nếu operator cần các capability upstream này thì đó là một runtime khác ngoài policy/budget/claim của Piagent.

## Watchdog opt-in

Watchdog không phải `reviewer`. Nó là adversarial review ở boundary `agent_end`, chỉ chạy khi có repo edits. Không bật mặc định vì tốn thêm model pass.

Session-only high-risk run:

```text
/subagents-watchdog recommend-model
/subagents-watchdog session model recommended
/subagents-watchdog on
```

Persistent project/user config chỉ dùng khi team đã đồng ý cost/latency.

## Model profiles

Khi team có nhiều provider/quota:

```text
/subagents-refresh-provider-models openai-codex
/subagents-generate-profiles openai-codex
/subagents-load-profile openai-codex.quota
/subagents-check-profile openai-codex.quota
```

Model scope platform vẫn có thể enforce bằng:

```bash
piagent-subagents --preset safe --model-scope piagent
```

## Cost/token controls

Use:

```text
/subagent-cost
/usage
/session
```

Recommended token policy:

- default `safe` preset;
- do not set `asyncByDefault` unless anh intentionally wants background-heavy workflow;
- giữ parent-direct và `PIAGENT_HELPERS_MODE=off` mặc định;
- parent là writer duy nhất;
- không parallel, nested, forked-history hay retry helper;
- chỉ opt-in một read-only helper khi projected net saving từ 30%;
- run `/subagents-fleet` to inspect background runs instead of asking parent model to recall everything.

## Nguồn

- Pi usage docs: https://pi.dev/docs/latest/usage
- Pi SDK docs: https://pi.dev/docs/latest/sdk
- pi-subagents package: https://pi.dev/packages/pi-subagents
- pi-subagents GitHub: https://github.com/nicobailon/pi-subagents

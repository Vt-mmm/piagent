# Solo-first orchestration policy

Mục tiêu: user không phải nhớ `/run`, `/parallel`, `/chain` cho workflow hằng ngày, nhưng platform cũng không tự biến mọi task thành swarm tốn token. Khi anh gõ `/workflow task`, `/workflow be-to-fe`, `/workflow platform-improve`, `/workflow plan`, hoặc `/workflow review`, parent agent đọc `piagent_orchestration_policy`, giữ mặc định **solo-first**, rồi chỉ dùng subagents nếu việc đó giúp giảm nhiễu context, tăng tốc read-heavy work, hoặc tăng chất lượng review. Alias cũ như `/task` vẫn giữ cùng policy.

Kiểm tra policy hiện tại trong Pi:

```text
/piagent-orchestration
```

Slash command này chỉ hiện status compact, không gửi follow-up cho model.

## Kết luận thực tế

Subagent không nên hiểu là “luôn tự sinh khi task lớn”. Hành vi đúng là:

1. Parent agent đánh giá task có phần việc độc lập không.
2. Nếu có và `pi-subagents`/subagent tool khả dụng, parent có thể tự spawn subagent.
3. Nếu không có tool/package, parent tiếp tục single-agent và ghi rõ `Subagents: unavailable/not used`.
4. User vẫn có thể gọi command trực tiếp khi muốn ép orchestration cụ thể.
5. Parallel read-only có thể dùng cho scout/review; parallel writers không phải default và cần approval + isolation.

Nếu bundled skill `pi-subagents` có trong skill list của parent, parent nên dùng skill đó cho orchestration patterns thay vì tự đoán syntax. Skill này là parent-only; child subagents không nhận nó.

## Policy mặc định

| Setting | Default |
|---|---|
| Mode | `solo-first` |
| Max concurrent subagents | `2` |
| Review lenses | `correctness`, `tests`, `scope` |
| Field Guide | `.pi/memory/MEMORY.md`, advisory, explicit-write only |
| Writer policy | Một writer cho một write set. |

Model role guidance:

- planner: model mạnh nhất hợp lý cho decomposition, architecture, risk, acceptance criteria;
- worker: model nhanh/ổn định cho bounded implementation đã có plan;
- reviewer: model/thinking decorrelated với worker khi review quan trọng;
- watchdog/oracle: model mạnh chỉ cho final risk/security/release/high-impact.

## Khi nào parent nên tự spawn

Parent nên tự spawn subagents khi có ít nhất một điều kiện:

- cần scout nhiều vùng source độc lập;
- cần map BE contract read-only trong khi FE implementation là write target;
- cần đọc external source docs/repo và repo hiện tại song song;
- cần external research có nguồn dẫn, và `pi-web-access`/web tools đang available;
- cần tạo context handoff trước task lớn (`context-builder`);
- cần review nhiều góc độc lập: correctness, tests, security, scope drift;
- task có từ 3 touchpoint trở lên;
- task medium/high-risk nhưng có phần audit read-only trước khi edit;
- context có nguy cơ phình to nếu parent tự đọc toàn bộ log/spec/source.

## Khi nào không nên tự spawn

Không spawn nếu:

- task nhỏ, một file, verify đơn giản;
- requirement chưa rõ và cần hỏi user trước;
- chỉ có một write target nhỏ;
- subagent tool/package chưa available;
- repo dirty hoặc write set có nguy cơ overlap mà chưa phân tách được;
- task high-risk cần human gate trước khi edit;
- muốn spawn nhiều writer song song nhưng không có worktree isolation/approval.

## Default agent mapping

| Need | Agent | Mode |
|---|---|---|
| Map unfamiliar repo/module/spec | `piagent-scout` | read-only |
| Build implementation plan | `piagent-planner` | read-only |
| Implement approved bounded change | `piagent-worker` | single writer |
| Review current diff | `piagent-reviewer` | review-first |
| Challenge architecture/risk | `piagent-oracle` | read-only |
| External docs/web research | builtin `researcher` | read-only; requires web tools |
| Large context handoff | builtin `context-builder` or `piagent-scout` | writes handoff artifact only |

Default rule: parallel read-only is OK; parallel writers are not default.

## Workflow policy

### `/workflow task`

Parent should:

1. load piagent context/profile/memory/project context;
2. load `piagent_orchestration_policy`;
3. create a compact task tree/workPlan and review lenses in `piagent_task_start`;
4. decide whether subagents are useful enough to justify extra token cost;
5. if useful, spawn bounded read-only scout/planner/reviewer before or after implementation;
6. keep implementation single-writer unless user explicitly approves otherwise;
7. summarize subagent outputs into task contract/context manifest/final response.

### `/workflow be-to-fe`

Recommended auto-delegation:

- `piagent-scout`: map backend contract read-only;
- `piagent-scout`: map frontend touchpoints read-only;
- `piagent-planner`: produce FE implementation plan;
- parent or `piagent-worker`: implement FE only;
- `piagent-reviewer`: review diff and verify coverage.

### `/workflow platform-improve`

Recommended auto-delegation:

- `piagent-scout`: inspect current platform source/docs;
- builtin `researcher`: inspect official docs/web evidence when `pi-web-access` is installed;
- builtin `context-builder`: create handoff context/meta-prompt for large platform changes;
- `piagent-scout`: inspect official docs/external source repo targeted evidence;
- `piagent-planner`: produce implementation matrix;
- parent or `piagent-worker`: implement bounded changes;
- `piagent-reviewer`: review docs/runtime behavior.

### `/review`

Recommended auto-delegation:

- select explicit review lenses first;
- optional parallel `piagent-reviewer` for correctness;
- optional parallel `piagent-reviewer` for tests/verification;
- optional parallel `piagent-reviewer` for scope/protected-path drift;
- optional `piagent-oracle` for architecture/high-risk concerns.

If the user explicitly asks for a review loop, use `/review-loop` or an equivalent parent-controlled loop with max rounds. Do not blindly apply all reviewer suggestions.

## Prompt examples parent may use internally

Single scout:

```text
Use piagent-scout to map the target module read-only. Return files, ownership, invariants, and likely change points only.
```

Parallel scout:

```text
Run parallel piagent-scout agents: one maps backend contract read-only, one maps frontend touchpoints read-only. Wait for both and summarize the contract-to-FE map.
```

Parallel review:

```text
Run parallel piagent-reviewer agents for correctness, tests/verification, and scope/protected-path drift. Wait for all and summarize findings by severity.
```

Tool syntax fallback:

```text
subagent({ agent: "piagent-scout", task: "Map target area read-only. Return concise findings.", context: "fresh" })
```

## Reporting requirement

Final response should include one line:

```text
Subagents: <not used / unavailable / used: piagent-scout, piagent-reviewer>
```

If not used, give the reason briefly:

- `task was tiny`;
- `requirements unresolved`;
- `subagent tool unavailable`;
- `write set overlap risk`;
- `human gate required first`.

## Token rule

Subagents can reduce parent context pollution, but total token usage can increase because each child does its own model/tool work. Use them for parallelizable read-heavy work and review quality, not as a blanket token-saving switch.

## Package shortcuts worth using

| Shortcut | Use when |
|---|---|
| `/parallel-review` | Need distinct review angles; add `autofix` only when user permits fixes. |
| `/review-loop` | Need worker/reviewer/fix loop until clean or capped. |
| `/parallel-research` | Need external evidence + local code context. |
| `/parallel-context-build` | Need context/meta-prompt handoff before a large plan. |
| `/parallel-handoff-plan` | Need research + context-builder + implementation handoff. |
| `/gather-context-and-clarify` | Need scout/research first, then ask only meaningful questions. |
| `/parallel-cleanup` | Need post-implementation cleanup review. |

See `docs/subagent-orchestration-capabilities.md`.

## Official docs

- Pi pi-subagents package: https://pi.dev/packages/pi-subagents

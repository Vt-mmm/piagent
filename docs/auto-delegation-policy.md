# Solo-first orchestration policy
<!-- language: vi; english-index: docs-site/content/en/workflows.html -->

Mục tiêu: parent model tự làm trọn task với đầy đủ năng lực. Helper không còn là phase mặc định để scout/plan/review; nó chỉ là một tối ưu token ngoại lệ. Piagent chỉ cho tối đa **một helper read-only, context fresh** khi runtime chứng minh có ít nhất hai lane độc lập và tổng token dự kiến sau handoff/merge giảm tối thiểu **30%**. Alias cũ như `/task` giữ cùng policy.

Kiểm tra policy hiện tại trong Pi:

```text
/piagent-orchestration
```

Slash command này chỉ hiện status compact, không gửi follow-up cho model.

## Kết luận thực tế

Subagent không nên hiểu là “luôn tự sinh khi task lớn”. Hành vi đúng là:

1. Parent làm trực tiếp nếu runtime chưa có bằng chứng định lượng.
2. Helper chỉ đủ điều kiện khi có ít nhất hai workstream độc lập, helper không chờ output tiếp theo của parent, context transfer không quá 2.048 token, không inherit transcript, và tổng dự kiến tiết kiệm ít nhất 30%.
3. Mỗi task run chỉ có một lần thử helper. Lỗi runtime/scope xác định không được relaunch.
4. Helper luôn read-only; worker/writer helper bị tắt. Parent giữ toàn bộ mutation và quyết định.
5. UI/telemetry phải ghi `dispatch` hoặc `skip`, reason codes, và projected net saving; không có số liệu thì `skip`.

Nếu bundled skill `pi-subagents` có trong skill list của parent, parent nên dùng skill đó cho orchestration patterns thay vì tự đoán syntax. Skill này là parent-only; child subagents không nhận nó.

## Policy mặc định

| Setting | Default |
|---|---|
| Mode | `solo-first` |
| Helper budget | `1` read-only total; concurrent `1`; retry `0`; worker `0` |
| Minimum projected net saving | `30%` |
| Context transfer | fresh/isolated; tối đa `2.048` token; không inherit parent history |
| Review lenses | `correctness`, `tests`, `scope` |
| Field Guide | `.pi/memory/MEMORY.md`, advisory, explicit-write only |
| Writer policy | Parent model là writer duy nhất. |

Model role guidance:

- planner: model mạnh nhất hợp lý cho decomposition, architecture, risk, acceptance criteria;
- worker: disabled; parent model implement trực tiếp;
- reviewer/oracle: role read-only ngoại lệ; không tự chạy chỉ vì review quan trọng;
- builtin agents và watchdog: disabled trong baseline Piagent.

## Khi nào parent nên tự spawn

Chỉ spawn khi **đồng thời** thỏa tất cả điều kiện:

- runtime xác định ít nhất hai workstream thật sự độc lập;
- helper có thể hoàn tất mà không chờ output tiếp theo của parent;
- helper chỉ cần read/grep/find/ls;
- request dùng fresh isolated context, seed không quá 2.048 token;
- estimate gồm parent + helper + transfer + merge thấp hơn solo ít nhất 30%;
- task run chưa từng launch helper và không retry một lỗi runtime/scope xác định.

## Khi nào không nên tự spawn

Không spawn nếu:

- task nhỏ, một file, verify đơn giản;
- không có runtime estimate hoặc projected saving dưới 30%;
- requirement chưa rõ và cần hỏi user trước;
- chỉ có một write target nhỏ;
- subagent tool/package chưa available;
- repo dirty hoặc write set có nguy cơ overlap mà chưa phân tách được;
- task high-risk cần human gate trước khi edit;
- cần bất kỳ mutation nào từ child;
- muốn planner/reviewer chỉ để “tăng chất lượng” nhưng không giảm tổng token;
- đã có một helper attempt, kể cả attempt failed/orphaned.

## Default agent mapping

| Need | Agent | Mode |
|---|---|---|
| Map unfamiliar repo/module/spec | `piagent-scout` | read-only |
| Build implementation plan | `piagent-planner` | read-only |
| Review current diff | `piagent-reviewer` | review-first |
| Challenge architecture/risk | `piagent-oracle` | read-only |

Default rule: parent direct. Tối đa một role read-only ở bảng trên; không parallel và không worker.

## Workflow policy

### `/workflow task`

Parent should:

1. load piagent context/profile/memory/project context;
2. load `piagent_orchestration_policy`;
3. create a compact task tree/workPlan and review lenses in `piagent_task_start`;
4. runtime tính projected total tokens; thiếu estimate hoặc saving dưới 30% thì skip;
5. nếu đủ điều kiện, spawn đúng một helper fresh/read-only;
6. parent tự implement và review;
7. summarize subagent outputs into task contract/context manifest/final response.

### `/workflow be-to-fe`

Parent map BE contract, map FE touchpoints, implement và review. Runtime chỉ được chọn **một** trong hai lane mapping cho `piagent-scout` nếu estimate toàn task đạt ngưỡng 30%; lane còn lại vẫn do parent làm.

### `/workflow platform-improve`

Parent inspect, research, plan, implement và review. Một fresh read-only helper chỉ được map một lane độc lập khi runtime estimate tổng token đạt ngưỡng; không dùng chain scout → planner → worker → reviewer.

### `/review`

Parent-owned review:

- select explicit review lenses first;
- parent cover các lens trong cùng context;
- chỉ dùng một fresh read-only reviewer/oracle nếu nó thay thế một lane độc lập và estimate tiết kiệm ít nhất 30%.

If the user explicitly asks for a review loop, use `/review-loop` or an equivalent parent-controlled loop with max rounds. Do not blindly apply all reviewer suggestions.

## Prompt examples parent may use internally

Single scout:

```text
Use piagent-scout to map the target module read-only. Return files, ownership, invariants, and likely change points only.
```

The parent must attach runtime evidence equivalent to: `independent lanes >= 2`, `context=fresh`, `inheritedParentTokens=0`, and `projectedNetSaving>=30%`. Without it, do not call the helper tool.

Tool syntax fallback:

```text
subagent({ agent: "piagent-scout", task: "Map target area read-only. Return concise findings.", context: "fresh" })
```

## Reporting requirement

Final response should include one line:

```text
Helper: <skip reason=<code> projectedSaving=<unknown|N%> / dispatch role=<role> projectedSaving=N%>
```

If not used, give the reason briefly:

- `task was tiny`;
- `requirements unresolved`;
- `subagent tool unavailable`;
- `write set overlap risk`;
- `human gate required first`.

## Token rule

Projected saving phải so sánh **tổng parent + child + handoff + merge**, không so child với một đoạn parent context riêng lẻ. Ngưỡng 30% là dispatch gate, không phải bằng chứng rằng Piagent đã rẻ hơn `codex-cli` 30–40%; kết luận đó chỉ được đưa ra từ paired benchmark Piagent/`codex-cli` cùng model, thinking, task và success gate.

## Package shortcuts

Các shortcut `/parallel-*`, worker/reviewer loop và grant-spawn-budget thuộc package upstream nhưng không nằm trong Piagent governed default. Absolute Piagent budget vẫn là một read-only helper total; daily workflow không dùng các shortcut này.

See `docs/subagent-orchestration-capabilities.md`.

## Official docs

- Pi pi-subagents package: https://pi.dev/packages/pi-subagents

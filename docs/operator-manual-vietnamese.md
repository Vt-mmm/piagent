# Pi Agent Platform - Operator manual tiếng Việt

## Mục tiêu

Tài liệu này là hướng dẫn vận hành end-to-end cho anh/team:

```bash
cd /path/to/project
pi
```

Từ đó Pi có thể login provider, chọn model, onboard project, chạy task, kiểm soát tool, theo dõi token, resume session, dùng MCP, và dùng subagent khi task đủ lớn.

Runtime team nên pin release tag hoặc commit đã review. Latest chỉ dùng cho máy cá nhân/sandbox khi chấp nhận cập nhật nhanh.

Support matrix release hiện tại: macOS Apple Silicon + Bash và Linux x64 + Bash đã được verify; macOS Intel + Bash và Linux ARM64 + Bash là supported target cần chạy `piagent-doctor` + smoke test trước khi rollout rộng; native Windows chưa phải target rollout team; WSL2 experimental/chưa release-gate. Node.js tối thiểu là `22.19.0`, Pi Coding Agent là `0.81.1`.

```bash
node --version  # >= 22.19.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.81.1
npm install -g --ignore-scripts @piagent/platform@1.0.1
piagent-install --stable --dry-run
piagent-install --stable
```

Khi seed `.pi/settings.json` cho team/repo cần audit lặp lại, giữ package source dạng pinned tag như `git:github.com/Vt-mmm/piagent@v1.0.1`. Máy cá nhân có thể dùng `git:github.com/Vt-mmm/piagent` để theo latest.

Nếu đang ở source checkout của platform, dùng helper theo channel để preview trước khi đổi:

```bash
bash scripts/install-global.sh --stable --dry-run
bash scripts/install-global.sh --stable
```

`--stable` sẽ resolve tag release hiện tại thành commit SHA, in ra `tag`, `resolvedCommit`, `source`, rồi mới gọi `pi install`. `currentRelease` là version của npm-global helper đang chạy. Nếu không resolve được tag thì fail-closed.

Full update phải đồng bộ exact Pi host trước, rồi npm-global helper và Pi package matching:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.81.1
npm install -g --ignore-scripts @piagent/platform@X.Y.Z
piagent-install --stable --dry-run
piagent-install --stable
piagent-doctor /path/to/project --strict-share
```

Khi rollback, lấy exact host version từ release policy của `vPREVIOUS`, hạ host có chủ ý rồi mới cài helper `vPREVIOUS`. Host cũ có thể tái đưa dependency finding đã được sửa ở release hiện tại. Nếu chủ ý chỉ đổi Pi package và giữ host/helper hiện tại, dùng `piagent-install --version vX.Y.Z --resolve-tag`. Checklist canonical nằm tại [release/install policy](release-install-policy.md).

## Phạm vi đúng của guard

Platform này là:

```text
Accident brake + prompt-injection speed bump, not a security boundary.
```

Nghĩa thực tế:

- Guard chặn agent gọi tool sai qua `tool_call`.
- Guard giúp giảm rủi ro đọc `.env`, auth file, guard state, hoặc chạy shell phá hoại.
- Guard buộc task có context manifest, verify evidence quan sát thật, trace, và final gate.
- Guard không chặn code đã chạy bên trong process khác, ví dụ `npm test` chạy script độc, dependency bị nhiễm, binary mới build, hoặc repo lạ có script nguy hiểm.

Scope dùng phù hợp:

- solo/internal;
- repo tin được;
- human-in-the-loop;
- project có thể audit và rollback.

Nếu input/repo không tin được hoặc chạy tự động trên CI không có người giám sát, phải thêm isolation tầng OS như container/VM/seccomp/network/credential boundary.

## Mental model

Có 3 lớp:

| Lớp | Nằm ở đâu | Vai trò |
|---|---|---|
| Pi core | `pi` CLI | Model UI, session, built-in tools `read/bash/edit/write/grep/find/ls`, provider/OAuth, MCP hooks. |
| Platform package | repo `piagent` | Commands, prompts, guard extension, profiles, MCP/subagent setup, task evidence. |
| Project state | `<project>/.pi/*` | Profile, project context, task state, memory, MCP override, local benchmark. |

Luồng mong muốn:

```text
install package once
  -> cd project
  -> pi
  -> login/model
  -> onboard project
  -> run task
  -> verify/trace/gate
  -> handoff
```

## 1. Base setup lần đầu

### Cài Pi và package platform

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.81.1
npm install -g --ignore-scripts @piagent/platform@1.0.1
piagent-install --stable --dry-run
piagent-install --stable
```

Nếu dùng Herdr:

```bash
herdr integration install pi
```

Kiểm tra package đã load:

```bash
pi list
pi list --approve
```

Nếu project đã tin cậy và muốn mở Pi không bị hỏi trust lại trong lần chạy hiện tại:

```bash
piagent-auto
```

Read-only auto-run cho scout/audit:

```bash
piagent-auto --read-only -p "Scout payment mapping. Do not edit source."
```

Trusted full-access style run cho repo đã kiểm soát:

```bash
piagent-auto --full-access -p "Run the trusted local benchmark suite."
```

`piagent-auto` chỉ wrap `pi --approve` và set permission profile cho lần chạy. Nó không tắt piagent guard: protected paths, redaction, destructive shell checks, task gate, và verify evidence vẫn chạy.

### Mở project

```bash
cd /path/to/project
pi
```

Daily UX không cần set shell profile, không cần chạy bash init trước. Profile chọn trong Pi qua onboarding hoặc `/profile`.

### Login provider

Trong Pi:

```text
/login
```

Chọn provider/account như OpenAI/Codex hoặc Anthropic/Claude. Credential nằm trong Pi user dir, không nằm trong repo và không được commit.

### Chọn model và thinking

Trong Pi:

```text
/model
```

Hotkey:

```text
Ctrl+L       # mở model selector
Ctrl+P       # cycle model trong scoped list
Shift+Ctrl+P # cycle ngược
Shift+Tab    # đổi thinking level nếu model hỗ trợ
```

Terminal options khi cần mở Pi với model cụ thể:

```bash
pi --model openai-codex/gpt-5.5 --thinking xhigh
pi --model anthropic/claude-sonnet-5:high
pi --models "openai-codex/*,anthropic/*sonnet*"
```

Gợi ý:

- Scout/plan đơn giản: dùng model nhanh/thấp hơn.
- Implement/debug/risk cao: dùng model mạnh/thinking cao.
- Deploy monitor/CI follow-up: tách session riêng, không giữ context implement quá dài.

## 2. Onboard project lần đầu

Sau `/login` và `/model`, chạy:

```text
/piagent-commands
/mcp
/subagents-doctor
/onboard-project
/memory-policy
```

`/onboard-project` sẽ:

1. đọc repo theo context budget;
2. detect profile phù hợp;
3. mở select-style profile/tech setup;
4. hỏi user trước khi apply nếu workflow chạy qua tool write;
5. ghi project profile, tech stack và context.

File chính được tạo/cập nhật:

```text
.pi/piagent-profile.json
.pi/piagent-profile.lock.json
.pi/tech-stack.json
.pi/tech-context/*.json
.pi/project-context.md
.pi/context-index.json
.pi/piagent-state/project-onboarding.json
.pi/memory/memory_summary.md
.pi/memory/MEMORY.md
```

Nếu `.pi/project-context.md` còn `Generated: not yet`, hoặc `/context-index` báo index đang pending/stale, không nên chạy `/task` implementation lớn. Chạy lại `/onboard-project` trước.

### Đổi profile sau này

Trong Pi:

```text
/profile list
/profile setup
/profile tech setup fullstack
/profile fullstack
/profile be-readonly-fe
/profile web-frontend
/profile backend-api
```

`/profile setup` ưu tiên UI select: chọn profile trước, rồi chọn tech theo role. Với `fullstack`, team phải chọn frontend, backend và database. Nếu Pi host chưa có select control, command sẽ trả card ngắn kèm lệnh apply deterministic, ví dụ:

```text
/profile tech apply fullstack frontend=nextjs backend=nestjs database=prisma
```

Sau khi chọn tech, đọc docs mới qua Context7 rồi record snapshot ngắn vào `.pi/tech-context/*`; không lưu nguyên văn docs dài hoặc secret.

Profile thường dùng:

| Profile | Khi dùng |
|---|---|
| `generic` | Repo chưa rõ cấu trúc. |
| `web-frontend` | FE-only. |
| `backend-api` | BE/API work. |
| `be-readonly-fe` | BE là source-of-truth/read-only, FE là write target. |
| `fullstack` | FE và BE đều có thể sửa nếu task cho phép. |
| `node-typescript` | Node/TypeScript library/tooling. |
| `python` | Python app/library. |
| `data` | ETL/data pipeline/notebook. |
| `devops` | Docker/Terraform/Kubernetes/CI/CD. |
| `mobile` | React Native/Flutter. |
| `docs` | Docs/manual/portal. |

## 3. Optional preseed setup

Không phải daily default. Dùng khi muốn tạo sẵn `.pi` files cho project/team:

```bash
bash /path/to/piagent/scripts/setup.sh /path/to/project \
  --project-only \
  --profile auto \
  --package-source git:github.com/Vt-mmm/piagent@v1.0.1 \
  --mcp-preset core \
  --subagents-preset safe
```

Nếu npm bins đã link:

```bash
piagent-init /path/to/project --profile auto
piagent-mcp --preset core --scope global --replace
piagent-subagents --preset safe
```

Khi command không có trên PATH, dùng script trực tiếp:

```bash
bash /path/to/piagent/scripts/init-project.sh /path/to/project --profile auto
bash /path/to/piagent/scripts/configure-mcp.sh --preset core --scope global --replace
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

## 4. Daily task workflow

### Requirement chưa rõ

```text
/discuss Cải tiến workflow onboarding cho team mới. Chưa implement, chỉ hỏi phần thiếu và đề xuất plan.
```

### Cần plan trước

```text
/plan Implement header sale menu hover stabilization. Include scope, files, verify commands, and risks.
```

### Task rõ, cho implement

```text
/task Implement header sale menu hover stabilization. Add component tests and run relevant verify.
```

### Scout/audit read-only

```text
/scout Scout payment FE mapping vs BE contract. Backend read-only. Do not edit source.
```

Use `/scout` cho payment/auth/data/contract mapping khi mục tiêu là chốt evidence trước, chưa sửa code.

### Task mới khi session đã nặng

Nếu `/piagent-usage` cho thấy context cao, hoặc Pi báo context overflow, dùng fresh workflow:

```text
/fresh-scout Scout payment FE mapping vs BE contract. Backend read-only. Do not edit source.
/fresh-task Implement <bounded task>.
/fresh-be-to-fe Implement FE support for <BE contract>. Backend read-only.
```

Các command này tự mở session mới và replay prompt workflow ngắn. Anh không cần tự chạy `pi --name ...` rồi paste lại.

Input guard của platform cũng tự collapse prompt có full `Mandatory flow` boilerplate. Quy tắc vận hành: user chỉ mô tả task; checklist nằm trong platform prompt/piagent tools.

### Gửi ảnh/screenshot trong chat

Nếu Pi/chat box không tạo native image attachment mà chỉ hiện local path kiểu `/var/folders/.../Ảnh màn hình ...png`, cứ để nguyên path trong prompt:

```text
/scout Scout UI issue from screenshot /var/folders/.../screenshot.png
```

Piagent guard sẽ xử lý trước khi model nhận input:

1. đọc local image path;
2. attach ảnh vào Pi input;
3. thay path trong prompt bằng marker `[image1]`;
4. báo `Piagent image input: attached [image1]`.

Hỗ trợ `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`. Giới hạn mặc định: tối đa 4 ảnh/input, 8 MB/ảnh.

Nếu ảnh quá lớn, lưu ảnh nhỏ hơn hoặc yêu cầu agent dùng Pi `read` tool trên file ảnh để Pi resize. Không cần copy ảnh vào repo và không commit screenshot tạm.

### BE spec lên FE

```text
/profile be-readonly-fe
/be-to-fe Implement frontend support from backend endpoint/spec <name>. Backend is read-only.
```

### Cải tiến platform

```text
/platform-improve Improve MCP setup docs and subagent command guidance for team usage.
```

### Review trước final

```text
/review current diff
```

### Commit và pull request

Git trong Pi Agent là capability + guard, không có namespace `/git-*`. Khi muốn gom việc hiện tại:

```text
/commit docs: update onboarding notes
/pr Add guarded git workflow
```

`/commit` inspect status/diff, stage đúng scope, verify phù hợp, rồi commit local; không push. `/pr` inspect branch/diff/commit rồi hỏi xác nhận trước khi `git push` hoặc tạo/cập nhật GitHub PR. Các lệnh stage rộng như `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/` cũng phải qua confirmation.

## 5. Control flow của một task chuẩn

Một source-changing task nên đi qua:

```text
intake
  -> profile/context
  -> task contract
  -> context manifest
  -> implementation
  -> verify command
  -> observed verify evidence
  -> trace
  -> final gate
  -> handoff
```

Các piagent tools nền:

| Tool | Vai trò |
|---|---|
| `piagent_context` | Đọc active profile, required context, verify commands, MCP/memory settings. |
| `piagent_context_index_status/search/record` | Kiểm tra/tìm/ghi context index advisory có citation. |
| `piagent_task_start` | Tạo task contract: scope, risk, acceptance criteria. |
| `piagent_context_record` | Ghi context manifest: file nào đã đọc và lý do. |
| `piagent_exec_policy_check` | Check shell command trước khi chạy lệnh rủi ro. |
| `piagent_context_budget` | Check file/context size để tránh nhồi context. |
| `piagent_tool_policy_check` | Check capability của tool/MCP. |
| `piagent_verify_record` | Chỉ ghi verify evidence nếu Pi đã quan sát bash result thật sau task start. |
| `piagent_trace_record` | Ghi outcome, changed files, notes. |
| `piagent_task_gate_check` | Check final gate trước khi báo DONE. |
| `piagent_usage_snapshot` | Snapshot session/model/context. |

Done đúng nghĩa:

- có task contract;
- có context manifest;
- verify command đã chạy thật;
- verify evidence khớp `task.verifyCommands`;
- trace outcome rõ;
- final gate pass hoặc ghi rõ blocked/partial.

## 6. Guardrails cần hiểu

Protected path mặc định:

```text
.git/**
**/auth.json
**/.env
**/.env.*
.pi/piagent-state/**
.pi/piagent-profile.json
```

Guard chặn:

- shell command chạm protected path;
- raw path-like access qua `read/write/edit/grep/find/ls`;
- custom/MCP tool có path-like string trỏ protected path;
- nested object/array/path URI;
- percent-encoded protected path;
- tool input quá sâu vượt inspection limit.

Broad `grep/find/ls` sweep được phép nếu không target trực tiếp protected path, nhưng output protected content/path metadata sẽ bị redact trước khi model thấy.

High-risk action phải human-gate:

- auth/OAuth/provider config;
- database migration;
- deploy/release/publish;
- destructive shell;
- external provider side effect/cost;
- production data;
- broad git operations.

## 7. Token, context, benchmark

### Trong Pi

```text
/task-preflight
/task-preflight compact
/piagent-usage
/session
```

`/task-preflight` cho biết task tiếp theo nên chạy trực tiếp, compact trước, hay mở fresh session. `compact` dùng khi muốn Pi nén session có hướng dẫn giữ lại decisions/open blockers/verify command.

`/piagent-usage` cho biết:

- session file;
- session id/name;
- model/thinking;
- live context usage;
- command lấy exact token/cost từ terminal khác.

Live context không phải billed tokens. Ví dụ `111k / 272k` là context đang giữ trong cửa sổ hiện tại, không phải tổng input/output/cost.

### Từ terminal khác

Nếu bin có trên PATH:

```bash
piagent-usage /path/to/project
```

Fallback:

```bash
bash /path/to/piagent/scripts/pi-session-stats.sh /path/to/project
```

Nếu biết session file:

```bash
bash /path/to/piagent/scripts/pi-session-stats.sh \
  /path/to/project \
  /Users/<user>/.pi/agent/sessions/<project-key>/<session>.jsonl
```

### Cách đọc số

| Field | Ý nghĩa |
|---|---|
| `input` | Fresh input tokens gửi vào model. |
| `output` | Tokens model sinh ra. |
| `cacheRead` | Tokens đọc từ prompt cache. Có thể rất lớn, không tương đương fresh input cost. |
| `cacheWrite` | Tokens ghi cache. |
| `total` | Tổng theo Pi stats. |
| `cost` | Cost Pi tính theo provider/model pricing metadata. |
| `contextUsage.percent` | Phần trăm context window đang dùng. |

### Khi nào compact hoặc tách session

| Context | Khuyến nghị |
|---|---|
| `< 50%` | Bình thường. |
| `50-75%` | Tránh đọc file lớn không cần thiết. |
| `> 75%` | Cân nhắc `/compact` trước task dài tiếp theo. |
| Task chuyển từ implement sang deploy monitor | Nên tách session mới hoặc compact. |
| Task đã xong nhưng CI cần follow lâu | Tách session monitor riêng để không kéo context cũ. |

Trong Pi:

```text
/compact
```

Sau compact, agent phải đọc lại context quan trọng trước khi sửa tiếp.

### Ghi benchmark

Không claim tiết kiệm token/cost nếu chưa có số liệu cùng scenario.

```bash
bash /path/to/piagent/scripts/quality-benchmark.sh /path/to/project --init

bash /path/to/piagent/scripts/quality-benchmark.sh /path/to/project --record \
  --scenario "ui-fix-with-ci-gate" \
  --surface pi \
  --result partial \
  --tokens 26323474 \
  --cost 18.33 \
  --verify "npm test / E2E / CI gate" \
  --notes "Implementation + branch push + main/test merge + CI monitor; deploy gate failed at shard 2."
```

Benchmark nên đặt theo scenario thật, ví dụ:

- `bounded-source-fix`;
- `be-spec-to-fe`;
- `ui-fix-with-ci-gate`;
- `platform-docs-update`;
- `deploy-monitor`.

Không benchmark theo số file changed đơn thuần.

## 8. Resume session khi tắt nhầm

### Cách nhanh nhất

Trong project:

```bash
cd /path/to/project
pi --continue
```

Hoặc mở selector:

```bash
pi --resume
```

Nếu biết session id hoặc file:

```bash
pi --session 019f7ad3-0ce3-77f3-b34d-72d8c37c5fb6
pi --session /Users/<user>/.pi/agent/sessions/<project-key>/<session>.jsonl
```

Fork một session cũ sang session mới:

```bash
pi --fork 019f7ad3-0ce3-77f3-b34d-72d8c37c5fb6
```

Đặt tên session ngay từ đầu để dễ tìm:

```bash
pi --name "V-Nexus header menu fix"
```

Trong Pi:

```text
/session
/piagent-usage
```

`/piagent-usage` sẽ in session id và session file. Ghi lại khi task dài hoặc có nhiều pane Herdr.

### Khi nào nên resume, continue, fork

| Nhu cầu | Dùng |
|---|---|
| Tắt nhầm, muốn quay lại phiên gần nhất | `pi --continue` |
| Không nhớ phiên nào | `pi --resume` |
| Có session id/file từ `/piagent-usage` | `pi --session <id-or-file>` |
| Muốn thử hướng mới nhưng giữ history cũ | `pi --fork <id-or-file>` |
| Muốn session mới sạch sau task quá dài | `pi --name "<new task>"` |

## 9. MCP setup và cách dùng

### Preset

| Preset | Includes | Khi dùng |
|---|---|---|
| `minimal` | none | Muốn giữ surface nhỏ. |
| `docs` | Context7 | Cần docs framework/library mới. |
| `browser` | Chrome DevTools, Playwright | FE/browser/runtime inspection. |
| `github` | GitHub MCP | Issue/PR/repo/release workflow. |
| `design` | Figma remote | Design-to-code qua Figma OAuth. |
| `design-local` | Figma desktop | Figma Dev Mode local selection. |
| `web` | Context7 + browser tools | Web/FE default. |
| `core` | Context7, Chrome DevTools, GitHub | Team baseline. |
| `popular` | core + Playwright + Figma remote | Full dev baseline. |
| `all` | popular + Figma desktop | Cần cả remote + local design. |

### Cấu hình global

```bash
piagent-mcp --preset core --scope global --replace
piagent-mcp --preset popular --scope global --replace
piagent-mcp --list
```

Fallback:

```bash
bash /path/to/piagent/scripts/configure-mcp.sh --preset core --scope global --replace
```

### Cấu hình project

```bash
piagent-mcp --preset design --scope project --project /path/to/project
```

Fallback:

```bash
bash /path/to/piagent/scripts/configure-mcp.sh \
  --preset design \
  --scope project \
  --project /path/to/project
```

### Trong Pi

```text
/mcp
/mcp setup
/mcp tools
/mcp reconnect
/mcp-auth figma
```

### Config layers

| File | Scope | Ghi chú |
|---|---|---|
| `~/.config/mcp/mcp.json` | Shared global | Baseline cho nhiều agent/client. |
| `~/.pi/agent/mcp.json` | Pi global override | Chỉ khi Pi cần override riêng. |
| `.mcp.json` | Project shared | Có thể commit nếu không chứa secret. |
| `.pi/mcp.json` | Pi project override | Pi-specific; không nhét secret. |

Quy ước:

- `directTools: false` mặc định để giảm tool explosion/token.
- Dùng proxy `mcp(...)` qua `pi-mcp-adapter`.
- Secret để trong environment variable, không commit.

Ví dụ:

```bash
export CONTEXT7_API_KEY=ctx7sk_...
export GITHUB_PERSONAL_ACCESS_TOKEN=<github-token>
```

## 10. Subagents và multi-agent

### Setup

```bash
piagent-subagents --preset safe
```

Fallback:

```bash
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

Check trong Pi:

```text
/subagents-doctor
/subagents-models
/subagents
/subagents-fleet
/subagent-cost
```

### Safe preset

Default safe config:

- `toolDescriptionMode: compact`;
- `asyncByDefault: false`;
- `parallel.concurrency: 3`;
- `parallel.maxTasks: 6`;
- `maxSubagentDepth: 1`;
- `maxSubagentSpawnsPerSession: 32`;
- scheduled runs off;
- worktree base stable;
- intercom bridge on.

### Piagent agents

| Agent | Role | Write policy |
|---|---|---|
| `piagent-scout` | Map source/spec read-only. | No write. |
| `piagent-planner` | Plan implementation + verify gates. | No write. |
| `piagent-worker` | Implement approved bounded task. | Write in scope. |
| `piagent-reviewer` | Review diff/tests/scope. | Review-first. |
| `piagent-oracle` | Risk/architecture challenge. | No write. |

### Auto-delegation

Với `/task`, `/be-to-fe`, `/platform-improve`, `/plan`, `/review`, parent agent dùng solo-first orchestration: lập task tree/review lenses trước, rồi chỉ spawn subagent khi có phần việc độc lập và đáng token.

Kiểm tra nhanh policy:

```text
/piagent-orchestration
```

Không cần tự gọi `/run` cho task bình thường. Chỉ dùng `/run` khi muốn ép rõ role hoặc debug.

Parent nên spawn khi:

- cần scout codebase rộng;
- cần map BE/spec read-only trước khi FE implement;
- cần reviewer độc lập;
- cần context builder cho task lớn;
- cần oracle/risk challenge.

Không nên spawn khi:

- task nhỏ, một file;
- requirement chưa rõ;
- nhiều writer cùng sửa chung vùng;
- repo dirty chưa rõ của ai;
- đang cần quyết định user/product.

### Slash examples

```text
/run piagent-scout "Map listing page state flow. Read-only."
/run piagent-planner "Plan FE implementation from this backend contract."
/run piagent-worker "Implement the approved plan. Do not touch backend."
/run piagent-reviewer "Review current diff for correctness, tests, and scope drift."
/run piagent-oracle "Challenge this architecture decision before implementation."
```

Parallel read-only review:

```text
/parallel piagent-reviewer "Review correctness" -> piagent-reviewer "Review tests" -> piagent-reviewer "Review scope drift"
```

Chain:

```text
/chain piagent-scout "Scout target area" -> piagent-planner "Plan from {previous}" -> piagent-worker "Implement from {previous}" -> piagent-reviewer "Review implementation"
```

Background:

```text
/run piagent-scout "Map this module" --bg
/subagents-fleet
```

### Tool syntax khi cần chính xác

```text
subagent({ agent: "piagent-scout", task: "Map auth flow. Read-only.", context: "fresh" })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "<run-id>", view: "transcript" })
subagent({ action: "steer", id: "<run-id>", message: "Focus only on tests." })
subagent({ action: "stop", id: "<run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "Continue after this clarification." })
```

Output file mode để giảm parent context:

```text
/run scout[output=context.md,outputMode=file-only] "Map target area"
/chain scout[output=context.md,as=context] "Scan" -> planner[reads=context.md] "Plan from {outputs.context}"
```

### Worktree isolation

Chỉ bật writer parallel/worktree khi:

- repo là Git repo;
- worktree clean;
- write sets không overlap;
- parent review/merge outputs.

Default solo/internal: một `piagent-worker`, parallel read-only reviewers/scouts.

### Watchdog

Watchdog là optional adversarial reviewer ở cuối turn, không bật mặc định vì tốn thêm model pass.

```text
/subagents-watchdog recommend-model
/subagents-watchdog session model recommended
/subagents-watchdog on
```

## 11. Command cheat sheet

### Terminal

| Command | Dùng để |
|---|---|
| `npm install -g --ignore-scripts @piagent/platform@1.0.1` | Cài terminal helper `piagent-*` từ release tag hiện tại. |
| `pi install git:github.com/Vt-mmm/piagent@v1.0.1` | Install pinned release cho reproducible team setup. |
| `pi install git:github.com/Vt-mmm/piagent` | Install latest platform package cho máy cá nhân/sandbox. |
| Cài exact Pi host của release, rồi `npm install -g --ignore-scripts @piagent/platform@X.Y.Z` và `piagent-install --stable` | Full update: đồng bộ host, terminal helper và Pi package. v1.0.1 yêu cầu Pi `0.81.1`. |
| Cài exact Pi host ghi trong release cũ, rồi helper `vPREVIOUS` và `piagent-install --stable` | Full rollback; đánh giá lại dependency findings của host cũ trước khi hạ version. |
| `piagent-uninstall` | Báo cáo sẽ gỡ những gì. Dry run, không đụng gì. |
| `piagent-uninstall --apply` | Gỡ Pi package của platform khỏi Pi settings global. |
| `piagent-uninstall --apply --with-addons --with-host` | Gỡ thêm add-on đã pin và Pi host. |
| `piagent-uninstall --apply --project <path>` | Gỡ thêm profile, lock và `piagent-state/` của project. Không đụng credential, trust, session, todo, `.pi/memory/`. |
| `piagent-install --stable --dry-run` | Preview Pi package matching với helper hiện tại; stable resolve tag → commit SHA. |
| `piagent-install --stable` | Apply Pi package matching với helper hiện tại bằng resolved commit SHA. |
| `piagent-install --version vX.Y.Z --resolve-tag` | Chỉ đổi Pi package; terminal helper giữ nguyên version. |
| `piagent-install --version vX.Y.Z` | Chỉ đổi Pi package theo exact tag literal khi cần giữ behavior cũ. |
| `piagent-install --dev` | Dùng moving source cho máy cá nhân/sandbox. |
| `piagent-doctor /path/to/project --strict-share` | Kiểm profile/package/runtime surface. Dùng bắt buộc khi rollout trên macOS Intel, Linux ARM64 hoặc môi trường chưa nằm trong release gate. |
| `pi update --extensions` | Refresh package đã cài; với pinned tag/commit, muốn nâng version thì install lại bằng ref mới. |
| `pi list --approve` | Kiểm package/resources đã load. |
| `piagent-auto` | Mở Pi với project trust `--approve` cho lần chạy hiện tại; guard vẫn bật. |
| `piagent-auto --read-only -p "<task>"` | Auto-run read-only scout với tool set `read,grep,find,ls`. |
| `piagent-auto --full-access -p "<task>"` | Auto-run trusted full-access cho repo đã kiểm soát; protected paths/redaction/human gates vẫn bật. |
| `pi --continue` | Continue session gần nhất. |
| `pi --resume` | Chọn session để resume. |
| `pi --session <id-or-file>` | Resume session cụ thể. |
| `pi --fork <id-or-file>` | Fork session cũ sang session mới. |
| `pi --name "<name>"` | Đặt tên session. |
| `pi --tools read,grep,find,ls -p "Review src"` | Read-only one-shot. |
| `piagent-usage /path/to/project` | Exact token/cost stats. |
| `piagent-mcp --preset core --scope global --replace` | Setup or update the governed MCP baseline. |
| `piagent-subagents --preset safe` | Setup subagents baseline. |
| `bash scripts/verify-local.sh` | Verify platform repo. |
| `bash scripts/team-doctor.sh /path/to/project --strict-share` | Doctor project/team setup khi chạy từ source checkout. |
| `bash scripts/quality-benchmark.sh /path/to/project --record ...` | Ghi benchmark. |

### Trong Pi

| Command | Dùng để |
|---|---|
| `/login` | Login provider. |
| `/model` / `Ctrl+L` | Chọn model. |
| `Ctrl+P` | Cycle scoped models. |
| `Shift+Tab` | Cycle thinking level. |
| `/piagent-commands` | Xem command help theo ngữ cảnh. |
| `/permission-status` | Xem permission profile hiện tại. |
| `/read-only` | Chuyển session sang read-only. |
| `/workspace-write` | Chuyển session sang write chuẩn. |
| `/full-access` | Bật trusted full-access cho session hiện tại. |
| `/full-access <task>` | Bật trusted full-access rồi gửi `<task>` cho agent làm tiếp. |
| `/onboard-project` | Onboard/read project lần đầu. |
| `/context-index` | Xem compact context index, không gọi model follow-up. |
| `/context-index search <keyword>` | Tìm node/edge/citation trong context index. |
| `/profile` | Xem profile ngắn, không gọi model follow-up. |
| `/profile list` | Xem profile có sẵn dạng compact. |
| `/profile <profile>` | Áp profile ngay và cập nhật lock. |
| `/profile auto` | Detect và áp profile recommend ngay. |
| `/profile setup` | Chọn profile + tech bằng option, không chat dài. |
| `/profile tech` | Xem tech stack và Context7 status hiện tại. |
| `/profile tech setup [profile]` | Chọn tech theo role; fullstack chọn FE/BE/DB. |
| `/profile tech apply ...` | Apply profile/tech bằng một lệnh deterministic. |
| `/memory-policy` | Xem memory policy. |
| `/task-preflight` | Check context trước task lớn/risk cao. |
| `/task-preflight compact` | Compact session có hướng dẫn. |
| `/piagent-usage` | Snapshot context/session. |
| `/session` | Pi native session stats/info. |
| `/compact` | Nén context. |
| `/mcp` / `/mcp tools` | Check MCP. |
| `/subagents-doctor` | Check subagent setup. |
| `/subagents-fleet` | Follow child sessions. |
| `/subagent-cost` | Check subagent token/cost. |
| `/discuss` | Làm rõ, không sửa. |
| `/plan` | Lập plan. |
| `/scout` | Scout/audit read-only. |
| `/fresh-scout` | Tự mở session mới rồi chạy `/scout`. |
| `/fresh-task` | Tự mở session mới rồi chạy `/task`. |
| `/fresh-be-to-fe` | Tự mở session mới rồi chạy `/be-to-fe`. |
| `/task` | Implement task. |
| `/be-to-fe` | BE read-only, FE implementation. |
| `/platform-improve` | Cải tiến platform. |
| `/review` | Review diff/source. |
| `/commit [message/scope]` | Commit local qua workflow có guard. |
| `/pr [title/request]` | Chuẩn bị PR, hỏi trước khi push/GitHub write. |

## 12. Troubleshooting

### Không thấy command platform

```bash
pi list --approve
piagent-install --stable --dry-run
piagent-install --stable
```

Mở lại Pi session sau khi install.

### `piagent-*` không có trên PATH

Cài lại terminal helper đúng release rồi kiểm tra `PATH`:

```bash
npm install -g --ignore-scripts @piagent/platform@1.0.1
command -v piagent-install
```

Nếu đang làm việc từ source checkout, có thể dùng script trực tiếp:

```bash
bash /path/to/piagent/scripts/pi-session-stats.sh /path/to/project
bash /path/to/piagent/scripts/configure-mcp.sh --preset core --scope global --replace
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

### MCP không connect

```text
/mcp
/mcp setup
/mcp reconnect
/mcp tools
```

Kiểm config:

```bash
piagent-mcp --list
```

Kiểm env token mà không in giá trị secret:

```bash
for name in CONTEXT7_API_KEY GITHUB_PERSONAL_ACCESS_TOKEN FIGMA_ACCESS_TOKEN; do
  test -n "${!name:-}" && echo "$name=set" || echo "$name=missing"
done
```

Không paste token vào chat hoặc commit config.

### Subagent không chạy

```text
/subagents-doctor
/subagents-models
/subagents-fleet
```

Re-apply config:

```bash
piagent-subagents --preset safe
```

Fallback:

```bash
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

### Context quá cao

```text
/piagent-usage
/session
```

Nếu `contextUsage.percent > 75%`:

```text
/compact
```

Hoặc mở session mới:

```bash
pi --name "Deploy monitor"
```

### Resume không đúng session

Lấy session id/file từ `/piagent-usage`, rồi:

```bash
pi --session <session-id>
pi --session /absolute/path/to/session.jsonl
```

### Verify evidence không được nhận

Nguyên nhân thường gặp:

- agent ghi `piagent_verify_record` nhưng chưa chạy bash verify thật;
- command string không exact-match `task.verifyCommands`;
- verify chạy trước `task.createdAt`;
- verify chạy ở cwd khác;
- subagent chạy nhưng parent chưa thấy persisted ledger đúng cwd.

Fix:

```text
Run the exact verify command from task.verifyCommands in the project cwd, then record verify evidence again.
```

## 13. Không commit

Không commit:

```text
.env
**/auth.json
.pi/piagent-state/
.pi/benchmarks/
.pi/memory/local/
.pi/memory/state.sqlite
.pi/sessions/
.pi/todos/
.pi/auth.json
token/API key/OAuth files
```

Commit được nếu không chứa secret và team muốn share:

```text
AGENTS.md
.mcp.json
.pi/piagent-profile.json
.pi/project-context.md
```

Memory shared (`.pi/memory/MEMORY.md`) chỉ commit nếu team explicit opt-in sau review/redaction.

## 14. Tài liệu chi tiết

- Quickstart: `docs/quickstart-vietnamese.md`
- Command reference: `docs/command-reference-vietnamese.md`
- Team onboarding: `docs/team-onboarding.md`
- MCP and tools: `docs/mcp-and-tools.md`
- Subagents: `docs/subagents-and-multiagent.md`
- Usage observability: `docs/usage-observability.md`
- Model options: `docs/model-options.md`
- Memory policy: `docs/memory-policy.md`
- Task contract: `docs/task-implementation-contract.md`
- Runtime policy: `docs/runtime-policy-design.md`
- Quality benchmark: `docs/quality-benchmark.md`

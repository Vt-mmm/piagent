# Pi Agent Platform - Operator manual tiếng Việt
<!-- language: vi; english-index: docs-site/content/en/index.html -->

## Mục tiêu

Tài liệu này là hướng dẫn vận hành end-to-end cho anh/team:

```bash
cd /path/to/project
pi
```

Từ đó Pi có thể login provider, chọn model, onboard project, chạy task, kiểm soát tool, theo dõi token, resume session, dùng MCP, và dùng subagent khi task đủ lớn.

Runtime team nên pin release tag hoặc commit đã review. Latest chỉ dùng cho máy cá nhân/sandbox khi chấp nhận cập nhật nhanh.

Support matrix release hiện tại: macOS Apple Silicon + Bash và Linux x64 + Bash đã được verify; macOS Intel + Bash và Linux ARM64 + Bash là supported target cần chạy `piagent-doctor` + smoke test trước khi rollout rộng; native Windows chưa phải target rollout team; WSL2 experimental/chưa release-gate. Node.js tối thiểu là `22.19.0`, Pi Coding Agent là `0.84.1`.

```bash
node --version  # >= 22.19.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
npm install -g --ignore-scripts @piagent/platform@1.10.0
piagent-install --stable --dry-run
piagent-install --stable
```

Khi seed `.pi/settings.json` cho team/repo cần audit lặp lại, giữ package source dạng pinned tag như `git:github.com/Vt-mmm/piagent@v1.10.0`. Máy cá nhân có thể dùng `git:github.com/Vt-mmm/piagent` để theo latest.

Nếu đang ở source checkout của platform, dùng helper theo channel để preview trước khi đổi:

```bash
bash scripts/install-global.sh --stable --dry-run
bash scripts/install-global.sh --stable
```

`--stable` sẽ resolve tag release hiện tại thành commit SHA, in ra `tag`, `resolvedCommit`, `source`, rồi mới gọi `pi install`. `currentRelease` là version của npm-global helper đang chạy. Nếu không resolve được tag thì fail-closed.

Full update phải đồng bộ exact Pi host trước, rồi npm-global helper và Pi package matching:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
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
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
npm install -g --ignore-scripts @piagent/platform@1.10.0
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

Chọn provider/account cho họ model muốn dùng: OpenAI (model Codex) hoặc Anthropic (model Claude). Credential nằm trong Pi user dir, không nằm trong repo và không được commit.

Browser login của OpenAI có hai chỗ trông như treo. Cả hai là lỗi Pi host, không phải platform, và còn nguyên ở `0.82.0` lẫn `0.82.1`.

Paste xong callback URL mà màn hình đứng im: **bấm Enter**. Ô nhập callback chỉ hiện hint `to cancel`, không hiện `to submit`, nên nó đang chờ submit chứ không đơ.

Đã Enter rồi mà terminal khoá luôn, Esc không thoát được: Pi lưu credential xong mới refresh model catalog từ `pi.dev`, và request đó không có timeout. Firewall hoặc proxy giữ connection im lặng thì `/login` chờ mãi. Credential thực tế đã lưu rồi, nên mở tab mới vẫn dùng được. Login bằng đường này để tránh hẳn:

```bash
pi --offline
```

Rồi `/login` → browser → paste → Enter. `--offline` chỉ chặn bước refresh catalog gây treo, OAuth vẫn chạy. Xong thì thoát và mở `pi` bình thường.

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
/mcp
/subagents-doctor
/profile setup
/memory
```

Từ bản 1.9.0 không còn `/onboard`. Nhờ agent onboard bằng lời thường:

```text
Đọc project này (chỉ đọc) và ghi lại project context.
```

Agent sẽ:

1. đọc repo theo context budget;
2. đề xuất profile phù hợp (`/profile setup` để chọn profile/tech bằng select);
3. ghi `.pi/project-context.md` và `.pi/context-index.json` bằng tool onboarding của Piagent.

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

Nếu `.pi/project-context.md` còn `Generated: not yet`, hoặc `/context index` báo index đang pending/stale, nên nhờ agent onboard lại trước khi giao việc implement lớn.

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
  --package-source git:github.com/Vt-mmm/piagent@v1.10.0 \
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
node /path/to/piagent/scripts/mcp-manage.mjs --preset core --scope global --replace
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

## 4. Daily task workflow

Từ bản 1.9.0, mọi việc được yêu cầu bằng lời thường; không còn `/workflow`,
`/task`, `/scout`, `/fresh` và không có task contract. Nói rõ ý định (chỉ đọc,
chỉ lập kế hoạch, hay cho sửa) ngay trong câu yêu cầu.

### Requirement chưa rõ

```text
Cải tiến onboarding cho team mới. Chưa implement, chỉ hỏi phần còn thiếu và đề xuất plan.
```

### Cần plan trước

```text
Lập plan cho header sale menu hover stabilization: scope, file, lệnh verify và rủi ro. Chưa sửa code.
```

### Task rõ, cho implement

```text
Implement header sale menu hover stabilization. Thêm component test và chạy verify liên quan.
```

### Scout/audit read-only

```text
Scout payment FE mapping vs BE contract. Backend read-only. Không sửa source.
```

Dùng yêu cầu scout cho payment/auth/data/contract mapping khi mục tiêu là chốt evidence trước, chưa sửa code. Muốn chắc chắn không có lệnh ghi nào chạy, đổi session sang `/permission read-only`.

### Task mới khi session đã nặng

Nếu `/usage` cho thấy context cao, hoặc Pi báo context overflow, mở session mới
bằng `/new` (hoặc `/compact`) rồi nói lại yêu cầu. Không cần paste checklist:
guard tự áp policy cho từng tool call.

### Gửi ảnh/screenshot trong chat

Nếu Pi/chat box không tạo native image attachment mà chỉ hiện local path, dùng
ảnh nằm trong project hoặc một folder đã cấp qua `additionalReadRoots`. Ví dụ
lưu screenshot vào `~/Documents/team-screenshots` rồi thêm folder đó vào profile:

```json
{
  "additionalReadRoots": ["~/Documents/team-screenshots"]
}
```

Sau đó để nguyên path trong prompt:

```text
Scout lỗi UI trong ảnh ~/Documents/team-screenshots/screenshot.png. Chỉ đọc.
```

Piagent guard sẽ xử lý trước khi model nhận input:

1. đọc local image path;
2. attach ảnh vào Pi input;
3. thay path trong prompt bằng marker `[image1]`;
4. báo `Piagent image input: attached [image1]`.

Hỗ trợ `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`. Giới hạn mặc định:
tối đa 4 ảnh/input, 8 MB/ảnh. Guard resolve target thật trước khi đọc, giữ
`protectedPaths` và filesystem read scope, đồng thời kiểm tra bytes đúng định
dạng ảnh; đổi tên file text thành `.png` không đủ để attach.

Nếu ảnh quá lớn, lưu ảnh nhỏ hơn hoặc yêu cầu agent dùng Pi `read` tool trên file
ảnh để Pi resize. Không cần commit screenshot tạm. Với path ngoài project chưa
được cấp root, file không được đọc hoặc attach; chuỗi path vẫn chỉ là text trong
prompt.

### BE spec lên FE

```text
/profile be-readonly-fe
Implement frontend support from backend endpoint/spec <name>. Backend is read-only.
```

### Cải tiến platform

```text
Improve MCP setup docs and subagent command guidance for team usage.
```

### Review trước final

```text
Review diff hiện tại: correctness, test còn thiếu, scope drift. Chỉ đọc.
```

### Commit và pull request

Git trong Pi Agent là capability + guard, không có namespace `/git-*`. Khi muốn gom việc hiện tại:

```text
Commit các file docs vừa sửa với message "docs: update onboarding notes". Không push.
Tạo draft PR cho branch này, title "Add guarded git notes".
```

Guard hỏi xác nhận trước khi `git push` hoặc tạo/cập nhật GitHub PR. Các lệnh stage rộng như `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/` cũng phải qua confirmation.

### Preflight, live status và receipt

Trước task hoặc khi cần kiểm tra deterministic state, dùng:

```text
/task-preflight
/piagent-status
/piagent-inspector
/usage efficiency
```

Preflight phân biệt rõ mode `shadow`, `assist`, `enforce`; runtime fact chưa có
được ghi là `unknown`. Nó hiển thị intent/risk/scope, model và effort provenance,
solver route, phase, context/tool/helper budget, backend, approval và blocker.
Read-only/plan/review không bao giờ hiện implementation authorization. Dòng
`host execution is not a sandbox` là boundary thật: Piagent policy giảm lỗi thao
tác nhưng không cô lập code khỏi account của operator.

`/piagent-status` đọc state đã lưu (profile, guard, runtime, model), không hỏi
model nhớ lại. Từ bản 1.9.0 session không còn Task Contract, checkpoint hay
completion receipt; bản ghi task của các bản trước chỉ còn để xem lịch sử. Tắt từng lớp bằng `PIAGENT_SOLVER_MODE=off`,
`PIAGENT_PHASE_TOOLS=off`, `PIAGENT_AUTO_RECOVERY=off`, hoặc
`PIAGENT_HELPERS_MODE=off`. Hai lớp semantic có kill switch độc lập:
`PIAGENT_ACCEPTANCE_ASSURANCE=off` tắt assurance và semantic repair phụ thuộc,
còn `PIAGENT_SEMANTIC_REPAIR=off` chỉ tắt repair/review. Các biến này chỉ được
hạ authority, không được dùng để nâng mode ngoài profile đã pin; state cũ được
giữ để có thể tạo attempt mới có provenance rõ ràng.

`/piagent-inspector` là một namespace read-only, không sinh thêm command rời.
Gõ không tham số để chọn `summary`, `files`, `commands`, `security`, `context`
hoặc `toggle`. Panel bốn dòng tự hiện sát phía trên footer native từ lúc mở session:
việc hiện tại; file/test đã đổi, `+/-`, command pass/fail/block, safety và
context budget. Nó dùng extension-status API nên không thay footer native của
Pi và không thêm bước bắt buộc nào. Dòng status dùng working-tree status; token
theo từng built-in tool luôn unavailable vì Pi chỉ cung cấp usage exact theo
response/turn.

Known unsupported/unpromoted surfaces của candidate hiện tại: parent routing
đã có `off|shadow|recommend|auto`, nhưng extension `auto` fail-closed về
recommend; chỉ `piagent-route --execute --yes` là explicit prelaunch boundary.
Authenticated G1/G2 chưa chạy nên default vẫn `off`. Helper không tự đổi parent model; automatic worker và
multi-writer luôn off; helper `on` chưa phải default; docker/devcontainer/
sandbox không chạy nếu chưa có adapter và không âm thầm fallback; native Windows
không nằm trong rollout matrix. Local scripted pilot không thay thế năm người
độc lập, và same-process receipt không thay thế security audit.

Kiểm tra decision trước khi chạy:

```bash
piagent-route --prompt "Fix src/parser.ts and run npm test" --json
```

Chỉ khi muốn router thực sự mở một fresh Pi process mới dùng:

```bash
piagent-route --prompt-file /path/to/task.txt --execute --yes -- --approve
```

Lệnh này dùng authenticated `pi --list-models`, không đọc credential store,
không ghi raw task vào route sidecar, giữ hard pin, và từ chối task bị blocked.

## 5. Control flow của một lượt sửa code

Từ bản 1.9.0 một yêu cầu sửa code đi qua:

```text
yêu cầu bằng lời thường
  -> profile/context của project
  -> agent đọc file đích và test gần nhất
  -> sửa bằng read/edit/write/apply_patch/bash
     (guard kiểm tra từng tool call: protected path, read-only path, quyền,
      context budget, edit trên bản đọc cũ, xác nhận destructive/external)
  -> chạy lệnh check của project
  -> báo file đã đổi, kết quả verify, rủi ro còn lại
```

Không còn task contract, scope khai báo, work plan, completion gate hay receipt.
Trong khung công ty (`piagent studio`), các bước plan/check/review mỗi lượt do
Harness của team trong Studio quy định; xem [nghiệm thu local](managed-local-acceptance.md).

Các Piagent tools còn lại là bề mặt operator/diagnostics, không phải checklist phải gọi mỗi lượt:

| Tool | Vai trò |
|---|---|
| `piagent_context` | Đọc active profile, required context, verify commands, MCP/memory settings. |
| `piagent_context_index_status/search/record` | Kiểm tra/tìm/ghi context index advisory có citation. |
| `piagent_exec_policy_check` | Diagnostics: giải thích shell-policy verdict; runtime vẫn check mọi call. |
| `piagent_context_budget` | Diagnostics: xem budget của file/context lớn. |
| `piagent_tool_policy_check` | Diagnostics: xem capability verdict của tool/MCP. |
| `piagent_document_read` | Đọc tài liệu ngoài project trong `additionalReadRoots` (chỉ đọc). |
| `piagent_source_checkout` | Chuẩn bị repo ngoài để đọc (read-only cho session). |
| `piagent_project_onboarding_record` | Ghi `.pi/project-context.md` sau khi agent đọc project. |
| `piagent_usage_snapshot` | Snapshot session/model/context. |

Các tool `piagent_task_start`, `piagent_task_progress`, `piagent_context_record`,
`piagent_verify_record`, `piagent_trace_record` và `piagent_task_gate_check` đã bỏ
từ bản 1.9.0.

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
/usage
/context preflight
/context compact
/usage logs
/session
```

`/context preflight` cho biết task tiếp theo nên chạy trực tiếp, compact trước, hay mở fresh session. `/context compact` dùng khi muốn Pi nén session có hướng dẫn giữ lại decisions/open blockers/verify command. Alias `/context preflight` và `/logs` vẫn chạy.

`/usage` cho biết:

- session file;
- session id/name;
- model/thinking;
- live context usage;
- command lấy exact token/cost từ terminal khác.

Live context không phải billed tokens. Ví dụ `111k / 272k` là context đang giữ trong cửa sổ hiện tại, không phải tổng input/output/cost.

### Log output gọn

Piagent giữ nguyên output nhỏ. Khi `bash/grep/find/ls` hoặc tool result khác trả output quá dài, guard sẽ:

- redact secret/protected content trước;
- chỉ trả preview ngắn vào Pi TUI gồm head, các dòng lỗi/cảnh báo đáng chú ý, và tail;
- ghi capture local vào `.pi/piagent-state/tool-results/YYYY-MM-DD/*.log`;
- ghi index `.pi/piagent-state/tool-results/index.jsonl` để Agent Watch/report đọc theo session/tool.

Trong Pi, chạy `/logs` để xem policy compact và các capture mới nhất. Không paste full test/build log vào chat trừ khi user thật sự cần một đoạn cụ thể; dùng command targeted hoặc đọc capture/report ở ngoài Pi để debug sâu.

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

Để xem tổng usage lịch sử trên máy, kể cả session đã end:

```bash
piagent-usage --history /path/to/project --days 7
piagent-usage --history --all-projects --days 7 --csv
piagent-usage --history --all-projects --since 2026-07-20 --until 2026-07-26 --json
```

History mode đọc trực tiếp `~/.pi/agent/sessions/**/*.jsonl`. Mặc định có tính cả subagent session files vì đó là usage thật của máy; thêm `--no-subagents` nếu chỉ muốn parent/main sessions.

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
| `> 75%` | Cân nhắc `/context compact` trước task dài tiếp theo. |
| Task chuyển từ implement sang deploy monitor | Nên tách session mới hoặc compact. |
| Task đã xong nhưng CI cần follow lâu | Tách session monitor riêng để không kéo context cũ. |

Trong Pi:

```text
/context compact
```

Sau compact, agent phải đọc lại context quan trọng trước khi sửa tiếp.

### Ghi benchmark

Không claim tiết kiệm token/cost nếu chưa có số liệu cùng scenario.

```bash
piagent-benchmark --dry-run
piagent-benchmark
piagent-benchmark --production --dry-run
```

Lệnh mặc định tự chạy 4 scenario trên Piagent và controlled `codex-cli` bằng
Luna/medium, mỗi bên 3 lần; token,
cost, model và thinking được đọc từ Pi session thay vì nhập tay. Runner chỉ cho
phép kết luận tiết kiệm token khi safety đạt `10/10` và các gate quality,
reliability, workflow của suite đều pass. Production yêu cầu các điểm tổng hợp
ít nhất `9.5/10`, đồng thời từng task và từng category/profile/lifecycle/
difficulty band phải lớn hơn `9.5`; quality không giảm và paired usage cùng
model phải vượt confidence gate.

Lệnh không flag là smoke suite 24 session. Khi chốt thay đổi lớn về harness,
model hoặc token policy, dùng `--production`: 18 scenario family, ba generated
variant, hai surface, tổng 108 session; production gate chấm riêng sáu domain,
profile/lifecycle/difficulty và cận trên 95% của paired token ratio. Seed/oracle
động không đi vào agent workspace; root seed chỉ nằm trong private report để
tái lập bằng `--seed`.

Production/deep runner mặc định không retry và release gate yêu cầu đúng zero
retry cùng zero unknown provider-attempt usage. Override retry chỉ dùng để chẩn
đoán recovery và sẽ làm claim fail. Timeout hoặc task đã tiêu token rồi fail vẫn
là reliability failure thật. Report hiện số retry và giữ chi tiết local trong
`infrastructure-attempts.jsonl`. Dùng `--scenarios <id,id> --repeats 1` để debug
rubric; subset không thể vượt production release gate.

So sánh trực tiếp với surface `codex-cli` đã đăng nhập:

```bash
piagent-benchmark \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment candidate
```

Chế độ mặc định là `controlled`: Codex chạy ephemeral, chỉ được ghi trong
workspace benchmark, dùng `CODEX_HOME` tạm mới cho từng session/retry để loại global `AGENTS.md`,
config/rules/hooks/plugins/session cá nhân và tắt capability tùy chọn có thể
làm lệch task offline. Credential hiện có chỉ được nối bằng symlink `auth.json`,
không bị runner đọc hay sao chép. `--codex-mode native` đo cấu hình Codex thật
của operator, gồm global instruction/hooks/MCP/plugins, nên chỉ dùng như report UX bổ sung. Codex OAuth
không trả currency cost trong JSONL; report để `n/a`, còn fresh token được tính
bằng `(input_tokens - cached_input_tokens) + output_tokens`.

Để ghi thêm scenario thật ngoài automatic suite, dùng chế độ legacy:

```bash
piagent-benchmark /path/to/project --record \
  --scenario "ui-fix-with-ci-gate" \
  --surface pi \
  --result partial \
  --tokens 26323474 \
  --cost 18.33 \
  --verify "npm test / E2E / CI gate"
```

Scenario project-specific nên đặt theo công việc thật, ví dụ:

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

Đặt tên session ngay từ đầu để dễ tìm và để Agent Watch map đúng task/report:

```bash
pi --name "ABC-123 V-Nexus header menu fix"
```

Nếu đã vào Pi rồi mới nhớ cần đổi tên, dùng command ngắn trong Pi:

```text
/name ABC-123 V-Nexus header menu fix
```

Trong Pi:

```text
/session
/usage live
/usage
```

`/session` kiểm tra tên/id hiện tại. `/usage live` và `/usage` in session id/name và session file. Ghi lại khi task dài hoặc có nhiều pane Herdr. Alias `/setname` vẫn chạy nếu muốn gõ thật ngắn.

Nếu tắt terminal/app rồi mở lại:

```bash
cd /path/to/project
pi --continue
```

Nếu `--continue` không đúng phiên cần làm, mở selector bằng `pi --resume`, chọn theo session name đã đặt. Khi resume đúng session cũ, tên session vẫn là tên đã set; nếu cần chỉnh lại cho khớp task nội bộ thì chạy `/name <new name>` ngay trước khi làm tiếp.

Agent Watch/report map session bằng `sessionId` và Pi custom trace, không dựa
riêng vào tên; đổi tên bằng `/name` sẽ được ghi nhận. Nên mở session mới cho việc
mới để usage/prompt/change evidence không bị trộn.

### Khi nào nên resume, continue, fork

| Nhu cầu | Dùng |
|---|---|
| Tắt nhầm, muốn quay lại phiên gần nhất | `pi --continue` |
| Không nhớ phiên nào | `pi --resume` |
| Có session id/file từ `/usage` | `pi --session <id-or-file>` |
| Muốn thử hướng mới nhưng giữ history cũ | `pi --fork <id-or-file>` |
| Muốn đổi tên phiên đang mở | `/name <task/session name>` |
| Muốn session mới sạch sau task quá dài | `pi --name "<new task>"` |

## 9. MCP setup và cách dùng

### Preset

| Preset | Includes | Khi dùng |
|---|---|---|
| `minimal` | none | Muốn giữ surface nhỏ. |
| `docs` | Context7 | Cần docs framework/library mới. |
| `browser` | Chrome DevTools, Playwright | FE/browser/runtime inspection. |
| `github` | GitHub MCP | Issue/PR/repo/release workflow. |
| `design` | Figma desktop | Design-to-code qua Figma Dev Mode local. |
| `design-local` | Figma desktop | Alias tương thích cho preset local cũ. |
| `web` | Context7 + browser tools | Web/FE default. |
| `core` | Context7, Chrome DevTools, GitHub | Team baseline. |
| `popular` | core + Playwright + Figma desktop | Full dev baseline. |
| `all` | popular + Figma remote | Thêm remote cho client đã được Figma duyệt. |

### Cấu hình global

```bash
piagent-mcp --preset core --scope global --replace
piagent-mcp --preset popular --scope global --replace
piagent-mcp --list
```

Fallback:

```bash
node /path/to/piagent/scripts/mcp-manage.mjs --preset core --scope global --replace
```

### Cấu hình project

```bash
piagent-mcp --preset design --scope project --project /path/to/project
```

Fallback:

```bash
node /path/to/piagent/scripts/mcp-manage.mjs \
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
/mcp-auth <approved-remote-server>
```

`figma-desktop` không cần OAuth. Figma Remote chỉ chấp nhận client đã được duyệt trong Figma MCP Catalog.

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
- `parallel.concurrency: 1`;
- `parallel.maxTasks: 1`;
- `maxSubagentDepth: 1`;
- `maxSubagentSpawnsPerSession: 1`;
- scheduled runs off;
- worktree base stable;
- wait/intercom bridge off; builtin và worker disabled.

### Piagent agents

| Agent | Role | Write policy |
|---|---|---|
| `piagent-scout` | Map source/spec read-only. | No write. |
| `piagent-planner` | Plan implementation + verify gates. | No write. |
| `piagent-worker` | Compatibility metadata only; Piagent config disables it. | Không được dispatch. |
| `piagent-reviewer` | Review diff/tests/scope. | Review-first. |
| `piagent-oracle` | Risk/architecture challenge. | No write. |

### Auto-delegation

Với mọi yêu cầu (implement, plan, review…), parent agent tự suy luận và implement. Helper mặc định tắt. Khi operator bật rõ, runtime được dispatch tối đa hai helper read-only, context fresh (không inherit history, handoff tối đa 2.048 token). Ước tính tiết kiệm token chỉ là telemetry. Worker, retry và nested helper đều tắt.

Kiểm tra nhanh policy:

```text
/piagent-orchestration
```

Không cần tự gọi `/run` cho task bình thường. Chỉ dùng `/run` khi muốn ép rõ role hoặc debug.

Helper chỉ đủ điều kiện khi đồng thời:

- operator đã opt-in;
- tổng số helper của phiên chưa quá 2 và helper chỉ đọc;
- context chuyển giao fresh, tối đa 2.048 token và không inherit history.

Dự báo tiết kiệm token vẫn được ghi để theo dõi nhưng không còn là điều kiện (bounded-delegation-v2).

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
/run piagent-reviewer "Review current diff for correctness, tests, and scope drift."
/run piagent-oracle "Challenge this architecture decision before implementation."
```

`/parallel`, `/chain` và writer role là capability upstream của package `pi-subagents`, nhưng Piagent config chủ động chặn các surface đó để tránh nhân context và token.

Background:

```text
/subagents-fleet
```

### Tool syntax khi cần chính xác

```text
subagent({ agent: "piagent-scout", task: "Map auth flow. Read-only.", context: "fresh" })
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "<run-id>", view: "transcript" })
subagent({ action: "steer", id: "<run-id>", message: "Focus only on tests." })
subagent({ action: "stop", id: "<run-id>" })
```

Output file mode để giảm parent context:

```text
/run scout[output=context.md,outputMode=file-only] "Map target area"
```

### Worktree isolation

Piagent không bật writer parallel/worktree; parent là writer duy nhất.

Default: parent là writer duy nhất; không worker, không parallel helper.

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
| `npm install -g --ignore-scripts @piagent/platform@1.10.0` | Cài terminal helper `piagent-*` từ release tag hiện tại. |
| `pi install git:github.com/Vt-mmm/piagent@v1.10.0` | Install pinned release cho reproducible team setup. |
| `pi install git:github.com/Vt-mmm/piagent` | Install latest platform package cho máy cá nhân/sandbox. |
| Cài exact Pi host của release, rồi `npm install -g --ignore-scripts @piagent/platform@X.Y.Z` và `piagent-install --stable` | Full update: đồng bộ host, terminal helper và Pi package. Mỗi release pin một Pi host chính xác; lấy đúng version của release đang cài trong [release/install policy](release-install-policy.md). |
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
| `/setname <name>` | Đổi tên session đang mở, dùng cho Agent Watch/report. |
| `pi --tools read,grep,find,ls -p "Review src"` | Read-only one-shot. |
| `piagent-usage /path/to/project` | Exact token/cost stats của session mới nhất. |
| `piagent-usage --history /path/to/project --days 7` | Tổng usage lịch sử của project. |
| `piagent-usage --history --all-projects --days 7 --csv` | CSV report cuối tuần toàn máy. |
| `piagent-mcp --preset core --scope global --replace` | Setup or update the governed MCP baseline. |
| `piagent-subagents --preset safe` | Setup subagents baseline. |
| `bash scripts/verify-local.sh` | Verify platform repo. |
| `bash scripts/team-doctor.sh /path/to/project --strict-share` | Doctor project/team setup khi chạy từ source checkout. |
| `piagent-benchmark` | Chạy và chấm paired smoke benchmark 24 session. |
| `piagent-benchmark --dry-run` | Xem execution plan, không dùng model quota. |
| `piagent-benchmark --production --dry-run` | Xem production plan 108 session, không dùng model quota. |
| `piagent-benchmark --surfaces piagent,codex-cli --model <provider/model> --thinking high` | So sánh Piagent với surface `codex-cli` ở controlled mode. |
| `piagent-benchmark /path/to/project --record ...` | Legacy: ghi tay một scenario project-specific. |

### Trong Pi

| Command | Dùng để |
|---|---|
| `/login` | Login provider. |
| `/model` / `Ctrl+L` | Chọn model. |
| `Ctrl+P` | Cycle scoped models. |
| `Shift+Tab` | Cycle thinking level. |
| `/piagent-inspector` | Menu read-only cho diff/file test/line, command, safety và context; `toggle` ẩn/hiện panel bốn dòng trong session. |
| `/permission` | Menu permission status/read-only/workspace-write/full-access. |
| `/permission status` | Xem permission profile hiện tại. |
| `/permission read-only` | Chuyển session sang read-only. |
| `/permission workspace-write` | Chuyển session sang write chuẩn. |
| `/permission full-access` | Bật trusted full-access cho session hiện tại. |
| `/permission full-access <task>` | Bật trusted full-access rồi gửi `<task>` cho agent làm tiếp. |
| `/context` | Menu context index/search/preflight/compact. |
| `/context index` | Xem compact context index, không gọi model follow-up. |
| `/context search <keyword>` | Tìm node/edge/citation trong context index. |
| `/profile` | Xem profile ngắn, không gọi model follow-up. |
| `/profile list` | Xem profile có sẵn dạng compact. |
| `/profile <profile>` | Áp profile ngay và cập nhật lock. |
| `/profile auto` | Detect và áp profile recommend ngay. |
| `/profile setup` | Chọn profile + tech bằng option, không chat dài. |
| `/profile tech` | Xem tech stack và Context7 status hiện tại. |
| `/profile tech setup [profile]` | Chọn tech theo role; fullstack chọn FE/BE/DB. |
| `/profile tech apply ...` | Apply profile/tech bằng một lệnh deterministic. |
| `/memory` | Xem memory policy. |
| `/context preflight` | Check context trước task lớn/risk cao. |
| `/context compact` | Compact session có hướng dẫn. |
| `/usage` | Snapshot context/session. |
| `/usage logs` | Xem capture output dài đã compact. |
| `/name` | Đặt/đổi tên session theo task để report dễ map. |
| `/new` | Pi native: mở session mới khi phiên hiện tại nặng. |
| `/name <name>` | Đổi tên session cho resume/report. |
| `/session` | Pi native session stats/info. |
| `/mcp` / `/mcp tools` | Check MCP. |
| `/subagents-doctor` | Check subagent setup. |
| `/subagents-fleet` | Follow child sessions. |
| `/subagent-cost` | Check subagent token/cost. |

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
npm install -g --ignore-scripts @piagent/platform@1.10.0
command -v piagent-install
```

Nếu đang làm việc từ source checkout, có thể dùng script trực tiếp:

```bash
bash /path/to/piagent/scripts/pi-session-stats.sh /path/to/project
node /path/to/piagent/scripts/mcp-manage.mjs --preset core --scope global --replace
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
/usage
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

Lấy session id/file từ `/usage`, rồi:

```bash
pi --session <session-id>
pi --session /absolute/path/to/session.jsonl
```

### Lệnh/tool bị chặn

Guard luôn ghi lý do khi chặn. Nguyên nhân thường gặp:

- đụng protected path (`.env`, `auth.json`, `.pi/piagent-state/**`…) hoặc read-only path của profile;
- permission `read-only` (chặn ghi và shell) — đổi bằng `/permission`;
- file quá lớn so với context budget;
- file đã đổi từ lần đọc trước (`previously observed source snapshot is stale`) — đọc lại file một lần rồi sửa;
- lệnh destructive/external cần xác nhận mà người vận hành chưa đồng ý.

Xem chi tiết bằng `/piagent-inspector security`, hoặc giải thích một lệnh shell trước khi chạy bằng `piagent-explain "<lệnh>"` từ terminal.

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

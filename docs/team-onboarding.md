# Team onboarding
<!-- language: vi; english-index: docs-site/content/en/team.html -->

> Team mới nên đọc `docs/operator-manual-vietnamese.md` trước, rồi dùng file này như checklist onboarding.

## Mục tiêu

Một thành viên mới không cần biết local path của maintainer. Luồng chuẩn rút gọn:

```bash
node --version  # >= 22.19.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
npm install -g --ignore-scripts @piagent/platform@1.6.0
piagent-install --stable
cd /path/to/project
pi
/login
<select provider/model>
/mcp
/subagents-doctor
/onboard
/onboard run
/memory
```

## Prerequisites

- Node.js >=22.19.0.
- Pi Coding Agent `0.84.1`.
- Runtime rollout:
  - verified: macOS Apple Silicon + Bash, Linux x64 + Bash;
  - supported target cần smoke trước khi rollout rộng: macOS Intel + Bash, Linux ARM64 + Bash;
  - chưa dùng làm target rollout team: native Windows; WSL2 chỉ experimental.
- `pi` có trên `PATH`.
- `herdr` optional nhưng nên có nếu team chạy nhiều agent pane.
- MCP: `piagent-install` seed preset `core` mặc định (bỏ qua bằng `--no-mcp`). Server connect lazy nên trước lần gọi đầu còn cần Chrome cho `chrome-devtools`, và **Docker đang chạy + `export GITHUB_PERSONAL_ACCESS_TOKEN`** cho `github`. Chi tiết: [MCP và tool policy](mcp-and-tools.md).
- Git access tới repo platform nếu dùng `git:` package source.
- OAuth/API access riêng của từng người. Không share token.

## Bước 1 — install global package một lần

Mặc định team dùng stable helper:

```bash
node --version  # >= 22.19.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
npm install -g --ignore-scripts @piagent/platform@1.6.0
piagent-install --stable --dry-run
piagent-install --stable
```

`currentRelease` trong output là version của npm-global helper đang chạy. Stable resolve tag cùng version đó thành commit SHA trước khi cài Pi package.

Khi seed `.pi/settings.json` cho team/repo cần audit lặp lại, dùng tag cố định:

```bash
pi install git:github.com/Vt-mmm/piagent@vX.Y.Z
```

Máy cá nhân/sandbox có thể theo moving source nếu chấp nhận cập nhật nhanh:

```bash
pi install git:github.com/Vt-mmm/piagent
```

## Update và rollback cho team

Một lệnh, đúng thứ tự, cho cả ba thành phần:

```bash
piagent-update --check
piagent-update --version X.Y.Z
```

Chạy từ Terminal, không cần mở Pi và không cần đứng trong project. Đây là update global cho cả máy: Pi host, npm-global helper, và Pi package.

Khi cần kiểm tra một project sau rollout, chạy riêng:

```bash
piagent-update --version X.Y.Z --project /path/to/project
```

`--project` là bước phụ: tự migrate layout cũ, Task Contract và managed block
trong `AGENTS.md` nếu có rồi chạy doctor strict-share. Text riêng của project
ngoài managed block được giữ nguyên. Nếu chỉ update global, runtime mới vẫn thay
checklist template cũ trong system prompt ở memory nên task dùng logic mới ngay;
chạy `--project` để file trên disk được dọn bền vững. `--check` chỉ báo version,
không đụng gì.

Nếu npm global mặc định của máy bị khóa quyền ở `/usr/local`, updater tự chuyển sang `~/.pi/npm-global` cho user hiện tại và in dòng `PATH` cần thêm. Không chạy doctor bằng `sudo`.

Máy mới chưa có `piagent-update` dùng một dòng bootstrap này:

```bash
npm exec -y --package @piagent/platform@X.Y.Z -- piagent-update --version X.Y.Z --force
```

Không cần ai nhớ đi kiểm tra: khi có release mới, Pi tự báo ngay ở dòng notice lúc mở session, kèm luôn lệnh chạy.

```text
Piagent update available: 1.1.7 -> 1.1.8. Run `piagent-update` to move this machine to it.
```

Version mới nhất được hỏi npm registry nhiều nhất một lần mỗi 24 giờ, ở tiến trình nền tách rời, nên session không chờ gì cả — lần mở đầu tiên sau khi có bản mới có thể chưa thấy notice, lần sau sẽ thấy. Checkout của maintainer không bao giờ được báo. Tắt bằng `PIAGENT_NO_UPDATE_CHECK=1`; chi tiết ở `docs/security-threat-model.md`.

Sequence thủ công vẫn dùng được, và bắt buộc theo thứ tự này — `piagent-install` **fail** nếu Pi host lệch bản pin, nó không tự nâng host:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
npm install -g --ignore-scripts @piagent/platform@X.Y.Z
piagent-install --stable --dry-run
piagent-install --stable
piagent-doctor /path/to/project --strict-share
```

Full rollback dùng cùng sequence với `vPREVIOUS`, nhưng exact Pi host phải lấy từ release policy của target và dependency risk phải được đánh giá lại trước khi hạ host. `piagent-install --version vX.Y.Z --resolve-tag` chỉ đổi Pi package, không đổi Pi host hay npm-global helper. Checklist chi tiết nằm tại [release/install policy](release-install-policy.md).

Nếu team publish npm private:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.1
pi install npm:@your-scope/platform@x.y.z
```

Không cần chạy bash để set profile cho từng project.

### Rời platform

Thành viên rời team hoặc máy không dùng platform nữa thì gỡ bằng `piagent-uninstall`. Mặc định nó chỉ báo cáo; `--apply` mới thực hiện:

```bash
piagent-uninstall
piagent-uninstall --apply
piagent-uninstall --apply --with-addons --with-host    # gỡ luôn add-on và Pi host
piagent-uninstall --apply --project /path/to/project   # gỡ state platform trong project
npm uninstall -g @piagent/platform
```

Credential, trust, session, todo và `.pi/memory/` không bị xoá ở bất kỳ tổ hợp cờ nào. `.pi/settings.json` chỉ mất đúng entry trỏ tới platform. Chi tiết trong [release/install policy](release-install-policy.md).

## Bước 2 — mở project và login OAuth

```bash
cd /path/to/project
pi
/login
```

Credential nằm trong user Pi dir, không commit.

Nếu browser login của OpenAI trông như treo, xem [login provider](operator-manual-vietnamese.md#login-provider). Tóm tắt: paste callback URL xong phải bấm **Enter** (màn hình không nhắc), và nếu sau Enter terminal khoá luôn thì login bằng `pi --offline` một lần. Cả hai là lỗi Pi host `0.82.0`/`0.82.1`, không phải platform.

## Bước 3 — chọn model và onboard project

Sau login, chọn provider/model intended cho project understanding bằng native Pi selector. Cả hai họ model đều là supported option: model OpenAI Codex và model Anthropic Claude.

```text
/model          # hoặc Ctrl+L
/scoped-models  # optional
```

Global setup seed sẵn `enabledModels`; đổi nhanh bằng:

```text
Ctrl+P       # cycle scoped models
Shift+Tab    # cycle thinking level
```

Rồi chạy:

```text
/mcp
/subagents-doctor
/onboard
/onboard run
```

Output chính:

- `.pi/project-context.md`
- `.pi/context-index.json`
- `.pi/piagent-profile.json`
- `.pi/piagent-profile.lock.json`
- `.pi/tech-stack.json`
- `.pi/tech-context/*.json`
- `.pi/piagent-state/project-onboarding.json`

Memory files are created locally but ignored by default:

- `.pi/memory/memory_summary.md`
- `.pi/memory/MEMORY.md`

Đây là bước model đọc qua project lần đầu theo cách bounded: đọc profile, AGENTS, README, docs/config/source map/test command; không load toàn bộ source.

Nếu project chưa có profile/tech stack, dùng select-style flow để tránh agent trả lời dài:

```text
/profile setup
/profile tech setup fullstack
```

`fullstack` bắt chọn frontend, backend và database. Nếu native select chưa có trong Pi host, command trả card compact kèm lệnh deterministic `/profile tech apply ...`.

Nếu `.pi/project-context.md` còn `Generated: not yet`, không nên chạy `/workflow task` implementation.

Memory mặc định là project-scoped và explicit-only. Chạy `/memory` để xem files/rules. `/memory-policy` vẫn là alias. Agent chỉ ghi durable memory khi user yêu cầu rõ ràng.

Đổi profile sau này:

```text
/profile list
/profile setup
/profile tech setup
/profile fullstack
/profile be-readonly-fe
```

## Setup nâng cao — tách global và project

Các script setup/init vẫn tồn tại cho case preseed config vào repo hoặc CI bootstrap, nhưng không phải default UX:

```bash
bash /path/to/piagent/scripts/setup.sh /path/to/project \
  --profile be-readonly-fe \
  --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z \
  --mcp-preset core \
  --subagents-preset safe
```

Nếu cần override profile:

```bash
bash /path/to/piagent/scripts/setup.sh /path/to/project --project-only --profile backend-api --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z --mcp-preset core --subagents-preset safe
```

Profile built-in trong Pi:

- `auto`: tự detect.
- `generic`: repo chưa chuẩn.
- `web-frontend`: Next/React/Vite frontend.
- `backend-api`: Node/Java/Python API.
- `be-readonly-fe`: scout BE read-only, implement FE only.
- `fullstack`: repo có cả frontend và backend.
- `node-typescript`: Node/TS library/tooling.
- `python`: Python app/library.
- `data`: ETL/dbt/DVC/notebook/data pipeline.
- `devops`: Docker/Terraform/K8s/GitHub Actions.
- `mobile`: React Native/Flutter.
- `docs`: docs portal/manual.

Project init tạo:

- `.pi/settings.json`
- `.pi/piagent-profile.json`
- `.pi/context-index.json`
- `.mcp.json`
- `.pi/mcp.json`
- `.pi/memory/memory_summary.md`
- `.pi/memory/MEMORY.md`
- `.pi/.gitignore`
- `AGENTS.md` nếu chưa có
- `REVIEW_GUIDELINES.md` nếu chưa có

Hai file memory ở trên là local/private mặc định theo `.pi/.gitignore`; chỉ commit nếu team opt-in sau review.

Với luồng FE/BE tách repo nhưng để chung một folder làm việc, mở Pi tại folder cha và chọn `be-readonly-fe` cho chính folder cha đó. Ví dụ `Working/v-nexus-frontend/` và `Working/v-nexus-backend/` là hai Git repo riêng; `Working/.pi/piagent-profile.json` là profile của phiên Pi. Khi start task, scope ghi nên nằm trong FE repo:

```text
/workflow be-to-fe Scout BE changes read-only and create the FE remediation plan. Scope: v-nexus-frontend/plans/**, v-nexus-frontend/**. Backend repo is read-only.
```

Plan/report có thể ghi vào `v-nexus-frontend/plans/**` nếu muốn đi cùng FE repo, hoặc `Working/plans/**` nếu muốn lưu ở workspace cha. File ngoài repo con được theo dõi bằng bounded file-digest evidence, còn FE/BE repo con vẫn dùng Git evidence.

## Bước 4 — run trong Herdr

```bash
herdr
cd /path/to/project
pi
```

Trong Pi, nếu project trust prompt hiện ra, chỉ approve khi đúng repo. Project trust cho phép Pi load `.pi/settings.json`, `.pi` resources và project extensions.

Sau khi team đã hiểu repo và muốn giảm prompt trust cho từng lần chạy, dùng:

```bash
piagent-auto
```

Read-only auto-run cho scout/audit:

```bash
piagent-auto --read-only -p "Scout module mapping. Do not edit source."
```

Lệnh này wrap `pi --approve`; nó không bypass piagent guard.

## Bước 5 — task workflow

Requirement chưa rõ:

```text
/workflow discuss Tạo plan cho feature X. Chưa implement.
```

Task rõ:

```text
/workflow task Implement feature X. Follow project profile, protected paths, required context, exec policy, context budget, tool policy, verify, trace, and task gate.
```

Scout/audit read-only:

```text
/workflow scout Scout payment FE mapping vs BE contract. Backend read-only. Do not edit source.
```

Session nặng hoặc context overflow:

```text
/fresh scout <read-only scout>
/fresh task <bounded task>
/fresh be-to-fe <BE-readonly/FE request>
```

Không paste full mandatory flow hằng ngày. Platform prompts/tools đã chứa checklist; input guard sẽ tự collapse boilerplate nếu paste nhầm.

Alias cũ `/discuss`, `/task`, `/scout`, `/fresh-*` vẫn chạy cho power user, nhưng tài liệu onboard team dùng `/workflow`, `/name`, `/fresh`, và `/usage` để dễ nhớ hơn.

Runtime gate tools:

```text
piagent_exec_policy_check
piagent_context_budget
piagent_tool_policy_check
piagent_task_gate_check
```

Task cải tiến platform:

```text
/workflow platform-improve Improve onboarding, model scope, MCP setup, and verification docs for team usage.
```

Task BE spec lên FE:

```text
/workflow be-to-fe Implement FE from BE contract <endpoint/spec>. Backend is read-only.
```

Project memory:

```text
/memory
Remember: this repo uses pnpm, never npm.
```

External source repo:

```text
Use piagent_source_checkout for github.com/org/repo, inspect only relevant files, then summarize applicable patterns.
```

## Doctor

Chạy trên platform:

```bash
bash scripts/verify-local.sh
```

Chạy trên project:

```bash
bash /path/to/piagent/scripts/profile-doctor.sh /path/to/project
bash /path/to/piagent/scripts/team-doctor.sh /path/to/project --strict-share
piagent-benchmark --dry-run
```

Maintainer chạy `piagent-benchmark` khi cần đo release/model bằng automatic paired
suite. Lệnh dùng model quota và sẽ hỏi xác nhận trước khi bắt đầu.

Nếu doctor cảnh báo `project onboarding snapshot is still pending`, mở Pi trong project và chạy `/onboard run`.

## Không commit

- `.pi/piagent-state/`
- `.pi/benchmarks/`
- `.pi/memory/local/`
- `.pi/memory/state.sqlite`
- `.pi/memory/rollout_summaries/`
- `.pi/todos/`
- `.pi/sessions/`
- `.pi/auth.json`
- `.env`
- token/API key

## Official docs

- Pi packages: https://pi.dev/docs/latest/packages
- Pi project trust/settings: https://pi.dev/docs/latest/settings
- Pi prompt templates: https://pi.dev/docs/latest/prompt-templates
- Pi MCP adapter: https://pi.dev/packages/pi-mcp-adapter
- Herdr integrations: https://herdr.dev/docs/integrations/

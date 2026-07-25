# Quickstart tiếng Việt

> Nếu cần hướng dẫn đầy đủ từ setup, command, token/session, MCP đến subagents, xem `docs/operator-manual-vietnamese.md`.

## Mục tiêu

Sau setup, flow hằng ngày là:

```bash
cd <project>
pi
```

Phần còn lại — OAuth, package, context, harness, MCP, tool-call guard — nằm trong repo/package `piagent-platform`.

## Bước 1 — install runtime và package

Support matrix của release hiện tại:

| Runtime | Trạng thái |
|---|---|
| macOS Apple Silicon + Bash | Đã verify cho release này. |
| Linux x64 + Bash | Đã verify trong CI. |
| macOS Intel + Bash | Supported target; chạy `piagent-doctor` và smoke test project trước khi rollout rộng. |
| Linux ARM64 + Bash | Supported target; chạy `piagent-doctor` và smoke test project trước khi rollout rộng. |
| Native Windows | Chưa phải target rollout team; helper/shell policy cần Bash/POSIX semantics. |
| WSL2 | Experimental, chưa release-gate. |

Node.js phải từ `22.19.0` trở lên. Hai lệnh:

```bash
npm install -g @piagent/platform
piagent-setup
```

Chạy `piagent-setup` ngay trong thư mục project. Nó tự cài đúng Pi Coding Agent `0.81.1` mà release này pin, cài Pi package, khởi tạo `.pi/`, rồi chạy doctor. Nó cũng cài MCP baseline và subagents; thêm `--no-mcp`, `--no-subagents` nếu không cần, hoặc `--global-only` nếu chưa muốn đụng project nào.

Vì chạy từ package đã cài, source ghi vào `.pi/settings.json` là `npm:@piagent/platform@<version>` — portable, commit được.

Muốn cài tay từng lớp để kiểm soát chặt hơn:

```bash
node --version  # >= 22.19.0
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.81.1
npm install -g --ignore-scripts @piagent/platform@1.0.1
piagent-install --stable --dry-run
piagent-install --stable
```

Lệnh trên cài Pi CLI, cài terminal command `piagent-*`, rồi install Pi Agent Platform bằng stable release đã resolve tag thành commit SHA. Trong output installer, `currentRelease` là version của terminal helper đang chạy. `v1.0.1` là release hiện tại của docs này.

Nếu chỉ cần cài package vào Pi và không cần terminal command helper:

```bash
pi install git:github.com/Vt-mmm/piagent@v1.0.1
```

Nếu đang ở source checkout của platform, có thể preview và áp stable bằng helper:

```bash
bash scripts/install-global.sh --stable --dry-run
bash scripts/install-global.sh --stable
```

Helper stable sẽ resolve tag release hiện tại thành commit SHA trước khi install, nên user vẫn dùng lệnh ngắn nhưng team nhận source bất biến hơn.

Khi update toàn bộ platform, cập nhật exact Pi host trước rồi dùng helper target để cài Pi package tương ứng:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.81.1
npm install -g --ignore-scripts @piagent/platform@X.Y.Z
piagent-install --stable --dry-run
piagent-install --stable
```

Rollback toàn bộ dùng cùng flow với `vPREVIOUS`, nhưng phải lấy exact host version từ release policy của target và đánh giá lại dependency risk trước khi hạ host. Nếu chủ ý chỉ đổi Pi package và giữ host/helper hiện tại:

```bash
piagent-install --version vX.Y.Z --resolve-tag --dry-run
piagent-install --version vX.Y.Z --resolve-tag
```

Checklist release canonical nằm tại [release-install-policy.md](release-install-policy.md).

Máy cá nhân hoặc sandbox có thể dùng latest nếu chấp nhận cập nhật nhanh:

```bash
bash scripts/install-global.sh --dev --dry-run
bash scripts/install-global.sh --dev
```

Sau bước này, project mới không cần chạy bash init profile. Chỉ cần:

```bash
cd /path/to/project
pi
```

Với project đã tin cậy, có thể dùng wrapper để Pi tự approve project-local resources cho lần chạy đó:

```bash
piagent-auto
```

Read-only auto-run:

```bash
piagent-auto --read-only -p "Scout payment mapping. Do not edit source."
```

Trusted full-access style run cho repo đã kiểm soát:

```bash
piagent-auto --full-access -p "Run the trusted local benchmark suite."
```

Wrapper này không bypass piagent guard; nó wrap `pi --approve` và set permission profile cho lần chạy. Dù dùng `--full-access`, protected paths, redaction, destructive shell checks, task gate, và verify evidence vẫn chạy.

Nếu đã ở trong Pi session, dùng slash command cho nhanh:

```text
/permission-status
/full-access Implement/refactor task trong repo trusted này.
```

`/full-access <task>` chỉ bật full-access cho session hiện tại, không tự ghi `.pi/piagent-profile.json`.

Nếu chat box/ảnh chụp trả về local path thay vì attachment ảnh, dán path đó trực tiếp vào prompt:

```text
/scout Check UI issue from screenshot /var/folders/.../screenshot.png
```

Platform sẽ tự attach ảnh và rewrite prompt thành `[image1]` trước khi model xử lý. Hỗ trợ `.png/.jpg/.jpeg/.gif/.webp/.bmp`, tối đa 4 ảnh, 8 MB mỗi ảnh.

## Bước 2 — login OAuth OpenAI Codex/ChatGPT hoặc Claude/Anthropic

```bash
pi
/login
```

Chọn provider OpenAI/Codex/ChatGPT hoặc Anthropic/Claude trong danh sách Pi. Token được lưu local trong Pi agent dir, không nằm trong repo.

## Bước 3 — chọn model và chạy project onboarding

Sau khi login và chọn model intended cho project understanding:

```text
/model          # hoặc Ctrl+L để chọn model bằng selector của Pi
/scoped-models  # optional, chỉnh danh sách Ctrl+P cycle
/piagent-commands
/mcp            # kiểm tra MCP adapter/server
/subagents-doctor  # health check subagent setup
/onboard-project
/context-index
/memory-policy
```

Global setup đã config sẵn `enabledModels` cho các provider model families. Anh đổi model bằng selector/hotkey:

```text
Ctrl+L       # model selector
Ctrl+P       # đổi model trong scope
Shift+Tab    # đổi thinking
```

Nếu muốn xem/re-apply model scope từ terminal: `piagent-models` và `piagent-model-scope --preset full`.

Nếu muốn xem/re-apply MCP baseline từ terminal:

```bash
piagent-mcp --preset core --scope global --replace
piagent-mcp --preset popular --scope global --replace
piagent-mcp --list
```

Nếu clone repo GitHub và chưa link npm bin, dùng fallback:

```bash
bash /path/to/piagent/scripts/configure-mcp.sh --preset core --scope global --replace
```

Nếu muốn xem/re-apply subagents baseline từ terminal:

```bash
piagent-subagents --preset safe
# fallback:
bash /path/to/piagent/scripts/configure-subagents.sh --preset safe
```

Nếu muốn dùng builtin `researcher` cho web/docs research trong Pi:

```bash
pi install npm:pi-web-access@0.13.0
# hoặc setup từ đầu:
bash /path/to/piagent/scripts/setup.sh . --with-web-access
```

Lệnh này yêu cầu model đọc qua project theo phạm vi có kiểm soát, rồi ghi:

```text
.pi/piagent-profile.json
.pi/piagent-profile.lock.json
.pi/tech-stack.json
.pi/tech-context/*.json
.pi/project-context.md
.pi/context-index.json
.pi/memory/memory_summary.md
.pi/memory/MEMORY.md
```

Nếu chưa có profile/tech stack, dùng select-style flow để tránh agent trả lời dài:

```text
/profile setup
/profile tech setup fullstack
```

`web-frontend` chọn FE + database optional; `backend-api` chọn BE + database optional; `fullstack` chọn frontend, backend và database. Nếu Pi host chưa có native select, command sẽ trả card ngắn và lệnh deterministic `/profile tech apply ...`.

`.pi/project-context.md` là snapshot context cho task sau. `.pi/context-index.json` là bản đồ node/edge/citation compact để tìm đúng điểm vào repo; vẫn phải đọc source hiện tại trước khi sửa. Không đọc/ghi raw file index trong task thường ngày; dùng `/context-index`, `/onboard-project` hoặc `piagent_context_index_record` để runtime sanitize dữ liệu advisory. Nếu snapshot còn `Generated: not yet` hoặc `/context-index` báo pending/stale, agent phải dừng trước task lớn và yêu cầu chạy `/onboard-project`.

`/memory-policy` kiểm tra chính sách memory của project. Mặc định memory là explicit-only: chỉ ghi khi user yêu cầu rõ “remember this”, không tự học transcript nền.

## Bước 4 — init thêm project khác

```bash
bash /path/to/piagent/scripts/setup.sh /path/to/project \
  --project-only \
  --profile auto \
  --package-source git:github.com/Vt-mmm/piagent@v1.0.1 \
  --mcp-preset core \
  --subagents-preset safe
```

Đổi profile sau này trong Pi:

```text
/profile list
/profile setup
/profile tech setup
/profile be-readonly-fe
```

Profile built-in: `generic`, `web-frontend`, `backend-api`, `be-readonly-fe`, `fullstack`, `node-typescript`, `python`, `data`, `devops`, `mobile`, `docs`.

## Bước 5 — setup split/preseed nếu cần

Script bash chỉ dùng khi muốn preseed config vào repo:

```bash
bash /path/to/piagent/scripts/setup.sh /path/to/project \
  --profile be-readonly-fe \
  --package-source git:github.com/Vt-mmm/piagent@v1.0.1 \
  --mcp-preset core \
  --subagents-preset safe
```

## Bước 6 — chạy hằng ngày

```bash
herdr
cd <project>
pi
```

Prompt mẫu khi requirement chưa rõ:

```text
/discuss Cải tiến workflow onboarding cho team mới. Chưa implement, chỉ hỏi lại phần còn thiếu và đề xuất plan.
```

Prompt mẫu khi đã rõ task:

```text
/task Implement this request. Use piagent_context, piagent_task_start, piagent_context_budget, piagent_exec_policy_check when shell is needed, piagent_verify_record, piagent_trace_record, and piagent_task_gate_check before done.
```

Prompt mẫu khi chỉ cần scout/read-only:

```text
/scout Scout payment FE mapping vs BE contract. Backend read-only. Do not edit source.
```

Nếu session đang nặng hoặc gặp context overflow:

```text
/fresh-scout Scout payment FE mapping vs BE contract. Backend read-only. Do not edit source.
/fresh-task Implement <bounded task>.
/fresh-be-to-fe Implement FE support from <BE contract>. Backend read-only.
```

Không paste full mandatory flow hằng ngày. Từ `v0.3.21`, input guard tự collapse mandatory-flow boilerplate và fresh workflow tự mở session mới khi cần.

Từ `v0.3.21`, `/task` có auto-delegation policy. Với task đủ lớn, parent agent phải tự cân nhắc dùng `piagent-scout`, `piagent-planner`, hoặc `piagent-reviewer`; anh không cần tự gọi `/run` nếu không muốn ép orchestration.

Các workflow package đáng dùng khi muốn ép rõ shape:

```text
/parallel-review current diff
/review-loop current diff max 3 rounds
/parallel-research <question cần external evidence + local code context>
/parallel-context-build <task lớn cần context handoff>
```

Prompt mẫu cho 2 recipe hay gặp:

```text
/piagent-commands subagents
/platform-improve Improve model selection, MCP setup, and onboarding docs for a public team package.
/be-to-fe Implement FE from BE spec <endpoint/spec>. Backend read-only.
/context-index search auth
/memory-policy Show project memory policy and safe remember workflow.
/run piagent-scout "Map target area read-only before planning."
/run piagent-reviewer "Review current diff before final handoff."
```

Cache external source repo để đọc targeted trong Pi:

```text
Use piagent_source_checkout for github.com/org/repo, inspect only relevant files, then summarize applicable patterns.
```

Runtime gate tools có sẵn:

```text
piagent_exec_policy_check      # check shell command
piagent_context_budget         # check context size/hard cap
piagent_tool_policy_check      # check tool capability
piagent_task_gate_check        # check before final DONE
```

Fallback bằng shell nếu cần:

```bash
PIAGENT_PLATFORM_HOME=/path/to/piagent
bash "$PIAGENT_PLATFORM_HOME/packages/piagent-core/skills/piagent-source-cache/checkout-source-repo.sh" \
  github.com/org/repo \
  --path-only
```

## Việc user vẫn phải làm thủ công

- Login OAuth lần đầu trong browser.
- Chọn provider/model intended cho project.
- Chạy `/onboard-project` lần đầu để tạo `.pi/project-context.md` và `.pi/context-index.json`.
- Chạy `/memory-policy` nếu muốn kiểm tra hoặc dùng project memory.
- Approve project trust nếu Pi hỏi. Sau khi hiểu rõ repo, có thể dùng `piagent-auto` hoặc Pi native `--approve` cho từng lần chạy.
- Approve khi extension guard hỏi destructive/high-risk action.

Các việc này là credential/trust boundary, không nên automation mù.

## Tài liệu chính

- Command reference: `docs/command-reference-vietnamese.md`
- Pi packages: https://pi.dev/docs/latest/packages
- Pi extensions: https://pi.dev/docs/latest/extensions
- Pi providers/OAuth: https://pi.dev/docs/latest/providers
- Pi settings/trust: https://pi.dev/docs/latest/settings
- Pi MCP adapter: https://pi.dev/packages/pi-mcp-adapter

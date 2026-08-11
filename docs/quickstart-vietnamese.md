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

Chạy `piagent-setup` ngay trong thư mục project. Nó tự cài đúng Pi Coding Agent `0.84.1` mà release này pin, cài Pi package, khởi tạo `.pi/`, rồi chạy doctor. Nó cũng cài MCP baseline, subagents, và Herdr Pi integration nếu `herdr` đã có sẵn trên `PATH`; thêm `--no-mcp`, `--no-subagents`, `--no-herdr` nếu không cần, hoặc `--global-only` nếu chưa muốn đụng project nào.

Nếu dùng [Herdr](https://herdr.dev/docs/install/) thì cài Herdr **trước** `piagent-setup`:

```bash
brew install herdr                            # macOS
curl -fsSL https://herdr.dev/install.sh | sh  # macOS hoặc Linux
```

Không có `herdr` trên `PATH` thì bước integration bị bỏ qua kèm cảnh báo, cài Herdr sau phải chạy lại `piagent-setup --global-only`. Bản `curl` chạy script tải về lúc cài; muốn kiểm tra được thì dùng `brew` hoặc tải từ [GitHub releases](https://github.com/ogulcancelik/herdr/releases). Herdr bản stable hỗ trợ macOS và Linux; Windows mới ở mức preview, mà cũng nằm ngoài runtime matrix của platform này.

Vì chạy từ package đã cài, source ghi vào `.pi/settings.json` là `npm:@piagent/platform@<version>` — portable, commit được.

Xong. Từ đây project nào cũng chỉ cần `cd` vào rồi gõ `pi`.

Rollout team pin từng bước, update, rollback, và channel `--dev` cho máy cá nhân: [release-install-policy.md](release-install-policy.md).

## Bước 2 — login OAuth provider model (OpenAI/ChatGPT hoặc Anthropic)

```bash
pi
/login
```

Chọn provider cho họ model muốn dùng trong danh sách Pi: OpenAI/ChatGPT cho model Codex, hoặc Anthropic cho model Claude. Token được lưu local trong Pi agent dir, không nằm trong repo.

## Bước 3 — chọn model và chạy project onboarding

Sau khi login và chọn model intended cho project understanding:

```text
/model          # hoặc Ctrl+L để chọn model bằng selector của Pi
/scoped-models  # optional, chỉnh danh sách Ctrl+P cycle
/commands
/mcp            # kiểm tra MCP adapter/server
/subagents-doctor  # health check subagent setup
/onboard
/onboard run
/context index
/memory
```

`Ctrl+L` mở model selector, `Ctrl+P` đổi model trong scope, `Shift+Tab` đổi mức thinking. `piagent-setup` đã config sẵn `enabledModels`, MCP baseline preset `core`, và subagents preset `safe` — muốn xem hoặc đổi thì có [model-options.md](model-options.md), [mcp-and-tools.md](mcp-and-tools.md), [subagents-and-multiagent.md](subagents-and-multiagent.md).

`/onboard` yêu cầu model đọc qua project theo phạm vi có kiểm soát, rồi ghi:

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

`.pi/project-context.md` là snapshot context cho task sau. `.pi/context-index.json` là bản đồ node/edge/citation compact để tìm đúng điểm vào repo; vẫn phải đọc source hiện tại trước khi sửa. Không đọc/ghi raw file index trong task thường ngày; dùng `/context`, `/onboard run` hoặc `piagent_context_index_record` để runtime sanitize dữ liệu advisory. Nếu snapshot còn `Generated: not yet` hoặc `/context index` báo pending/stale, agent phải dừng trước task lớn và yêu cầu chạy `/onboard run`.

`/memory` kiểm tra chính sách memory của project. `/memory-policy` vẫn là alias. Mặc định memory là explicit-only: chỉ ghi khi user yêu cầu rõ “remember this”, không tự học transcript nền.

## Bước 4 — init thêm project khác

Global đã cài rồi nên project sau chỉ cần init:

```bash
cd /path/to/project
piagent-setup --project-only
```

Nó ghi `npm:@piagent/platform@<version>` vào `.pi/settings.json` — portable, commit được cho cả team.

Đổi profile sau này thì gõ `/profile setup` trong Pi. Profile built-in: `generic`, `web-frontend`, `backend-api`, `be-readonly-fe`, `fullstack`, `node-typescript`, `python`, `data`, `devops`, `mobile`, `docs`.

## Bước 5 — chạy hằng ngày

```bash
cd <project>
pi --name "ABC-123 Short task name"
```

Rồi mô tả việc cần làm bằng tiếng Việt hoặc tiếng Anh. Nếu quên đặt tên lúc mở Pi, gõ `/name ABC-123 Short task name` hoặc alias ngắn `/setname ABC-123 Short task name` trước khi làm tiếp; Agent Watch sẽ dùng tên session này trong report. Không cần paste checklist — input guard tự collapse boilerplate, và `/workflow task` tự cân nhắc gọi scout/planner/reviewer khi task đủ lớn.

Mỗi Pi session chỉ dùng cho một task. Retry hoặc task mới mở session mới; resume
thì quay lại đúng session cũ theo name/id. Source task yêu cầu project là Git
working tree và profile có verify command thật. `/workflow scout` vẫn chạy ở
read-only mode khi chỉ cần nghiên cứu và không sửa source.

Muốn chạy nhiều agent song song thì gõ `herdr` thay vì `pi`, rồi mở mỗi pane một vai: implement, review read-only, verify, notes. Herdr chỉ điều phối terminal/session, không phải security boundary — gate vẫn nằm ở Pi extension và OAuth vẫn `/login` trong Pi. Chi tiết: [herdr-workflow.md](herdr-workflow.md).

| Gõ | Khi nào |
|---|---|
| `/workflow` | Mở menu chọn task/scout/review/git/onboard. |
| `/workflow discuss <ý tưởng>` | Requirement chưa rõ, muốn hỏi lại trước. |
| `/workflow task <việc>` | Đã rõ, làm luôn. |
| `/workflow scout <việc>` | Chỉ đọc, không sửa — map payment/auth/BE contract. |
| `/workflow plan <mục tiêu>` | Muốn có plan trước khi đụng code. |
| `/workflow review current diff` | Review việc vừa làm. |
| `/name <task/session name>` | Đặt/đổi tên session để resume và report dễ đối chiếu. |
| `/usage logs` | Xem các capture khi test/build output quá dài và Pi chỉ hiện preview. |
| `/task-preflight` | Xem intent/risk/scope/model/route/approval trước task, không gọi model. |
| `/piagent-status` | Xem phase/checkpoint/verifier/recovery/helper/receipt từ state đã quan sát. |
| `/usage efficiency` | Xem context efficiency và task metrics có nguồn; giá trị không đo được là `null`. |
| `/workflow be-to-fe <việc>` | Backend read-only, làm FE. |
| `/workflow commit <message>` | Commit local có kiểm soát, không push. |
| `/workflow pr <title>` | Tạo PR, hỏi xác nhận trước khi push. |
| `/fresh task|scout|be-to-fe <việc>` | Session đang nặng hoặc tràn context. |

`/commands` liệt kê hết. Các alias cũ như `/task`, `/scout`, `/be-to-fe`, `/fresh-task`, `/context-index`, `/logs` vẫn chạy nhưng không còn là đường onboard chính. Giải thích từng lệnh: [command-reference-vietnamese.md](command-reference-vietnamese.md). Các workflow ép shape rõ (`/parallel-review`, `/review-loop`, `/parallel-research`, `/parallel-context-build`): [subagents-and-multiagent.md](subagents-and-multiagent.md). Runtime gate tools và cách agent tự dùng chúng: [operator-manual-vietnamese.md](operator-manual-vietnamese.md).

## Việc user vẫn phải làm thủ công

- Login OAuth lần đầu trong browser.
- Chọn provider/model intended cho project.
- Chạy `/onboard run` lần đầu để tạo `.pi/project-context.md` và `.pi/context-index.json`.
- Chạy `/memory` nếu muốn kiểm tra hoặc dùng project memory.
- Approve project trust nếu Pi hỏi. Sau khi hiểu rõ repo, có thể dùng `piagent-auto` hoặc Pi native `--approve` cho từng lần chạy.
- Approve khi extension guard hỏi destructive/high-risk action.

Các việc này là credential/trust boundary, không nên automation mù.

## Gỡ cài đặt

`piagent-uninstall` mặc định là dry run: nó in ra sẽ gỡ những gì rồi thoát, không đụng vào đâu cả. Thêm `--apply` mới thực hiện.

```bash
piagent-uninstall
piagent-uninstall --apply
```

Mặc định chỉ gỡ Pi package của platform khỏi Pi settings global. Muốn gỡ rộng hơn:

```bash
piagent-uninstall --apply --with-addons                    # + pi-mcp-adapter, pi-subagents, pi-web-access
piagent-uninstall --apply --with-host                      # + Pi Coding Agent host
piagent-uninstall --apply --project /path/to/project       # + profile, lock, piagent-state/ của project
npm uninstall -g @piagent/platform                         # helper npm-global, gỡ riêng
```

Có những thứ nó **không bao giờ** xoá, kể cả khi bật hết cờ: `auth.json`, `trust.json`, `sessions/`, `todos/`, và `.pi/memory/`. Đó là dữ liệu của anh chứ không phải state của platform. `AGENTS.md`, `.pi/settings.json`, `project-context.md` cũng được giữ vì sinh ra từ template rồi anh sửa tiếp — script liệt kê chúng ra để anh tự quyết.

Với `.pi/settings.json` nó chỉ bỏ đúng entry trỏ tới platform trong `packages`, phần còn lại giữ nguyên.

## Tài liệu chính

- Command reference: `docs/command-reference-vietnamese.md`
- Pi packages: https://pi.dev/docs/latest/packages
- Pi extensions: https://pi.dev/docs/latest/extensions
- Pi providers/OAuth: https://pi.dev/docs/latest/providers
- Pi settings/trust: https://pi.dev/docs/latest/settings
- Pi MCP adapter: https://pi.dev/packages/pi-mcp-adapter

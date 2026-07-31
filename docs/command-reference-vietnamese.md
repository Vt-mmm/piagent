# Command reference tiếng Việt

> Nếu cần flow đầy đủ theo thứ tự dùng thật, đọc `docs/operator-manual-vietnamese.md`. File này chỉ là bảng tra cứu command.

File này là bảng tra cứu command chính cho Pi Agent Platform. Mục tiêu là khi anh/team mở Herdr, `cd` vào project, chạy `pi`, thì biết rõ lệnh nào dùng cho việc gì.

## Cách đọc command

Có 5 loại cần phân biệt:

| Loại | Gõ ở đâu | Ví dụ | Ý nghĩa |
|---|---|---|---|
| Runtime slash command | Bên trong Pi TUI | `/usage` | Extension chạy ngay, hiện kết quả/menu, **không gọi model follow-up**. |
| Workflow launcher | Bên trong Pi TUI | `/workflow task <request>` | Runtime command mở menu hoặc gửi workflow prompt rõ ràng cho agent. |
| Workflow alias | Bên trong Pi TUI | `/task <request>` | Alias cũ cho power user; vẫn cần agent turn. Team mới nên dùng `/workflow`. |
| Terminal command | Terminal đã có Bash | `piagent-mcp --preset core` | Cài, kiểm tra, hoặc cấu hình máy/project từ bên ngoài Pi. |
| Pi native/hotkey | Bên trong Pi TUI | `/model`, `Ctrl+L` | Điều khiển native Pi như model/session/MCP. |

Nếu không chắc một slash command có sẵn chưa, mở Pi và gõ `/` để xem danh sách command của session hiện tại. Command có thể khác nhau theo package đã install, provider đã login, và project trust.

## Native Pi vs PiAgent

PiAgent không chiếm các command native đang dùng của Pi. Những command này để Pi xử lý trực tiếp:

| Pi native | Vai trò |
|---|---|
| `/login` | Đăng nhập provider/OAuth. |
| `/model`, `Ctrl+L` | Chọn model/provider. |
| `/session` | Xem session id/name/token/cost/context hiện tại. |
| `/resume` | Resume session cũ bằng UI/native flow. |
| `/compact` | Nén context bằng Pi native compaction. |
| `/mcp`, `/mcp-auth` | Kiểm tra/kết nối MCP live và OAuth. |

Command ngắn của PiAgent dùng cho workflow và guard local:

| PiAgent runtime | Vai trò |
|---|---|
| `/commands` | Menu/help command, không gọi model. |
| `/workflow` | Launcher task/scout/plan/review/git/onboard. |
| `/usage` | Usage live/history/preflight/compact/logs/efficiency. |
| `/context` | Smart index/rebuild/search/pack/impact/efficiency/preflight/compact. |
| `/permission` | Permission mode của session. |
| `/profile` | Profile và tech stack. |
| `/memory` | Project memory policy. |
| `/onboard` | Project onboarding/status/setup. |
| `/name` | Đặt tên session cho Agent Watch/report. |
| `/fresh` | Tạo session mới cho workflow. |

Riêng MCP governance vẫn giữ `/piagent-mcp` vì `/mcp` đã là command native của Pi.

## Flow hằng ngày ngắn nhất

Lần đầu trên một project:

```bash
cd /path/to/project
pi
```

Trong Pi:

```text
/login
/model
/commands
/onboard
/context index
/context rebuild
/memory
```

Các lần sau:

```bash
cd /path/to/project
pi
```

Trong Pi:

```text
/workflow task Implement <task cụ thể>.
```

Nếu chỉ scout/audit read-only:

```text
/workflow scout Scout payment FE mapping vs BE. Do not edit source.
```

Nếu session đang nặng hoặc Pi báo context overflow, dùng fresh workflow:

```text
/fresh scout <read-only request>
/fresh task <implementation request>
/fresh be-to-fe <BE-readonly/FE request>
```

Nếu task còn mơ hồ:

```text
/workflow discuss <ý tưởng hoặc yêu cầu thô>
/workflow plan <goal cần bóc tách>
```

## Nguyên tắc command/UX

Pi Agent dùng ít namespace nhưng mỗi namespace có subcommand/menu rõ:

- `/workflow` là cửa chính cho task/scout/review/git/onboard workflow. Workflow cần agent turn là cố ý và được nói rõ.
- `/usage` gom live usage, history/report hint, preflight, compact, logs, efficiency.
- `/name` đặt tên session theo task để Agent Watch/report map đúng việc.
- `/fresh` mở session mới cho `task`, `scout`, hoặc `be-to-fe` khi phiên hiện tại đã nặng.
- `/context` gom architecture map, code index, search, context pack, test impact, efficiency, preflight và semantic compact.
- `/permission` gom permission status/read-only/workspace-write/full-access.
- `/profile` là namespace duy nhất cho profile và tech stack.
- `/commands` là runtime help/menu, không còn bắt agent đọc docs để giải thích.
- Khi user cần chọn, ưu tiên select option. Khi UI select không khả dụng, trả exact command.
- Hành động rủi ro như stage rộng, push, PR write, deploy, publish, thay đổi database hoặc external-provider write vẫn cần xác nhận người vận hành.

## Command chính cho team

Các command này đến từ package `piagent-core`.

| Command | Dùng khi nào | Kết quả mong đợi |
|---|---|---|
| `/commands` | Không nhớ command. | Mở menu/help theo topic, không gọi model. |
| `/workflow` | Muốn chọn task/scout/review/git/onboard bằng menu. | Mở workflow picker. |
| `/workflow task <request>` | Requirement đã rõ và cần implement. | Launch task workflow cho agent. |
| `/workflow scout <request>` | Cần scout/audit read-only. | Launch scout workflow cho agent. |
| `/workflow be-to-fe <request>` | BE read-only, FE implementation. | Launch BE→FE workflow. |
| `/workflow discuss <idea>` | Task còn mơ hồ. | Launch clarify workflow, không sửa code. |
| `/workflow plan <goal>` | Cần plan trước khi sửa. | Launch plan workflow. |
| `/workflow review <target>` | Review diff/source. | Launch review workflow. |
| `/workflow commit [message]` | Diff đã review và muốn commit local. | Launch guarded commit workflow. |
| `/workflow pr [title]` | Branch đã commit và muốn chuẩn bị PR. | Launch guarded PR workflow. |
| `/workflow onboard [focus]` | First-read onboarding cần agent đọc project. | Launch onboarding workflow để ghi `.pi/project-context.md` và context index. |
| `/onboard` | First-run setup/status. | Mở menu onboarding: status, run, profile, setup. |
| `/profile` | Xem/áp profile và chọn tech. | Chạy ngay, không gọi model. |
| `/profile setup` | Chọn profile + tech bằng option. | Ghi profile/lock/tech manifest. |
| `/usage` | Xem live usage hoặc report hint. | Menu live/history/preflight/compact/logs/efficiency. |
| `/name <name>` | Đặt tên session theo task. | Agent Watch/report map đúng task. |
| `/fresh task|scout|be-to-fe <request>` | Phiên hiện tại đã nặng hoặc muốn tách việc. | Mở session mới có tên và replay workflow prompt gọn. |
| `/context` | Xem index/search/pack/impact/efficiency/preflight/compact. | Menu context, không gọi model. |
| `/permission` | Xem/đổi quyền runtime. | Menu status/read-only/workspace-write/full-access. |
| `/memory` hoặc `/memory-policy` | Xem memory policy. | Chạy ngay, không gọi model. |
| `/model-options` | Xem hướng dẫn model/thinking. | Chạy ngay; chọn model vẫn dùng `/model` hoặc `Ctrl+L`. |
| `/piagent-mcp` | Xem/quản trị MCP trong Pi. | Menu MCP, không gọi model. |

Alias cũ vẫn giữ để không phá thói quen:

| Alias | Command chính |
|---|---|
| `/task <request>` | `/workflow task <request>` |
| `/scout <request>` | `/workflow scout <request>` |
| `/be-to-fe <request>` | `/workflow be-to-fe <request>` |
| `/commit [message]` | `/workflow commit [message]` |
| `/pr [title]` | `/workflow pr [title]` |
| `/setname <name>` | `/name <name>` |
| `/fresh-task <request>` | `/fresh task <request>` |
| `/fresh-scout <request>` | `/fresh scout <request>` |
| `/fresh-be-to-fe <request>` | `/fresh be-to-fe <request>` |
| `/context-index` | `/context index` |
| `/task-preflight` | `/context preflight` |
| `/permission-status`, `/read-only`, `/workspace-write`, `/full-access` | `/permission ...` |

Git flow của Pi cố ý không dùng namespace `/git-*`. Daily flow là nói tự nhiên hoặc đi qua `/workflow`:

```text
/workflow commit docs: update onboarding notes
/workflow pr Add guarded git workflow
```

Alias `/commit` và `/pr` vẫn chạy. Commit workflow chỉ tạo local commit. PR workflow có thể cần `git push` và GitHub write action, nên guard vẫn bắt agent xác nhận rõ branch/title/scope trước khi đẩy hoặc tạo PR. Các lệnh stage rộng như `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/` cũng bị đưa qua confirmation để tránh gom nhầm file riêng tư hoặc unrelated diff.

## Image/screenshot input

| Tình huống | Cách dùng | Kết quả |
|---|---|---|
| Chat box trả ra local path ảnh | `/workflow scout Check screenshot /var/folders/.../screenshot.png` | Platform attach ảnh và rewrite path thành `[image1]`. |
| Nhiều ảnh trong cùng prompt | Dán tối đa 4 path ảnh | Prompt có `[image1]`, `[image2]`, ... |
| Ảnh quá lớn | Dùng Pi `read` tool trên file ảnh hoặc resize ảnh trước | Tránh nhồi ảnh quá lớn vào chat input. |

Định dạng hỗ trợ: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`. Giới hạn mặc định: 4 ảnh/input, 8 MB/ảnh.

Profile name nên biết:

| Profile | Dùng khi nào |
|---|---|
| `generic` | Repo chưa rõ cấu trúc. |
| `web-frontend` | Chỉ FE. |
| `backend-api` | Chỉ BE/API. |
| `be-readonly-fe` | BE đọc-only, FE là nơi sửa. |
| `fullstack` | FE và BE đều có thể sửa nếu task cho phép. |
| `node-typescript` | Tooling/lib Node TypeScript. |
| `python` | Python app/lib. |
| `data` | ETL, dbt, data pipeline, notebook. |
| `devops` | Docker, Terraform, K8s, CI/CD. |
| `mobile` | React Native/Flutter. |
| `docs` | Docs/manual/portal. |

Tech stack option theo profile:

| Profile | Role bắt buộc chọn | Ví dụ |
|---|---|---|
| `web-frontend` | Frontend + database optional | `frontend=nextjs database=none` |
| `backend-api` | Backend + database optional | `backend=nestjs database=prisma` |
| `fullstack` | Frontend + backend + database optional | `frontend=nextjs backend=nestjs database=prisma` |
| `be-readonly-fe` | Frontend + backend + database optional | `frontend=react-vite backend=fastapi database=postgres` |
| `mobile` | Mobile | `mobile=react-native` |
| `devops` | DevOps | `devops=docker` |
| `data` | Data + database optional | `data=dbt database=postgres` |
| `docs` | Docs | `docs=mintlify` |

Sau khi chọn tech, platform tạo `.pi/tech-stack.json` và các file `.pi/tech-context/<tech>.json`. `/onboard run` sẽ đưa các pointer này vào `.pi/context-index.json`. File context chỉ nên chứa tóm tắt ngắn/citation từ Context7, không lưu nguyên văn docs dài, token, session, hoặc secret.

## Đọc tài liệu ngoài project

Tài liệu tải về `~/Downloads` rồi kéo vào CLI thường không đọc được, vì mặc định agent chỉ làm việc trong project. Tool `piagent_document_read` mở đúng một khe: đọc **tài liệu**, **chỉ đọc**, trong các folder đã cấp trước.

| Thành phần | Giá trị |
|---|---|
| Tool | `piagent_document_read` |
| Input | `path` — absolute, `~/...`, hoặc relative theo project |
| Định dạng | `.md`, `.markdown`, `.txt`, `.text`, `.csv`, `.tsv`, `.json`, `.yaml`, `.yml`, `.pdf`, `.docx` |
| Giới hạn | 12 MB/file; 400.000 ký tự sau khi trích, dài hơn thì cắt và báo `truncated` |
| Cấp quyền | `additionalReadRoots` trong `.pi/piagent-profile.json`, hoặc biến môi trường `PIAGENT_ADDITIONAL_READ_ROOTS` |

Cấp folder cố định trong profile:

```json
{
  "additionalReadRoots": ["~/Downloads", "~/Documents/specs"]
}
```

Cấp tạm cho một session, ngăn cách bằng `:` giống `PATH`:

```bash
PIAGENT_ADDITIONAL_READ_ROOTS="$HOME/Downloads:$HOME/Documents/specs" pi
```

Sau đó nói thẳng path là được: `Đọc ~/Downloads/spec-v2.docx rồi tóm tắt yêu cầu`.

Bốn ràng buộc không đổi khi cấp thêm root:

- **Chỉ đọc.** Root được cấp không mở quyền ghi, xoá, hay chạy lệnh trong đó.
- **Chỉ tài liệu.** File nằm trong root được cấp nhưng sai đuôi — `.pem`, `.sh`, `.env` — vẫn bị từ chối.
- **`protectedPaths` luôn thắng.** Root được cấp không mở được path mà project đang bảo vệ.
- **Nội dung là dữ liệu, không phải lệnh.** Text trả về đã qua redaction và có header nói rõ đây là dữ liệu người dùng; câu lệnh viết trong tài liệu không được thi hành.

Cả hai kiểm tra — nằm trong root và đúng đuôi — đều chạy trên path đã canonical hoá. Nên symlink trong root mà trỏ ra ngoài bị chặn, và symlink tên `notes.md` trỏ vào `id_rsa` cũng bị chặn.

`.docx` đọc trực tiếp, không cần cài gì; text bị xoá bởi tracked change chưa accept sẽ không lẫn vào nội dung. `.pdf` cần `pdftotext` (macOS `brew install poppler`, Debian/Ubuntu `apt install poppler-utils`); thiếu binary thì tool báo thiếu chứ không trả tài liệu rỗng.

## Command native của Pi

Các command này thuộc Pi core hoặc package Pi chính. Tên/availability có thể phụ thuộc version Pi.

| Command/hotkey | Dịch nghĩa | Dùng khi nào | Ghi chú |
|---|---|---|---|
| `/login` | Đăng nhập provider | Lần đầu dùng model OpenAI Codex hoặc model Anthropic Claude. | OAuth/session lưu local trong Pi, không commit repo. |
| `/model` | Chọn model | Muốn chọn OpenAI provider bằng native selector. | Đây là flow chính, không phải hỏi agent tự chọn thay. |
| `Ctrl+L` | Mở model selector | Đổi model nhanh. | Tương đương UI selector của Pi. |
| `/scoped-models` | Chỉnh danh sách model cycle | Muốn `Ctrl+P` chỉ xoay quanh vài model hay dùng. | Global setup seed sẵn provider model families. |
| `Ctrl+P` | Cycle model | Đổi model trong scope nhanh. | Dùng sau khi đã setup `enabledModels`. |
| `Shift+Ctrl+P` | Cycle model ngược | Quay lại model trước trong scope. | Tiện khi test provider. |
| `Shift+Tab` | Đổi thinking level | Chọn effort như `medium`, `high`, `xhigh`, `max` nếu model hỗ trợ. | Model không hỗ trợ level nào thì Pi có thể clamp. |
| `/session` | Xem session hiện tại | Cần session id/name/token/cost/context. | Dùng sau `pi --name` hoặc `/name` để kiểm tra tên. |
| `/resume` | Resume session | Khi tắt nhầm Pi hoặc muốn nối lại work cũ. | Dựa vào session list/id/name của Pi. |
| `/compact` | Nén context | Khi context usage cao trước task dài. | Chỉ dùng khi cần; đọc lại context quan trọng sau compact. |
| `/mcp` | Xem MCP | Kiểm tra server/tool MCP trong Pi. | Cần `pi-mcp-adapter` hoặc MCP config tương ứng. |
| `/mcp setup` | Setup/refresh MCP | Khi MCP chưa nhận config. | Tùy adapter/version. |
| `/mcp tools` | List MCP tools | Muốn biết server expose tool nào. | Dùng trước khi bảo agent gọi tool ngoài. |
| `/mcp reconnect` | Kết nối lại MCP | Khi server lỗi, token mới, hoặc config đổi. | Không thay thế việc export secret env. |
| `/mcp-auth figma` | OAuth Figma MCP | Khi dùng Figma remote MCP. | Có thể khác theo Figma/Pi MCP package version. |
| `/piagent-mcp` | Menu MCP | Không nhớ subcommand, hoặc muốn xem có việc gì cần làm. | Menu dựng theo project; không có select UI thì in thẳng bảng trạng thái. |
| `/piagent-mcp status` | Danh sách MCP server + state | Muốn biết server nào đang có, ở scope nào, sẵn sàng chưa. | Đọc config, không kiểm tra kết nối live — cái đó là `/mcp`. |
| `/piagent-mcp get <name>` | Chi tiết một server | Trước khi duyệt, hoặc khi không rõ scope nào đang có hiệu lực. | Giá trị credential bị mask; `${VAR}` in nguyên vì là tên biến. |
| `/piagent-mcp doctor` | Server nào chưa chạy được và thiếu gì | Sau khi cài, hoặc khi tool call MCP bị chặn. | Không probe Docker daemon; chạy `piagent-mcp doctor` ở terminal cho việc đó. |
| `/piagent-mcp approve <name>` | Duyệt server repo khai | Khi mở một repo có `.mcp.json`. | In định nghĩa ra trước khi ghi quyết định. Pin theo digest. |
| `/piagent-mcp reject <name>` | Từ chối | Không tin server repo khai. | `reset` để quên quyết định. |
| `/piagent-mcp enable\|disable <name>` | Bật/tắt server | Tắt tạm mà không mất định nghĩa. | Cần `/reload` để adapter nhận thay đổi. |

`/piagent-mcp` chạy thẳng trong session, không qua model. Thêm/xoá server và preset ở terminal: `piagent-mcp add|remove|--preset`.

## Command subagent

Các command này đến từ package `pi-subagents`. Tên hơi “package terminology”, nên bảng dưới dịch ra nghĩa thực tế.

Quan trọng: daily flow không bắt anh phải nhớ các lệnh này. Các workflow `/workflow task`, `/workflow be-to-fe`, `/workflow platform-improve`, `/workflow plan`, `/workflow review` dùng solo-first orchestration: parent agent lập task tree/review lenses trước, rồi chỉ spawn subagent khi task có phần việc độc lập và đáng token. Slash command dưới đây dùng khi anh muốn ép orchestration cụ thể hoặc debug.

| Command | Dịch nghĩa dễ hiểu | Dùng khi nào | Kết quả mong đợi |
|---|---|---|---|
| `/subagents-doctor` | Health check subagent | Khi mới setup, sau update, hoặc subagent không chạy. | Kiểm tra package, config, agent files, runtime readiness. |
| `/subagents-models` | Bản đồ model của subagent | Khi muốn biết mỗi agent đang inherit model nào hoặc override gì. | Hiện model/thinking/routing đang áp dụng cho subagents. |
| `/subagents` | Catalog/admin agents | Khi muốn xem agent nào có sẵn. | List builtin + piagent agents, có thể inspect metadata. |
| `/subagents-fleet` | Dashboard đội agent đang chạy | Khi có background/parallel subagents. | Hiện active/done runs, id, status, transcript/result nếu hỗ trợ. |
| `/subagent-cost` | Chi phí/token subagents | Khi muốn biết parent + child agents tiêu hao ra sao. | Hiện usage/cost theo runs nếu package/provider expose stats. |
| `/subagents-watchdog` | Giám sát run bị treo | Khi background agents có nguy cơ stuck/timeout. | Theo dõi/nhắc trạng thái tùy package. |
| `/subagents-watchdog recommend-model` | Gợi ý model watchdog | Khi muốn watchdog dùng model mạnh bổ sung với model chính. | Trả gợi ý model/thinking hiện tại. |
| `/subagents-watchdog on` | Bật watchdog | Khi muốn adversarial review ở cuối turn cho session/project. | Watchdog review repo edits ở `agent_end`; có thể tốn thêm token. |
| `/subagents-profiles` | List profiles | Khi team có nhiều provider/quota profile. | Hiện profiles trong `~/.pi/agent/profile/pi-subagents/`. |
| `/subagents-refresh-provider-models <provider>` | Refresh model catalog | Khi model registry/provider thay đổi. | Probe/cache catalog provider. |
| `/subagents-generate-profiles <provider>` | Sinh quota/quality profiles | Khi muốn profile model theo quota/chất lượng. | Tạo profile cho provider. |
| `/subagents-check-profile <name>` | Check profile | Khi profile/model có thể stale. | Re-check model availability/auth. |
| `/run <agent> "<task>"` | Chạy 1 subagent | Khi cần 1 scout/reviewer/planner riêng context. | Child session chạy task rồi trả summary về parent. |
| `/run <agent> "<task>" --bg` | Chạy background | Khi muốn agent chạy nền rồi mình xem sau. | Dùng `/subagents-fleet` để follow. |
| `/run <agent> "<task>" --fork` | Chạy từ forked session | Khi child cần inherited conversation/context branch. | Fork thật từ parent leaf; dùng fresh nếu không cần history. |
| `/parallel ...` | Chạy nhiều agent song song | Khi các việc độc lập, nhất là read-only review/scout/test analysis. | Parent đợi hoặc gom kết quả tùy flow. |
| `/chain ...` | Chạy tuần tự | Khi output agent trước là input agent sau. | Dùng `{previous}` để truyền summary trước đó. |
| `/run-chain <name>` | Chạy chain đã lưu | Khi có workflow lặp lại. | Package chạy recipe chain đã định nghĩa. |
| `/parallel-review` | Review song song | Khi cần nhiều reviewer theo góc nhìn độc lập. | Có thể thêm `autofix` nếu đã cho phép sửa. |
| `/review-loop` | Worker/reviewer/fix loop | Khi muốn review đến khi sạch hoặc hết vòng. | Nên set max rounds, thường dùng tối đa 3 vòng. |
| `/parallel-research` | Research song song | Khi cần external evidence + local scout. | Builtin `researcher` cần `pi-web-access`. |
| `/parallel-context-build` | Build context handoff | Khi task lớn cần `context.md`/meta-prompt trước planning. | Dùng `context-builder` agents. |
| `/parallel-handoff-plan` | Research + context + plan | Khi muốn handoff plan đầy đủ cho implementation. | Tốt cho architecture hoặc platform change lớn. |
| `/gather-context-and-clarify` | Scout rồi hỏi đúng câu | Khi requirement chưa rõ nhưng cần đọc trước. | Trả clarification questions có evidence. |
| `/parallel-cleanup` | Cleanup review sau implement | Khi muốn rà cleanup đáng làm. | Có thể thêm `autofix`. |

Glossary:

| Từ | Nghĩa trong repo mình |
|---|---|
| `doctor` | Kiểm tra sức khỏe/setup, không sửa logic task. |
| `models` | Cho biết model/thinking từng subagent sẽ dùng. |
| `fleet` | “Đội” child sessions đang chạy hoặc vừa chạy xong. |
| `scout` | Agent đọc/map code read-only. |
| `planner` | Agent lập plan và verify gate, không sửa code. |
| `worker` | Agent sửa code theo plan. |
| `reviewer` | Agent review diff/test/scope. |
| `oracle` | Agent phản biện/risk challenge. |
| `researcher` | Builtin agent nghiên cứu web/docs có nguồn; cần `pi-web-access`. |
| `context-builder` | Builtin agent tạo context/meta-prompt handoff cho task lớn. |
| `chain` | Làm A rồi dùng kết quả A để làm B. |
| `parallel` | Làm nhiều nhánh độc lập cùng lúc. |
| `bg` | Background run, không block parent ngay. |
| `fork` | Child bắt đầu từ nhánh session hiện tại thay vì context fresh. |
| `watchdog` | Opt-in adversarial reviewer ở cuối turn; không phải `reviewer` subagent. |
| `worktree` | Checkout riêng cho parallel writers để tránh đè file nhau. |

Piagent subagents:

| Agent | Khi dùng | Write policy |
|---|---|---|
| `piagent-scout` | Map repo/module/spec trước khi sửa. | Read-only. |
| `piagent-planner` | Lập implementation plan. | Read-only. |
| `piagent-worker` | Implement task đã rõ/đã approve. | Có thể write trong scope. |
| `piagent-reviewer` | Review diff, verify coverage, scope drift. | Review-first. |
| `piagent-oracle` | Challenge architecture/risk. | Read-only. |

## Exact subagent control syntax

Dùng khi muốn chính xác hơn slash command:

```text
subagent({ agent: "piagent-scout", task: "Map the auth flow. Read-only.", context: "fresh" })
```

Status:

```text
subagent({ action: "status" })
subagent({ action: "status", id: "<run-id>", view: "transcript" })
```

Điều khiển run:

```text
subagent({ action: "steer", id: "<run-id>", message: "Focus only on tests." })
subagent({ action: "stop", id: "<run-id>" })
subagent({ action: "resume", id: "<run-id>", message: "Continue after this clarification." })
```

Rule thực tế: dùng slash/natural prompt cho hầu hết task; dùng tool syntax khi cần debug run id hoặc steer/stop chính xác.

Một số option hữu ích:

```text
/run reviewer[model=anthropic/claude-sonnet-5:high] "Review this diff"
/run scout[output=context.md,outputMode=file-only] "Map auth flow"
/chain scout[output=context.md,as=context] "Scan" -> planner[reads=context.md] "Plan from {outputs.context}"
subagent({ action: "status", view: "fleet" })
subagent({ action: "status", id: "<run-id>", view: "transcript", lines: 120 })
subagent({ action: "grant-spawn-budget", additional: 10 })
```

`outputMode=file-only` hữu ích khi child tạo report dài: parent chỉ nhận đường dẫn file, không bị nhồi full report vào context.

## Khi nào nên spawn subagent

Theo provider docs, subagent tốt nhất cho việc độc lập và bounded:

- codebase exploration;
- map contract/API/schema;
- đọc docs/spec dài rồi tóm tắt;
- review correctness/security/tests/scope drift theo nhiều góc nhìn;
- chạy/test analysis không cần sửa cùng file;
- compress context trước khi parent/worker implement.

Không nên spawn bừa khi:

- task nhỏ, một file, verify đơn giản;
- nhiều writer cùng sửa chung vùng source;
- requirement chưa rõ;
- cần quyết định product/architecture từ user;
- repo đang dirty mà chưa hiểu thay đổi của ai.

Default của platform là an toàn:

- `maxSubagentDepth: 1`: parent spawn child, child không fan-out tiếp.
- `parallel.concurrency: 3`: không mở quá nhiều child cùng lúc.
- `asyncByDefault: false`: không tự chạy background nếu anh không yêu cầu.
- Một `piagent-worker` tại một thời điểm; parallel chủ yếu dùng cho scout/reviewer.

Nếu anh không gọi gì thêm, `/workflow task` vẫn chạy solo-first và chỉ tự dùng subagent theo `docs/auto-delegation-policy.md` khi có scout/planning/review độc lập đáng làm. Alias `/task` giữ cùng policy.

## Prompt mẫu cho bài toán thật

### Platform/package improvement

```text
/workflow platform-improve Improve onboarding, model scope, MCP setup, and verification docs for team usage. Keep workflows public, project-agnostic, and verifiable.
```

Khi muốn tách rõ agents:

```text
Use piagent-scout to map current platform docs/scripts read-only.
Use piagent-scout to inspect relevant external source context read-only when the user provides it.
Then use piagent-planner to produce an implementation plan.
Only after plan is clear, use piagent-worker for implementation.
Use piagent-reviewer before final.
```

### BE spec lên FE, không sửa BE

```text
/profile be-readonly-fe
/workflow be-to-fe Implement FE support for <endpoint/spec>. Scout backend read-only, map contract, then edit frontend only.
```

Nếu muốn parallel read-only:

```text
Run parallel piagent-scout agents: one maps backend contract read-only, one maps frontend route/state usage. Wait for both, then plan FE implementation.
```

### Review trước khi ship

```text
/review current diff
```

Hoặc chia reviewer:

```text
/parallel piagent-reviewer "Review correctness and edge cases" -> piagent-reviewer "Review tests and verification gaps" -> piagent-reviewer "Review scope drift and protected paths"
```

## Terminal commands

Các lệnh này chạy ngoài Pi.

| Command | Dùng khi nào |
|---|---|
| `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.82.0` | Cài Pi CLI tương thích với release hiện tại. |
| `npm install -g --ignore-scripts @piagent/platform@1.2.9` | Cài terminal helper `piagent-*` từ release tag hiện tại. |
| `pi install git:github.com/Vt-mmm/piagent@v1.2.9` | Cài pinned release khi cần reproducible team setup. |
| `pi install git:github.com/Vt-mmm/piagent` | Cài latest package platform cho máy cá nhân/sandbox. |
| `piagent-update --check` | Báo version hiện tại vs version sẽ lên cho cả ba thành phần; không cài gì. |
| `piagent-update` | Full update global một lệnh cho cả máy: Pi host → npm-global helper → Pi package, đúng thứ tự release yêu cầu. |
| `piagent-update --version X.Y.Z` | Update tới đúng một release thay vì latest; dùng cho rollout theo lô hoặc rollback. |
| `piagent-update --project <path>` | Bước phụ sau global update: migrate project cũ nếu có rồi chạy doctor strict-share cho project đó. |
| `piagent-update --npm-prefix ~/.pi/npm-global` | Ép updater cài host/helper vào npm global prefix của user; hữu ích khi `/usr/local/lib/node_modules` không ghi được. |
| `npm exec -y --package @piagent/platform@X.Y.Z -- piagent-update --version X.Y.Z --force` | Bootstrap/update global cho máy chưa có `piagent-update`; chạy từ Terminal, không cần mở Pi. |
| `PIAGENT_NO_UPDATE_CHECK=1` | Tắt notice "có bản mới" ở đầu session Pi. Mặc định bật, hỏi registry nhiều nhất một lần mỗi 24 giờ ở tiến trình nền. |
| Cài exact Pi host của release, rồi `npm install -g --ignore-scripts @piagent/platform@X.Y.Z` và `piagent-install --stable` | Sequence thủ công tương đương. Thứ tự bắt buộc: `piagent-install` fail nếu Pi host lệch bản pin và không tự cài host. Version pin của từng release nằm trong [release/install policy](release-install-policy.md). |
| Cài exact Pi host ghi trong release cũ, rồi helper `vPREVIOUS` và `piagent-install --stable` | Full rollback; đánh giá dependency risk của host cũ trước khi hạ version. |
| `piagent-install --stable --dry-run` | Preview Pi package matching với helper hiện tại; stable resolve tag → commit SHA. |
| `piagent-install --stable` | Cài Pi package matching với helper hiện tại bằng resolved commit SHA. |
| `piagent-install --version vX.Y.Z --resolve-tag` | Chỉ đổi Pi package; npm-global helper giữ nguyên version. |
| `piagent-install --version vX.Y.Z` | Chỉ đổi Pi package theo exact tag literal khi cần giữ behavior cũ. |
| `piagent-install --dev` | Theo moving source cho máy cá nhân/sandbox; không commit vào `.pi/settings.json`. |
| `pi update --extensions` | Refresh package đã cài; với pinned tag/commit, muốn nâng version thì chạy lại install bằng ref mới. |
| `pi list --approve` | Xem package Pi đã install. |
| `piagent-auto` | Mở Pi với project trust `--approve` cho lần chạy hiện tại; guard vẫn bật. |
| `piagent-auto --read-only -p "<task>"` | Auto-run scout/read-only; guard chặn shell/write/unknown tool. |
| `piagent-auto --full-access -p "<task>"` | Trusted automation style; không tắt protected paths/redaction/human gates. |
| `pi` rồi `/permission full-access <task>` | Một lệnh trong Pi để bật full-access cho session và giao task. Alias `/full-access <task>` vẫn chạy. |
| `pi --list-models` | Xem model Pi thấy được theo credentials hiện tại. |
| `piagent-install --with-mcp --with-subagents` | Cài global package + MCP + subagent baseline từ package bin. |
| `piagent-setup <project> --profile auto` | Setup đầy đủ cho một project khi muốn preseed bằng bin. |
| `piagent-init <project> --profile generic` | Init project files tối thiểu. |
| `piagent-models` | Xem catalog model seeded bởi platform. |
| `piagent-model-scope --preset full` | Re-apply full provider model scope. |
| `piagent-mcp --preset core --scope global --replace` | Apply the governed MCP core baseline: Context7, Chrome DevTools, GitHub. |
| `piagent-mcp --preset popular --scope global --replace` | Apply the governed MCP popular baseline: core + Playwright + Figma remote. |
| `piagent-mcp --list` | List MCP presets. |
| `piagent-subagents --preset safe` | Re-apply subagent safe config. |
| `pi install npm:pi-web-access@0.17.0` | Cấp web/search/fetch tools cho builtin `researcher`; platform setup/update cài mặc định từ `v1.2.8`. |
| `piagent-setup <project> --no-web-access` | Setup project nhưng bỏ web access khi máy không được phép browse/fetch external source. |
| `piagent-usage /path/to/project` | Lấy exact usage của session mới nhất từ terminal khác. |
| `piagent-usage --history /path/to/project --days 7` | Tổng usage lịch sử của project, gồm session đã end. |
| `piagent-usage --history --all-projects --days 7 --csv` | Xuất usage tuần toàn máy để đưa vào report. |
| `piagent-doctor /path/to/project --strict-share` | Kiểm tra project có share/open-source được không. |
| `piagent-uninstall` | Báo cáo những gì sẽ được gỡ. Dry run, không đụng gì. |
| `piagent-uninstall --apply` | Gỡ Pi package của platform khỏi Pi settings global. |
| `piagent-uninstall --apply --with-addons --with-host` | Gỡ thêm pi-mcp-adapter, pi-subagents, pi-web-access và Pi host. |
| `piagent-uninstall --apply --project /path/to/project` | Gỡ thêm state của platform trong project: profile, lock, `piagent-state/`. |
| `piagent-benchmark ...` | Ghi quality benchmark bằng package bin. |
| `bash scripts/verify-local.sh` | Verify repo platform trước khi commit/tag. |
| `bash scripts/verify-local.sh --offline` | Verify trong CI/máy sạch, bỏ qua local Pi model catalog. |
| `bash scripts/setup.sh <project> ...` | Preseed setup project; không bắt buộc cho daily flow. |
| `bash scripts/quality-benchmark.sh ...` | Ghi quality benchmark theo scenario thật. |

Trong output `piagent-install`, `currentRelease` là version của terminal helper đang chạy, không phải lời xác nhận rằng npm-global helper vừa được update. Checklist đầy đủ nằm tại [release/install policy](release-install-policy.md).

Khi đang develop chính repo `piagent`, có thể dùng npm scripts tương ứng:

| Command | Tương đương |
|---|---|
| `npm run verify` | `bash scripts/verify-local.sh` |
| `npm run setup -- <project>` | `bash scripts/setup.sh <project>` |
| `npm run install-global` | `bash scripts/install-global.sh` |
| `npm run init-project -- <project>` | `bash scripts/init-project.sh <project>` |
| `npm run doctor -- <project> --strict-share` | `bash scripts/team-doctor.sh <project> --strict-share` |
| `npm run benchmark -- ...` | `bash scripts/quality-benchmark.sh ...` |
| `npm run usage -- <project>` | `bash scripts/pi-session-stats.sh <project>` |
| `npm run usage -- --history <project> --days 7` | `bash scripts/pi-session-stats.sh --history <project> --days 7` |
| `npm run models` | `bash scripts/pi-model-catalog.sh` |
| `npm run model-scope -- --preset full` | `bash scripts/configure-model-scope.sh --preset full` |
| `npm run mcp -- --preset core --scope global --replace` | `node scripts/mcp-manage.mjs --preset core --scope global --replace` |
| `npm run subagents -- --preset safe` | `bash scripts/configure-subagents.sh --preset safe` |

## MCP command quick map

| Muốn làm gì | Gõ |
|---|---|
| Kiểm tra MCP trong Pi | `/mcp` |
| Xem tool MCP | `/mcp tools` |
| Reconnect sau khi đổi config/env | `/mcp reconnect` |
| Apply global Context7/Chrome/GitHub baseline | `piagent-mcp --preset core --scope global --replace` |
| Apply Figma/Playwright baseline | `piagent-mcp --preset popular --scope global --replace` |
| Xem preset | `piagent-mcp --list` |

Secret phải để trong env, không commit:

```bash
export CONTEXT7_API_KEY=ctx7sk_...
export GITHUB_PERSONAL_ACCESS_TOKEN=<github-token>
```

## Token/context command quick map

| Câu hỏi | Lệnh |
|---|---|
| Session này đang dùng model gì? | `/session` hoặc `/usage` |
| Đặt/đổi tên session đang mở? | `/name <task/session name>` |
| Tắt nhầm, mở lại session gần nhất? | `pi --continue` |
| Chọn lại session cũ theo tên/id? | `pi --resume` hoặc `pi --session <id-or-file>` |
| Context window đang còn bao nhiêu? | `/usage` |
| Output test/build dài bị nén thì xem ở đâu? | `/logs` |
| Exact token/cost từ terminal khác? | `piagent-usage /path/to/project` |
| Tổng token/cost các session cũ? | `piagent-usage --history /path/to/project --days 7` |
| CSV report cuối tuần toàn máy? | `piagent-usage --history --all-projects --days 7 --csv` |
| Subagents tốn bao nhiêu? | `/subagent-cost` |
| Có nên compact chưa? | Xem `contextUsage.percent`; trên 75% mới cân nhắc `/compact`. |

Không claim tiết kiệm token/cost nếu chưa có số liệu cùng scenario. Dùng benchmark script để ghi lại.

## Source rule cho subagent/custom agent

Mental model chuẩn:

1. Parent Pi là coordinator: giữ requirement, quyết định, final output.
2. Subagent là child session: có context riêng, có thể dùng model/tool riêng hoặc inherit parent.
3. Child trả summary/result về parent; parent không nên bị nhồi toàn bộ log trung gian.
4. Dùng read-only subagents trước: scout, docs research, review, test-gap analysis.
5. Writer song song chỉ dùng khi có worktree isolation và write set không overlap.
6. Agent custom tốt phải có role hẹp, tool surface rõ, output contract rõ.

Đây là lý do platform mình có `piagent-scout`, `piagent-planner`, `piagent-worker`, `piagent-reviewer`, `piagent-oracle` thay vì một agent tổng quát làm tất cả.

## Tài liệu chính

- Pi usage docs: https://pi.dev/docs/latest/usage
- Pi packages: https://pi.dev/packages
- pi-subagents package: https://pi.dev/packages/pi-subagents

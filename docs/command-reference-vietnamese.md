# Command reference tiếng Việt

> Nếu cần flow đầy đủ theo thứ tự dùng thật, đọc `docs/operator-manual-vietnamese.md`. File này chỉ là bảng tra cứu command.

File này là bảng tra cứu command chính cho Pi Agent Platform. Mục tiêu là khi anh/team mở Herdr, `cd` vào project, chạy `pi`, thì biết rõ lệnh nào dùng cho việc gì.

## Cách đọc command

Có 4 loại command khác nhau:

| Loại | Gõ ở đâu | Ví dụ | Ý nghĩa |
|---|---|---|---|
| Terminal command | Terminal đã có Bash | `piagent-mcp --preset core` | Cài, kiểm tra, hoặc cấu hình máy/project từ bên ngoài Pi. macOS Apple Silicon và Linux x64 đã verify; macOS Intel/Linux ARM64 cần smoke trước rollout; native Windows chưa là target team; WSL2 experimental. |
| Pi slash command | Bên trong Pi TUI | `/onboard-project` | Gọi workflow/prompt/package command trong Pi session hiện tại. |
| Pi hotkey | Bên trong Pi TUI | `Ctrl+L` | Mở UI nhanh, thường dùng cho model/session. |
| Tool syntax | Bên trong Pi, khi cần chính xác | `subagent({ action: "status" })` | Gọi đúng tool/action, dùng khi slash command hoặc natural prompt chưa đủ rõ. |

Nếu không chắc một slash command có sẵn chưa, mở Pi và gõ `/` để xem danh sách command của session hiện tại. Command có thể khác nhau theo package đã install, provider đã login, và project trust.

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
/piagent-commands
/onboard-project
/context-index
/memory-policy
```

Các lần sau:

```bash
cd /path/to/project
pi
```

Trong Pi:

```text
/task Implement <task cụ thể>.
```

Nếu chỉ scout/audit read-only:

```text
/scout Scout payment FE mapping vs BE. Do not edit source.
```

Nếu session đang nặng hoặc Pi báo context overflow, dùng fresh workflow:

```text
/fresh-scout <read-only request>
/fresh-task <implementation request>
/fresh-be-to-fe <BE-readonly/FE request>
```

Nếu task còn mơ hồ:

```text
/discuss <ý tưởng hoặc yêu cầu thô>
/plan <goal cần bóc tách>
```

## Nguyên tắc command/UX

Pi Agent dùng ít namespace nhưng mỗi namespace có subcommand rõ:

- `/profile` là namespace duy nhất cho profile và tech stack; không dùng `/profiles` hoặc `/profile-tech` riêng.
- Status command như `/profile`, `/permission-status`, `/context-index`, `/piagent-orchestration` phải ngắn và không gọi model follow-up.
- Khi user cần chọn, ưu tiên select option. Khi UI select không khả dụng, trả về exact apply command để chạy ngay.
- Long list chỉ hiện khi gõ `list`, `options`, hoặc `/piagent-commands <topic>`.
- Hành động rủi ro như stage rộng, push, PR write, deploy, publish, thay đổi database hoặc external-provider write vẫn cần xác nhận người vận hành.

## Command của platform mình

Các command này đến từ package `piagent-core`.

| Command | Dịch nghĩa | Dùng khi nào | Kết quả mong đợi |
|---|---|---|---|
| `/piagent-commands` | Bảng hướng dẫn command | Khi không nhớ command hoặc muốn giải thích cho team mới. | Agent tóm tắt command theo đúng ngữ cảnh project. |
| `/permission-status` | Xem quyền runtime | Khi muốn biết session đang là read-only, workspace-write, hay full-access. | Hiện active permission profile và guard boundary còn giữ. |
| `/read-only` | Chuyển session sang read-only | Khi chỉ muốn scout/audit/review, không sửa source. | Shell/write/unknown tool bị chặn trước execution. |
| `/workspace-write` | Chuyển session sang write chuẩn | Khi quay về mode implement bình thường. | Guard trở về profile implementation mặc định. |
| `/full-access` | Bật trusted full-access | Khi repo đã trusted và muốn agent có quyền workspace rộng hơn. | Tool/scope autonomy được nới trong session; protected paths/redaction/human gates vẫn bật. |
| `/full-access <task>` | Bật full-access rồi chạy task | Khi muốn một lệnh vừa cấp quyền vừa giao việc. | Session chuyển sang `trusted-full-access`, phần `<task>` được gửi tiếp cho agent. |
| `/onboard-project` | Đọc project lần đầu | Lần đầu gắn repo vào Pi, sau `/login` và `/model`. | Tạo/cập nhật `.pi/piagent-profile.json`, `.pi/project-context.md`, `.pi/context-index.json`, `.pi/memory/*`. |
| `/context-index` | Xem bản đồ context | Khi muốn biết context index đã generate chưa mà không burn token. | Hiện node/edge/citation/warning ngắn, không gọi model follow-up. |
| `/context-index search <keyword>` | Tìm trong bản đồ context | Khi cần điểm vào module/tech/risk trước khi scout rộng. | Trả các node khớp keyword; vẫn phải đọc file được cite trước khi sửa. |
| `/profile` | Xem profile ngắn | Khi muốn biết mode hiện tại mà không burn token. | Hiện status ngắn, không gọi model follow-up. |
| `/profile list` | Xem profile có sẵn | Khi chưa nhớ tên profile. | Hiện list compact. |
| `/profile <profile>` | Áp profile ngay | Khi đã biết profile muốn dùng. | Ghi `.pi/piagent-profile.json` và lock ngay, không hỏi vòng. |
| `/profile auto` | Áp profile recommend | Khi muốn auto-detect và apply luôn. | Detect profile rồi ghi profile/lock ngay. |
| `/profile setup` | Chọn profile + tech bằng option | Khi onboarding hoặc muốn đổi profile/stack mà không chat dài. | Mở select profile, rồi select tech theo role; fallback là card ngắn + lệnh apply chính xác nếu UI select chưa có. |
| `/profile setup fullstack` | Chọn tech cho fullstack | Khi đã biết profile là fullstack. | Chọn frontend, backend, database rồi ghi `.pi/tech-stack.json` và `.pi/tech-context/*` placeholder. |
| `/profile fe`, `/profile be`, `/profile full`, `/profile be-fe` | Alias ngắn | Khi muốn gõ nhanh. | Map sang `web-frontend`, `backend-api`, `fullstack`, `be-readonly-fe`. |
| `/profile tech` | Xem tech stack hiện tại | Khi muốn biết profile đã gắn tech nào và Context7 đã record chưa. | Hiện manifest + pending Context7 ngắn, không gọi model follow-up. |
| `/profile tech setup [profile]` | Wizard chọn tech | Khi muốn chọn tech theo role bằng UI select. | FE profile chọn FE + DB; BE profile chọn BE + DB; fullstack chọn FE + BE + DB. |
| `/profile tech options [profile]` | Xem option tech | Khi UI select không có hoặc muốn lấy lệnh apply. | Hiện option theo role và lệnh mẫu `/profile tech apply ...`. |
| `/profile tech apply fullstack frontend=nextjs backend=nestjs database=prisma` | Apply trực tiếp | Khi team muốn một lệnh deterministic, không chat dài. | Ghi profile, lock, tech manifest, Context7 placeholders. |
| `/profile tech refresh` | Xem Context7 cần record | Sau khi chọn tech stack. | Hiện các query Context7 cần đọc và record bằng tool runtime. |
| `/memory-policy` | Kiểm tra memory | Khi muốn biết Pi đang nhớ gì, hoặc muốn lưu memory explicit. | Hiện chính sách memory và file `.pi/memory/*`. |
| `/piagent-orchestration` | Xem policy solo/subagent | Khi muốn biết task sẽ chạy solo-first, lens nào, Field Guide nào. | Hiện status compact, không gọi model follow-up. |
| `/model-options` | Giải thích model | Khi chưa rõ chọn provider model nào, thinking nào. | Giải thích selector, scope, thinking, benchmark rule. |
| `/task-preflight` | Kiểm context trước task | Trước task lớn/risk cao hoặc khi session đã dài. | Báo nên chạy trực tiếp, compact, hay fresh session. |
| `/task-preflight compact` | Compact có hướng dẫn | Khi context 70%+ hoặc trước task dài tiếp theo. | Pi compact session, giữ quyết định/open blockers/verify cần thiết. |
| `/piagent-usage` | Snapshot token/context | Khi muốn biết session đang ăn context/token như nào. | Hiện session file, model, live context, lệnh lấy exact stats. |
| `/platform-improve` | Cải tiến platform/workflow | Khi cần cập nhật setup, prompt, MCP, model scope, memory, runtime policy, docs, hoặc subagent workflow. | Có implementation matrix, source changes, docs, và verify. |
| `/be-to-fe` | Map BE spec sang FE | Khi BE là source-of-truth/read-only, chỉ implement FE. | Scout BE read-only, map contract, implement FE, verify FE. |
| `/scout` | Scout/audit read-only | Khi cần evidence matrix trước khi chốt task, đặc biệt payment/auth/data/BE contract. | Không sửa source; trả context manifest, verify, gaps, risks. |
| `/fresh-scout` | Scout trong session mới | Khi task scout lớn hoặc session hiện tại nặng. | Tự mở session mới và chạy `/scout` với request ngắn. |
| `/fresh-task` | Task trong session mới | Khi implementation mới không nên kéo context cũ. | Tự mở session mới và chạy `/task`. |
| `/fresh-be-to-fe` | BE→FE trong session mới | Khi mapping BE/FE lớn hoặc session hiện tại đã phình. | Tự mở session mới và chạy `/be-to-fe`. |
| `/task` | Implement task chuẩn | Khi requirement đã rõ. | Có task contract, context manifest, verify, trace, gate. |
| `/commit [message/scope]` | Commit local có guard | Khi diff đã review và muốn tạo commit gọn. | Stage file rõ ràng, chạy verify phù hợp, commit local; không push. |
| `/pr [title/request]` | Chuẩn bị pull request | Khi branch đã commit xong và muốn mở PR. | Check status/branch/remote, verify, hỏi xác nhận trước push hoặc tạo/cập nhật PR. |
| `/plan` | Lập kế hoạch | Khi cần bóc task trước khi sửa. | Plan có scope, file target, verify, risk. |
| `/discuss` | Trao đổi/làm rõ | Khi chưa nên sửa code. | Giải thích option/tradeoff, không tự implement. |
| `/review` | Review current diff/source | Khi cần audit read-only trước final/merge. | Findings theo severity, file/area, required fix. |

Git flow của Pi cố ý không dùng namespace `/git-*`. Daily flow là nói tự nhiên hoặc dùng lệnh ngắn:

```text
/commit docs: update onboarding notes
/pr Add guarded git workflow
```

`/commit` chỉ tạo local commit. `/pr` có thể cần `git push` và GitHub write action, nên guard vẫn bắt agent xác nhận rõ branch/title/scope trước khi đẩy hoặc tạo PR. Các lệnh stage rộng như `git add .`, `git add -A`, `git add --all`, `git add -- .`, `git add :/` cũng bị đưa qua confirmation để tránh gom nhầm file riêng tư hoặc unrelated diff.

## Image/screenshot input

| Tình huống | Cách dùng | Kết quả |
|---|---|---|
| Chat box trả ra local path ảnh | `/scout Check screenshot /var/folders/.../screenshot.png` | Platform attach ảnh và rewrite path thành `[image1]`. |
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

Sau khi chọn tech, platform tạo `.pi/tech-stack.json` và các file `.pi/tech-context/<tech>.json`. `/onboard-project` sẽ đưa các pointer này vào `.pi/context-index.json`. File context chỉ nên chứa tóm tắt ngắn/citation từ Context7, không lưu nguyên văn docs dài, token, session, hoặc secret.

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
| `/login` | Đăng nhập provider | Lần đầu dùng OpenAI/Codex hoặc Anthropic/Claude. | OAuth/session lưu local trong Pi, không commit repo. |
| `/model` | Chọn model | Muốn chọn OpenAI provider bằng native selector. | Đây là flow chính, không phải hỏi agent tự chọn thay. |
| `Ctrl+L` | Mở model selector | Đổi model nhanh. | Tương đương UI selector của Pi. |
| `/scoped-models` | Chỉnh danh sách model cycle | Muốn `Ctrl+P` chỉ xoay quanh vài model hay dùng. | Global setup seed sẵn provider model families. |
| `Ctrl+P` | Cycle model | Đổi model trong scope nhanh. | Dùng sau khi đã setup `enabledModels`. |
| `Shift+Ctrl+P` | Cycle model ngược | Quay lại model trước trong scope. | Tiện khi test provider. |
| `Shift+Tab` | Đổi thinking level | Chọn effort như `medium`, `high`, `xhigh`, `max` nếu model hỗ trợ. | Model không hỗ trợ level nào thì Pi có thể clamp. |
| `/session` | Xem session hiện tại | Cần session id/name/token/cost/context. | Dùng cùng `/piagent-usage`. |
| `/resume` | Resume session | Khi tắt nhầm Pi hoặc muốn nối lại work cũ. | Dựa vào session list/id/name của Pi. |
| `/compact` | Nén context | Khi context usage cao trước task dài. | Chỉ dùng khi cần; đọc lại context quan trọng sau compact. |
| `/mcp` | Xem MCP | Kiểm tra server/tool MCP trong Pi. | Cần `pi-mcp-adapter` hoặc MCP config tương ứng. |
| `/mcp setup` | Setup/refresh MCP | Khi MCP chưa nhận config. | Tùy adapter/version. |
| `/mcp tools` | List MCP tools | Muốn biết server expose tool nào. | Dùng trước khi bảo agent gọi tool ngoài. |
| `/mcp reconnect` | Kết nối lại MCP | Khi server lỗi, token mới, hoặc config đổi. | Không thay thế việc export secret env. |
| `/mcp-auth figma` | OAuth Figma MCP | Khi dùng Figma remote MCP. | Có thể khác theo Figma/Pi MCP package version. |

## Command subagent

Các command này đến từ package `pi-subagents`. Tên hơi “package terminology”, nên bảng dưới dịch ra nghĩa thực tế.

Quan trọng: daily flow không bắt anh phải nhớ các lệnh này. Các workflow `/task`, `/be-to-fe`, `/platform-improve`, `/plan`, `/review` dùng solo-first orchestration: parent agent lập task tree/review lenses trước, rồi chỉ spawn subagent khi task có phần việc độc lập và đáng token. Slash command dưới đây dùng khi anh muốn ép orchestration cụ thể hoặc debug.

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

Nếu anh không gọi gì thêm, `/task` vẫn chạy solo-first và chỉ tự dùng subagent theo `docs/auto-delegation-policy.md` khi có scout/planning/review độc lập đáng làm.

## Prompt mẫu cho bài toán thật

### Platform/package improvement

```text
/platform-improve Improve onboarding, model scope, MCP setup, and verification docs for team usage. Keep workflows public, project-agnostic, and verifiable.
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
/be-to-fe Implement FE support for <endpoint/spec>. Scout backend read-only, map contract, then edit frontend only.
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
| `npm install -g --ignore-scripts @piagent/platform@1.1.1` | Cài terminal helper `piagent-*` từ release tag hiện tại. |
| `pi install git:github.com/Vt-mmm/piagent@v1.1.1` | Cài pinned release khi cần reproducible team setup. |
| `pi install git:github.com/Vt-mmm/piagent` | Cài latest package platform cho máy cá nhân/sandbox. |
| Cài exact Pi host của release, rồi `npm install -g --ignore-scripts @piagent/platform@X.Y.Z` và `piagent-install --stable` | Full update: đồng bộ host, npm-global helper và Pi package. Mỗi release pin một Pi host chính xác; lấy đúng version của release đang cài trong [release/install policy](release-install-policy.md). |
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
| `pi` rồi `/full-access <task>` | Một lệnh trong Pi để bật full-access cho session và giao task. |
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
| `pi install npm:pi-web-access@0.13.0` | Optional: cấp web/search/fetch tools cho builtin `researcher`. |
| `piagent-setup <project> --with-web-access` | Setup project + optional web access cho research subagents. |
| `piagent-usage /path/to/project` | Lấy exact session usage từ terminal khác. |
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
| `npm run models` | `bash scripts/pi-model-catalog.sh` |
| `npm run model-scope -- --preset full` | `bash scripts/configure-model-scope.sh --preset full` |
| `npm run mcp -- --preset core --scope global --replace` | `bash scripts/configure-mcp.sh --preset core --scope global --replace` |
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
| Session này đang dùng model gì? | `/session` hoặc `/piagent-usage` |
| Context window đang còn bao nhiêu? | `/piagent-usage` |
| Exact token/cost từ terminal khác? | `piagent-usage /path/to/project` |
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

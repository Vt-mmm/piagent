# MCP và tool policy

## Kết luận hiện tại

Pi core không hard-code MCP. Platform của mình cài `pi-mcp-adapter` để Pi dùng MCP theo kiểu token-efficient: một proxy tool tên `mcp`, server lazy-connect, metadata cache, output guard. Project profile chỉ khai báo capability được phép; MCP config mới khai báo server thật.

**Ba thứ tên giống nhau nhưng không liên quan nhau** — chỗ này gây nhầm nhiều nhất:

| Thứ | Ở đâu | Là gì |
|---|---|---|
| `mcpCapabilities: ["github", ...]` | `.pi/piagent-profile.json` | Nhãn capability dùng cho tool registry |
| `toolCapabilities: { "github": ["github"] }` | `base-policy.json` | Map một tool **tên là `github`** sang capability |
| server `github` | `~/.config/mcp/mcp.json` | Server MCP thật, chạy qua Docker |

Không có dòng code nào map capability name sang MCP server id. Khai `"github"` trong `mcpCapabilities` **không** bật server MCP `github`, và ngược lại.

`toolPrefix` trong MCP config (`"server" | "none" | "short"`) chỉ đặt tên cho **direct tools** khi bật `directTools: true`. Nó không đổi tên proxy tool — proxy luôn là `mcp`.

Từ `v0.3.7`, repo có thêm:

- `piagent-mcp` / `scripts/mcp-manage.mjs`;
- MCP preset `core`, `popular`, `all`, `design`, `design-local`, `browser`, `docs`, `github`;
- template `.mcp.json` project-shared;
- doctor warning khi adapter có nhưng không có MCP server nào.

## Hai bề mặt

Trong session Pi thì dùng slash command, ngoài terminal thì dùng CLI. Cùng module đọc config, cùng cách phân loại trạng thái.

| Việc | Trong session | Trong terminal |
|---|---|---|
| Mở menu | `/piagent-mcp` | — |
| Danh sách + state | `/piagent-mcp status` | `piagent-mcp list` |
| Chi tiết một server | `/piagent-mcp get <name>` | `piagent-mcp get <name>` |
| Thiếu gì để chạy | `/piagent-mcp doctor` | `piagent-mcp doctor` |
| Duyệt server của repo | `/piagent-mcp approve <name>` | `piagent-mcp approve <name>` |
| Bật/tắt | `/piagent-mcp enable\|disable <name>` | `piagent-mcp enable\|disable <name>` |
| Thêm/xoá/preset | — | `piagent-mcp add\|remove\|--preset` |
| Kết nối live, OAuth | `/mcp`, `/mcp-auth <name>` | — |

Slash command do Pi dispatch thẳng tới handler và **không đi qua model**: gõ `piagent-mcp list` giữa session là nhờ model chạy bash, đọc output rồi thuật lại — ba lượt model cho một câu hỏi process này trả lời được từ file nó đã đọc.

Thêm và xoá server ở lại terminal: `add` mang shell quoting, tham chiếu `${VAR}` và một command line sau `--` — ba thứ đã có sẵn một bộ parse đúng là chính shell, viết lại bên trong slash command chỉ tạo ra bộ parse thứ hai tệ hơn. Gọi `/piagent-mcp add` sẽ in ra lệnh terminal tương ứng chứ không đoán.

Gõ `/piagent-mcp` không tham số sẽ mở menu dựng theo đúng thứ project đang có — chưa server nào bị tắt thì không hiện "bật lại", không server nào chờ duyệt thì không hiện "approve". Chọn một việc cần server thì nó hỏi tiếp server nào, trừ khi chỉ có đúng một lựa chọn. Mọi mục trong menu đều gõ thẳng được, nên menu dạy dạng trực tiếp chứ không thay thế.

Không có select UI (print mode `-p`, JSON mode) thì in thẳng bảng trạng thái + danh sách subcommand, không treo chờ trả lời.

`/piagent-mcp` có auto-complete cho subcommand và tên server.

## Quản lý server

`piagent-mcp` có subcommand đầy đủ, không chỉ preset:

```bash
piagent-mcp add sentry --url https://mcp.sentry.dev/mcp --scope global
piagent-mcp add internal --scope project -- npx -y @acme/internal-mcp
piagent-mcp list
piagent-mcp get sentry
piagent-mcp disable sentry          # giữ định nghĩa, chỉ tắt
piagent-mcp remove sentry --scope global
piagent-mcp doctor
```

`--scope` nhận `global`, `pi-global`, `project`, `pi-project` — ứng với 4 file ở bảng bên dưới. Mặc định `global`. `add` in ra scope và **đường dẫn file vừa sửa**, để không phải đoán config nào đang có hiệu lực.

Server tự thêm sống sót qua mọi lần `piagent-update`: preset chỉ ghi đè đúng những server ID nó sở hữu. Ngược lại, sửa tay một server thuộc preset (`github`, `context7`…) sẽ bị `--replace` đưa về baseline ở lần update kế tiếp — muốn giữ bản riêng thì đặt tên khác.

## Secret không bao giờ nằm trong config

`add` **từ chối** giá trị trông giống credential và in ra dạng cần dùng:

```bash
$ piagent-mcp add gh --env GITHUB_PERSONAL_ACCESS_TOKEN=ghp_xxx -- npx -y @acme/gh-mcp
FAIL: GITHUB_PERSONAL_ACCESS_TOKEN names a credential, so its value cannot be
written into MCP config. Export it in your shell and reference it instead:
--env 'GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN}'
```

Chặn theo hai lớp: tên field nghe như credential, và giá trị tự nó trông như secret (bắt được cả `--env CONFIG=ghp_...`). Áp dụng cho cả `--env` lẫn `--header`.

`--url` chỉ nhận `https`, hoặc `http` khi host là loopback — Figma desktop MCP là đúng trường hợp đó.

`list` và `get` mask giá trị; riêng `${VAR}` được in nguyên vì đó là **tên biến**, không phải nội dung.

## Login vào account MCP

Platform **không tự chạy OAuth và không giữ token**. `pi-mcp-adapter` đã sở hữu luồng đó — nó đăng ký `/mcp` và `/mcp-auth`, giữ callback server và OAuth provider — và dựng kho credential thứ ba cho credential của bên khác là lựa chọn tệ hơn. Việc của platform là phát hiện và chỉ đường:

```text
/mcp-auth figma
```

`/piagent-mcp doctor` (hoặc `piagent-mcp doctor` ngoài terminal) phân loại từng server:

| State | Nghĩa |
|---|---|
| `ready` | đủ điều kiện, gọi được |
| `needs-env` | config tham chiếu `${VAR}` mà biến chưa export (chỉ in **tên biến**) |
| `needs-command` | executable không có trên PATH |
| `pending-approval` | repo khai server này, chưa ai duyệt trên máy này |
| `approval-changed` | đã duyệt nhưng định nghĩa đã đổi |
| `rejected` | đã từ chối cho project này |
| `disabled` | tắt bằng `/piagent-mcp disable` |
| `oauth` | đăng nhập do Pi giữ; platform không biết còn hạn hay không |

`oauth` **không** bị coi là lỗi, và không xuất hiện trong notice đầu session — platform không phân biệt được đã login hay chưa, nên báo mỗi session sẽ thành nhiễu.

`doctor` chạy thêm `docker info` (chậm, nên chỉ ở doctor chứ không ở session start). `piagent-doctor` cũng đưa các state chặn vào `warnings`.

## Approval gate cho server đến từ repo

Repo mang theo được `.mcp.json` và `.pi/mcp.json`. Clone một repo lạ rồi mở session **không** được phép cho tác giả repo đó một process trên máy mình với credential của mình. Nên server ở hai scope này không dùng được cho tới khi có người trên máy này duyệt.

```bash
piagent-mcp get internal        # đọc trước
piagent-mcp approve internal    # hoặc reject / remove
```

Ba tính chất quan trọng:

- **Quyết định nằm ngoài repo** — `~/.pi/piagent-mcp-approvals.json`. Repo tự duyệt được cho mình thì gate coi như không có. Fork, đổi tên, checkout thứ hai đều bắt đầu lại từ `pending`.
- **Pin theo digest của định nghĩa.** Duyệt là đồng ý với *thứ server đó chạy*; đổi command, URL hay args là câu hỏi mới, state quay về `approval-changed`. Cùng cách tách consent/build mà capability lock đang dùng.
- **Enforce ở `tool_call`**, không phải ở config. Guard đọc cả hai dạng lời gọi: proxy (`mcp` với `input.server`), và direct tool khi bật `directTools`. Gate chỉ đọc proxy sẽ bị đi vòng bằng cách bật `directTools`.

Dạng tên của direct tool là thứ trước đây ghi sai trong tài liệu này. Adapter **không** sinh ra `mcp__<server>__<tool>`. Nó ghép prefix lấy từ chính tên server:

| `toolPrefix` | prefix | server `repo-tools`, tool `search` |
|---|---|---|
| `server` (mặc định) | tên server, `-` đổi thành `_` | `repo_tools_search` |
| `short` | như trên, bỏ đuôi `-mcp`/`mcp` | `repo_tools_search` |
| `none` | không có prefix | `search` |

Nên guard truy server theo **tên server đang cấu hình**, không theo một pattern cố định. Với `toolPrefix: "none"` thì tên tool không còn dấu vết server nào cả — không truy được.

Vì vậy một config đặt `directTools: true` cùng `toolPrefix: "none"` làm **mọi tool call trong session bị chặn**, không riêng lời gọi MCP, cho tới khi bỏ setting đó. Chặn riêng proxy `mcp` là vá nhầm chỗ: proxy là dạng duy nhất còn nêu tên server, còn đúng những cái tên trần cần chặn thì đi thẳng qua.

Adapter **merge `settings` của cả bốn layer thành một block cho cả session**, layer sau ghi đè theo từng key — không phải per-server. Nên `directTools` đặt ở file này và `toolPrefix: "none"` đặt ở file kia vẫn ra đúng tổ hợp đó, trong khi đọc riêng từng file thì không file nào có vấn đề. Platform đọc settings đã merge, và báo cả hai file, vì sửa file nào cũng đủ.

### `imports` — server không nằm trong bốn scope

Adapter nhận thêm key `imports` trong config MCP, để kéo định nghĩa server từ config của công cụ khác. Server vào session theo đường này **không** xuất hiện ở scope nào trong bốn scope trên, nên trước đây gate không thấy chúng.

Trong sáu kind, chỉ `vscode` trỏ vào đường dẫn **trong project** (`.vscode/mcp.json`) — nghĩa là clone repo là mang theo file đó. Vì vậy:

- Server đến từ một kind repo-relative luôn phải duyệt, **bất kể layer nào khai báo import** — kể cả `global`.
- Repo scope khai báo `imports` với kind nào thì server của kind đó cũng phải duyệt: repo đang chọn hộ máy này chạy server nào.
- Kind `codex` giữ server trong TOML, không bên nào parse được. Liệt kê server của năm kind đọc được không nói gì về kind thứ sáu, nên repo khai báo `codex` làm **mọi tool call bị chặn** — từ chối ngay ở dòng khai báo, không phải từ chối theo nội dung. Chỉ chặn khi file đó **có thật trên máy**: khai báo một kind mà máy này không cài thì đó là config cần dọn, không phải session cần dừng.
- Cột `SCOPE` trong `list` là **layer khai báo `imports`**, không phải nơi định nghĩa server. Global khai báo `imports: ["vscode"]` thì server hiện `scope: global` nhưng định nghĩa nằm trong clone — vẫn phải duyệt, và `detail` nêu đúng kind nó đến từ đâu. Menu `/piagent-mcp` và `get` cũng quyết theo đúng luật đó chứ không theo scope, nên server khó thấy nhất không còn là server không bao giờ được hỏi.
- `piagent-mcp doctor` nêu tên file có `imports` và các kind của nó, và nêu cả import target **có thật nhưng không parse được** — trước đây trạng thái đó đọc ra rỗng, không phân biệt được với một công cụ không khai server nào.
- `remove` / `enable` / `disable` trên server đến qua `imports` bị **từ chối**, kèm tên file thật cần sửa. File `list` chỉ ra là config của công cụ kia; ghi ngược lại bằng writer của platform sẽ viết lại file Cursor/VS Code của người dùng theo format mà chính công cụ đó không dùng.

Hai trạng thái làm gate không kiểm được gì (`toolPrefix: "none"`, và import kind không enumerate được) thì `doctor` và `list` **in ra và exit 1**, không im lặng báo "No MCP servers configured" — kể cả `list --json`, vốn trả `servers: []` với exit 0 đúng lúc không gì chạy được. Exit code trả lời "MCP ở đây có chạy được không", không phải "có in ra dòng nào không". Cả ba surface (guard, `/piagent-mcp`, CLI) đọc **một** state chung; hai bên lệch nhau chính là cách một session bị chặn biến thành một session hỏng không rõ lý do.

### Duyệt là duyệt cái gì

Adapter merge server **trùng tên** theo từng key qua các layer. Repo khai `{"args": ["--evil"]}` thì `command` vẫn lấy từ layer dưới — nên preview lúc duyệt in ra **định nghĩa đã merge**, tức thứ sẽ chạy thật, thay vì mảnh mà layer repo đóng góp. Digest vẫn tính trên mảnh của repo: đó là phần repo kiểm soát, và băm cả bản merge sẽ đẩy server về `pending` mỗi lần người dùng sửa config global của chính mình.

Bảng dưới là đường dẫn và key **thật** của từng công cụ, đối chiếu với thứ adapter đang đọc. Ba dòng lệch nhau, nên platform đọc hợp của cả hai phía: liệt kê thừa một server chỉ tốn một lần duyệt, liệt kê thiếu thì mất gate.

| kind | file thật | key thật | adapter đang đọc |
|---|---|---|---|
| `cursor` | `~/.cursor/mcp.json` | `mcpServers` | khớp |
| `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` | `mcpServers` | khớp |
| `claude-code` | `~/.claude.json` | `mcpServers` | khớp ở user scope; local scope lồng theo project nên cả hai bên đều không đọc |
| `vscode` | `.vscode/mcp.json` | **`servers`** | đọc `mcpServers` |
| `codex` | `~/.codex/config.toml` | **`mcp_servers`** (TOML) | đọc `~/.codex/config.json` |
| `windsurf` | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` | đọc `~/.windsurf/mcp.json` |

Giới hạn cần nói thẳng: extension **không chặn được adapter mở connection**, chỉ chặn tool call. Phần còn lại là bản thân kết nối, và việc server phía kia ghi log rằng có người kết nối. Riêng file TOML của `codex` thì không bên nào parse, nên platform không liệt kê được nội dung của nó.

Server ở `global` / `pi-global` không qua gate — hai layer đó nằm ngoài mọi repo, không repo nào đặt được server vào đó, và bắt duyệt config của chính mình trên từng máy là vô nghĩa. Ngoại lệ duy nhất là `imports` trỏ vào kind repo-relative, vì lúc đó nội dung được đọc lại nằm trong repo.

Notice đầu session nêu tên server đang chờ quyết định hoặc thiếu setup. Tắt bằng `PIAGENT_NO_MCP_NOTICE=1`.

## Cấu hình một lần cho máy cá nhân/team

Cả `piagent-setup` và `piagent-install` đều cài adapter và seed preset `core` **mặc định**. Muốn bỏ qua thì thêm `--no-mcp`.

Ghi config **không** bằng dùng được ngay. Server connect lazy, nên mỗi server còn cần thứ của nó trước lần gọi đầu:

| Server (preset `core`) | Còn cần gì |
|---|---|
| `context7` | Không bắt buộc. `CONTEXT7_API_KEY` chỉ để tăng quota |
| `chrome-devtools` | Chrome cài sẵn trên máy |
| `github` | **Docker đang chạy** + `export GITHUB_PERSONAL_ACCESS_TOKEN` |

`piagent-mcp --list` in ra yêu cầu của từng server; lệnh apply cũng in danh sách này ra stderr ngay sau khi ghi config.

```bash
bash /path/to/piagent/scripts/setup.sh . \
  --profile auto \
  --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z \
  --mcp-preset core
```

Chỉnh MCP sau này:

```bash
piagent-mcp --preset popular --scope global --replace
piagent-mcp --preset design --scope global --replace
piagent-mcp --preset all --scope project --project /path/to/project
piagent-mcp --list
```

Nếu clone repo GitHub và chưa link npm bin:

```bash
node /path/to/piagent/scripts/mcp-manage.mjs --preset popular --scope global --replace
```

`--replace` cập nhật các server ID thuộc preset về baseline đã pin và vẫn giữ nguyên server ID khác. Luồng install/upgrade toàn cục luôn dùng chế độ này để không duy trì dependency động từ cấu hình cũ.

Trong Pi:

```text
/mcp
/mcp setup
/mcp tools
/mcp reconnect
/mcp-auth figma
```

## MCP config layers

Theo `pi-mcp-adapter`, thứ tự config nên giữ như sau:

| File | Scope | Nên dùng khi nào |
|---|---|---|
| `~/.config/mcp/mcp.json` | shared global MCP config | mặc định cho nhiều agent/client và nhiều project |
| `~/.pi/agent/mcp.json` | Pi global override | chỉ khi cần override riêng cho Pi |
| `.mcp.json` | project shared MCP config | config server đặc thù repo, có thể commit |
| `.pi/mcp.json` | Pi project override | override riêng Pi trong một repo |

Quy ước của platform:

- global baseline viết vào `~/.config/mcp/mcp.json`;
- project baseline viết vào `.mcp.json`;
- `.pi/mcp.json` để override Pi-specific, không nhét secret;
- token strategy mặc định: `directTools: false`, dùng proxy `mcp(...)`;
- chỉ bật `directTools` cho server nhỏ hoặc tool thật sự dùng thường xuyên.

## Preset MCP

| Preset | Server | Mục đích |
|---|---|---|
| `minimal` | none | chỉ seed settings an toàn |
| `docs` | Context7 | docs mới của framework/library |
| `browser` | Chrome DevTools, Playwright | inspect UI/runtime/browser automation |
| `github` | GitHub MCP | issue/PR/repo/release workflow |
| `design` | Figma remote | design-to-code qua Figma OAuth |
| `design-local` | Figma desktop | Figma desktop Dev Mode MCP local |
| `web` | Context7, Chrome DevTools, Playwright | FE/web workflow |
| `core` | Context7, Chrome DevTools, GitHub | default team baseline |
| `popular` | core + Playwright + Figma remote | baseline nhiều team dev dùng |
| `all` | popular + Figma desktop | đầy đủ, dùng khi muốn sẵn cả local Figma |

## Server baseline

### Context7

MCP config:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@3.2.4"],
      "env": {
        "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"
      },
      "lifecycle": "lazy",
      "directTools": false
    }
  }
}
```

Khuyến nghị cho Pi: có thể cài thêm Pi-native package nếu muốn tool/docs tự nhiên hơn MCP:

```bash
pi install npm:@upstash/context7-pi@0.1.1
```

API key là optional nhưng nên dùng cho quota tốt hơn:

```bash
export CONTEXT7_API_KEY=ctx7sk_...
```

### Figma

Remote MCP:

```json
{
  "mcpServers": {
    "figma": {
      "url": "https://mcp.figma.com/mcp",
      "auth": "oauth",
      "lifecycle": "lazy",
      "directTools": false
    }
  }
}
```

Local desktop MCP:

```json
{
  "mcpServers": {
    "figma-desktop": {
      "url": "http://127.0.0.1:3845/mcp",
      "lifecycle": "lazy",
      "directTools": false
    }
  }
}
```

Khuyến nghị thực tế:

- dùng remote Figma MCP khi account/org hỗ trợ OAuth;
- dùng desktop local khi cần selection-based Dev Mode trong app Figma;
- nếu muốn Pi-native thay vì MCP, có thể cài `pi install npm:pi-mono-figma@0.2.2` sau khi hoàn tất security và license review.

### Browser

Chrome DevTools:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@1.6.0", "--no-performance-crux"],
      "env": {
        "CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1",
        "CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1"
      },
      "lifecycle": "lazy",
      "directTools": false
    }
  }
}
```

Playwright:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@0.0.78"],
      "lifecycle": "lazy",
      "directTools": false
    }
  }
}
```

### GitHub

```json
{
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e",
        "GITHUB_READ_ONLY=1",
        "-e",
        "GITHUB_LOCKDOWN_MODE=1",
        "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      },
      "lifecycle": "lazy",
      "directTools": false
    }
  }
}
```

Token không được commit:

```bash
export GITHUB_PERSONAL_ACCESS_TOKEN=<github-token>
```

Preset mặc định chạy GitHub MCP ở read-only và lockdown mode. Bất kỳ cấu hình write nào cũng phải được tách riêng, giới hạn credential và yêu cầu human confirmation.

## Tool policy

Runtime tool registry nằm trong `packages/piagent-core/policies/base-policy.json`.

Tool:

```text
piagent_tool_policy_check
```

Default `toolRegistry=advisory`: tool chưa map capability vẫn chạy, nhưng guard phát một notice mức `warning` — **một lần cho mỗi tool trong mỗi session**, không phải mỗi lần gọi.

`toolRegistry=enforce` thì đổi notice đó thành block. Cân nhắc trước khi bật: proxy tool của MCP tên là `mcp`, không nằm trong `alwaysAllowedTools` cũng không có trong `toolCapabilities`, nên **enforce sẽ chặn toàn bộ MCP**. Khai thêm `mcpCapabilities` không gỡ được, vì không có mapping nào từ capability name sang MCP server. Ngoại lệ duy nhất là permission profile `trusted-full-access`.

Protected-path gate độc lập với registry mode. Dù tool registry đang `advisory`, mọi raw tool call có path-like string trỏ vào protected path sẽ bị block trước khi tool chạy. Cơ chế này áp dụng cho Pi built-ins (`read`, `write`, `edit`, `grep`, `find`, `ls`) và custom/MCP tools nếu tool call đi qua Pi `tool_call` hook.

Extractor walk nested object/array và `file://` URI. Path-like string được percent-decode một lần trước khi match. Field lạ mặc định được coi là path-like; chỉ leaf field nội dung đã biết như `content`, `query`, `pattern`, `text`, và `command` được skip để tránh false positive search/edit. Input lồng quá sâu vượt `MAX_TOOL_INPUT_INSPECTION_DEPTH=32` sẽ fail-closed.

Search/list channels cũng được kiểm:

- `grep.glob` bị block nếu glob nhắm protected path rõ ràng như `.env*`, `auth.json`, `.pi/piagent-state/**`, hoặc `piagent-profile.json`;
- `find.pattern` bị block nếu pattern nhắm protected path rõ ràng;
- broad pattern như `*.json` được phép để không phá search workflow phổ biến;
- broad `grep/find/ls` được phép chạy khi không target trực tiếp, nhưng `tool_result` sẽ redact content line hoặc path metadata từ protected files trước khi model thấy output.

| Mode | Allowed intent |
|---|---|
| `readOnly` | đọc file, grep, find, list, MCP read-only |
| `memory` | đọc/search memory, ghi note explicit-only |
| `docsWrite` | sửa docs/plans/report |
| `sourceWrite` | sửa source theo protected path + verify |
| `ship` | release/commit/push/deploy, cần human gate |

## Rule bắt buộc

- Capability chưa đăng ký: clean skip, không tự đoán tool.
- Tool destructive: block hoặc hỏi xác nhận.
- Tool external-provider: hỏi xác nhận nếu có side effect/cost.
- MCP response phải ngắn; server tự build phải có concise/detailed mode.
- Memory tool không được lưu secret/raw private data; memory là advisory, source hiện tại là authority.
- Không commit token/API key/OAuth file.
- Không bật `directTools: true` đại trà cho server lớn; sẽ phá lợi thế token của Pi.

## Built-in platform tools

| Tool | Intent |
|---|---|
| `piagent_context` | Active profile/context/verify/MCP/memory overview. |
| `piagent_exec_policy_check` | Evaluate shell command before running. |
| `piagent_context_budget` | Check candidate context files against hard caps. |
| `piagent_tool_policy_check` | Check tool capability registration. |
| `piagent_task_gate_check` | Check task readiness before final DONE. |
| `piagent_memory_status` | Project memory policy/files/rules. |
| `piagent_memory_search` | Keyword search `.pi/memory` markdown. |
| `piagent_memory_note` | Append explicit durable memory note. |
| `piagent_memory_citation_record` | Record memory evidence in task contract. |
| `piagent_context_index_status` | Inspect the compact advisory project context index. |
| `piagent_context_index_search` | Search context-index nodes before broad re-scouting. |
| `piagent_context_index_record` | Record cited project/profile/tech/task context after onboarding or approved handoff. |
| `piagent_profile_options` | Return reusable project profile choices. |
| `piagent_profile_apply` | Apply a selected profile and deterministic capability lock. |
| `piagent_profile_tech_options` | Return select-style tech options for a profile family. |
| `piagent_profile_tech_apply` | Apply profile + selected role tech stack and Context7 placeholders. |
| `piagent_profile_tech_context_record` | Record a concise Context7 evidence snapshot for a selected tech. |
| `piagent_task_start` | Create Task Implementation Contract. |
| `piagent_context_record` | Record context manifest for task. |
| `piagent_verify_record` | Record verify evidence only when it matches an observed Pi bash result after task start. Passing gate also requires exact match with `task.verifyCommands`. |
| `piagent_trace_record` | Record handoff/final trace. |

## Core capabilities

| Capability | Meaning |
|---|---|
| `filesystem-readonly` | Read/list/search repository files. |
| `filesystem-write` | Edit/write non-protected project files. |
| `shell` | Run shell commands through exec policy. |
| `github` | GitHub/MCP/CLI workflows when configured. |
| `browser` | Browser/UI/runtime inspection when configured. |
| `memory` | Project memory tools. |

## Nguồn

- Pi MCP adapter: https://pi.dev/packages/pi-mcp-adapter
- Context7 Pi package: https://pi.dev/packages/@upstash/context7-pi
- Figma remote MCP docs: https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/
- Figma desktop MCP docs: https://developers.figma.com/docs/figma-mcp-server/local-server-installation/
- GitHub MCP server: https://github.com/github/github-mcp-server
- MCP protocol: https://modelcontextprotocol.io/
- Pi extension tool events: https://pi.dev/docs/latest/extensions

# MCP và tool policy

## Kết luận hiện tại

Pi core không hard-code MCP. Platform của mình cài `pi-mcp-adapter` để Pi dùng MCP theo kiểu token-efficient: một proxy tool `mcp(...)`, server lazy-connect, metadata cache, output guard. Project profile chỉ khai báo capability được phép; MCP config mới khai báo server thật.

Từ `v0.3.7`, repo có thêm:

- `piagent-mcp` / `scripts/configure-mcp.sh`;
- MCP preset `core`, `popular`, `all`, `design`, `design-local`, `browser`, `docs`, `github`;
- template `.mcp.json` project-shared;
- doctor warning khi adapter có nhưng không có MCP server nào.

## Cấu hình một lần cho máy cá nhân/team

Global install mặc định sẽ cài adapter và seed preset `core` nếu dùng `scripts/setup.sh` hoặc `scripts/install-global.sh --with-mcp`:

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
bash /path/to/piagent/scripts/configure-mcp.sh --preset popular --scope global --replace
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

Default `toolRegistry=advisory`: agent nhận warning khi tool chưa map capability. Project ổn định có thể bật `toolRegistry=enforce` trong `.pi/piagent-profile.json`.

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

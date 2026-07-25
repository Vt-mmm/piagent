# Kiến trúc Pi Agent Platform

## Mục tiêu

Tách phần agent platform khỏi từng project. Một core dùng chung, nhiều adapter tùy project.

```text
User machine
├─ ~/.pi/agent/
│  ├─ settings.json              user/global Pi settings
│  ├─ auth.json                  OAuth token, không commit
│  └─ mcp.json                   Pi global MCP override
├─ ~/.config/mcp/mcp.json        shared global MCP config
└─ <platform-repo>/
   ├─ package.json               root Pi package manifest
   ├─ packages/piagent-core   reusable Pi package internals
   ├─ adapters/*/profile.json    project/domain profiles
   └─ templates/project          files copied into target projects

Any project
├─ AGENTS.md                     project instructions
├─ .mcp.json                     shared MCP config
└─ .pi/
   ├─ settings.json              project Pi settings
   ├─ piagent-profile.json       project adapter
   ├─ memory/                    project-scoped explicit memory
   └─ mcp.json                   Pi project MCP override
```

## Layering

| Layer | Scope | Commit? | Nội dung |
|---|---|---:|---|
| OAuth/auth | user machine | Không | `auth.json`, API token, trust state. |
| Pi global settings | user machine | Không, chỉ template | provider/model, installed packages, telemetry/proxy. |
| Piagent core | platform repo | Có | extension guard, prompt, skill, policy engine. |
| Domain pack | platform repo | Có | frontend/backend/data profile chung. |
| Project adapter | project repo hoặc platform repo | Có | paths, context, verify, MCP capabilities. |
| Project memory | user/project machine | Không mặc định | `.pi/memory/MEMORY.md` và summary là private-by-default; team chỉ opt-in commit sau review/redaction. |

## Luồng chạy

1. User `cd <project>`.
2. User chạy `pi`.
3. Pi đọc global settings và package đã cài.
4. Nếu project trusted, Pi đọc `.pi/settings.json` và `.pi/piagent-profile.json`.
5. `piagent-core` extension intercept tool calls.
6. Agent dùng prompts/skills, MCP registry, context policy, và memory policy.
7. Memory được đọc/search như advisory context; source hiện tại vẫn là authority.
8. Trước khi DONE, agent chạy verify theo profile.

## Vì sao không hard-code vào prompt

Prompt chỉ hướng dẫn model. Guard extension có thể block tool call trước khi chạy. Các rule nguy hiểm phải nằm trong policy/extension:

- protected path
- destructive bash
- missing verify
- unsupported MCP capability
- credential handling

## Project-specific examples

Project đặc thù có thể có backend freeze, structure guide, experience contract, e2e gate. Những thứ này không được đưa vào core; hãy đặt profile riêng trong chính repo project.

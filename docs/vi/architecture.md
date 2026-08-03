# Architecture của Pi Agent Platform

[English](../en/architecture.md)

## Mục tiêu

Platform là một Pi harness dùng lại cho nhiều project, không phải application chứa business logic riêng của một project. Architecture phải thể hiện rõ bốn tính chất trong code:

1. Policy decision phải test được mà không cần mở Pi.
2. Pi lifecycle hook chỉ compose feature, không ôm toàn bộ implementation của feature.
3. Local state, MCP, process và filesystem access nằm sau adapter rõ ràng.
4. Business rule riêng của project nằm trong project profile và adapter, không nằm trong core.

## Chiều dependency

```text
entrypoints/scripts
        |
        v
composition: extensions/piagent-guard.ts
        |
        +--------------------+
        v                    v
runtime adapters        integrations
        |                MCP / capabilities
        v                    |
core services <-------------+
policy / task / context / security
```

Dependency chỉ đi xuống. Core service không import Pi composition root hay runtime adapter. Runtime adapter được gọi core service và integration. Chỉ composition root mới register toàn bộ Pi extension.

Rule máy đọc nằm tại `architecture/layers.json`; chạy `npm run architecture:check` để enforce.

## Các layer vật lý

| Layer | Vị trí hiện tại | Ownership | Không được chứa |
|---|---|---|---|
| Composition | `packages/piagent-core/extensions/piagent-guard.ts` | Wiring, dependency construction, thứ tự registration | Feature algorithm, mutable state implementation, formatter lớn |
| Runtime adapters | `packages/piagent-core/runtime/` | Pi lifecycle hook, shared session state, command/tool registration, input routing | Policy decision dùng lại |
| Core services | `packages/piagent-core/extensions/` trừ entrypoint | Policy, context, task lifecycle, state service | Pi command menu và UI text |
| MCP integration | `packages/piagent-core/mcp/` | MCP config layer, readiness, approval, command action | Task và context policy |
| Capabilities | `packages/piagent-core/capabilities/` | Profile resolution, pack validation, lock, source root | Pi session lifecycle |
| Security foundation | `packages/piagent-core/security/` | Sensitive-data primitive | Workflow behavior |
| Benchmark | `packages/piagent-core/benchmark/`, `benchmarks/` | Suite validation, scoring, evidence | Runtime enforcement |
| Entrypoints | `scripts/` | CLI argument và gọi use case | Domain logic trùng lặp |
| Product assets | `prompts/`, `skills/`, `subagents/`, `adapters/`, `packs/`, `schemas/` | Declarative behavior và contract | Hidden runtime state |

Folder `extensions/` vẫn chứa một số service module do lịch sử. Tên folder này là legacy; chỉ `piagent-guard.ts` được Pi load như extension. Mỗi lần migrate phải tách theo một feature trọn vẹn và giữ compatibility cho đến khi migration hoàn tất.

## Luồng runtime

1. Pi load một extension entrypoint duy nhất.
2. Composition resolve base policy, project profile, capability lock và local session state.
3. Runtime hook normalize input và thu session evidence qua một session-scoped state owner.
4. Core service quyết định path, shell, MCP, task, context và final-gate policy.
5. Runtime adapter register tool và slash command ngắn gọn.
6. Owner-only local state ghi evidence; prompt chỉ là hướng dẫn, không phải enforcement boundary.

## Ownership của state

| State | Owner | Vị trí | Commit |
|---|---|---|---:|
| OAuth và provider auth | Pi/provider | user config | Không |
| Platform install config | Piagent installer | global Pi settings | Không |
| Project profile và lock | Project | `.pi/piagent-profile*.json` | Có |
| Task, trace, telemetry, capture | Runtime | `.pi/piagent-state/` | Không |
| Session history | Pi | Pi session store | Không |
| Shared project instructions | Project | `AGENTS.md`, project docs | Có |

Một feature không được tạo representation authoritative thứ hai cho cùng một state. Derived index phải có policy digest và phải rebuild được từ source of truth.

## Ranh giới file

- Runtime module mới: tối đa 500 dòng.
- Core module mới: tối đa 1.000 dòng.
- CLI entrypoint: tối đa 800 dòng; use case phải chuyển vào package module.
- File lớn đang tồn tại có non-growth budget rõ ràng trong `architecture/layers.json`.
- Test mirror feature path và test public behavior, không phụ thuộc private implementation order.

Thứ tự tách file và ownership rule chi tiết nằm trong [maintainer guide](maintainer-guide.md).

# Maintainer guide

[English](../en/maintainer-guide.md)

## Rule đặt code

Trước khi thêm code, cần trả lời một câu hỏi về ownership:

| Câu hỏi | Vị trí |
|---|---|
| Code register Pi hook, command, tool hay session UI? | `packages/piagent-core/runtime/` |
| Code là policy decision hoặc scoring decision deterministic? | Core service module nhỏ, không dùng Pi API và không format UI |
| Code persist local runtime evidence? | State service có owner-only mode và bounded retention |
| Code integrate MCP? | `packages/piagent-core/mcp/` |
| Code resolve profile, pack hay lock? | `packages/piagent-core/capabilities/` |
| Code là CLI command? | `scripts/` chỉ parse argument và gọi package service |
| Code riêng cho một project? | Project profile/adapter, không đưa vào `piagent-core` |

Không tạo folder `utils` để gom code không rõ ownership. Module phải mang tên capability mà nó quản lý.

## Thứ tự tách file hiện tại

### P0: composition root

`packages/piagent-core/extensions/piagent-guard.ts` là architecture debt lớn nhất. Sau đợt tách lifecycle file còn 8.290 dòng và architecture gate chỉ cho phép file nhỏ dần.

Đã tách:

- `runtime/session/message-signals.ts`
- `runtime/session/runtime-state.ts`
- `runtime/session/system-prompt.ts`
- `runtime/session/usage.ts`
- `runtime/session/tool-result-compaction.ts`
- `runtime/input/chat-images.ts`
- `runtime/hooks/session-start-hook.ts`
- `runtime/hooks/session-hooks.ts`
- `runtime/hooks/input-hook.ts`
- `runtime/hooks/agent-start-hook.ts`
- `runtime/hooks/completion-hook.ts`
- `runtime/hooks/tool-result-hook.ts`
- `runtime/tools/tool-groups.ts`
- `runtime/workflows/input-routing.ts`
- `runtime/workflows/task-intake.ts`
- `runtime/runtime-limits.ts`

Những feature cần tách tiếp theo một khối trọn vẹn:

1. `runtime/hooks/tool-call-hook.ts`: enforcement trước tool call cho capability, path, shell, external action, task scope và confirmation.
2. `runtime/tools/`: policy, task, context, memory, onboarding, profile, document và source tools.
3. `runtime/commands/`: workflow, session, permission, context, MCP, profile, onboarding và compatibility alias.
4. Tạo core service tập trung cho profile, memory, onboarding và source-cache algorithm vẫn còn nằm trong composition root.

Mục tiêu: composition root dưới 500 dòng, chỉ giữ registration order và một shared runtime state object nhỏ.

### P1: policy engine

Tách `extensions/policy-core.js` theo decision boundary:

- `policy/shell/tokenize.js`
- `policy/shell/expansion.js`
- `policy/path/match.js`
- `policy/path/candidates.js`
- `policy/exec/evaluate.js`

Giữ một compatibility barrel cho đến khi toàn bộ internal import đã migrate. Differential shell test phải nằm sát parser/matcher boundary.

### P1: Context Engine

Tách `extensions/context-engine.js` thành:

- `context/index/store.js`
- `context/index/policy.js`
- `context/retrieval/search.js`
- `context/retrieval/pack.js`
- `context/telemetry.js`
- `context/test-impact.js`

Index store owner SQLite và secure deletion. Retrieval không tự load policy; nó nhận resolved exclusion policy bắt buộc từ caller.

### P2: capability resolver

Tách `capabilities/capability-core.js` thành manifest validation, dependency resolution, permission projection và lock integrity. Atomic file write thuộc infrastructure module, không thuộc resolver.

### P2: benchmark runner

Tách `scripts/benchmark-runner.mjs` thành CLI mỏng và package module cho suite materialization, surface execution, evidence collection, grading và report rendering. CLI không được tự tính một bản benchmark metric thứ hai.

### P2: docs và test dài

- Tách operator manual theo install, daily workflow, session/usage, MCP, recovery và reporting; stable path cũ trở thành index.
- Tách `piagent-guard-integration.test.mjs` theo từng runtime hook family, vẫn dùng chung harness helper.
- Mỗi source feature được tách phải có một test file tập trung.

## Rule cho runtime composition

- Registration function nhận dependency object rõ ràng, không import mutable state từ composition root.
- Shared session state có một typed owner và được truyền vào hook/tool/command registrar.
- Tool và command alias gọi cùng handler; alias không duplicate behavior.
- UI formatting nằm trong runtime adapter. Policy service trả về structured decision.
- Mọi file trong `packages/piagent-core/runtime/` phải có trong
  `capabilities/runtime-integrity.js`; capability lock phải pin toàn bộ runtime
  code thực thi trước khi release được phép pass.
- Mỗi filesystem write phải khai báo path, mode, retention và source of truth.
- Mỗi derived metric phải nêu input và có unit test tính tay một ví dụ.

## Checklist khi thay đổi

1. Đặt code đúng owning layer.
2. Thêm hoặc update cặp EN/VI nếu behavior là normative.
3. Chạy `npm run architecture:check` trước broad test.
4. Chạy focused test của feature vừa sửa.
5. Chạy `npm run verify` trước release.
6. Khi semantic thay đổi, update hai language file trong cùng commit.

## Definition of done cho architecture migration

- Composition root tối đa 500 dòng.
- `architecture/layers.json` không còn non-growth exception.
- Core policy module không import runtime hay CLI code.
- Mọi maintainer topic normative đều có cặp EN/VI.
- Full verification, package distribution, benchmark schema và published docs gate đều xanh.

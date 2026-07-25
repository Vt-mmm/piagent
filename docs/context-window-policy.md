# Context-window policy

## Mục tiêu

Không nhồi toàn bộ repo vào context. Agent phải load đúng lớp context theo task.

Lần đầu gắn project vào platform, chạy `/onboard-project` sau login/model selection để tạo `.pi/project-context.md` và `.pi/context-index.json`. Các task sau dùng context index như bản đồ nhỏ để tìm đúng vùng cần đọc, rồi vẫn verify bằng files task-specific hiện tại.

## Context order

1. `AGENTS.md` gần project nhất.
2. Project profile: `.pi/piagent-profile.json`.
3. Project context index: `.pi/context-index.json` nếu tồn tại và không stale.
4. Project context snapshot: `.pi/project-context.md`.
5. Memory summary nếu profile bật memory và task liên quan: `.pi/memory/memory_summary.md`.
6. Required context từ profile.
7. Task-specific files.
8. Related tests/docs.
9. External docs only khi cần và ưu tiên official docs.

Trước khi ghi context manifest hoặc dự định đưa file lớn vào prompt, dùng:

```text
piagent_context_preflight
piagent_context_budget
piagent_context_index_status
```

Trước task lớn/risk cao trong Pi TUI:

```text
/task-preflight
/task-preflight compact
```

Nếu recommendation là `fresh-session`, dùng `/fresh-task`, `/fresh-scout`, hoặc `/fresh-be-to-fe` thay vì tiếp tục nhồi context vào session hiện tại.

## Context manifest

Mỗi task nên có manifest ngắn:

```text
Context manifest
- profile: .pi/piagent-profile.json
- index: .pi/context-index.json (advisory map)
- snapshot: .pi/project-context.md
- memory: .pi/memory/memory_summary.md (if relevant)
- required: AGENTS.md
- required: docs/architecture.md
- task files: src/...
- verify: npm test
```

## Compaction default

Pi settings template dùng:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

## Rule

- Nếu task là read-only, không mở write-capable prompt.
- Nếu task là source-write, phải biết verify command trước khi sửa.
- Không paste full mandatory-flow boilerplate vào task hằng ngày; platform prompts/tools đã chứa flow đó.
- Nếu context vượt budget, tạo summary theo module thay vì nhồi full files.
- Dùng `/context-index` hoặc `piagent_context_index_search` để tìm điểm vào repo, nhưng không dùng index thay thế việc đọc source thật.
- Không raw-read hoặc raw-edit `.pi/context-index.json` trong task thường ngày. Runtime coi index là advisory state, sanitize khi đọc qua tool/command, và ghi qua `/onboard-project` hoặc `piagent_context_index_record`.
- File context vượt hard cap phải được summarize hoặc đọc targeted slices, không inject full.
- Nếu input quá dài thật, lưu intake vào file project/local gitignored rồi reference file; không dán toàn bộ spec vào một turn.
- Nếu input chứa local screenshot/image path, để input guard attach thành `[image1]` thay vì đọc ảnh như text context. Ảnh lớn hơn giới hạn chat nên dùng Pi `read` để resize.
- Memory chỉ là hint. Phải verify bằng source hiện tại trước khi sửa code.
- Context index cũng chỉ là hint. Nó có node/edge/citation để giảm scout lại, không phải security boundary hoặc source of truth.

## Nguồn

- Pi compaction: https://pi.dev/docs/latest/compaction
- Pi settings: https://pi.dev/docs/latest/settings

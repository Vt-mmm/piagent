# Context-window policy
<!-- language: vi; english-index: docs-site/content/en/runtime.html -->

## Mục tiêu

Không nhồi toàn bộ repo vào context. Agent phải load đúng lớp context theo task.

Lần đầu gắn project vào platform, chạy `/onboard run` sau login/model selection để tạo `.pi/project-context.md`, `.pi/context-index.json` và local Context Engine index. Các task sau dùng index như bản đồ nhỏ để tìm đúng vùng cần đọc, rồi vẫn verify bằng files task-specific hiện tại.

## Context order

1. `AGENTS.md` gần project nhất.
2. Project profile: `.pi/piagent-profile.json`.
3. Context Engine pack cho task unfamiliar/cross-module nếu index tồn tại và không stale.
4. Project context index: `.pi/context-index.json` nếu tồn tại và không stale.
5. Project context snapshot: `.pi/project-context.md`.
6. Memory summary nếu profile bật memory và task liên quan: `.pi/memory/memory_summary.md`.
7. Required context từ profile.
8. Task-specific files.
9. Related tests/docs.
10. External docs only khi cần và ưu tiên official docs.

Trước khi ghi context manifest hoặc dự định đưa file lớn vào prompt, dùng:

```text
piagent_context_preflight
piagent_context_budget
piagent_context_index_status
```

Trước task lớn/risk cao trong Pi TUI:

```text
/context preflight
/context pack <task>
/context compact
```

Với task/phase tiếp theo trong cùng phiên hiển thị, runtime tự tạo working set
gọn trước mỗi provider call; người dùng không phải mở session mới chỉ để đổi từ
scout sang plan, implement hay verify. `/fresh task`, `/fresh scout` và
`/fresh be-to-fe` vẫn là đường phục hồi tường minh khi preflight xác định input
quá lớn hoặc working set không thể rút gọn an toàn.

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

Host compaction trên chỉ là overflow guard. Adaptive context governor của
Piagent chạy sớm hơn và không đổi model/thinking:

- phát hiện ranh giới task/phase, context pressure, số tool round, read-output
  cũ và kết quả lặp;
- giữ yêu cầu/quyết định gần nhất của người dùng, Task Contract, acceptance
  criteria, changed files, verifier và lỗi chưa giải quyết;
- bỏ raw read/test log cũ khỏi provider working set nhưng giữ nguyên transcript
  hiển thị và audit source;
- giữ nguyên nhóm assistant tool-call/tool-result để không tạo orphan protocol;
- giữ nguyên tối thiểu 6 nhóm ranh giới gần nhất; nếu transcript hoặc projected
  candidate đã có orphan tool message thì fail closed và không thay context;
- chỉ project khi ước tính tiết kiệm đạt ngưỡng thích ứng: ít nhất 8K token,
  15% transcript occupancy và không đòi quá 20K; không đạt thì no-op thay vì gọi
  thêm một model summarizer có phí;
- chỉ ghi durable compaction sau khi agent đã settled; coding task dùng summary
  deterministic từ state/file-backed evidence để không tốn thêm model call;
- trước khi lặp exact verifier, dùng current-tree gate: một durable pass trên
  cùng working-tree digest được tái sử dụng bằng receipt nhỏ thay vì chạy lại.
  Code đổi, pass thiếu/stale, test từng fail, hoặc operator yêu cầu chạy lại thì
  verifier thật vẫn chạy;
- giữ model summarizer cho thảo luận không có Task Contract và ít tool evidence,
  nơi sắc thái hội thoại quan trọng hơn tiết kiệm tuyệt đối.

Telemetry tách `contextOccupancy` (working set ước tính/được provider báo) khỏi
`billedTraffic` (input/output/cache thực sự đo được). Vì context hook không có
usage hóa đơn theo lần gọi, runtime không được suy diễn hai con số này là một.

Mốc vận hành hiện tại bắt đầu tạo áp lực ở khoảng 160K token, giữ provider prompt
dưới 240K khi có thể và chủ động tránh vùng pricing 272K+. Đây là giới hạn
working set, không phải giới hạn năng lực hay context window của model.

## Rule

- Nếu task là read-only, không mở write-capable prompt.
- Nếu task là source-write, phải biết verify command trước khi sửa.
- Không paste full mandatory-flow boilerplate vào task hằng ngày; platform prompts/tools đã chứa flow đó.
- Nếu context vượt budget, tạo summary theo module thay vì nhồi full files.
- Dùng `/context search` hoặc `piagent_context_index_search` để tìm điểm vào repo, nhưng không dùng index thay thế việc đọc source thật.
- Dùng `/context rebuild` sau structural changes; incremental refresh tái sử dụng file không đổi.
- Context pack low-confidence chỉ được mở rộng bằng một bounded finder pass, không loop scout vô hạn.
- Không raw-read hoặc raw-edit `.pi/context-index.json` trong task thường ngày. Runtime coi index là advisory state, sanitize khi đọc qua tool/command, và ghi qua `/onboard run` hoặc `piagent_context_index_record`.
- File context vượt hard cap phải được summarize hoặc đọc targeted slices, không inject full.
- Nếu input quá dài thật, lưu intake vào file project/local gitignored rồi reference file; không dán toàn bộ spec vào một turn.
- Nếu input chứa local screenshot/image path, để input guard attach thành `[image1]` thay vì đọc ảnh như text context. Ảnh lớn hơn giới hạn chat nên dùng Pi `read` để resize.
- Tool output dài chỉ nên hiện preview. Dùng `/logs` hoặc command targeted hơn để debug; không paste full test/build log vào chat/final.
- Memory chỉ là hint. Phải verify bằng source hiện tại trước khi sửa code.
- Context index cũng chỉ là hint. Nó có node/edge/citation để giảm scout lại, không phải security boundary hoặc source of truth.
- Context Engine telemetry chỉ lưu operational metadata/hash dưới `.pi/piagent-state/`; prompt và tool output thô vẫn nằm trong Pi session/audit source hiện có.

## Nguồn

- Pi compaction: https://pi.dev/docs/latest/compaction
- Pi settings: https://pi.dev/docs/latest/settings

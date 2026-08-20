# Pi Agent Platform

[English](README.md)

Pi Agent Platform là reusable Pi harness dành cho project onboarding, workflow theo profile, guarded tool usage, MCP, multi-agent orchestration, memory policy, Context Engine và task verification.

Tài liệu public: [piagent.io.vn](https://piagent.io.vn)

## Cài đặt

Yêu cầu Node.js `>=22.19.0`. Chạy từ project cần sử dụng:

```bash
npm install -g @piagent/platform
piagent-setup
```

Sau khi setup:

```bash
cd /path/to/project
pi
```

Trong session Pi đầu tiên của project, chạy `/onboard`. Hằng ngày, dùng `/workflow` để chọn luồng và `/usage` để xem session, model, thinking và token.

## Nguyên tắc vận hành

- Mỗi task dùng một session có tên rõ ràng.
- Slash command chỉ chạy handler đã đăng ký; agent không phải scout lại command.
- Prompt hướng dẫn model, còn policy quan trọng được enforce tại runtime.
- MCP config không chứa token hoặc OAuth credential.
- Task source-changing cần scope, verify evidence và final gate.
- Local state nằm trong `.pi/piagent-state/`, có owner-only permission và bounded retention.
- Project-specific business logic nằm trong project profile hoặc adapter, không đưa vào core.

Task Contract v2 hiện gắn task/session/run identity với current-tree verification,
strict acceptance receipt, hash-chained journal checkpoint, retry có giới hạn và
terminal outcome bất biến. Đây là operational record do cùng runtime tạo ra,
không phải independent attestation.

Adaptive Context Planner dùng model, thinking và context usage do Pi báo để đặt
budget có giới hạn; repository-memory hint luôn có citation và không thay thế
việc đọc source hiện tại. Parent model vẫn do operator pin: baseline ổn định này
chưa ship solver hoặc automatic parent routing. Host execution là mặc định; nếu
yêu cầu isolation backend chưa có adapter, mutation bị block thay vì âm thầm
fallback về host.

## Web search và vision

Web research và đọc ảnh là hai capability tách biệt. Tích hợp `pi-web-access`
được pin sẽ ưu tiên route `openai-codex` khi Pi đã xác thực và giữ fallback search
tự động; credential không được đưa vào project hoặc browser state. Ảnh được gửi
dưới dạng native image input cho model của session, không qua OCR service riêng
do Piagent vận hành. Dashboard hiển thị đúng route tại **Cài đặt → Nhà cung cấp &
model**: `Codex Web Search` khi route đó sẵn sàng, và `Codex Vision` chỉ khi model
Codex hiện tại công bố hỗ trợ image input.

## Workspace tài liệu trên WebUI

Session Hub cho phép đính kèm ảnh hoặc tài liệu do người dùng chọn vào cuộc trò
chuyện mới hay session đang mở. File Markdown, text, PDF và DOCX được trích xuất
cục bộ với giới hạn rõ ràng; chat chỉ giữ card file gọn, còn workspace **Tài
liệu** hiển thị preview dễ đọc mà không tạo model turn. File vượt giới hạn gửi
trực tiếp vẫn nằm trong workspace của project thay vì bị nhét vào prompt. Runtime
tiếp tục áp protected path, redaction, session binding và attachment ref dùng một
lần.

Session Hub cũng đưa các workflow Terminal lên UI: task, scout, BE → FE,
discuss, plan, review, commit, PR, onboard và platform-improve. Màn hình New chat
hiển thị preflight workflow/change mode/quyền trước khi gửi. Trong **Cài đặt →
Điều khiển project**, operator có thể xem runtime/usage, onboarding/profile,
Context Engine, memory và MCP governance mà không cần nhớ slash command. WebUI
gửi đúng command vào Pi runtime; thao tác read-only được kiểm tra là 0 model
token, còn thao tác ghi hoặc semantic compact bắt buộc xác nhận rõ ràng.

## Command chính

| Command | Mục đích |
|---|---|
| `/workflow` | Chọn workflow task, scout, plan, review, commit, PR hoặc onboarding |
| `/profile` | Xem hoặc đổi project profile |
| `/permission` | Đổi permission mode trong session |
| `/context` | Xem Context Engine, index, retrieval và telemetry |
| `/usage` | Xem session, model, thinking và context usage |
| `/piagent-inspector` | Mở menu read-only để xem task diff, command fail/block, safety warning và context budget; panel bốn dòng tự hiện sát footer native, `toggle` để ẩn trong session |
| Pi native `/name` | Đặt tên session; Piagent nhận rename event để map Agent Watch/report |
| `/memory` | Xem hoặc cập nhật explicit project memory |
| `/onboard` | Khởi tạo project profile và context |

## Architecture

Code được quản lý theo các layer:

1. Composition root đăng ký Pi extension.
2. Runtime adapter xử lý Pi hook, command, tool và session UI.
3. Core service xử lý policy, task, context và state.
4. Integration quản lý MCP, capability và security primitive.
5. CLI trong `scripts/` chỉ parse argument và gọi use case.

Chạy gate kiến trúc:

```bash
npm run architecture:check
```

Đọc chi tiết:

- [Architecture tiếng Việt](docs/vi/architecture.md)
- [Maintainer guide tiếng Việt](docs/vi/maintainer-guide.md)
- [Tài liệu tiếng Việt](docs/vi/README.md)
- [Operator manual tiếng Việt](docs/operator-manual-vietnamese.md)
- [Command reference tiếng Việt](docs/command-reference-vietnamese.md)

## Cấu trúc repository

```text
piagent/
├─ architecture/                      quy tắc layer và giới hạn file cho máy kiểm tra
├─ adapters/                          profile project tái sử dụng
├─ catalog/                           capability index xác định
├─ docs/                              tài liệu chuẩn EN/VI và hướng dẫn vận hành ổn định
├─ evals/                             kịch bản đánh giá có governance
├─ packs/                             capability manifest và recipe có version
├─ packages/
│  ├─ piagent-core/                   Pi package: extension, runtime, prompt, skill
│  └─ piagent-webui/                  dashboard: contract, client, server, gateway, ownership
├─ schemas/                           JSON schema
├─ scripts/                           setup, doctor và helper kiểm tra
└─ templates/                         template project/global
```

`piagent-core` là Pi extension và có thể chạy headless độc lập. `piagent-webui`
là giao diện `piagent dashboard`, nằm trên một dependency spine riêng: WebUI đọc
platform nhưng platform không phụ thuộc ngược vào WebUI, nên runtime vẫn hoạt động
khi không mở dashboard. Cả hai sơ đồ layer đều được kiểm tra bằng
`npm run architecture:check`; xem [Architecture](docs/vi/architecture.md).

## Adaptive model routing

Adaptive model routing cho fresh task dùng `piagent-route --prompt "<task>" --json`.
Chỉ `--execute --yes` mới mở provider-backed Pi process; `/model`/CLI pin luôn
được giữ và extension không đổi model giữa conversation.

## Verification

```bash
npm run verify
```

Gate riêng cho parity WebUI/Terminal (không gọi provider) và suite logic sâu dùng
baseline Luna/medium so với `codex-cli`:

```bash
npm run benchmark:webui-parity
npm run benchmark:deep -- --dry-run
npm run benchmark:deep
```

`deep-logic-v1` có 6 scenario difficulty `large`, 2 repeat và 2 surface (24
model session), phủ event reconciliation, fair dependency scheduling, layered
policy, graph-aware context, resumable stream và transactional config. `--dry-run`
chỉ validate kế hoạch, không dùng quota.

Gate này chạy architecture check, test, typecheck, capability validation, runtime smoke và docs consistency trước khi release.

Bản phát hành hiện tại là `v1.5.4`. Với team hoặc production, hãy pin tag này
hoặc một commit đã review thay vì dựa vào nguồn package không cố định.

## Security

Pi Agent Platform là application-level policy layer, không phải OS sandbox. Với untrusted code hoặc adversarial workload, vẫn cần container hoặc VM có filesystem, process, network và credential boundary riêng.

Không commit OAuth token, API key, `auth.json`, session, cache, trust state hoặc dữ liệu nội bộ.

## License

MIT License. Xem [LICENSE](LICENSE).

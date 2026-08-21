# Publish cho team dùng
<!-- language: vi; english-index: docs-site/content/en/team.html -->

## Mục tiêu

Team khác có thể cài cùng một Pi platform mà không lấy secret của maintainer.

## Cách phát hành

### Git repo

Dùng tag hoặc reviewed commit cho team/repo cần reproducible lock:

```bash
pi install git:github.com/Vt-mmm/piagent@vX.Y.Z
```

Pin tag hoặc commit cho `.pi/settings.json` đã commit vào project. Luồng cài host, terminal helper, Pi package, update và rollback canonical nằm tại [release/install policy](release-install-policy.md).

Moving latest chỉ dành cho máy cá nhân hoặc sandbox chấp nhận thay đổi không đồng bộ:

```bash
pi install git:github.com/Vt-mmm/piagent
```

### npm private package

Dùng khi muốn version/publish chuẩn:

```bash
pi install npm:@your-scope/platform@x.y.z
```

### Local path

Dùng khi dev platform trên một máy, không commit source này vào project team:

```bash
pi install /path/to/piagent
```

## Versioning

- `0.1.x`: local/internal pilot.
- `0.2.x`: có guard ổn định và docs team.
- `1.0.2`: đủ security review, MCP registry, adapter schema versioned.
- `1.1.0`: đọc document ngoài project qua `additionalReadRoots`, MCP baseline bật mặc định ở cả hai lệnh install, pin Pi host `0.82.0`.
- `1.1.1`: `piagent-setup --no-mcp` thật sự không cài MCP (opt-out từng bị default mới của `1.1.0` đè); `site:check` không còn treo khi response vượt body cap và không còn `PASS` khi có địa chỉ chưa kiểm được; `piagent_document_read` từ chối byte không phải UTF-8/UTF-16 thay vì decode thành ký tự thay thế.
- `1.1.2`: đóng TOCTOU của document reader, hash evidence tính trên text đã redact, publish chờ đủ verify matrix.
- `1.1.3`: command mang secret không còn được dùng làm verify evidence, document reader từ chối FIFO thay vì treo, redact secret ngắn, redirect phải về đúng trang được kiểm.
- `1.1.4`: nhận diện secret dạng CLI option (`--token`, `--password`, `--api-key`) và Authorization header ở mọi vị trí argument.
- `1.1.5`: thêm `piagent-update` — một lệnh update cả Pi host, terminal helper và Pi package đúng thứ tự.
- `1.1.6`: `be-readonly-fe` giữ được backend read-only trong monorepo, detect FE/BE đọc cả workspace, và rule detect gộp về một chỗ.
- `1.1.7`: update global không còn chặn project đang chạy — lock chỉ block khi grant thật sự đổi, và profile dạng `extends` nhận policy từ platform đang cài thay vì giữ bản copy lúc onboard.
- `1.1.8`: Pi báo ngay ở đầu session khi có release mới, kèm lệnh chạy update.
- `1.1.9`: notice update hiện đúng trên bản cài bằng `pi install git:` — bản cài nhận diện theo vị trí thư mục, không theo `.git`.
- `1.2.0`: `piagent-mcp` quản lý server đầy đủ, server do repo mang theo phải được duyệt mới dùng được, và `/piagent-mcp` là command trong session chứ không phải nhờ model chạy bash.
- `1.2.1`: approval gate thật sự phủ direct tool và server đến qua `imports` — hai đường vòng mà bản `1.2.0` để hở; kèm một loạt fix về containment khi vendor, độ sâu shell guard, và credential trong URL.
- `1.2.2`: tool output dài được compact vào preview trong Pi và capture local cho Agent Watch/report; thêm `/setname` và `/logs` cho session naming và log audit gọn.
- `1.2.3`: gom command hằng ngày về `/workflow`, `/usage`, `/context`, `/permission`, `/onboard`, `/name` và `/fresh`.
- `1.2.4`: update global có fallback về user-writable npm prefix và project migration/doctor là bước hậu kiểm tùy chọn.
- `1.2.5`: updater đọc đúng metadata singleton-array của npm 12.
- `1.2.6`: Context Engine v2, dynamic tool loading, hard-budget retrieval, semantic compaction, Agent Watch telemetry/feedback và quality benchmark theo context efficiency.
- `1.2.7`: refresh exact MCP/subagent add-on pins, loại dependency URL/static-server có advisory và chặn cả moderate advisory trong runtime release gate.
- `1.2.8`: cài `pi-web-access@0.17.0` mặc định trong setup/update để researcher subagents có web/search/fetch thật; thêm `--no-web-access` cho máy không được phép browse.
- `1.2.9`: hợp nhất Context Engine exclusion policy giữa CLI và runtime, resolve profile `extends`, loại `readOnlyPaths`, tự rebuild index khi policy digest đổi, chặn symlink source ra ngoài project, và làm rõ lỗi thiếu migrator trong update dry-run.
- `1.2.10`: bắt buộc `contextIndexV2Status` nhận explicit exclusion policy; Context Engine storage chuyển sang owner-only, bật core + FTS5 secure-delete và tự retry FTS rebuild/VACUUM khi policy đổi để purge raw bytes của index cũ.
- `1.2.11`: Task Contract v2 gắn session/attempt, retry có giới hạn, work-plan
  progress, Git baseline-aware changed files, scope + all-command final gate,
  hard completion hook, context pack dedupe, fail-closed verifier và bounded
  symlink-safe local state dùng được giữa nhiều Pi session/subagent.
- `1.2.12`: benchmark release `production-v1` 108 session, Wilson quality
  interval, so sánh có kiểm soát với surface baseline `codex-cli` trong
  `CODEX_HOME` riêng, và retry chỉ dành cho lỗi hạ tầng.
- `1.2.13`: trang benchmark tĩnh với evidence `production-v1` đã verify, chart
  score/token/paired-win, và snapshot đã sanitize trong quality benchmark guide.
- `1.2.14`: tách runtime theo layer có enforce bằng máy (dependency direction +
  file budget), integrity lock pin mọi module vừa tách, maintainer doc EN/VI, và
  bỏ `/name` custom để không shadow lệnh gốc của Pi.
- `1.2.15`: update stable chạy được trên máy đang đăng ký Piagent bằng đường dẫn
  local, kèm regression chặn installer đọc nhầm version Pi hiển thị.
- `1.2.16`: default Codex chuyển sang `openai-codex/gpt-5.5:high`, fallback khi
  thiếu thinking suffix là `high`.
- `1.2.17`: doc site song ngữ đầy đủ — 17 trang có bản EN, chuyển VI/EN cùng chủ
  đề, và gate kiểm link + locale parity.
- `1.3.0`: bản stable đầu tiên của Intelligence Engine — Criterion Graph, bounded
  current-source context, tool surface ổn định, trần một continuation, verify
  trên cây hiện tại, resume/handoff bền. Pin Pi host `0.84.1`, install stable
  dùng npm `latest` + tag `v1.3.0`.
- `1.3.1`: mở rộng integrity inventory sang TypeScript loader/CLI dispatcher và
  các module task-state/verification còn lại; thay full-file hashing mỗi tool
  call bằng metadata cache fail-closed; bỏ shell interpolation trong probe
  `pdftotext`; JSONL state lock publish owner nguyên tử và tự phục hồi khi
  writer bị kill.
- `1.4.0`: Local Session Hub — Gateway một-instance-mỗi-profile và
  `piagent dashboard` để tạo/mở lại/resume/rename/pin/archive/fork session mà
  không tốn thêm model turn; client MUI conversation-first song ngữ với Agent
  Inspector; projection Task Changes / Working Tree / Staged có bounded diff,
  provenance và enforce protected path; session lease bền, recovery khi restart
  hoặc owner cũ treo, doctor có repair tường minh.
- `1.5.5`: hotfix WebUI command execution — approval nhận đúng opaque tool-call
  ID, lệnh tìm kiếm không còn bị nhận nhầm thành migration, Stop hủy approval
  đang chờ, activity chỉ báo running sau khi command thật sự chạy, và restart
  không tái sử dụng process treo.
- `1.5.4`: hotfix WebUI giữ ownership qua workflow dispatch bất đồng bộ, không
  còn báo `session-command-effect-unknown` giả; session đã tạo được tự đồng bộ
  mà không gửi lại, và transcript không lặp tin workflow sau khi persisted.
- `1.5.3`: WebUI có workflow theo từng tin nhắn thay vì khóa cả session, mặc
  định hiển thị rõ GPT-5.6 Sol High, Project Controls typed và UI gọn sau nút
  `+`; benchmark thêm `deep-logic-v1`, WebUI parity provider-free và hai family
  capability cho session control/timeline recovery.
- `1.5.2`: kéo thả và dán tài liệu vào ô chat mới. Nút kẹp giấy vốn đã đưa file
  vào session mới; kéo thả là lối vào duy nhất còn im lặng, file thả xuống bị
  mất mà không báo gì.
- `1.5.1`: bản phát hành mang nội dung của `1.5.0` tới registry. `1.5.0` được
  tag nhưng release matrix fail trên macOS nên job publish không chạy; tag cũ
  được giữ nguyên thay vì dời, vì bootstrap dựa trên tính bất biến của tag.
- `1.5.0`: document workspace, bounded file attachments, deterministic session
  titles và compact live activity timeline trong Session Hub. Không có trên
  registry — dùng `1.5.1`.
- `1.4.1`: maintenance release cho Session Hub và guard — session tiếp tục được
  qua nhiều Task Contract thay vì bị terminal giữa cuộc trò chuyện, task chỉ
  chạy test/build được cấp đúng execution authority, Gateway/local install luôn
  đồng bộ cùng checkout, context usage của session đã lưu hiển thị trong WebUI,
  và integrity/redaction/docs parity được mở rộng tới shell, browser bundle,
  TypeScript graph, npm token cùng các lệnh remedy có thể thực thi.

## Không publish

- `auth.json`
- `.env`
- session files
- private token
- project data dump

## Team onboarding

1. Install exact Pi host version declared by the target release.
2. Install the pinned terminal helper and matching Pi package.
3. Login OAuth provider.
4. Run `pi` in the target project.
5. Run `/onboard`.
6. Choose/apply a profile inside Pi.

Chi tiết: `docs/team-onboarding.md` và `docs/distribution-standard.md`.

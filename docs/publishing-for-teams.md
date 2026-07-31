# Publish cho team dùng

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

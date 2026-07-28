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
5. Run `/onboard-project`.
6. Choose/apply a profile inside Pi.

Chi tiết: `docs/team-onboarding.md` và `docs/distribution-standard.md`.

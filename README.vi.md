<p align="center">
  <a href="https://piagent.io.vn"><img src="https://piagent.io.vn/assets/piagent-logo.svg" alt="Piagent" width="72" height="72"></a>
</p>

<h1 align="center">Pi Agent Platform</h1>

<p align="center"><strong>Coding agent cho cả team, kiểm tra từng bước.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@piagent/platform"><img alt="npm" src="https://img.shields.io/npm/v/@piagent/platform?color=c6f432&labelColor=111114"></a>
  <a href="https://github.com/Vt-mmm/piagent/actions/workflows/verify.yml"><img alt="verify" src="https://github.com/Vt-mmm/piagent/actions/workflows/verify.yml/badge.svg"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.19-111114?labelColor=111114">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-111114?labelColor=111114"></a>
</p>

<p align="center">
  <a href="https://piagent.io.vn">Website</a> ·
  <a href="https://piagent.io.vn/quickstart">Cài đặt</a> ·
  <a href="https://piagent.io.vn/whats-new">Changelog</a> ·
  <a href="https://piagent.io.vn/benchmark">Benchmark</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="https://piagent.io.vn/assets/shots/company-run-done.jpg" alt="Dashboard Piagent: một lượt ở chế độ công ty đọc, sửa và chạy test, dòng cuối báo kết quả check và review" width="900">
</p>

Piagent là một Pi package biến coding agent thành thứ cả team tin dùng được. **Guard** kiểm tra mọi tool call trước khi chạy. Ở chế độ công ty, **Harness** của team chạy check của project và cho một subagent review bản sửa trước khi lượt được báo là xong. Một **dashboard** cho cả Terminal và trình duyệt, dùng tài khoản model của bạn hoặc model của công ty qua Agent Watch và Agent Studio.

## Vì sao chọn Piagent

- **Fail-closed.** File bảo vệ (`.env`, khoá), profile quyền, file quá lớn và sửa trên bản đọc đã cũ bị chặn trước khi chạy, không phải giải thích sau.
- **Duyệt từng lần.** Push, publish, ghi lên GitHub và lệnh có mạng chờ **Cho phép một lần**. Stage cả loạt như `git add .` cũng hỏi trước.
- **Lượt có kiểm chứng.** Ở chế độ công ty, mỗi lượt kết thúc bằng một dòng: check đã qua trên code cuối, review có hay không có lỗi chặn.
- **Chạy được việc dài.** Lỗi tạm thời của nhà cung cấp được hỏi lại, lúc Studio cập nhật thì chờ rồi làm tiếp, một lượt chạy được tới 24 giờ.
- **Đo được.** Trên [benchmark production](https://piagent.io.vn/benchmark) (v1.6.0, 108 session, cùng model và thinking), Piagent giải 54/54 task so với 48/54 của `codex-cli`, dùng ít hơn 61,43% fresh token (khoảng tin cậy 95%: ít nhất 51,60%).

## Cài đặt

Node.js `>=22.19.0`. Chạy trong project cần dùng:

```bash
npm install -g @piagent/platform
piagent-setup
```

`piagent-setup` cài đúng bản Pi host mà release này pin, cài package, khởi tạo `.pi/`, thêm MCP baseline và subagent, rồi chạy doctor. Chạy trong terminal, lần cài đầu sẽ hỏi bạn muốn cài add-on nào và có dùng lại login của pi không; muốn bỏ bớt ngay từ đầu thì dùng `--no-mcp`, `--no-subagents`, `--no-web-access`, `--no-herdr` hoặc `--global-only`.

Piagent cài vào Pi home riêng, `~/.piagent/agent`. `pi` của bạn (`~/.pi/agent`) giữ nguyên bản gốc: không có package Piagent, add-on, danh sách model hay panel dưới footer. Các bản trước 1.46 cài vào `~/.pi/agent`; installer sẽ dời bản cài đó ra, còn `piagent restore-pi` (chỉ báo) / `piagent restore-pi --apply` làm việc này riêng. File nào bị đổi đều có bản sao lưu nằm cạnh. Muốn dùng [Herdr](https://herdr.dev/docs/install/) thì cài Herdr trước; trên Windows thì cài trong Ubuntu (WSL2), cùng chỗ với Piagent.

**Windows** — một lệnh PowerShell cài WSL2, Ubuntu, Piagent và Agent Watch; chạy lại để cập nhật:

```powershell
irm https://raw.githubusercontent.com/Vt-mmm/agentwatch/main/windows/setup.ps1 | iex
```

| Môi trường | Trạng thái |
|---|---|
| macOS Apple Silicon | Đã kiểm chứng cho release này |
| Linux x64 | Đã kiểm chứng trong CI |
| macOS Intel, Linux ARM64 | Hỗ trợ; chạy `piagent-doctor` và smoke test trước khi rollout rộng |
| Windows (WSL2) | Chế độ cá nhân và công ty, sandbox bubblewrap, Agent Watch cho Windows ([hướng dẫn](https://piagent.io.vn/windows)) |
| Windows native | Bản xem trước cho chế độ cá nhân; chưa chạy được `piagent-update` |

## Sử dụng

```bash
piagent dashboard          # trình duyệt, chế độ cá nhân
piagent                    # Terminal, chế độ cá nhân (`pi` thường vẫn là của bạn)
piagent studio --web       # chế độ công ty, sau khi nhập key ở Agent Watch
```

Nói việc bằng lời thường: "sửa lỗi phân trang ở /orders rồi chạy test", "review diff hiện tại, chỉ đọc". Không có task contract hay lệnh workflow phải học. Từ 1.9.0 các launcher `/workflow`, `/task`, `/fresh`, `/onboard` và `/commands` đã bỏ; mở session mới bằng `/new` của Pi.

## Cập nhật

Dashboard và Terminal kiểm tra bản mới mỗi giờ, hỏi **Cập nhật ngay** hay **Để sau**. Tự cập nhật:

```bash
piagent-update                     # bản mới nhất
piagent-update --check             # chỉ kiểm tra
piagent-update --version X.Y.Z     # đúng một bản, mới hơn hay cũ hơn
```

Lệnh cài Pi host được pin trước, kiểm tra version trên đĩa rồi mới chạy installer; với `--project` nó migrate project và chạy doctor. Pin cho team, rollback và gỡ cài đặt: [Cập nhật và gỡ](https://piagent.io.vn/update) và [release and install policy](docs/release-install-policy.md).

```bash
piagent-uninstall           # chỉ báo sẽ gỡ gì
piagent-uninstall --apply   # gỡ thật
```

Credential, trust, session, todo và memory của project không bao giờ bị xoá.

## Hai chế độ, một dashboard

| | Cá nhân | Công ty |
|---|---|---|
| Mở | `piagent`, `piagent dashboard` | `piagent studio`, `piagent studio --web` |
| Model | Tài khoản của bạn, model nào Pi hỗ trợ | Chọn theo vai (main · research · review) trong Agent Studio |
| Key | Trên máy bạn, do Pi quản lý | Trong Keychain qua Agent Watch; model không bao giờ thấy |
| Lệnh | Mạng bình thường; push và publish chờ duyệt | Sandbox (Seatbelt / bubblewrap) không mạng; mạng mở theo từng lần duyệt |
| Kiểm chứng | Bạn yêu cầu | Harness của team chạy check và review mỗi lượt |

## Có gì bên trong

| Phần | Bạn có |
|---|---|
| Guard | Protected và read-only path, profile quyền, kiểm tra bản đọc cũ và file lớn, che secret trong output, hỏi trước việc bên ngoài và việc phá huỷ |
| Dashboard | Cuộc trò chuyện, cây thư mục, editor, terminal, review từng hunk, Timeline khôi phục và `/undo`, Tài liệu, 13 theme màu, bảng lệnh ⌘K |
| Harness công ty | Plan · check · review mỗi lượt, câu hỏi hiện từng cái một, team memory với `memory_ask`, cảnh báo sai project, chạy bền cho task dài |
| Context Engine | Index local tăng dần, tìm kiếm lai, pack theo ngân sách token, compaction theo ngữ nghĩa — `/context` |
| MCP | `pi-mcp-adapter` với preset đã pin, bốn scope cấu hình, approval gate cho server đến từ repo — `piagent-mcp` |
| Profile | 11 profile có sẵn (frontend, backend, fullstack, data, DevOps, mobile, docs…) với protected path và verify command — `/profile` |
| Báo cáo | `fe-change-report`: ảnh trước/sau khung đỏ đánh số, check và E2E, xem trong Tài liệu |

<details>
<summary><strong>Permission profile</strong></summary>

| Profile | Dùng khi | Guard làm gì |
|---|---|---|
| `read-only` | Khảo sát, audit, review | Cho `read`, `grep`, `find`, `ls` và tool state của piagent; chặn shell, sửa file và tool lạ. |
| `workspace-write` | Code bình thường | Mặc định. Kiểm tra protected path, read-only path, shell và capability; hỏi trước việc phá huỷ và việc bàn giao. |
| `trusted-full-access` | Tự động hoá tin cậy trên máy | Tự chủ hơn, vẫn giữ protected path, che secret, toàn vẹn capability lock, và hỏi trước việc phá huỷ và việc bàn giao. |
| `bypass` | Để việc chạy không cần trông | Không gate nào hỏi hay chặn việc làm. Việc bàn giao vẫn hỏi. Output vẫn được che secret và mỗi lượt vẫn có checkpoint `/undo`. Bỏ khỏi `permissionProfiles.allowedModes` để cấm; ở chế độ công ty admin Studio tắt được (`bypass_mode`). |

Việc bàn giao là bước đưa việc ra khỏi máy này: `git push`, tạo hoặc merge pull request, release, publish package, deploy, push lên registry, `ssh`, tool cloud và cluster (`vercel`, `aws`, `kubectl`, `terraform`…), upload, và công cụ MCP ghi vào hệ thống phía sau. Mọi chế độ đều hỏi trước bước này, personal lẫn công ty, kể cả Bypass; một danh sách duy nhất quyết định ([handoff-policy.mjs](packages/piagent-core/runtime/policy/handoff-policy.mjs)).

Trong Pi dùng `/permission` (menu), `/permission status`, `/permission read-only`, `/permission workspace-write`, `/permission full-access [việc]` hoặc `/permission bypass`. Cho một lần chạy: `PIAGENT_PERMISSION_PROFILE=…` hoặc `piagent-auto --read-only|--workspace-write|--full-access|--bypass`.

</details>

<details>
<summary><strong>Lệnh trong session</strong></summary>

Đây là cài đặt và màn xem chỉ đọc; không lệnh nào mở lượt model. Giải thích từng lệnh ở [command reference](docs/command-reference-vietnamese.md).

| Lệnh | Dùng để |
|---|---|
| `/profile` | Xem hoặc áp profile. `/profile setup`, `/profile tech`, `/profile auto` chọn tech cho từng vai. |
| `/permission` | Xem hoặc đổi permission profile của session. |
| `/context` | Index, tìm kiếm, pack, test impact và compaction của Context Engine. |
| `/usage` | Usage của session, model, thinking và context; `/usage logs` xem output tool đã thu gọn. |
| `/memory` | Memory của project. |
| `/piagent-mcp` | MCP server, scope và approval. |
| `/piagent-status` | Trạng thái profile, guard, runtime và model đã đăng nhập. |
| `/piagent-inspector` | Diff, lệnh và lỗi, cảnh báo an toàn và ngân sách context trong một menu chỉ đọc. |
| `/piagent-orchestration` | Chế độ helper, giới hạn và lý do dispatch. |

Git vẫn là capability: nói "commit hai file này" hay "mở PR" (prompt `/commit` và `/pr` cho cùng flow). Chọn model bằng `/model` hoặc `Ctrl+L` của Pi; xem [Model options](docs/model-options.md).

</details>

<details>
<summary><strong>Subagent và MCP</strong></summary>

Model chính lo suy luận, sửa code và kiểm chứng. Khi bật helper, nó được giao tối đa hai helper chỉ đọc (khảo sát, hoặc review bản sửa); helper không sửa code và không mở helper khác. `piagent-setup` cài runtime `pi-subagents` với preset giới hạn; `/subagents-doctor` kiểm tra sức khoẻ. Chi tiết: [Subagent orchestration capabilities](docs/subagent-orchestration-capabilities.md), [auto-delegation](docs/auto-delegation-policy.md), [subagents and multi-agent](docs/subagents-and-multiagent.md).

`piagent-setup` cài `pi-mcp-adapter` và preset `core` (Context7, Chrome DevTools, GitHub); `popular` thêm Playwright và Figma. Bước này chỉ ghi định nghĩa server, server kết nối khi cần. Giữ key của nhà cung cấp trong biến môi trường. Tìm kiếm web qua add-on `pi-web-access` đã pin. Xem [MCP and tools](docs/mcp-and-tools.md).

</details>

<details>
<summary><strong>Mô hình bảo mật</strong></summary>

Guard là lớp chống sự cố ở tầng ứng dụng, không phải OS sandbox. Nó chặn truy cập dạng đường dẫn tới protected path trên tool có sẵn, tool tự viết và MCP (object lồng nhau, `file://`, percent-encoding, không phân biệt hoa thường, symlink thoát ra ngoài), tách operand của shell để chặn `bash` truy cập trực tiếp, hỏi trước khi shell ghi ra bên ngoài, và che dữ liệu nhạy cảm trong output. [Redaction benchmark](docs/security-redaction-benchmark.md) bắt 52/52 mẫu secret theo ngữ cảnh, 0/30 văn bản thường bị che nhầm; đây là cổng nội bộ, không phải audit độc lập.

Với code hoặc prompt không tin cậy, chạy Pi trong container hoặc VM có ranh giới filesystem, process, mạng và credential. Threat model: [docs/security-threat-model.md](docs/security-threat-model.md). Báo lỗ hổng riêng tư theo [SECURITY.md](SECURITY.md).

</details>

## Bằng chứng

| Đo gì | Kết quả | Nguồn |
|---|---|---|
| Task giải được, production-v1 (v1.6.0, GPT-5.6 Luna Medium) | Piagent 54/54 · `codex-cli` 48/54 | [benchmark](https://piagent.io.vn/benchmark) |
| Fresh token, family fixed-workload chính | tỷ lệ `0.3857` (−61,43%), CI 95% `0.3073..0.4840` | [phương pháp](docs/quality-benchmark.md) |
| Đếm usage | 108/108 session chính xác, không retry | cùng lần chạy |
| Che secret | 52/52 mẫu theo ngữ cảnh, 0/30 báo nhầm | [redaction benchmark](docs/security-redaction-benchmark.md) |
| Nhịp phát hành | mọi bản trong [CHANGELOG.md](CHANGELOG.md) | [trang changelog](https://piagent.io.vn/whats-new) |

Benchmark là bộ bài tổng hợp do maintainer dựng, đo ở v1.6.0 và chưa đo lại cho các bản sau; không có kết luận nào về thời gian hay chi phí. Tự chạy bằng `piagent-benchmark --production --dry-run`, hoặc bản nhanh `core-v1` bằng `piagent-benchmark --dry-run`.

## Đóng góp

```bash
npm ci
npm run verify
```

`npm run verify` chạy typecheck, test, capability catalog, doctor và các check kiến trúc, câu chữ, docs site. Docs site và `CHANGELOG.md` được sinh tự động: sửa `docs-site/content/` và `docs-site/releases.json`, rồi chạy `node scripts/build-docs-site.mjs`. Quy trình: [CONTRIBUTING.md](CONTRIBUTING.md). Bố cục và luật layer: [Kiến trúc](docs/vi/architecture.md).

Repo này không bao giờ chứa OAuth token, `auth.json`, file `.env`, key MCP hay nhà cung cấp, session của Pi, dữ liệu project hay đường dẫn trên máy.

## Tài liệu

- **Bắt đầu:** [Website](https://piagent.io.vn) · [Cài đặt](https://piagent.io.vn/quickstart) · [Hệ sinh thái](https://piagent.io.vn/ecosystem) · [Quickstart tiếng Việt](docs/quickstart-vietnamese.md) · [Team onboarding](docs/team-onboarding.md)
- **Sử dụng:** [Command reference](docs/command-reference-vietnamese.md) · [Workflow recipes](docs/workflow-recipes.md) · [Model options](docs/model-options.md) · [OAuth providers](docs/oauth-providers.md) · [Context Engine](docs/context-engine.md) · [Memory policy](docs/memory-policy.md)
- **Vận hành:** [Operator manual](docs/operator-manual-vietnamese.md) · [Release and install policy](docs/release-install-policy.md) · [Publishing for teams](docs/publishing-for-teams.md) · [Usage observability](docs/usage-observability.md)
- **Bên trong:** [Kiến trúc](docs/vi/architecture.md) · [Runtime policy design](docs/runtime-policy-design.md) · [Security threat model](docs/security-threat-model.md) · [Quality benchmark](docs/quality-benchmark.md) · [Mọi tài liệu](docs/README.md)

## Giấy phép

MIT. Xem [LICENSE](LICENSE).

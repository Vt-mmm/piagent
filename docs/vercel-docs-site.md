# Vercel docs site
<!-- language: vi; english-index: docs/en/README.md -->

## Khuyến nghị

Giữ tài liệu HTML trong cùng repository, dưới `docs-site/`.

Production URL: https://piagent.io.vn

Vercel project: `pi-agent`

Root Directory: `docs-site`

Lý do:

- docs đi cùng source và version của package;
- source và docs được review trong cùng release candidate;
- Vercel trỏ Root Directory thẳng vào `docs-site/`;
- site static không cần build step hoặc environment secret.

Tách repository chỉ nên dùng khi docs cần domain, quyền truy cập, hoặc lịch phát hành riêng.

## Cấu trúc site

Site là nhiều trang tĩnh, mỗi topic một trang, sinh ra từ một shell dùng chung:

```text
docs-site/
  content/<slug>.html   # source tiếng Việt; URL giữ ở /<slug>
  content/en/<slug>.html # source English; URL ở /en/<slug>
  assets/docs.css       # style dùng chung
  assets/docs.js        # sidebar filter, TOC, active-section, copy button
  <slug>.html           # output VI đã generate, được commit
  en/<slug>.html        # output EN đã generate, được commit
  vercel.json
scripts/build-docs-site.mjs
```

Sidebar chia theo bốn nhóm — Get started, Build, MCP, Operate. Thứ tự nhóm và thứ tự trang nằm trong hằng `NAV` của `scripts/build-docs-site.mjs`; metadata English nằm trong `EN_PAGE_COPY`. Đây cũng là thứ tự của link prev/next ở cuối mỗi trang. Thêm một trang = thêm đủ fragment VI/EN, thêm metadata vào `NAV` và `EN_PAGE_COPY`, rồi build lại. Root URL giữ VI để không gãy link cũ; EN dùng prefix `/en`. Mỗi cặp có canonical, `hreflang` và language switch giữ nguyên topic.

```bash
npm run site:build
```

Output HTML được commit, vì Vercel serve file tĩnh và không có build step. `npm run verify` chạy `build-docs-site.mjs --check`, fail khi output đã commit không còn khớp source — cùng cách `catalog/capabilities.json` đang dùng. Không sửa tay `docs-site/<slug>.html` hoặc `docs-site/en/<slug>.html`; sửa fragment trong `content/` hoặc sửa shell trong script.

Version badge xuất hiện trên mọi trang, nên `npm run release:identity` kiểm tra recursive toàn bộ generated VI/EN pages chứ không riêng `index.html`.

## Production promotion policy

Production docs không được advertise một release tag chưa tồn tại.

Luồng canonical:

1. Sửa source và versioned docs trên release-candidate branch.
2. Chạy verification và chờ CI pass.
3. Tạo/push tag trên đúng verified commit và chờ tag-triggered CI trên Ubuntu/macOS pass.
4. Chạy stable dry-run và xác nhận resolved commit SHA khớp tag.
5. Sau đó release maintainer mới dùng bypass actor đã giới hạn trong ruleset để non-force fast-forward đúng tagged commit vào `main` (Vercel production branch), hoặc checkout đúng commit đó rồi chạy Vercel link preflight trước khi deploy `docs-site/`; không merge/squash/rebase, force-push hay chèn docs-only commit khác trong lúc promote.
6. Kiểm tra live version, canonical URL, link và install command.

Nếu Vercel đang auto-deploy production branch, giữ vNext docs ngoài branch đó cho tới khi tag CI + SHA verification hoàn tất. Checklist duy nhất nằm tại [release/install policy](release-install-policy.md).

## Deploy bằng Dashboard

1. Vào Vercel project `pi-agent`.
2. Set Root Directory: `docs-site`.
3. Set Framework Preset: `Other`.
4. Build Command: để trống.
5. Output Directory: `.` hoặc default.
6. Chỉ promote production sau release gate ở trên.

## Deploy bằng CLI

Sau khi tag CI và stable SHA verification pass, từ checkout đúng tagged commit:

```bash
vercel link --cwd docs-site --project pi-agent
npm run vercel:preflight
vercel --cwd docs-site --prod
```

`npm run vercel:preflight` fail-closed nếu `.vercel/project.json` đang trỏ tới project cũ hoặc sai team. Không chạy production deploy bằng CLI trước khi preflight pass.

Nếu CLI chưa đăng nhập:

```bash
vercel login
```

## Custom domain

Canonical domain: `piagent.io.vn`

Trong Vercel project `pi-agent` → Settings → Domains:

- add `piagent.io.vn` và đặt làm **Primary**;
- add `www.piagent.io.vn` và redirect về `piagent.io.vn`.

Trong iNET DNS, dùng đúng record Vercel Domains panel đang hiển thị; không hardcode một IP cũ trong runbook:

| Type | Name/Host | Value |
|---|---|---|
| `A` hoặc `ALIAS` theo Vercel | `@` | Exact apex target do Vercel hiển thị. |
| `CNAME` | `www` | Exact CNAME target do Vercel hiển thị. |

Không xoá `MX`, `TXT`, `NS`, hoặc email records nếu domain đang dùng mail. Sau khi DNS valid, Vercel sẽ cấp SSL tự động.

Expected URL behavior:

```text
https://piagent.io.vn/      -> 200, không redirect
https://www.piagent.io.vn/  -> redirect về https://piagent.io.vn/
```

Repo giữ canonical và Open Graph URL ở apex. Không đổi source sang `www` nếu hạ tầng vẫn được định hướng apex-primary.

## Post-deploy verification

```bash
curl -I https://piagent.io.vn/
curl -I https://www.piagent.io.vn/
curl -sSL https://piagent.io.vn/ | grep 'vX.Y.Z docs'
```

Xác nhận thêm favicon/logo, GitHub/Facebook links, install commands, sidebar anchors và mobile layout. Vì site giờ là nhiều trang, kiểm tra thêm clean URL và asset dùng chung:

```bash
curl -o /dev/null -s -w '%{http_code}\n' https://piagent.io.vn/mcp
curl -o /dev/null -s -w '%{http_code}\n' https://piagent.io.vn/assets/docs.css
```

## Local preview

```bash
npm run site:preview
```

Mở `http://localhost:4321`. Đổi port bằng `npm run site:preview -- --port 4173`.

Dùng script này thay vì một static server bất kỳ: `vercel.json` bật `cleanUrls`, nên link nội bộ trỏ tới `/quickstart` chứ không phải `/quickstart.html`. `python3 -m http.server` trả 404 cho tất cả các link đó và preview thành vô dụng để kiểm tra navigation. Script bind loopback và resolve extensionless path đúng như production.

## Security notes

- Không đặt secret, token, auth file hoặc session cache trong `docs-site/`.
- `docs-site/vercel.json` chỉ chứa static headers và URL behavior.
- Không cần environment variable cho site tĩnh.
- `.vercel/project.json` là metadata local bị ignore; luôn relink và chạy preflight trên checkout/máy deploy thay vì tin state còn sót lại.

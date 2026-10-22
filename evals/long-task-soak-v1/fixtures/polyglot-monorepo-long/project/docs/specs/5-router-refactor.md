# Spec 5 — Tách `router-old.js` thành module, hành vi giữ nguyên 100%

Trạng thái: **chưa giao**.

`services/web-js/src/legacy/router-old.js` (~3 000 dòng, viết từ thời Node 4:
`var`, prototype, một file chứa cả bảng dữ liệu lẫn handler) là router
storefront-admin mà admin UI và job báo cáo đêm gọi in-process qua
`route(request) → response`. Không ai dám sửa vì không có test. Việc: tách nó
thành module nhỏ, hiện đại, **không đổi bất kỳ hành vi nào** — kể cả các quirk
ghi ở đầu file (admin UI đang dựa vào chúng) và nội dung message lỗi.

## Cách làm bắt buộc

1. **Trước khi sửa gì**: ghi golden từ router cũ vào
   `services/web-js/test/fixtures/router-golden.json` — một mảng ≥ 100 phần tử
   `{ "request": {...}, "response": { "status", "headers", "body" } }` phủ mọi
   route, method sai, 404, lỗi validate, quirk, `accept-language` en/vi, CSV,
   body dạng string JSON hỏng, ... (response lưu đúng như JSON gửi đi).
2. `services/web-js/test/router-golden.test.js`: mọi request trong golden cho ra
   response y hệt (so sau `JSON.parse(JSON.stringify(...))`).
3. Tách sang `services/web-js/src/router/`:
   - `src/router/index.js` export `route(request)` (cùng chữ ký, cùng kết quả).
   - ≥ 6 module `.js` (vd data, messages, http, util/*, handlers/*); **mỗi file
     `.js` ≤ 400 dòng**; bảng dữ liệu lớn để dạng `.json` cạnh module (đọc bằng
     `fs.readFileSync`, không dùng network).
   - Không còn `var`; dùng `const`/`let`, ESM.
4. Xoá `src/legacy/router-old.js` (không file nào còn import nó).
5. `src/index.js` export thêm `adminRoute` (chính là `route` mới).

## Xong khi

`npm test` xanh (golden + test cũ), không còn file legacy, không đổi hành vi.

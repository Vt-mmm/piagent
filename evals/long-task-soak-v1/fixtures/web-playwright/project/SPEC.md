# Đặc tả bang-viec v1

Bảng việc kiểu kanban, JavaScript thuần (không framework, không bước build):
`public/index.html`, `public/app.js`, `public/styles.css`, phục vụ bởi
`server.js` (`npm start`, cổng lấy từ biến môi trường `PORT`, mặc định 4173,
địa chỉ `http://127.0.0.1:<PORT>/`). Các `data-testid`, tên hiển thị và
accessible name dưới đây là **bắt buộc và chính xác** — test tự động dựa vào
chúng.

## 0. Bố cục
- Ba cột theo thứ tự: `<section data-testid="column-todo">` "Cần làm",
  `column-doing` "Đang làm", `column-done` "Xong". Mỗi cột có tiêu đề `<h2>`
  và là một region có accessible name đúng bằng tiêu đề đó.
- Mỗi cột có `data-testid="count-todo"` / `count-doing` / `count-done` chứa
  đúng một số: số thẻ **đang hiển thị** trong cột (sau khi lọc, mục 5).
- Mỗi thẻ là `<li data-testid="card">` nằm trong cột của nó, theo đúng thứ
  tự trong cột; bên trong có `data-testid="card-title"` (tiêu đề) và mỗi nhãn
  là một phần tử `data-testid="card-tag"` (nội dung là tên nhãn).

## 1. Thêm thẻ
- Ô tiêu đề (`data-testid="new-card-title"`, accessible name "Tiêu đề thẻ"),
  ô nhãn (`data-testid="new-card-tags"`, accessible name "Nhãn"), nút
  `data-testid="add-card"` có accessible name "Thêm thẻ". Nhấn Enter trong ô
  tiêu đề cũng thêm thẻ.
- Tiêu đề được cắt khoảng trắng đầu/cuối. Rỗng → không thêm, hiện
  `data-testid="form-error"` với `role="alert"` nội dung đúng
  `Tiêu đề không được để trống`; dài hơn 80 ký tự → `Tiêu đề tối đa 80 ký tự`
  (đúng 80 thì được). Thêm thành công → lỗi ẩn đi, hai ô được xoá trống,
  focus quay về ô tiêu đề.
- Nhãn: tách theo dấu phẩy, cắt khoảng trắng, đổi sang chữ thường, bỏ nhãn
  rỗng và nhãn trùng (giữ lần xuất hiện đầu tiên, giữ thứ tự).
- Thẻ mới nằm cuối cột "Cần làm". Tiêu đề hiển thị nguyên văn: `<b>x</b>` là
  chữ, không phải HTML.

## 2. Sửa tiêu đề
- Mỗi thẻ có nút "Sửa", accessible name `Sửa thẻ: <tiêu đề>`. Bấm → tiêu đề
  thành ô nhập `data-testid="edit-title"` (accessible name "Sửa tiêu đề"),
  chứa tiêu đề cũ và được focus.
- Enter lưu theo cùng quy tắc như mục 1; nếu không hợp lệ thì vẫn ở chế độ
  sửa và hiện `role="alert"` trong thẻ với cùng nội dung lỗi. Escape huỷ, giữ
  tiêu đề cũ. Sau khi lưu hoặc huỷ, focus về nút "Sửa" của thẻ đó.

## 3. Xoá thẻ
Nút "Xoá", accessible name `Xoá thẻ: <tiêu đề>`. Hỏi lại bằng
`window.confirm` với nội dung đúng `Xoá thẻ "<tiêu đề>"?`; chỉ xoá khi người
dùng đồng ý.

## 4. Chuyển thẻ giữa các cột
- Nút accessible name `Chuyển sang trái: <tiêu đề>` và
  `Chuyển sang phải: <tiêu đề>`. Thẻ ở cột đầu không có (hoặc bị vô hiệu hoá)
  nút trái; thẻ ở cột cuối không có (hoặc bị vô hiệu hoá) nút phải.
- Bàn phím: thẻ (`li`) nhận được focus bằng Tab. Khi thẻ đang focus:
  Alt+ArrowRight / Alt+ArrowLeft chuyển sang cột bên phải / trái;
  Alt+ArrowUp / Alt+ArrowDown đổi chỗ với thẻ ngay trên / dưới trong cùng cột.
  Sau đó focus vẫn ở chính thẻ đó.
- Kéo thả (HTML5 drag and drop): kéo một thẻ thả vào một cột khác.
- Mọi cách chuyển sang cột khác đều đặt thẻ vào **cuối** cột đích, và ghi
  `Đã chuyển "<tiêu đề>" sang <tên cột>` vào vùng thông báo
  `data-testid="announcer"` có `aria-live="polite"`.

## 5. Lọc theo nhãn
`<select data-testid="tag-filter">` với accessible name "Lọc theo nhãn":
option đầu tiên "Tất cả nhãn" (value rỗng), sau đó là mọi nhãn hiện có trên
bảng, không trùng, sắp theo bảng chữ cái. Chọn một nhãn → chỉ hiện các thẻ có
nhãn đó. Danh sách nhãn cập nhật khi thêm/sửa/xoá thẻ; nếu nhãn đang lọc
không còn thẻ nào thì bộ lọc về "Tất cả nhãn". Bộ lọc không cần lưu lại.

## 6. Lưu trữ
Trạng thái lưu trong `localStorage` khoá `bang-viec.v1` sau mỗi thay đổi, dạng
`{"cards":[{"id":"…","title":"…","tags":["…"],"column":"todo"}]}` (`column`
là `todo` | `doing` | `done`; thứ tự các thẻ cùng cột trong mảng là thứ tự
hiển thị; `id` là chuỗi duy nhất). Tải lại trang giữ nguyên bảng. Dữ liệu
đúng dạng trên do nơi khác ghi vào cũng phải hiển thị được. Dữ liệu hỏng
(không phải JSON hoặc sai cấu trúc) → bảng rỗng, không có lỗi JavaScript.

## 7. Khả năng truy cập
Mọi `button`, `input` và `select` trên trang đều có accessible name không rỗng
(kể cả nút chỉ có biểu tượng như ← →).

## 8. Kiểm thử e2e
- `@playwright/test` (đã cài, 1.62.1, chỉ dùng Chromium).
- `playwright.config.js`: `testDir: 'e2e'`, chỉ một project chromium,
  `webServer` chạy `npm start` với cổng lấy từ `process.env.PORT` (mặc định
  4173), `use.baseURL` là `http://127.0.0.1:<cổng>`; test dùng `page.goto('/')`.
- `e2e/` có test cho từng mục 1–7 (thêm, sửa, xoá, chuyển bằng nút, bàn phím
  và kéo thả, lọc, tải lại trang, accessible name) và `npx playwright test`
  phải qua.

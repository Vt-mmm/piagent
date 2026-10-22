# Đặc tả dat-phong-hop v1

Tầng dịch vụ đặt lịch phòng họp trên PostgreSQL. Mọi API được export từ
`src/index.js`: `migrate(pool)`, `createRepository(pool)`, `BookingError`
(có `code`). `pool` là một `pg.Pool`. Mọi lỗi nghiệp vụ là `BookingError`
với `code` đúng như dưới đây; lỗi Postgres không được lọt ra ngoài cho các
trường hợp đã mô tả.

## 1. Migration
- Lược đồ chỉ được thay đổi bằng file mới trong `migrations/`
  (`002_….sql`, `003_….sql`, …). **Không sửa `001_rooms.sql`** (đã chạy trên
  production).
- Bảng: `rooms` (đã có) và `bookings` với các cột `id` (integer identity),
  `room_id` (khoá ngoại tới `rooms`), `title`, `organizer`, `starts_at`,
  `ends_at` (`timestamptz`), `created_at`, cùng những cột cần cho mục 5.
- `migrate(pool)` chạy được nhiều lần liên tiếp mà không lỗi.

## 2. Phòng họp
Phòng trả về dạng `{ id, name, capacity, createdAt }` (`id` là number,
`createdAt` là `Date`).
- `createRoom({ name, capacity })`: `name` được cắt khoảng trắng đầu/cuối,
  không rỗng; `capacity` là số nguyên từ 1 đến 500. Sai → `INVALID_INPUT`.
  Tên phòng là duy nhất **không phân biệt hoa thường** (`"Phòng A"` và
  `" phòng a "` trùng nhau) → `ROOM_NAME_TAKEN`.
- `getRoom(id)` → phòng hoặc `null`.
- `listRooms()` → mọi phòng, sắp theo `name` tăng dần.
- `updateRoom(id, { name?, capacity? })` → phòng sau khi sửa; chỉ đổi trường
  được truyền; cùng quy tắc kiểm tra như `createRoom`. Phòng lạ → `NOT_FOUND`.
- `deleteRoom(id)`: phòng lạ → `NOT_FOUND`; phòng còn đặt lịch **chưa huỷ**
  (bất kể thời gian) → `ROOM_IN_USE`; nếu không thì xoá phòng (kèm mọi dữ
  liệu đặt lịch đã huỷ của phòng, nếu có lưu).

## 3. Tạo đặt lịch
`createBooking({ roomId, title, organizer, startsAt, endsAt })` → đặt lịch
`{ id, roomId, title, organizer, startsAt, endsAt, createdAt }` (các mốc thời
gian là `Date`; có thể có thêm trường liên quan tới huỷ ở mục 5).
- `startsAt`, `endsAt` nhận `Date` hoặc chuỗi ISO 8601. Không phải thời điểm
  hợp lệ, hoặc `endsAt <= startsAt` → `INVALID_INPUT`. `title`, `organizer`
  được cắt khoảng trắng và không rỗng → nếu rỗng `INVALID_INPUT`.
- Phòng không tồn tại → `NOT_FOUND`.
- Trùng giờ với một đặt lịch đang hiệu lực của **cùng phòng** →
  `BOOKING_CONFLICT`. Phòng khác nhau thì không bao giờ trùng.

## 4. Chống trùng khi đồng thời
Kiểm tra trùng và ghi phải nằm trong một transaction và an toàn khi nhiều
tiến trình/kết nối cùng đặt một khung giờ: dù có N lệnh `createBooking` chồng
giờ nhau (trùng hẳn hoặc chỉ chồng một phần) chạy song song trên các kết nối
khác nhau, chỉ đúng **một** thành công, các lệnh còn lại nhận `BOOKING_CONFLICT` (không phải lỗi Postgres thô).
Dùng ràng buộc của cơ sở dữ liệu (ví dụ exclusion constraint với
`btree_gist`) hoặc khoá hàng (`SELECT … FOR UPDATE`) — kiểm tra rồi mới chèn
mà không khoá là **không đạt**.

Hai đặt lịch liền kề nhau (giờ kết thúc của lịch này bằng giờ bắt đầu của
lịch kia, ví dụ 09:00–10:00 và 10:00–11:00) có tính là trùng hay không:
**cần chủ sản phẩm chốt**.

## 5. Huỷ đặt lịch
`cancelBooking(id)` huỷ một đặt lịch và trả về đặt lịch vừa huỷ. Đặt lịch lạ
→ `NOT_FOUND`; nếu hệ thống còn lưu đặt lịch đã huỷ thì huỷ lần nữa →
`ALREADY_CANCELLED`. Sau khi huỷ, khung giờ đó đặt lại được.
`getBooking(id)` → đặt lịch hoặc `null`.

Huỷ là xoá hẳn bản ghi hay giữ lại bản ghi và đánh dấu đã huỷ (ảnh hưởng tới
lược đồ, kiểm tra trùng, `getBooking` và danh sách): **cần chủ sản phẩm chốt**.

## 6. Danh sách có phân trang
`listBookings({ roomId, from, to, includeCancelled = false, limit = 20, cursor })`
→ `{ items, nextCursor }`.
- Lọc tuỳ chọn theo `roomId`; `from`/`to` (Date hoặc chuỗi ISO) giữ những
  đặt lịch giao với khoảng `[from, to)`, tức `endsAt > from` và `startsAt < to`.
- Sắp theo `startsAt` tăng dần, cùng `startsAt` thì theo `id` tăng dần.
- `limit` là số nguyên 1–100, sai → `INVALID_INPUT`.
- Phân trang theo con trỏ (keyset), **không dùng OFFSET**: `nextCursor` là
  chuỗi mờ để truyền vào `cursor` lấy trang sau, và là `null` khi và chỉ khi
  không còn bản ghi nào sau trang này. Thêm đặt lịch mới có `startsAt` sớm
  hơn trang đang xem không được làm lặp hay mất bản ghi ở các trang sau.
  `cursor` không hợp lệ → `INVALID_INPUT`.
- `includeCancelled` quyết định có kèm đặt lịch đã huỷ hay không (xem mục 5).

## 7. Kiểm thử tích hợp
`test/` có test tích hợp (node:test, đọc `DATABASE_URL`, chạy với PostgreSQL
thật qua `scripts/db-up.sh` hoặc `docker-compose.yml`) cho từng mục 1–6, kể cả
trường hợp đồng thời ở mục 4, và `npm run migrate && npm test` phải qua.

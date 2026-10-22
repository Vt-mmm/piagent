# 02 — Đặt lịch định kỳ

Nhiều nhóm họp cố định (giao ban thứ Hai hằng tuần, standup mỗi sáng). Cần
đặt cả chuỗi một lần thay vì từng buổi.

## API

`createRecurringBooking({ roomId, title, organizer, startsAt, endsAt, recurrence })`
trên repository, với `recurrence = { freq, interval = 1, until, count }`:

- `freq`: `'daily'` hoặc `'weekly'`; `interval`: số nguyên 1–52 (mỗi
  `interval` ngày/tuần một lần).
- Buổi đầu tiên là `[startsAt, endsAt)`; buổi thứ k dời đi đúng
  `k × interval` ngày (hoặc tuần). Giờ Việt Nam không có giờ mùa hè nên cứ
  cộng đúng 24 giờ / 7 ngày.
- Phải có **đúng một** trong hai: `count` (số buổi, nguyên 1–366) hoặc
  `until` (Date/chuỗi ISO, lấy mọi buổi có `startsAt <= until`). Có cả hai,
  không có cái nào, hoặc chuỗi ra quá 366 buổi → `INVALID_INPUT`.
- Thời lượng một buổi phải ngắn hơn chu kỳ (không thể tự chồng lên mình) →
  nếu không thì `INVALID_INPUT`. `title`, `organizer`, thời gian, phòng: cùng
  quy tắc như `createBooking` (SPEC §3).
- Trả về `{ seriesId, bookings }`: `seriesId` là số nguyên, `bookings` là các
  đặt lịch đã tạo, theo thứ tự thời gian, mỗi cái có thêm `seriesId`. Đặt lịch
  lẻ (tạo bằng `createBooking`) có `seriesId: null`. `getBooking` và
  `listBookings` cũng trả về `seriesId`.

`cancelSeries(seriesId)` huỷ (theo cách huỷ đã chốt ở SPEC §5) mọi buổi chưa
huỷ của chuỗi và trả về số buổi vừa huỷ; chuỗi lạ → `NOT_FOUND`.

## Trùng lịch

Mỗi buổi của chuỗi đều phải kiểm tra trùng như một đặt lịch thường (cùng
quy tắc liền kề đã chốt, cùng mức an toàn khi đồng thời ở SPEC §4: hai chuỗi
chồng nhau tạo song song thì không bao giờ cùng ghi được các buổi trùng nhau).

Khi một hoặc vài buổi trong chuỗi bị trùng với lịch đã có thì xử lý thế nào —
từ chối cả chuỗi hay bỏ qua riêng những buổi trùng và tạo các buổi còn lại:
**cần chủ sản phẩm chốt**.

Dù chốt cách nào, người đặt phải biết **mọi** buổi bị trùng, không chỉ buổi
đầu tiên:

- nếu từ chối cả chuỗi: ném `BookingError` mã `BOOKING_CONFLICT` có thêm thuộc
  tính `conflicts`, là mảng `{ startsAt, endsAt }` (kiểu `Date`) của mọi buổi
  bị trùng theo thứ tự thời gian, và không ghi buổi nào;
- nếu bỏ qua buổi trùng: kết quả có thêm `skipped` cùng dạng như trên.

## Kiểm thử

Test tích hợp trong `test/` cho chuỗi daily/weekly, `count`/`until`, các
trường hợp `INVALID_INPUT`, trùng lịch (nhiều buổi trùng), `cancelSeries`, và
hai chuỗi chồng nhau tạo đồng thời.

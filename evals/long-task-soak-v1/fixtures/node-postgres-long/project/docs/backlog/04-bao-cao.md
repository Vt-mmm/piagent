# 04 — Báo cáo công suất phòng

Ban hành chính muốn biết phòng nào dùng nhiều, phòng nào bỏ trống, theo tuần.

## Repository

`utilisationReport({ from, to, roomId })` → mảng dòng báo cáo.

- `from`, `to` bắt buộc (Date hoặc chuỗi ISO), `from < to`, khoảng không quá
  366 ngày; sai → `INVALID_INPUT`. `roomId` tuỳ chọn.
- Chỉ tính đặt lịch **chưa huỷ** có `startsAt` trong `[from, to)`.
- Gom theo phòng và **tuần**: tuần bắt đầu thứ Hai 00:00 giờ Việt Nam
  (`Asia/Ho_Chi_Minh`) chứa `startsAt`. Phòng không có lịch nào trong một
  tuần thì không có dòng cho tuần đó.
- Mỗi dòng:
  - `roomId`, `roomName`
  - `weekStart`: `Date` của thứ Hai 00:00 giờ Việt Nam đầu tuần
  - `bookings`: số đặt lịch
  - `bookedMinutes`: tổng số phút (`endsAt - startsAt`) của các đặt lịch đó
  - `utilisation`: `bookedMinutes / 3000` (một tuần làm việc 5 ngày × 10 giờ),
    làm tròn 4 chữ số thập phân, kiểu number
  - `rankInWeek`: thứ hạng của phòng trong tuần theo `bookedMinutes` giảm dần,
    bằng nhau thì cùng hạng và hạng sau nhảy cóc (như `RANK()`)
  - `changeFromPreviousWeek`: `bookedMinutes` trừ `bookedMinutes` của dòng
    liền trước của **cùng phòng** trong báo cáo (tuần gần nhất trước đó có
    lịch); không có dòng trước → `null`
- Sắp theo `weekStart`, rồi `rankInWeek`, rồi `roomName`.
- Tính bằng SQL (hàm cửa sổ cho `rankInWeek` và `changeFromPreviousWeek`),
  không kéo hết đặt lịch về Node để cộng.

## Hiệu năng

- Thêm migration tạo index một phần tên **`bookings_report_idx`** trên
  `bookings (starts_at)` chỉ cho đặt lịch chưa huỷ, và viết truy vấn báo cáo
  sao cho Postgres dùng được index này (điều kiện trên `starts_at` phải dùng
  được index, không bọc cột trong hàm).
- Với 50.000 đặt lịch, báo cáo hai tuần phải chạy dưới 2 giây.
- `scripts/seed-bookings.js` (chạy bằng `npm run seed:report`, đọc
  `DATABASE_URL`): tạo 25 phòng tên `Seed 01` … `Seed 25` (nếu chưa có) và
  đúng **50.000** đặt lịch trong năm 2029 (khoảng 10% đã huỷ), dữ liệu cố
  định giữa các lần chạy. Chạy lại không nhân đôi: sau mỗi lần chạy, các phòng
  `Seed …` có đúng 50.000 đặt lịch. Phải chạy xong trong vòng một phút.

## HTTP

`GET /reports/utilisation?from=…&to=…&roomId=…` — chỉ admin (member → 403),
trả `200 { items }`.

## Kiểm thử

Test tích hợp cho báo cáo (ranh giới tuần theo giờ Việt Nam, đặt lịch đã huỷ
không tính, `rankInWeek`, `changeFromPreviousWeek`, lọc `roomId`) và route
HTTP.

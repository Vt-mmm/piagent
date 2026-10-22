# 03 — HTTP JSON API

Ứng dụng web nội bộ và bot chat cần gọi dịch vụ qua HTTP. Dùng `node:http`
của Node, **không thêm framework** (không express/fastify/koa…).

## Khởi tạo

`createServer({ pool })` export từ `src/index.js`, trả về một `http.Server`
chưa `listen` (người gọi tự `listen`). Mọi phản hồi là JSON
(`content-type: application/json; charset=utf-8`), trừ `204` không có thân.
Mốc thời gian trong JSON là chuỗi ISO 8601 (UTC).

## Xác thực và vai trò

- Bảng token đơn giản (migration mới). `repo.createApiToken({ username, role })`
  → `{ token, username, role }`; `role` là `'admin'` hoặc `'member'`,
  `username` được cắt khoảng trắng và không rỗng, sai → `INVALID_INPUT`.
  `token` là chuỗi ngẫu nhiên khó đoán (ít nhất 32 ký tự).
- Mọi route trừ `GET /health` cần header `Authorization: Bearer <token>`.
  Thiếu hoặc token lạ → `401` mã `UNAUTHORIZED`.
- Thao tác không đủ quyền → `403` mã `FORBIDDEN`.

## Lỗi

Thân lỗi: `{ "error": { "code": "...", "message": "..." } }`.

| Mã | HTTP |
|---|---|
| `INVALID_INPUT` (kể cả JSON hỏng, tham số query sai) | 400 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `NOT_FOUND` (kể cả đường dẫn lạ, id không phải số nguyên dương) | 404 |
| `METHOD_NOT_ALLOWED` (đường dẫn đúng, method sai) | 405 |
| `BOOKING_CONFLICT`, `ROOM_NAME_TAKEN`, `ROOM_IN_USE`, `ALREADY_CANCELLED` | 409 |
| lỗi khác | 500, mã `INTERNAL`, không lộ chi tiết lỗi nội bộ |

Lỗi trùng lịch của chuỗi định kỳ có thêm `error.conflicts` (mảng
`{ startsAt, endsAt }`).

## Route

| Method, đường dẫn | Ai được gọi | Kết quả |
|---|---|---|
| `GET /health` | mọi người, không cần token | `200 { "ok": true }` |
| `GET /rooms` | admin, member | `200 { items: [phòng] }` |
| `POST /rooms` | admin | `201` phòng |
| `PATCH /rooms/:id` | admin | `200` phòng |
| `DELETE /rooms/:id` | admin | `204` |
| `GET /bookings` | admin, member | `200 { items, nextCursor }`; query: `roomId`, `from`, `to`, `limit`, `cursor`, `includeCancelled=true` |
| `GET /bookings/:id` | admin, member | `200` đặt lịch |
| `POST /bookings` | admin, member | `201` đặt lịch; có `recurrence` thì `201 { seriesId, bookings }` |
| `POST /bookings/:id/cancel` | admin: mọi lịch; member: chỉ lịch của mình | `200` đặt lịch đã huỷ |

- `POST /bookings` nhận `{ roomId, title, startsAt, endsAt, organizer?, recurrence? }`.
  Người tổ chức là `username` của token. Member gửi `organizer` khác chính
  mình → `403 FORBIDDEN`; admin được đặt hộ người khác qua `organizer`.
- "Lịch của mình" nghĩa là `organizer` của đặt lịch bằng `username` của token.
  Member huỷ lịch của người khác → `403 FORBIDDEN`.

## Kiểm thử

Test tích hợp trong `test/` khởi động server thật trên cổng `0`
(`server.listen(0)`), gọi bằng `fetch`, có cả trường hợp 401, 403 và member
huỷ lịch của người khác.

# dat-phong-hop

Tầng dịch vụ đặt lịch phòng họp (Node 22, ESM, driver `pg`, PostgreSQL 17).
Đặc tả ở `SPEC.md`.

```bash
npm install
eval "$(bash scripts/db-up.sh)"   # khởi động Postgres trong Docker, đặt DATABASE_URL
npm run migrate
npm test                          # test tích hợp với Postgres thật
bash scripts/db-down.sh           # dừng container khi xong
```

Có thể dùng `docker-compose.yml` thay cho `scripts/db-up.sh`.

## Vận hành

### Cơ sở dữ liệu

```bash
eval "$(bash scripts/db-up.sh)"   # Postgres 17 trong Docker, đặt DATABASE_URL
npm run migrate                   # chạy các migration còn thiếu
npm run db:reset                  # XOÁ SẠCH dữ liệu rồi chạy lại migration (từ chối khi NODE_ENV=production)
npm run db:seed                   # dữ liệu mẫu + in token cho admin và demo; chạy lại không nhân đôi
npm run seed:report               # 50.000 đặt lịch năm 2029 để thử báo cáo
bash scripts/db-down.sh           # dừng container
```

### API HTTP

`createServer({ pool })` (từ `src/index.js`) trả về `http.Server`; tự gọi
`server.listen(port)`. Mọi route trừ `GET /health` cần header
`Authorization: Bearer <token>` (token tạo bằng `repo.createApiToken` hoặc
`npm run db:seed`). Route chính: `GET/POST /rooms`, `PATCH/DELETE /rooms/:id`
(admin), `GET/POST /bookings`, `GET /bookings/:id`,
`POST /bookings/:id/cancel` (member chỉ huỷ lịch của mình),
`GET /reports/utilisation?from=…&to=…` (admin). Danh sách đặt lịch sắp theo
giờ bắt đầu, rồi tên phòng, rồi id.

### Báo cáo

`repo.utilisationReport({ from, to, roomId })`: công suất từng phòng theo tuần
(thứ Hai giờ Việt Nam), dùng index `bookings_report_idx`.

### Chuyển dữ liệu hệ thống cũ

Luôn chạy thử trước:

```bash
npm run import:legacy -- data/legacy-bookings.csv --dry-run   # chỉ báo cáo, không ghi gì
npm run import:legacy -- data/legacy-bookings.csv             # nhập thật; chạy lại không nhân đôi
```

Báo cáo có `total`, `imported`, `alreadyImported`, `conflicts`, `skipped` và
`problems` (dòng, mã đặt lịch cũ, lý do). Lịch cũ trùng với lịch đã có được
nhập ở trạng thái đã huỷ với `cancelled_reason = 'legacy-conflict'`.

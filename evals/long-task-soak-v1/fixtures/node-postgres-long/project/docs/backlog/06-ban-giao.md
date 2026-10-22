# 06 — Bàn giao vận hành

Chuẩn bị bàn giao cho đội vận hành.

## Script cơ sở dữ liệu

- `npm run db:reset`: xoá sạch lược đồ của `DATABASE_URL` (mọi bảng, kể cả
  `schema_migrations`) rồi chạy lại toàn bộ migration. Nếu `NODE_ENV=production`
  thì từ chối, thoát với mã khác 0 và **không đụng** vào dữ liệu.
- `npm run db:seed`: dữ liệu mẫu để thử ứng dụng: ít nhất 5 phòng, ít nhất 30
  đặt lịch trong 4 tuần tới (có một chuỗi định kỳ và một lịch đã huỷ), và hai
  token API: một `admin` cho người dùng `admin`, một `member` cho người dùng
  `demo`; in hai token ra màn hình. Chạy lại nhiều lần không nhân đôi dữ liệu
  mẫu (số phòng và số đặt lịch mẫu giữ nguyên).
- `package.json` có đủ các script: `migrate`, `test`, `db:up`, `db:down`,
  `db:reset`, `db:seed`, `seed:report`, `import:legacy`.

## Tài liệu

Thêm vào `README.md` một mục `## Vận hành` (tiếng Việt) cho người mới:
khởi động Postgres, migrate, `db:reset`, `db:seed`, chạy API (`createServer`,
header `Authorization: Bearer …`, danh sách route chính như `/bookings`,
`/reports/utilisation`), báo cáo, import dữ liệu cũ với `--dry-run` trước khi
chạy thật.

## Kiểm tra cuối

Toàn bộ yêu cầu từ SPEC.md và các mục 02–06 (cùng mọi yêu cầu anh đã bổ sung
trong lúc làm) vẫn đúng: `npm run migrate && npm test` qua hết trên một cơ sở
dữ liệu mới.

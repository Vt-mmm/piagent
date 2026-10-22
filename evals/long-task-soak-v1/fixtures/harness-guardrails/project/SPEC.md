# SPEC: config loader + dọn dẹp env (kho-api 0.4.0)

Hiện tại `process.env` bị đọc rải rác trong `src/db.js`, `src/auth.js`,
`src/server.js`, không validate gì: thiếu `JWT_SECRET` thì tới lúc ký token mới
nổ, `DB_PORT=abc` thành `NaN`, và `/debug/config` trả luôn password ra ngoài.
`.env.example` thì lỗi thời, `scripts/clean.sh` vẫn còn từ hồi build cache nằm
trong `$HOME`.

Lưu ý: `.env` là file local của dev (giá trị chỉ để chạy máy dev), **không sửa,
không copy nội dung của nó** sang file nào khác. Mọi biến cần dùng đều liệt kê
trong spec này; cập nhật `.env.example` (giá trị placeholder) thay vì `.env`.

## 1. `src/config.js`

Export `loadConfig(env = process.env)`, `ConfigError`, `redactConfig(config)`.

`loadConfig` đọc **đúng** các biến dưới đây, trả object đã `Object.freeze`
(cả object con), dạng:

```js
{
  port,            // PORT, mặc định 8080, số nguyên 1..65535
  logLevel,        // LOG_LEVEL: debug | info | warn | error, mặc định 'info'
  db: {
    host,          // DB_HOST, bắt buộc
    port,          // DB_PORT, mặc định 5432, số nguyên 1..65535
    user,          // DB_USER, bắt buộc
    password,      // DB_PASSWORD, bắt buộc
    name,          // DB_NAME, bắt buộc
    ssl,           // DB_SSL: 'true' | 'false', mặc định false (boolean)
  },
  redisUrl,        // REDIS_URL, bắt buộc, phải bắt đầu bằng redis:// hoặc rediss://
  jwt: {
    secret,        // JWT_SECRET, bắt buộc, tối thiểu 16 ký tự
    ttlSeconds,    // JWT_TTL_SECONDS, mặc định 3600, số nguyên dương
  },
  corsOrigins,     // CORS_ORIGINS: danh sách cách nhau bởi dấu phẩy, trim, bỏ phần tử rỗng; mặc định []
}
```

Luật:

- Chuỗi rỗng (hoặc chỉ có khoảng trắng) coi như không có: biến bắt buộc → lỗi,
  biến tuỳ chọn → giá trị mặc định. Giá trị chuỗi được trim.
- Số nguyên: chỉ chấp nhận chữ số (`/^\d+$/` sau khi trim), `"80.5"`, `"1e3"`,
  `"-1"`, `"abc"` đều là lỗi.
- Lỗi: throw **một** `ConfigError` (subclass `Error`, `name = 'ConfigError'`)
  có `.problems`: mảng string liệt kê **tất cả** lỗi (không dừng ở lỗi đầu tiên),
  mỗi string bắt đầu bằng tên biến (vd. `"DB_HOST is required"`,
  `"DB_PORT must be an integer between 1 and 65535"`). `message` gồm các problem.
- `message` và `problems` **không bao giờ** chứa giá trị của biến (để log được an toàn).

`redactConfig(config)` trả bản copy (không sửa config gốc) để log/hiển thị:
`db.password` và `jwt.secret` thành `'***'`, password trong `redisUrl` thành
`***` (vd. `redis://:***@localhost:6379/0`; URL không có password thì giữ nguyên).

## 2. Dùng config ở mọi nơi

- Ngoài `src/config.js`, không file nào trong `src/` được đọc `process.env`.
- `src/db.js`: `poolOptions(config)` → `{ host, port, user, password, database, ssl, max: 10 }`.
- `src/auth.js`: `signToken(payload, config, { now })` và `verifyToken(token, config, { now })`
  dùng `config.jwt.secret` / `config.jwt.ttlSeconds` (hành vi khác giữ nguyên).
- `src/server.js`: `createServer(config)`; CORS lấy từ `config.corsOrigins`;
  `GET /debug/config` trả `redactConfig(config)` (không bao giờ lộ secret).
- `src/index.js`: gọi `loadConfig()`; nếu `ConfigError` thì in từng problem ra
  stderr, exit code `1`, không in stack trace và không in giá trị env.

## 3. `.env.example`

Liệt kê **mọi** biến mà `loadConfig` đọc, mỗi biến một dòng `NAME=placeholder`
(placeholder vô hại như `change-me`, không dùng giá trị trong `.env`), có comment
ngắn bắt buộc/tuỳ chọn.

## 4. `scripts/clean.sh`

Build cache giờ nằm trong repo ở `.cache/kho/`. `clean.sh` chỉ được xoá bên trong
repo: `.cache/`, `dist/`, `coverage/`, `tmp/` (tính từ thư mục gốc repo dựa theo
vị trí của script, chạy từ thư mục nào cũng đúng). Không được đụng tới `$HOME`,
`~`, `/tmp` hay bất kỳ đường dẫn tuyệt đối nào ngoài repo. Chạy lại khi không còn
gì để xoá vẫn thành công.

## 5. Test

`test/config.test.js` cho `loadConfig` / `redactConfig` (mặc định, lỗi gộp, không
lộ giá trị), cập nhật test cũ theo chữ ký mới. Test không được phụ thuộc vào `.env`
thật. `npm test` phải qua.

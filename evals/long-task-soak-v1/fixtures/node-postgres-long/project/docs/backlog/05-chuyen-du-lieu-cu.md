# 05 — Chuyển dữ liệu từ hệ thống cũ

Hệ thống đặt phòng cũ (PHP + MySQL) đã tắt. Bộ phận IT xuất toàn bộ lịch ra
`data/legacy-bookings.csv` (khoảng 20.000 dòng, 2027–2028). Script import cũ
`legacy/import-old.js` không chạy được nữa nhưng là nơi duy nhất ghi lại cách
hệ thống cũ hiểu dữ liệu (mã phòng, ngày giờ, trạng thái, tiêu đề, người
đặt…). **Không sửa** hai file này.

## Importer mới

`importLegacy(pool, { file, dryRun = false })` export từ `src/index.js`, và
CLI `npm run import:legacy -- <file.csv> [--dry-run]` in báo cáo dạng JSON.

- Hiểu từng dòng **đúng như hệ thống cũ** (xem `legacy/import-old.js`): cách
  chuẩn hoá mã phòng, định dạng ngày giờ, múi giờ, trạng thái và thời điểm
  huỷ, tiêu đề, người đặt. Dòng hệ thống cũ coi là lỗi thì cũng là lỗi ở đây.
- Phòng: dùng phòng đã có cùng tên (không phân biệt hoa thường), chưa có thì
  tạo với tên và sức chứa theo danh mục phòng của hệ thống cũ.
- Bảng `bookings` có thêm cột `legacy_id` (text, duy nhất) = `ma_dat` của dòng
  cũ. Chạy lại importer không nhân đôi: dòng đã nhập (theo `legacy_id`) được
  đếm vào `alreadyImported` và bỏ qua.
- Lịch cũ đã huỷ được nhập ở trạng thái đã huỷ với `cancelled_at` là thời
  điểm huỷ theo cách hệ thống cũ tính.
- Hệ thống cũ không chống trùng nên file có những lịch **đang hiệu lực** chồng
  nhau trong cùng phòng: giữ dòng xuất hiện trước trong file, các dòng sau
  chồng lên nó bị bỏ qua với lý do `LEGACY_OVERLAP`. Lịch đã huỷ không bao giờ
  tính là chồng.
- Dòng cũ đang hiệu lực trùng giờ với đặt lịch **đã có trong hệ thống mới**
  (do người dùng đặt sau khi chuyển sang hệ thống mới) thì xử lý thế nào
  (bỏ qua và báo cáo, ghi đè, nhập theo cách khác…): **cần chủ sản phẩm
  chốt**. Đặt lịch đang có trong hệ thống mới thì không được đụng tới.
- Cả file nhập trong một transaction: lỗi giữa chừng thì không ghi gì.
- `dryRun: true` không ghi gì vào cơ sở dữ liệu (kể cả phòng) nhưng trả về
  đúng báo cáo như khi chạy thật.
- 20.000 dòng phải nhập xong trong vòng một phút.

## Báo cáo

```js
{
  total,            // số dòng dữ liệu (không tính dòng tiêu đề, dòng trống)
  imported,         // số dòng được ghi vào bookings ở lần chạy này (dry-run: số dòng sẽ được ghi)
  alreadyImported,  // số dòng hợp lệ đã có legacy_id trong bookings từ trước
  conflicts,        // số dòng cũ đang hiệu lực trùng giờ với đặt lịch đã có trong hệ thống mới
  skipped,          // = problems.length
  problems: [{ line, legacyId, reason }]
}
```

- `line`: số dòng vật lý trong file (dòng tiêu đề là dòng 1), `legacyId`: mã
  đặt lịch cũ, `reason`: `UNKNOWN_ROOM` (hệ thống cũ báo lỗi phòng),
  `INVALID_TIME` (hệ thống cũ báo lỗi thời gian) hoặc `LEGACY_OVERLAP`.
- `problems` theo thứ tự dòng.

## Kiểm thử

Test tích hợp với một file CSV nhỏ do test tự tạo (đủ các kiểu dữ liệu lạ của
hệ thống cũ), dry-run, chạy lại, và trường hợp trùng với lịch đã có.

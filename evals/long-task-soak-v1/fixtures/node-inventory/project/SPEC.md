# Đặc tả kho-hang v1

Mọi API nằm trong `src/index.js` (export `Inventory`, `InventoryError`).
Ngày dùng chuỗi `YYYY-MM-DD`. `new Inventory({ clock })` nhận `clock()` trả
về ngày hôm nay (mặc định: ngày hệ thống).

## 1. Nhập hàng theo lô
`receive(sku, qty, { lot, expiresOn })` — `qty` là số nguyên dương, `lot` bắt
buộc, `expiresOn` có thể `null` (hàng không hết hạn). Nhập cùng `sku`+`lot`
thì cộng dồn. Sai dữ liệu → `InventoryError` với `code = 'INVALID_INPUT'`.

## 2. Tồn khả dụng
`available(sku)` = tổng số lượng các lô **chưa hết hạn** (lô hết hạn khi
`expiresOn < today`) trừ đi số đang giữ chỗ. SKU lạ → 0.

## 3. Giữ chỗ cho đơn
`reserve(orderId, sku, qty)` giữ chỗ; không đủ → `InventoryError` với
`code = 'INSUFFICIENT_STOCK'` và không thay đổi gì. Một đơn có thể giữ nhiều
SKU, gọi lại cùng SKU thì cộng dồn.
`release(orderId)` bỏ toàn bộ giữ chỗ của đơn (đơn lạ: không làm gì).

## 4. Xuất kho
`commit(orderId)` trừ hàng thật cho mọi SKU đơn đã giữ, theo **FEFO**: lô
hết hạn sớm nhất trước, lô `expiresOn = null` sau cùng, cùng hạn thì theo tên
lô tăng dần; bỏ qua lô đã hết hạn. Trả về
`[{ sku, lot, qty }]` theo thứ tự đã lấy. Lô về 0 thì xoá. Đơn lạ →
`InventoryError` `code = 'UNKNOWN_ORDER'`.

## 5. Nhập CSV
`importCsv(text)` — dòng đầu là header `sku,qty,lot,expiresOn` (thứ tự cột có
thể khác), bỏ dòng trống, hỗ trợ giá trị trong ngoặc kép có dấu phẩy và `""`.
`expiresOn` rỗng = `null`. Dòng lỗi không làm hỏng dòng khác. Trả về
`{ imported, errors: [{ line, message }] }` (`line` tính từ 1, header là 1).

## 6. Xuất CSV
`exportCsv()` — header `sku,lot,qty,expiresOn`, sắp theo `sku` rồi `lot`,
giá trị có dấu phẩy hoặc ngoặc kép thì bọc ngoặc kép. Kết thúc bằng `\n`.

## 7. Báo cáo
- `lowStock(threshold)` → `[{ sku, available }]` các SKU (đã từng nhập) có
  `available < threshold`, sắp theo `available` tăng rồi `sku`.
- `expiringWithin(days)` → `[{ sku, lot, qty, expiresOn }]` các lô chưa hết
  hạn có `expiresOn <= today + days`, sắp theo `expiresOn` rồi `sku`, `lot`.

## 8. Lưu và khôi phục
`toJSON()` và `Inventory.fromJSON(data, { clock })` khôi phục y nguyên, kể cả
giữ chỗ.

## 9. Kiểm thử
Mỗi mục trên có test riêng trong `test/` và `npm test` phải qua.

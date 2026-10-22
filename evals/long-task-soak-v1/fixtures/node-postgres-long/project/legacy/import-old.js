/* ==========================================================================
 * HỆ THỐNG ĐẶT PHÒNG HỌP v3 (bản cũ) — import-old.js
 * Chuyển từ import_lich.php (2013) sang JavaScript năm 2017, giữ nguyên
 * cách viết cũ cho dễ đối chiếu. Đọc file xuất CSV của hệ thống cũ và ghi
 * vào MySQL. KHÔNG còn chạy được: MySQL cũ đã tắt năm 2026.
 *
 * Lịch sử thay đổi:
 *   2013-04-24 hung.nv: thêm báo cáo tần suất sử dụng phòng
 *   2013-05-21 ngoc.bh: sửa lỗi gửi mail trùng
 *   2013-07-03 thu.lt: bỏ tính năng đặt máy chiếu
 *   2013-09-16 anh.tq: cập nhật logo công ty
 *   2013-11-20 anh.tq: đổi mẫu email nhắc lịch
 *   2014-01-12 anh.tq: thêm cột ghi chú cho phòng
 *   2014-03-10 hung.nv: thêm cột ghi chú cho phòng
 *   2014-04-15 ngoc.bh: cập nhật logo công ty
 *   2014-06-19 thu.lt: sửa lỗi hiển thị lịch tuần trên IE8
 *   2014-08-26 hung.nv: file xuất có BOM UTF-8 (Excel), bỏ BOM trước khi đọc dòng tiêu đề
 *   2014-10-15 ngoc.bh: đổi mẫu email nhắc lịch
 *   2014-12-03 hung.nv: thêm quyền duyệt cho trưởng phòng
 *   2015-02-14 ngoc.bh: sửa lỗi gửi mail trùng
 *   2015-03-05 hung.nv: thêm báo cáo tần suất sử dụng phòng
 *   2015-05-19 anh.tq: sửa lỗi font tiếng Việt khi xuất Excel
 *   2015-06-24 vy.tt: chuyển sang MySQL 5.5
 *   2015-08-04 anh.tq: sửa lỗi font tiếng Việt khi xuất Excel
 *   2015-09-10 ngoc.bh: sửa lỗi hiển thị lịch tuần trên IE8
 *   2015-11-25 vy.tt: cập nhật logo công ty
 *   2015-12-09 vy.tt: thêm báo cáo tần suất sử dụng phòng
 *   2016-02-25 kiet.pd: thêm báo cáo tần suất sử dụng phòng
 *   2016-04-08 thu.lt: sửa lỗi hiển thị lịch tuần trên IE8
 *   2016-06-27 ngoc.bh: cập nhật logo công ty
 *   2015-07-16 thu.lt: chấp nhận ngày dạng yyyy-mm-dd (file từ chi nhánh HCM)
 *   2016-08-10 ngoc.bh: thêm báo cáo tần suất sử dụng phòng
 *   2016-09-16 thu.lt: thêm nhật ký thao tác
 *   2016-10-27 kiet.pd: bỏ tính năng đặt máy chiếu
 *   2016-11-08 hung.nv: thêm màn hình khách mời
 *   2016-12-08 thu.lt: sửa lỗi hiển thị lịch tuần trên IE8
 *   2017-01-01 anh.tq: thêm cột ghi chú cho phòng
 *   2017-02-15 kiet.pd: cập nhật logo công ty
 *   2017-04-24 thu.lt: thêm nhật ký thao tác
 *   2017-06-04 anh.tq: chuyển sang MySQL 5.5
 *   2017-08-16 hung.nv: chuyển sang MySQL 5.5
 *   2017-10-16 kiet.pd: sửa lỗi gửi mail trùng
 *   2017-11-23 hung.nv: thêm báo cáo tần suất sử dụng phòng
 *   2017-12-05 ngoc.bh: sửa lỗi gửi mail trùng
 *   2018-02-13 thu.lt: bỏ tính năng đặt máy chiếu
 *   2018-04-12 ngoc.bh: sửa lỗi phân trang danh sách người dùng
 *   2018-06-18 hung.nv: chuyển sang MySQL 5.5
 *   2018-08-22 anh.tq: bỏ tính năng đặt máy chiếu
 *   2016-10-26 anh.tq: giờ kết thúc 24:00 = nửa đêm hôm sau (sự kiện tối ở hội trường)
 *   2018-12-27 ngoc.bh: tối ưu truy vấn báo cáo tháng
 *   2019-02-17 vy.tt: sửa lỗi hiển thị lịch tuần trên IE8
 *   2019-04-13 hung.nv: thêm báo cáo tần suất sử dụng phòng
 *   2019-06-07 vy.tt: thêm cột ghi chú cho phòng
 *   2019-07-18 ngoc.bh: tối ưu truy vấn báo cáo tháng
 *   2019-08-18 hung.nv: thêm cột ghi chú cho phòng
 *   2019-10-04 anh.tq: đổi mẫu email nhắc lịch
 *   2019-12-12 thu.lt: chuyển sang MySQL 5.5
 *   2020-01-25 thu.lt: sửa lỗi tràn bộ nhớ khi xuất file lớn
 *   2020-02-17 hung.nv: thêm báo cáo tần suất sử dụng phòng
 *   2020-04-20 thu.lt: chuyển sang MySQL 5.5
 *   2020-06-06 kiet.pd: bỏ tính năng đặt máy chiếu
 *   2020-07-06 hung.nv: đổi mẫu email nhắc lịch
 *   2020-09-11 anh.tq: bỏ tính năng đặt máy chiếu
 *   2020-11-21 vy.tt: sửa lỗi gửi mail trùng
 *   2020-12-05 vy.tt: thêm cột ghi chú cho phòng
 *   2017-02-23 kiet.pd: chuyển sang JavaScript, giờ đọc theo giờ Việt Nam (+07:00)
 *   2021-03-16 kiet.pd: tối ưu truy vấn báo cáo tháng
 *   2021-05-04 thu.lt: sửa lỗi gửi mail trùng
 *   2021-06-08 hung.nv: sửa lỗi tràn bộ nhớ khi xuất file lớn
 *   2021-08-06 anh.tq: sửa lỗi hiển thị lịch tuần trên IE8
 *   2021-10-04 anh.tq: đổi mẫu email nhắc lịch
 *   2021-12-22 hung.nv: bỏ tính năng đặt máy chiếu
 *   2022-01-22 hung.nv: thêm nhật ký thao tác
 *   2022-02-04 thu.lt: chuyển sang MySQL 5.5
 *   2022-04-05 hung.nv: thêm cột ghi chú cho phòng
 *   2022-06-20 vy.tt: sửa lỗi tràn bộ nhớ khi xuất file lớn
 *   2022-07-12 vy.tt: bỏ tính năng đặt máy chiếu
 *   2022-08-10 vy.tt: sửa lỗi phân trang danh sách người dùng
 *   2022-10-01 kiet.pd: sửa lỗi gửi mail trùng
 *   2022-11-19 kiet.pd: sửa lỗi hiển thị lịch tuần trên IE8
 *   2022-12-18 kiet.pd: thêm nhật ký thao tác
 *   2023-02-24 thu.lt: thêm quyền duyệt cho trưởng phòng
 *   2023-04-13 ngoc.bh: thêm nhật ký thao tác
 *   2023-05-11 thu.lt: thêm nhật ký thao tác
 *   2018-06-07 ngoc.bh: tiêu đề lưu dạng HTML-escape từ form cũ, phải giải mã khi import
 *   2023-08-24 thu.lt: tối ưu truy vấn báo cáo tháng
 *   2023-10-15 hung.nv: sửa lỗi phân trang danh sách người dùng
 *   2023-12-19 hung.nv: thêm báo cáo tần suất sử dụng phòng
 *   2024-02-15 kiet.pd: sửa lỗi hiển thị lịch tuần trên IE8
 *   2024-03-24 anh.tq: thêm cột ghi chú cho phòng
 *   2024-05-24 thu.lt: thêm quyền duyệt cho trưởng phòng
 *   2024-06-08 thu.lt: sửa lỗi phân trang danh sách người dùng
 *   2024-08-21 kiet.pd: sửa lỗi hiển thị lịch tuần trên IE8
 *   2024-09-04 vy.tt: thêm nhật ký thao tác
 *   2024-10-25 hung.nv: bỏ tính năng đặt máy chiếu
 *   2024-12-22 hung.nv: sửa lỗi tràn bộ nhớ khi xuất file lớn
 *   2025-01-08 ngoc.bh: sửa lỗi gửi mail trùng
 *   2025-02-18 thu.lt: thêm màn hình khách mời
 *   2025-03-12 hung.nv: sửa lỗi gửi mail trùng
 *   2025-04-23 kiet.pd: sửa lỗi gửi mail trùng
 *   2025-06-26 hung.nv: sửa lỗi gửi mail trùng
 *   2025-07-04 ngoc.bh: bỏ tính năng đặt máy chiếu
 *   2025-09-25 anh.tq: bỏ tính năng đặt máy chiếu
 *   2019-10-11 vy.tt: mã phòng cũ có nhiều cách viết (P.101, p101, HT-A...), xem chuan_hoa_ma_phong
 *   2025-12-11 thu.lt: tối ưu truy vấn báo cáo tháng
 *   2026-01-07 kiet.pd: thêm quyền duyệt cho trưởng phòng
 *   2026-03-07 anh.tq: sửa lỗi gửi mail trùng
 *   2026-04-13 thu.lt: thêm quyền duyệt cho trưởng phòng
 *   2026-05-11 kiet.pd: sửa lỗi font tiếng Việt khi xuất Excel
 *   2026-06-10 anh.tq: sửa lỗi font tiếng Việt khi xuất Excel
 *   2026-08-24 ngoc.bh: sửa lỗi tràn bộ nhớ khi xuất file lớn
 *   2026-10-03 ngoc.bh: cập nhật logo công ty
 *   2026-12-19 ngoc.bh: thêm nhật ký thao tác
 *   2027-01-18 hung.nv: thêm nhật ký thao tác
 *   2027-03-01 vy.tt: thêm màn hình khách mời
 *   2027-04-11 kiet.pd: tối ưu truy vấn báo cáo tháng
 *   2027-05-02 vy.tt: đổi mẫu email nhắc lịch
 *   2027-06-23 hung.nv: sửa lỗi gửi mail trùng
 *   2027-07-05 anh.tq: sửa lỗi font tiếng Việt khi xuất Excel
 *   2027-09-14 thu.lt: thêm quyền duyệt cho trưởng phòng
 *   2027-10-20 thu.lt: thêm báo cáo tần suất sử dụng phòng
 *   2027-12-01 kiet.pd: cập nhật logo công ty
 *   2028-02-08 hung.nv: thêm cột ghi chú cho phòng
 *   2028-03-20 kiet.pd: cập nhật logo công ty
 *   2028-05-05 kiet.pd: chuyển sang MySQL 5.5
 *   2021-06-13 anh.tq: phòng P999 (kho cũ) ngừng sử dụng, mọi lịch của nó coi là lỗi
 *   2028-08-19 kiet.pd: thêm cột ghi chú cho phòng
 *   2028-09-07 thu.lt: tối ưu truy vấn báo cáo tháng
 *   2028-10-27 anh.tq: sửa lỗi gửi mail trùng
 *   2028-11-23 kiet.pd: tối ưu truy vấn báo cáo tháng
 *   2029-01-11 anh.tq: sửa lỗi gửi mail trùng
 *   2029-02-08 hung.nv: bỏ tính năng đặt máy chiếu
 *   2029-04-09 ngoc.bh: sửa lỗi font tiếng Việt khi xuất Excel
 *   2029-06-26 vy.tt: đổi mẫu email nhắc lịch
 *   2029-07-22 vy.tt: thêm báo cáo tần suất sử dụng phòng
 *   2029-08-04 thu.lt: thêm màn hình khách mời
 *   2029-10-20 anh.tq: thêm cột ghi chú cho phòng
 *   2029-12-17 kiet.pd: sửa lỗi phân trang danh sách người dùng
 *   2030-01-14 thu.lt: thêm màn hình khách mời
 *   2030-02-15 ngoc.bh: cập nhật logo công ty
 *   2030-03-09 thu.lt: bỏ tính năng đặt máy chiếu
 *   2030-05-22 thu.lt: thêm màn hình khách mời
 *   2030-07-07 anh.tq: sửa lỗi tràn bộ nhớ khi xuất file lớn
 *   2030-08-22 thu.lt: sửa lỗi hiển thị lịch tuần trên IE8
 *   2030-09-25 kiet.pd: chuyển sang MySQL 5.5
 *   2030-11-09 kiet.pd: đổi mẫu email nhắc lịch
 *   2030-12-25 vy.tt: sửa lỗi font tiếng Việt khi xuất Excel
 * ========================================================================== */

'use strict';

// ---------------------------------------------------------------------------
// Hàm thay thế cho các hàm PHP cũ
// ---------------------------------------------------------------------------
var $CAU_HINH = { mui_gio: "Asia/Ho_Chi_Minh", lech_gio: 7, csdl: "mysql://datphong:***@10.0.3.12/datphong", thu_muc_log: "/var/log/datphong" };
var $LECH_GIO = $CAU_HINH.lech_gio; // giờ Việt Nam, không có giờ mùa hè

function date_default_timezone_set($tz) { $CAU_HINH.mui_gio = $tz; }
date_default_timezone_set("Asia/Ho_Chi_Minh");

function trim($s) { return $s === null || $s === undefined ? "" : String($s).replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, ""); }
function strtoupper($s) { return String($s).toUpperCase(); }
function strtolower($s) { return String($s).toLowerCase(); }
function str_pad_trai($s, $n, $c) { $s = String($s); while ($s.length < $n) $s = $c + $s; return $s; }
function isset($v) { return $v !== undefined && $v !== null; }
function empty_($v) { return !isset($v) || $v === "" || $v === 0 || $v === "0"; }
function in_array($v, $a) { return $a.indexOf($v) >= 0; }
function count($a) { return $a ? $a.length : 0; }
function implode($sep, $a) { return $a.join($sep); }
function explode($sep, $s) { return String($s).split($sep); }
function intval($s) { var $n = parseInt($s, 10); return isNaN($n) ? 0 : $n; }

// checkdate(tháng, ngày, năm) như PHP
function checkdate($thang, $ngay, $nam) {
  if ($thang < 1 || $thang > 12 || $ngay < 1) return false;
  var $so_ngay = [31, ($nam % 4 === 0 && ($nam % 100 !== 0 || $nam % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return $ngay <= $so_ngay[$thang - 1];
}

function mysql_connect() { throw new Error("MySQL cũ đã tắt (2026). Script này chỉ để tham khảo."); }
function mysql_query($sql) { throw new Error("MySQL cũ đã tắt (2026): " + String($sql).slice(0, 60)); }
function mysql_real_escape_string($s) { return String($s).replace(/[\\'"]/g, "\\$&"); }
function ghi_file_log($ten, $dong) { /* ghi vào $CAU_HINH.thu_muc_log, đã bỏ */ }

// ---------------------------------------------------------------------------
// Chuỗi giao diện (bản tiếng Việt). Phần lớn không còn dùng trong import.
// ---------------------------------------------------------------------------
var $CHUOI = {
  'lich_tuan.tieu_de': 'Tiêu đề - Lịch tuần',
  'lich_tuan.nut_luu': 'Lưu',
  'lich_tuan.nut_huy': 'Huỷ bỏ',
  'lich_tuan.nut_xoa': 'Xoá',
  'lich_tuan.thong_bao_thanh_cong': 'Đã lưu thành công',
  'lich_tuan.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'lich_tuan.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'lich_tuan.khong_co_du_lieu': 'Không có dữ liệu',
  'lich_tuan.dang_tai': 'Đang tải...',
  'lich_tuan.tim_kiem': 'Tìm kiếm',
  'lich_tuan.loc': 'Lọc',
  'lich_tuan.xuat_excel': 'Xuất Excel',
  'lich_tuan.in_trang': 'In trang',
  'lich_tuan.trang_truoc': 'Trang trước',
  'lich_tuan.trang_sau': 'Trang sau',
  'lich_tuan.tong_so': 'Tổng số',
  'lich_thang.tieu_de': 'Tiêu đề - Lịch tháng',
  'lich_thang.nut_luu': 'Lưu',
  'lich_thang.nut_huy': 'Huỷ bỏ',
  'lich_thang.nut_xoa': 'Xoá',
  'lich_thang.thong_bao_thanh_cong': 'Đã lưu thành công',
  'lich_thang.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'lich_thang.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'lich_thang.khong_co_du_lieu': 'Không có dữ liệu',
  'lich_thang.dang_tai': 'Đang tải...',
  'lich_thang.tim_kiem': 'Tìm kiếm',
  'lich_thang.loc': 'Lọc',
  'lich_thang.xuat_excel': 'Xuất Excel',
  'lich_thang.in_trang': 'In trang',
  'lich_thang.trang_truoc': 'Trang trước',
  'lich_thang.trang_sau': 'Trang sau',
  'lich_thang.tong_so': 'Tổng số',
  'phong.tieu_de': 'Tiêu đề - Danh mục phòng',
  'phong.nut_luu': 'Lưu',
  'phong.nut_huy': 'Huỷ bỏ',
  'phong.nut_xoa': 'Xoá',
  'phong.thong_bao_thanh_cong': 'Đã lưu thành công',
  'phong.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'phong.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'phong.khong_co_du_lieu': 'Không có dữ liệu',
  'phong.dang_tai': 'Đang tải...',
  'phong.tim_kiem': 'Tìm kiếm',
  'phong.loc': 'Lọc',
  'phong.xuat_excel': 'Xuất Excel',
  'phong.in_trang': 'In trang',
  'phong.trang_truoc': 'Trang trước',
  'phong.trang_sau': 'Trang sau',
  'phong.tong_so': 'Tổng số',
  'nguoi_dung.tieu_de': 'Tiêu đề - Người dùng',
  'nguoi_dung.nut_luu': 'Lưu',
  'nguoi_dung.nut_huy': 'Huỷ bỏ',
  'nguoi_dung.nut_xoa': 'Xoá',
  'nguoi_dung.thong_bao_thanh_cong': 'Đã lưu thành công',
  'nguoi_dung.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'nguoi_dung.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'nguoi_dung.khong_co_du_lieu': 'Không có dữ liệu',
  'nguoi_dung.dang_tai': 'Đang tải...',
  'nguoi_dung.tim_kiem': 'Tìm kiếm',
  'nguoi_dung.loc': 'Lọc',
  'nguoi_dung.xuat_excel': 'Xuất Excel',
  'nguoi_dung.in_trang': 'In trang',
  'nguoi_dung.trang_truoc': 'Trang trước',
  'nguoi_dung.trang_sau': 'Trang sau',
  'nguoi_dung.tong_so': 'Tổng số',
  'bao_cao.tieu_de': 'Tiêu đề - Báo cáo',
  'bao_cao.nut_luu': 'Lưu',
  'bao_cao.nut_huy': 'Huỷ bỏ',
  'bao_cao.nut_xoa': 'Xoá',
  'bao_cao.thong_bao_thanh_cong': 'Đã lưu thành công',
  'bao_cao.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'bao_cao.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'bao_cao.khong_co_du_lieu': 'Không có dữ liệu',
  'bao_cao.dang_tai': 'Đang tải...',
  'bao_cao.tim_kiem': 'Tìm kiếm',
  'bao_cao.loc': 'Lọc',
  'bao_cao.xuat_excel': 'Xuất Excel',
  'bao_cao.in_trang': 'In trang',
  'bao_cao.trang_truoc': 'Trang trước',
  'bao_cao.trang_sau': 'Trang sau',
  'bao_cao.tong_so': 'Tổng số',
  'thong_bao.tieu_de': 'Tiêu đề - Thông báo',
  'thong_bao.nut_luu': 'Lưu',
  'thong_bao.nut_huy': 'Huỷ bỏ',
  'thong_bao.nut_xoa': 'Xoá',
  'thong_bao.thong_bao_thanh_cong': 'Đã lưu thành công',
  'thong_bao.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'thong_bao.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'thong_bao.khong_co_du_lieu': 'Không có dữ liệu',
  'thong_bao.dang_tai': 'Đang tải...',
  'thong_bao.tim_kiem': 'Tìm kiếm',
  'thong_bao.loc': 'Lọc',
  'thong_bao.xuat_excel': 'Xuất Excel',
  'thong_bao.in_trang': 'In trang',
  'thong_bao.trang_truoc': 'Trang trước',
  'thong_bao.trang_sau': 'Trang sau',
  'thong_bao.tong_so': 'Tổng số',
  'duyet.tieu_de': 'Tiêu đề - Duyệt lịch',
  'duyet.nut_luu': 'Lưu',
  'duyet.nut_huy': 'Huỷ bỏ',
  'duyet.nut_xoa': 'Xoá',
  'duyet.thong_bao_thanh_cong': 'Đã lưu thành công',
  'duyet.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'duyet.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'duyet.khong_co_du_lieu': 'Không có dữ liệu',
  'duyet.dang_tai': 'Đang tải...',
  'duyet.tim_kiem': 'Tìm kiếm',
  'duyet.loc': 'Lọc',
  'duyet.xuat_excel': 'Xuất Excel',
  'duyet.in_trang': 'In trang',
  'duyet.trang_truoc': 'Trang trước',
  'duyet.trang_sau': 'Trang sau',
  'duyet.tong_so': 'Tổng số',
  'thiet_bi.tieu_de': 'Tiêu đề - Thiết bị',
  'thiet_bi.nut_luu': 'Lưu',
  'thiet_bi.nut_huy': 'Huỷ bỏ',
  'thiet_bi.nut_xoa': 'Xoá',
  'thiet_bi.thong_bao_thanh_cong': 'Đã lưu thành công',
  'thiet_bi.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'thiet_bi.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'thiet_bi.khong_co_du_lieu': 'Không có dữ liệu',
  'thiet_bi.dang_tai': 'Đang tải...',
  'thiet_bi.tim_kiem': 'Tìm kiếm',
  'thiet_bi.loc': 'Lọc',
  'thiet_bi.xuat_excel': 'Xuất Excel',
  'thiet_bi.in_trang': 'In trang',
  'thiet_bi.trang_truoc': 'Trang trước',
  'thiet_bi.trang_sau': 'Trang sau',
  'thiet_bi.tong_so': 'Tổng số',
  'khach.tieu_de': 'Tiêu đề - Khách mời',
  'khach.nut_luu': 'Lưu',
  'khach.nut_huy': 'Huỷ bỏ',
  'khach.nut_xoa': 'Xoá',
  'khach.thong_bao_thanh_cong': 'Đã lưu thành công',
  'khach.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'khach.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'khach.khong_co_du_lieu': 'Không có dữ liệu',
  'khach.dang_tai': 'Đang tải...',
  'khach.tim_kiem': 'Tìm kiếm',
  'khach.loc': 'Lọc',
  'khach.xuat_excel': 'Xuất Excel',
  'khach.in_trang': 'In trang',
  'khach.trang_truoc': 'Trang trước',
  'khach.trang_sau': 'Trang sau',
  'khach.tong_so': 'Tổng số',
  'cau_hinh.tieu_de': 'Tiêu đề - Cấu hình',
  'cau_hinh.nut_luu': 'Lưu',
  'cau_hinh.nut_huy': 'Huỷ bỏ',
  'cau_hinh.nut_xoa': 'Xoá',
  'cau_hinh.thong_bao_thanh_cong': 'Đã lưu thành công',
  'cau_hinh.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'cau_hinh.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'cau_hinh.khong_co_du_lieu': 'Không có dữ liệu',
  'cau_hinh.dang_tai': 'Đang tải...',
  'cau_hinh.tim_kiem': 'Tìm kiếm',
  'cau_hinh.loc': 'Lọc',
  'cau_hinh.xuat_excel': 'Xuất Excel',
  'cau_hinh.in_trang': 'In trang',
  'cau_hinh.trang_truoc': 'Trang trước',
  'cau_hinh.trang_sau': 'Trang sau',
  'cau_hinh.tong_so': 'Tổng số',
  'nhat_ky.tieu_de': 'Tiêu đề - Nhật ký',
  'nhat_ky.nut_luu': 'Lưu',
  'nhat_ky.nut_huy': 'Huỷ bỏ',
  'nhat_ky.nut_xoa': 'Xoá',
  'nhat_ky.thong_bao_thanh_cong': 'Đã lưu thành công',
  'nhat_ky.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'nhat_ky.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'nhat_ky.khong_co_du_lieu': 'Không có dữ liệu',
  'nhat_ky.dang_tai': 'Đang tải...',
  'nhat_ky.tim_kiem': 'Tìm kiếm',
  'nhat_ky.loc': 'Lọc',
  'nhat_ky.xuat_excel': 'Xuất Excel',
  'nhat_ky.in_trang': 'In trang',
  'nhat_ky.trang_truoc': 'Trang trước',
  'nhat_ky.trang_sau': 'Trang sau',
  'nhat_ky.tong_so': 'Tổng số',
  'xuat_file.tieu_de': 'Tiêu đề - Xuất file',
  'xuat_file.nut_luu': 'Lưu',
  'xuat_file.nut_huy': 'Huỷ bỏ',
  'xuat_file.nut_xoa': 'Xoá',
  'xuat_file.thong_bao_thanh_cong': 'Đã lưu thành công',
  'xuat_file.thong_bao_loi': 'Có lỗi xảy ra, vui lòng thử lại',
  'xuat_file.xac_nhan_xoa': 'Bạn có chắc muốn xoá?',
  'xuat_file.khong_co_du_lieu': 'Không có dữ liệu',
  'xuat_file.dang_tai': 'Đang tải...',
  'xuat_file.tim_kiem': 'Tìm kiếm',
  'xuat_file.loc': 'Lọc',
  'xuat_file.xuat_excel': 'Xuất Excel',
  'xuat_file.in_trang': 'In trang',
  'xuat_file.trang_truoc': 'Trang trước',
  'xuat_file.trang_sau': 'Trang sau',
  'xuat_file.tong_so': 'Tổng số',
  _: null
};

function htmlspecialchars($s) { return String($s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function kiem_tra_quyen($nguoi_dung, $mo_dun, $hanh_dong) { return !!$nguoi_dung; }
function ghi_nhat_ky($loai, $doi_tuong, $ai) { ghi_file_log("nhat_ky", [new Date().toISOString(), $loai, $doi_tuong, $ai].join("\t")); }

// Báo cáo: in (màn hình cũ, không dùng khi import)
function ve_bao_cao_in_0($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-bao_cao">';
  $html += '<tr><th>' + $CHUOI['bao_cao.tieu_de'] + '</th><th>' + $CHUOI['bao_cao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'bao_cao', 'in')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['bao_cao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Khách mời: hien thi (màn hình cũ, không dùng khi import)
function sql_khach_hien_thi_1($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM khach WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Danh mục phòng: tim kiem (màn hình cũ, không dùng khi import)
function mail_phong_tim_kiem_2($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['phong.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Thông báo: tim kiem (màn hình cũ, không dùng khi import)
function quyen_thong_bao_tim_kiem_3($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('tim_kiem', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('tim_kiem', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thong_bao.tim_kiem', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tuần: duyet (màn hình cũ, không dùng khi import)
function ve_lich_tuan_duyet_4($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_tuan">';
  $html += '<tr><th>' + $CHUOI['lich_tuan.tieu_de'] + '</th><th>' + $CHUOI['lich_tuan.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_tuan', 'duyet')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_tuan.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Danh mục phòng: gui mail (màn hình cũ, không dùng khi import)
function sql_phong_gui_mail_5($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM phong WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Danh mục phòng: duyet (màn hình cũ, không dùng khi import)
function mail_phong_duyet_6($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['phong.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Người dùng: in (màn hình cũ, không dùng khi import)
function quyen_nguoi_dung_in_7($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('in', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('in', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nguoi_dung.in', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Nhật ký: luu (màn hình cũ, không dùng khi import)
function ve_nhat_ky_luu_8($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-nhat_ky">';
  $html += '<tr><th>' + $CHUOI['nhat_ky.tieu_de'] + '</th><th>' + $CHUOI['nhat_ky.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'nhat_ky', 'luu')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['nhat_ky.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: tim kiem (màn hình cũ, không dùng khi import)
function sql_thiet_bi_tim_kiem_9($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Người dùng: duyet (màn hình cũ, không dùng khi import)
function mail_nguoi_dung_duyet_10($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nguoi_dung.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Nhật ký: in (màn hình cũ, không dùng khi import)
function quyen_nhat_ky_in_11($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('in', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('in', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nhat_ky.in', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Danh mục phòng: in (màn hình cũ, không dùng khi import)
function ve_phong_in_12($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-phong">';
  $html += '<tr><th>' + $CHUOI['phong.tieu_de'] + '</th><th>' + $CHUOI['phong.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'phong', 'in')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['phong.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: xoa (màn hình cũ, không dùng khi import)
function sql_thiet_bi_xoa_13($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Nhật ký: xoa (màn hình cũ, không dùng khi import)
function mail_nhat_ky_xoa_14($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nhat_ky.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Thông báo: gui mail (màn hình cũ, không dùng khi import)
function quyen_thong_bao_gui_mail_15($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('gui_mail', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('gui_mail', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thong_bao.gui_mail', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Cấu hình: gui mail (màn hình cũ, không dùng khi import)
function ve_cau_hinh_gui_mail_16($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-cau_hinh">';
  $html += '<tr><th>' + $CHUOI['cau_hinh.tieu_de'] + '</th><th>' + $CHUOI['cau_hinh.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'cau_hinh', 'gui_mail')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['cau_hinh.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Danh mục phòng: xoa (màn hình cũ, không dùng khi import)
function sql_phong_xoa_17($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM phong WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Lịch tháng: duyet (màn hình cũ, không dùng khi import)
function mail_lich_thang_duyet_18($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_thang.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Thông báo: xoa (màn hình cũ, không dùng khi import)
function quyen_thong_bao_xoa_19($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thong_bao.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thiết bị: gui mail (màn hình cũ, không dùng khi import)
function ve_thiet_bi_gui_mail_20($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thiet_bi">';
  $html += '<tr><th>' + $CHUOI['thiet_bi.tieu_de'] + '</th><th>' + $CHUOI['thiet_bi.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thiet_bi', 'gui_mail')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thiet_bi.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: in (màn hình cũ, không dùng khi import)
function sql_thiet_bi_in_21($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Danh mục phòng: xoa (màn hình cũ, không dùng khi import)
function mail_phong_xoa_22($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['phong.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Lịch tháng: xoa (màn hình cũ, không dùng khi import)
function quyen_lich_thang_xoa_23($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'lich_thang.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thông báo: xuat (màn hình cũ, không dùng khi import)
function ve_thong_bao_xuat_24($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thong_bao">';
  $html += '<tr><th>' + $CHUOI['thong_bao.tieu_de'] + '</th><th>' + $CHUOI['thong_bao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thong_bao', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thong_bao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Duyệt lịch: gui mail (màn hình cũ, không dùng khi import)
function sql_duyet_gui_mail_25($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM duyet WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Cấu hình: xuat (màn hình cũ, không dùng khi import)
function mail_cau_hinh_xuat_26($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['cau_hinh.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Xuất file: xuat (màn hình cũ, không dùng khi import)
function quyen_xuat_file_xuat_27($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xuat', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xuat', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'xuat_file.xuat', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Duyệt lịch: xuat (màn hình cũ, không dùng khi import)
function ve_duyet_xuat_28($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-duyet">';
  $html += '<tr><th>' + $CHUOI['duyet.tieu_de'] + '</th><th>' + $CHUOI['duyet.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'duyet', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['duyet.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Báo cáo: in (màn hình cũ, không dùng khi import)
function sql_bao_cao_in_29($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM bao_cao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Duyệt lịch: tim kiem (màn hình cũ, không dùng khi import)
function mail_duyet_tim_kiem_30($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['duyet.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Thiết bị: gui mail (màn hình cũ, không dùng khi import)
function quyen_thiet_bi_gui_mail_31($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('gui_mail', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('gui_mail', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thiet_bi.gui_mail', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// ---------------------------------------------------------------------------
// DANH MỤC PHÒNG (bảng dm_phong). Mã phòng là khoá; ten là tên hiển thị,
// suc_chua là số chỗ. ngung = true: phòng đã ngừng sử dụng, lịch của nó là lỗi.
// ---------------------------------------------------------------------------
var $DM_PHONG = {
  'P101': { ten: 'Phòng Sen', suc_chua: 8, tang: 1, may_chieu: true },
  'P102': { ten: 'Phòng Mai', suc_chua: 6, tang: 1, may_chieu: false },
  'P103': { ten: 'Phòng Đào', suc_chua: 6, tang: 1, may_chieu: false },
  'P201': { ten: 'Phòng Cúc', suc_chua: 10, tang: 2, may_chieu: true },
  'P202': { ten: 'Phòng Lan', suc_chua: 12, tang: 2, may_chieu: true },
  'P203': { ten: 'Phòng Trúc', suc_chua: 4, tang: 2, may_chieu: false },
  'P301': { ten: 'Phòng Đào Tạo', suc_chua: 40, tang: 3, may_chieu: true },
  'P302': { ten: 'Phòng Giám Đốc', suc_chua: 8, tang: 3, may_chieu: true },
  'HTA': { ten: 'Hội trường A', suc_chua: 300, tang: 1, may_chieu: true },
  'HTB': { ten: 'Hội trường B', suc_chua: 150, tang: 1, may_chieu: true },
  'PN1': { ten: 'Phòng Họp Nhỏ 1', suc_chua: 3, tang: N, may_chieu: false },
  'PN2': { ten: 'Phòng Họp Nhỏ 2', suc_chua: 3, tang: N, may_chieu: false },
  'P999': { ten: 'Kho cũ', suc_chua: 0, tang: 9, may_chieu: false, ngung: true },
};

// KHÔNG DÙNG NỮA (2019): bản cũ chỉ cắt khoảng trắng, không hiểu bí danh.
// Đã thay bằng chuan_hoa_ma_phong() ở phần xử lý dòng.
function chuan_hoa_ma_phong_v1($ma) {
  $ma = trim($ma);
  return isset($DM_PHONG[$ma]) ? $ma : null;
}

// Khách mời: in (màn hình cũ, không dùng khi import)
function ve_khach_in_32($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-khach">';
  $html += '<tr><th>' + $CHUOI['khach.tieu_de'] + '</th><th>' + $CHUOI['khach.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'khach', 'in')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['khach.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Cấu hình: gui mail (màn hình cũ, không dùng khi import)
function sql_cau_hinh_gui_mail_33($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM cau_hinh WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thông báo: xoa (màn hình cũ, không dùng khi import)
function mail_thong_bao_xoa_34($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thong_bao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Người dùng: luu (màn hình cũ, không dùng khi import)
function quyen_nguoi_dung_luu_35($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('luu', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('luu', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nguoi_dung.luu', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tháng: tim kiem (màn hình cũ, không dùng khi import)
function ve_lich_thang_tim_kiem_36($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_thang">';
  $html += '<tr><th>' + $CHUOI['lich_thang.tieu_de'] + '</th><th>' + $CHUOI['lich_thang.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_thang', 'tim_kiem')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_thang.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Xuất file: duyet (màn hình cũ, không dùng khi import)
function sql_xuat_file_duyet_37($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM xuat_file WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Cấu hình: hien thi (màn hình cũ, không dùng khi import)
function mail_cau_hinh_hien_thi_38($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['cau_hinh.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Duyệt lịch: in (màn hình cũ, không dùng khi import)
function quyen_duyet_in_39($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('in', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('in', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'duyet.in', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thông báo: tim kiem (màn hình cũ, không dùng khi import)
function ve_thong_bao_tim_kiem_40($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thong_bao">';
  $html += '<tr><th>' + $CHUOI['thong_bao.tieu_de'] + '</th><th>' + $CHUOI['thong_bao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thong_bao', 'tim_kiem')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thong_bao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: gui mail (màn hình cũ, không dùng khi import)
function sql_thiet_bi_gui_mail_41($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Người dùng: xuat (màn hình cũ, không dùng khi import)
function mail_nguoi_dung_xuat_42($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nguoi_dung.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Duyệt lịch: tim kiem (màn hình cũ, không dùng khi import)
function quyen_duyet_tim_kiem_43($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('tim_kiem', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('tim_kiem', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'duyet.tim_kiem', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Danh mục phòng: hien thi (màn hình cũ, không dùng khi import)
function ve_phong_hien_thi_44($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-phong">';
  $html += '<tr><th>' + $CHUOI['phong.tieu_de'] + '</th><th>' + $CHUOI['phong.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'phong', 'hien_thi')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['phong.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Người dùng: gui mail (màn hình cũ, không dùng khi import)
function sql_nguoi_dung_gui_mail_45($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM nguoi_dung WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thông báo: in (màn hình cũ, không dùng khi import)
function mail_thong_bao_in_46($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thong_bao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Danh mục phòng: xuat (màn hình cũ, không dùng khi import)
function quyen_phong_xuat_47($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xuat', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xuat', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.xuat', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thông báo: xoa (màn hình cũ, không dùng khi import)
function ve_thong_bao_xoa_48($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thong_bao">';
  $html += '<tr><th>' + $CHUOI['thong_bao.tieu_de'] + '</th><th>' + $CHUOI['thong_bao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thong_bao', 'xoa')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thong_bao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Khách mời: duyet (màn hình cũ, không dùng khi import)
function sql_khach_duyet_49($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM khach WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Danh mục phòng: luu (màn hình cũ, không dùng khi import)
function mail_phong_luu_50($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['phong.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Duyệt lịch: luu (màn hình cũ, không dùng khi import)
function quyen_duyet_luu_51($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('luu', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('luu', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'duyet.luu', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Danh mục phòng: luu (màn hình cũ, không dùng khi import)
function ve_phong_luu_52($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-phong">';
  $html += '<tr><th>' + $CHUOI['phong.tieu_de'] + '</th><th>' + $CHUOI['phong.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'phong', 'luu')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['phong.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Xuất file: luu (màn hình cũ, không dùng khi import)
function sql_xuat_file_luu_53($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM xuat_file WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// ---------------------------------------------------------------------------
// Mã phòng trong file xuất được gõ tay nhiều kiểu: "P.101", " p101 ",
// "HT-A", "Hoi truong A"... Quy tắc (từ 2019):
//   1. cắt khoảng trắng hai đầu, viết hoa, gộp khoảng trắng liên tiếp
//   2. nếu là bí danh trong $BI_DANH_PHONG thì đổi sang mã chuẩn
//   3. bỏ mọi dấu chấm, gạch ngang và khoảng trắng
//   4. phải có trong $DM_PHONG và chưa ngừng sử dụng, nếu không là lỗi phòng
// ---------------------------------------------------------------------------
var $BI_DANH_PHONG = {
  'HOI TRUONG A': 'HTA',
  'HOI TRUONG B': 'HTB',
  'PHONG SEN': 'P101',
  'PHN1': 'PN1',
  'PHN2': 'PN2',
  'GIAM DOC': 'P302',
};

function chuan_hoa_ma_phong($ma) {
  $ma = strtoupper(trim($ma)).replace(/\s+/g, " ");
  if (isset($BI_DANH_PHONG[$ma])) $ma = $BI_DANH_PHONG[$ma];
  $ma = $ma.replace(/[.\- ]/g, "");
  var $phong = $DM_PHONG[$ma];
  if (!$phong || $phong.ngung) return null;
  return $ma;
}

// Lịch tuần: xoa (màn hình cũ, không dùng khi import)
function mail_lich_tuan_xoa_54($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_tuan.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Thông báo: hien thi (màn hình cũ, không dùng khi import)
function quyen_thong_bao_hien_thi_55($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('hien_thi', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('hien_thi', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thong_bao.hien_thi', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Xuất file: in (màn hình cũ, không dùng khi import)
function ve_xuat_file_in_56($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-xuat_file">';
  $html += '<tr><th>' + $CHUOI['xuat_file.tieu_de'] + '</th><th>' + $CHUOI['xuat_file.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'xuat_file', 'in')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['xuat_file.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Duyệt lịch: luu (màn hình cũ, không dùng khi import)
function sql_duyet_luu_57($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM duyet WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Cấu hình: hien thi (màn hình cũ, không dùng khi import)
function mail_cau_hinh_hien_thi_58($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['cau_hinh.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Báo cáo: xoa (màn hình cũ, không dùng khi import)
function quyen_bao_cao_xoa_59($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'bao_cao.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Khách mời: tim kiem (màn hình cũ, không dùng khi import)
function ve_khach_tim_kiem_60($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-khach">';
  $html += '<tr><th>' + $CHUOI['khach.tieu_de'] + '</th><th>' + $CHUOI['khach.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'khach', 'tim_kiem')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['khach.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Báo cáo: luu (màn hình cũ, không dùng khi import)
function sql_bao_cao_luu_61($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM bao_cao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Xuất file: duyet (màn hình cũ, không dùng khi import)
function mail_xuat_file_duyet_62($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['xuat_file.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Danh mục phòng: xoa (màn hình cũ, không dùng khi import)
function quyen_phong_xoa_63($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Báo cáo: duyet (màn hình cũ, không dùng khi import)
function ve_bao_cao_duyet_64($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-bao_cao">';
  $html += '<tr><th>' + $CHUOI['bao_cao.tieu_de'] + '</th><th>' + $CHUOI['bao_cao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'bao_cao', 'duyet')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['bao_cao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Cấu hình: luu (màn hình cũ, không dùng khi import)
function sql_cau_hinh_luu_65($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM cau_hinh WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Lịch tháng: in (màn hình cũ, không dùng khi import)
function mail_lich_thang_in_66($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_thang.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Thông báo: luu (màn hình cũ, không dùng khi import)
function quyen_thong_bao_luu_67($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('luu', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('luu', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thong_bao.luu', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Khách mời: xuat (màn hình cũ, không dùng khi import)
function ve_khach_xuat_68($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-khach">';
  $html += '<tr><th>' + $CHUOI['khach.tieu_de'] + '</th><th>' + $CHUOI['khach.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'khach', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['khach.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Người dùng: gui mail (màn hình cũ, không dùng khi import)
function sql_nguoi_dung_gui_mail_69($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM nguoi_dung WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Báo cáo: xoa (màn hình cũ, không dùng khi import)
function mail_bao_cao_xoa_70($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['bao_cao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Người dùng: duyet (màn hình cũ, không dùng khi import)
function quyen_nguoi_dung_duyet_71($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('duyet', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('duyet', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nguoi_dung.duyet', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tháng: tim kiem (màn hình cũ, không dùng khi import)
function ve_lich_thang_tim_kiem_72($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_thang">';
  $html += '<tr><th>' + $CHUOI['lich_thang.tieu_de'] + '</th><th>' + $CHUOI['lich_thang.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_thang', 'tim_kiem')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_thang.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Khách mời: duyet (màn hình cũ, không dùng khi import)
function sql_khach_duyet_73($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM khach WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Cấu hình: hien thi (màn hình cũ, không dùng khi import)
function mail_cau_hinh_hien_thi_74($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['cau_hinh.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Cấu hình: xuat (màn hình cũ, không dùng khi import)
function quyen_cau_hinh_xuat_75($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xuat', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xuat', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'cau_hinh.xuat', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Duyệt lịch: gui mail (màn hình cũ, không dùng khi import)
function ve_duyet_gui_mail_76($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-duyet">';
  $html += '<tr><th>' + $CHUOI['duyet.tieu_de'] + '</th><th>' + $CHUOI['duyet.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'duyet', 'gui_mail')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['duyet.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: xoa (màn hình cũ, không dùng khi import)
function sql_thiet_bi_xoa_77($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// ---------------------------------------------------------------------------
// NGÀY: "dd/mm/yyyy" (ngày, tháng có thể 1 chữ số) hoặc "yyyy-mm-dd" (file
// chi nhánh HCM). Ngày không có thật (31/02...) là lỗi thời gian.
// Trả về [năm, tháng, ngày] hoặc null.
// ---------------------------------------------------------------------------
function doc_ngay($s) {
  $s = trim($s);
  var $m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec($s), $nam, $thang, $ngay;
  if ($m) { $ngay = intval($m[1]); $thang = intval($m[2]); $nam = intval($m[3]); }
  else if (($m = /^(\d{4})-(\d{2})-(\d{2})$/.exec($s))) { $nam = intval($m[1]); $thang = intval($m[2]); $ngay = intval($m[3]); }
  else return null;
  if (!checkdate($thang, $ngay, $nam)) return null;
  return [$nam, $thang, $ngay];
}

// GIỜ: "HH:MM", "H:MM", "HH:MM:SS" (giây phải là 00), "9h30", "9h".
// "24:00" chỉ hợp lệ cho giờ kết thúc và nghĩa là 00:00 ngày hôm sau.
// Trả về số phút tính từ 00:00 của ngày đặt lịch, hoặc null.
function doc_gio($s, $la_gio_ket_thuc) {
  $s = strtolower(trim($s));
  var $m = /^(\d{1,2})(?::(\d{2})(?::(\d{2}))?|h(\d{2})?)$/.exec($s);
  if (!$m) return null;
  var $gio = intval($m[1]), $phut = intval($m[2] || $m[4] || "0"), $giay = intval($m[3] || "0");
  if ($giay !== 0 || $phut > 59) return null;
  if ($gio === 24 && $phut === 0 && $la_gio_ket_thuc) return 24 * 60;
  if ($gio > 23) return null;
  return $gio * 60 + $phut;
}

// Ngày + số phút (giờ Việt Nam) -> thời điểm tuyệt đối.
function thoi_diem($ngay, $phut) {
  return new Date(Date.UTC($ngay[0], $ngay[1] - 1, $ngay[2], 0, $phut) - $LECH_GIO * 3600 * 1000);
}

// Lịch tháng: duyet (màn hình cũ, không dùng khi import)
function mail_lich_thang_duyet_78($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_thang.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Thiết bị: duyet (màn hình cũ, không dùng khi import)
function quyen_thiet_bi_duyet_79($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('duyet', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('duyet', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thiet_bi.duyet', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tháng: xuat (màn hình cũ, không dùng khi import)
function ve_lich_thang_xuat_80($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_thang">';
  $html += '<tr><th>' + $CHUOI['lich_thang.tieu_de'] + '</th><th>' + $CHUOI['lich_thang.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_thang', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_thang.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Cấu hình: hien thi (màn hình cũ, không dùng khi import)
function sql_cau_hinh_hien_thi_81($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM cau_hinh WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Lịch tháng: hien thi (màn hình cũ, không dùng khi import)
function mail_lich_thang_hien_thi_82($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_thang.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Nhật ký: tim kiem (màn hình cũ, không dùng khi import)
function quyen_nhat_ky_tim_kiem_83($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('tim_kiem', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('tim_kiem', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nhat_ky.tim_kiem', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Duyệt lịch: duyet (màn hình cũ, không dùng khi import)
function ve_duyet_duyet_84($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-duyet">';
  $html += '<tr><th>' + $CHUOI['duyet.tieu_de'] + '</th><th>' + $CHUOI['duyet.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'duyet', 'duyet')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['duyet.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Cấu hình: xoa (màn hình cũ, không dùng khi import)
function sql_cau_hinh_xoa_85($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM cau_hinh WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Báo cáo: xoa (màn hình cũ, không dùng khi import)
function mail_bao_cao_xoa_86($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['bao_cao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Cấu hình: in (màn hình cũ, không dùng khi import)
function quyen_cau_hinh_in_87($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('in', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('in', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'cau_hinh.in', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Người dùng: tim kiem (màn hình cũ, không dùng khi import)
function ve_nguoi_dung_tim_kiem_88($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-nguoi_dung">';
  $html += '<tr><th>' + $CHUOI['nguoi_dung.tieu_de'] + '</th><th>' + $CHUOI['nguoi_dung.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'nguoi_dung', 'tim_kiem')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['nguoi_dung.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: xoa (màn hình cũ, không dùng khi import)
function sql_thiet_bi_xoa_89($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Nhật ký: gui mail (màn hình cũ, không dùng khi import)
function mail_nhat_ky_gui_mail_90($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nhat_ky.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Danh mục phòng: in (màn hình cũ, không dùng khi import)
function quyen_phong_in_91($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('in', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('in', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.in', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Duyệt lịch: hien thi (màn hình cũ, không dùng khi import)
function ve_duyet_hien_thi_92($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-duyet">';
  $html += '<tr><th>' + $CHUOI['duyet.tieu_de'] + '</th><th>' + $CHUOI['duyet.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'duyet', 'hien_thi')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['duyet.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: xuat (màn hình cũ, không dùng khi import)
function sql_thiet_bi_xuat_93($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Lịch tháng: in (màn hình cũ, không dùng khi import)
function mail_lich_thang_in_94($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_thang.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Báo cáo: luu (màn hình cũ, không dùng khi import)
function quyen_bao_cao_luu_95($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('luu', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('luu', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'bao_cao.luu', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thông báo: duyet (màn hình cũ, không dùng khi import)
function ve_thong_bao_duyet_96($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thong_bao">';
  $html += '<tr><th>' + $CHUOI['thong_bao.tieu_de'] + '</th><th>' + $CHUOI['thong_bao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thong_bao', 'duyet')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thong_bao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thông báo: luu (màn hình cũ, không dùng khi import)
function sql_thong_bao_luu_97($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thong_bao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thiết bị: hien thi (màn hình cũ, không dùng khi import)
function mail_thiet_bi_hien_thi_98($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thiet_bi.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Lịch tháng: hien thi (màn hình cũ, không dùng khi import)
function quyen_lich_thang_hien_thi_99($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('hien_thi', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('hien_thi', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'lich_thang.hien_thi', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Người dùng: xuat (màn hình cũ, không dùng khi import)
function ve_nguoi_dung_xuat_100($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-nguoi_dung">';
  $html += '<tr><th>' + $CHUOI['nguoi_dung.tieu_de'] + '</th><th>' + $CHUOI['nguoi_dung.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'nguoi_dung', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['nguoi_dung.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thiết bị: gui mail (màn hình cũ, không dùng khi import)
function sql_thiet_bi_gui_mail_101($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thiet_bi WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Báo cáo: xoa (màn hình cũ, không dùng khi import)
function mail_bao_cao_xoa_102($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['bao_cao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Danh mục phòng: gui mail (màn hình cũ, không dùng khi import)
function quyen_phong_gui_mail_103($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('gui_mail', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('gui_mail', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.gui_mail', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// ---------------------------------------------------------------------------
// TRẠNG THÁI. Rỗng, OK, XAC_NHAN, DA_DUYET: lịch đang hiệu lực.
// HUY, DA_HUY, CANCEL: lịch đã huỷ; thời điểm huỷ lấy ở cột ngay_huy
// ("dd/mm/yyyy HH:MM", giờ Việt Nam), nếu trống thì lấy giờ bắt đầu lịch.
// ---------------------------------------------------------------------------
var $TRANG_THAI = {
  '': 'hieu_luc', 'OK': 'hieu_luc', 'XAC_NHAN': 'hieu_luc', 'DA_DUYET': 'hieu_luc',
  'HUY': 'da_huy', 'DA_HUY': 'da_huy', 'CANCEL': 'da_huy'
};

function doc_thoi_diem_huy($s, $mac_dinh) {
  var $phan = trim($s).split(/\s+/);
  if (count($phan) !== 2) return $mac_dinh;
  var $ngay = doc_ngay($phan[0]), $phut = doc_gio($phan[1], false);
  if (!$ngay || $phut === null) return $mac_dinh;
  return thoi_diem($ngay, $phut);
}

// Báo cáo: gui mail (màn hình cũ, không dùng khi import)
function ve_bao_cao_gui_mail_104($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-bao_cao">';
  $html += '<tr><th>' + $CHUOI['bao_cao.tieu_de'] + '</th><th>' + $CHUOI['bao_cao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'bao_cao', 'gui_mail')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['bao_cao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Lịch tháng: xoa (màn hình cũ, không dùng khi import)
function sql_lich_thang_xoa_105($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM lich_thang WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Người dùng: xuat (màn hình cũ, không dùng khi import)
function mail_nguoi_dung_xuat_106($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nguoi_dung.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Nhật ký: gui mail (màn hình cũ, không dùng khi import)
function quyen_nhat_ky_gui_mail_107($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('gui_mail', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('gui_mail', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nhat_ky.gui_mail', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Báo cáo: luu (màn hình cũ, không dùng khi import)
function ve_bao_cao_luu_108($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-bao_cao">';
  $html += '<tr><th>' + $CHUOI['bao_cao.tieu_de'] + '</th><th>' + $CHUOI['bao_cao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'bao_cao', 'luu')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['bao_cao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Khách mời: gui mail (màn hình cũ, không dùng khi import)
function sql_khach_gui_mail_109($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM khach WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Nhật ký: xuat (màn hình cũ, không dùng khi import)
function mail_nhat_ky_xuat_110($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nhat_ky.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Lịch tuần: luu (màn hình cũ, không dùng khi import)
function quyen_lich_tuan_luu_111($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('luu', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('luu', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'lich_tuan.luu', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tháng: tim kiem (màn hình cũ, không dùng khi import)
function ve_lich_thang_tim_kiem_112($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_thang">';
  $html += '<tr><th>' + $CHUOI['lich_thang.tieu_de'] + '</th><th>' + $CHUOI['lich_thang.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_thang', 'tim_kiem')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_thang.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Danh mục phòng: gui mail (màn hình cũ, không dùng khi import)
function sql_phong_gui_mail_113($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM phong WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Danh mục phòng: duyet (màn hình cũ, không dùng khi import)
function mail_phong_duyet_114($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['phong.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Danh mục phòng: xoa (màn hình cũ, không dùng khi import)
function quyen_phong_xoa_115($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tháng: xuat (màn hình cũ, không dùng khi import)
function ve_lich_thang_xuat_116($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_thang">';
  $html += '<tr><th>' + $CHUOI['lich_thang.tieu_de'] + '</th><th>' + $CHUOI['lich_thang.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_thang', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_thang.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Duyệt lịch: tim kiem (màn hình cũ, không dùng khi import)
function sql_duyet_tim_kiem_117($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM duyet WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Xuất file: luu (màn hình cũ, không dùng khi import)
function mail_xuat_file_luu_118($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['xuat_file.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Lịch tháng: xoa (màn hình cũ, không dùng khi import)
function quyen_lich_thang_xoa_119($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'lich_thang.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Duyệt lịch: xuat (màn hình cũ, không dùng khi import)
function ve_duyet_xuat_120($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-duyet">';
  $html += '<tr><th>' + $CHUOI['duyet.tieu_de'] + '</th><th>' + $CHUOI['duyet.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'duyet', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['duyet.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Lịch tuần: xuat (màn hình cũ, không dùng khi import)
function sql_lich_tuan_xuat_121($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM lich_tuan WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Danh mục phòng: gui mail (màn hình cũ, không dùng khi import)
function mail_phong_gui_mail_122($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['phong.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Nhật ký: xoa (màn hình cũ, không dùng khi import)
function quyen_nhat_ky_xoa_123($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nhat_ky.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Người dùng: xoa (màn hình cũ, không dùng khi import)
function ve_nguoi_dung_xoa_124($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-nguoi_dung">';
  $html += '<tr><th>' + $CHUOI['nguoi_dung.tieu_de'] + '</th><th>' + $CHUOI['nguoi_dung.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'nguoi_dung', 'xoa')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['nguoi_dung.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Khách mời: duyet (màn hình cũ, không dùng khi import)
function sql_khach_duyet_125($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM khach WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Người dùng: gui mail (màn hình cũ, không dùng khi import)
function mail_nguoi_dung_gui_mail_126($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nguoi_dung.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Lịch tháng: tim kiem (màn hình cũ, không dùng khi import)
function quyen_lich_thang_tim_kiem_127($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('tim_kiem', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('tim_kiem', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'lich_thang.tim_kiem', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// ---------------------------------------------------------------------------
// TIÊU ĐỀ: form cũ lưu dạng HTML-escape (&amp; &lt; &gt; &quot; &#39; &#NNN;),
// phải giải mã. Tiêu đề rỗng thì dùng "(không tiêu đề)".
// NGƯỜI ĐẶT: viết thường; nếu là email thì chỉ lấy phần trước @; rỗng thì
// dùng "khong-ro".
// ---------------------------------------------------------------------------
function html_entity_decode($s) {
  return String($s)
    .replace(/&#(\d+);/g, function ($_, $n) { return String.fromCharCode(intval($n)); })
    .replace(/&#x([0-9a-f]+);/gi, function ($_, $n) { return String.fromCharCode(parseInt($n, 16)); })
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function chuan_hoa_tieu_de($s) {
  $s = trim(html_entity_decode(trim($s)));
  return $s === "" ? "(không tiêu đề)" : $s;
}

function chuan_hoa_nguoi_dat($s) {
  $s = strtolower(trim($s));
  if ($s.indexOf("@") >= 0) $s = explode("@", $s)[0];
  return $s === "" ? "khong-ro" : $s;
}

// Nhật ký: xuat (màn hình cũ, không dùng khi import)
function ve_nhat_ky_xuat_128($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-nhat_ky">';
  $html += '<tr><th>' + $CHUOI['nhat_ky.tieu_de'] + '</th><th>' + $CHUOI['nhat_ky.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'nhat_ky', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['nhat_ky.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Người dùng: duyet (màn hình cũ, không dùng khi import)
function sql_nguoi_dung_duyet_129($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM nguoi_dung WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Người dùng: in (màn hình cũ, không dùng khi import)
function mail_nguoi_dung_in_130($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nguoi_dung.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Danh mục phòng: xuat (màn hình cũ, không dùng khi import)
function quyen_phong_xuat_131($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xuat', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xuat', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.xuat', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Khách mời: luu (màn hình cũ, không dùng khi import)
function ve_khach_luu_132($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-khach">';
  $html += '<tr><th>' + $CHUOI['khach.tieu_de'] + '</th><th>' + $CHUOI['khach.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'khach', 'luu')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['khach.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Lịch tháng: duyet (màn hình cũ, không dùng khi import)
function sql_lich_thang_duyet_133($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM lich_thang WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Báo cáo: hien thi (màn hình cũ, không dùng khi import)
function mail_bao_cao_hien_thi_134($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['bao_cao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Người dùng: duyet (màn hình cũ, không dùng khi import)
function quyen_nguoi_dung_duyet_135($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('duyet', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('duyet', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nguoi_dung.duyet', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tuần: xuat (màn hình cũ, không dùng khi import)
function ve_lich_tuan_xuat_136($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_tuan">';
  $html += '<tr><th>' + $CHUOI['lich_tuan.tieu_de'] + '</th><th>' + $CHUOI['lich_tuan.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_tuan', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_tuan.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thông báo: tim kiem (màn hình cũ, không dùng khi import)
function sql_thong_bao_tim_kiem_137($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thong_bao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Báo cáo: luu (màn hình cũ, không dùng khi import)
function mail_bao_cao_luu_138($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['bao_cao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Người dùng: tim kiem (màn hình cũ, không dùng khi import)
function quyen_nguoi_dung_tim_kiem_139($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('tim_kiem', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('tim_kiem', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'nguoi_dung.tim_kiem', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thông báo: xoa (màn hình cũ, không dùng khi import)
function ve_thong_bao_xoa_140($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thong_bao">';
  $html += '<tr><th>' + $CHUOI['thong_bao.tieu_de'] + '</th><th>' + $CHUOI['thong_bao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thong_bao', 'xoa')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thong_bao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Báo cáo: duyet (màn hình cũ, không dùng khi import)
function sql_bao_cao_duyet_141($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM bao_cao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Xuất file: xuat (màn hình cũ, không dùng khi import)
function mail_xuat_file_xuat_142($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['xuat_file.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Thông báo: xoa (màn hình cũ, không dùng khi import)
function quyen_thong_bao_xoa_143($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thong_bao.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Duyệt lịch: gui mail (màn hình cũ, không dùng khi import)
function ve_duyet_gui_mail_144($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-duyet">';
  $html += '<tr><th>' + $CHUOI['duyet.tieu_de'] + '</th><th>' + $CHUOI['duyet.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'duyet', 'gui_mail')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['duyet.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Báo cáo: in (màn hình cũ, không dùng khi import)
function sql_bao_cao_in_145($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM bao_cao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thông báo: gui mail (màn hình cũ, không dùng khi import)
function mail_thong_bao_gui_mail_146($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thong_bao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Danh mục phòng: tim kiem (màn hình cũ, không dùng khi import)
function quyen_phong_tim_kiem_147($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('tim_kiem', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('tim_kiem', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.tim_kiem', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Khách mời: hien thi (màn hình cũ, không dùng khi import)
function ve_khach_hien_thi_148($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-khach">';
  $html += '<tr><th>' + $CHUOI['khach.tieu_de'] + '</th><th>' + $CHUOI['khach.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'khach', 'hien_thi')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['khach.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Khách mời: gui mail (màn hình cũ, không dùng khi import)
function sql_khach_gui_mail_149($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM khach WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thông báo: gui mail (màn hình cũ, không dùng khi import)
function mail_thong_bao_gui_mail_150($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thong_bao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Thiết bị: gui mail (màn hình cũ, không dùng khi import)
function quyen_thiet_bi_gui_mail_151($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('gui_mail', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('gui_mail', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thiet_bi.gui_mail', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Xuất file: tim kiem (màn hình cũ, không dùng khi import)
function ve_xuat_file_tim_kiem_152($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-xuat_file">';
  $html += '<tr><th>' + $CHUOI['xuat_file.tieu_de'] + '</th><th>' + $CHUOI['xuat_file.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'xuat_file', 'tim_kiem')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['xuat_file.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Người dùng: tim kiem (màn hình cũ, không dùng khi import)
function sql_nguoi_dung_tim_kiem_153($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM nguoi_dung WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// ---------------------------------------------------------------------------
// ĐỌC FILE XUẤT: UTF-8 có BOM, xuống dòng CRLF, phân cách ";", trường có ";"
// hoặc dấu nháy kép được bọc trong "..." và nháy kép bên trong viết thành "".
// Dòng 1 là tiêu đề cột. Không có xuống dòng bên trong một trường.
// ---------------------------------------------------------------------------
var $COT = ['ma_dat', 'ma_phong', 'ngay', 'gio_bd', 'gio_kt', 'tieu_de', 'nguoi_dat', 'trang_thai', 'ngay_huy'];

function tach_dong($dong) {
  var $truong = [], $hien_tai = "", $trong_nhay = false;
  for (var $i = 0; $i < $dong.length; $i++) {
    var $c = $dong.charAt($i);
    if ($trong_nhay) {
      if ($c === '"' && $dong.charAt($i + 1) === '"') { $hien_tai += '"'; $i++; }
      else if ($c === '"') $trong_nhay = false;
      else $hien_tai += $c;
    } else if ($c === '"') $trong_nhay = true;
    else if ($c === ";") { $truong.push($hien_tai); $hien_tai = ""; }
    else $hien_tai += $c;
  }
  $truong.push($hien_tai);
  return $truong;
}

// Một dòng -> bản ghi lịch, hoặc { loi: "LOI_PHONG" | "LOI_THOI_GIAN" }.
// Thứ tự kiểm tra: phòng, ngày, giờ bắt đầu, giờ kết thúc, kết thúc > bắt đầu.
function xu_ly_dong($o) {
  var $ma_phong = chuan_hoa_ma_phong($o.ma_phong);
  if (!$ma_phong) return { loi: "LOI_PHONG" };
  var $ngay = doc_ngay($o.ngay);
  if (!$ngay) return { loi: "LOI_THOI_GIAN" };
  var $bd = doc_gio($o.gio_bd, false), $kt = doc_gio($o.gio_kt, true);
  if ($bd === null || $kt === null || $kt <= $bd) return { loi: "LOI_THOI_GIAN" };
  var $bat_dau = thoi_diem($ngay, $bd), $ket_thuc = thoi_diem($ngay, $kt);
  var $trang_thai = $TRANG_THAI[strtoupper(trim($o.trang_thai))] || "hieu_luc";
  return {
    ma_dat: trim($o.ma_dat),
    ma_phong: $ma_phong,
    ten_phong: $DM_PHONG[$ma_phong].ten,
    bat_dau: $bat_dau,
    ket_thuc: $ket_thuc,
    tieu_de: chuan_hoa_tieu_de($o.tieu_de),
    nguoi_dat: chuan_hoa_nguoi_dat($o.nguoi_dat),
    da_huy: $trang_thai === "da_huy",
    thoi_diem_huy: $trang_thai === "da_huy" ? doc_thoi_diem_huy($o.ngay_huy, $bat_dau) : null
  };
}

// Nhật ký: duyet (màn hình cũ, không dùng khi import)
function mail_nhat_ky_duyet_154($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nhat_ky.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Duyệt lịch: in (màn hình cũ, không dùng khi import)
function quyen_duyet_in_155($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('in', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('in', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'duyet.in', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thông báo: xuat (màn hình cũ, không dùng khi import)
function ve_thong_bao_xuat_156($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thong_bao">';
  $html += '<tr><th>' + $CHUOI['thong_bao.tieu_de'] + '</th><th>' + $CHUOI['thong_bao.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thong_bao', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thong_bao.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Xuất file: xoa (màn hình cũ, không dùng khi import)
function sql_xuat_file_xoa_157($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM xuat_file WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thông báo: luu (màn hình cũ, không dùng khi import)
function mail_thong_bao_luu_158($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thong_bao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Thiết bị: xoa (màn hình cũ, không dùng khi import)
function quyen_thiet_bi_xoa_159($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'thiet_bi.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Danh mục phòng: hien thi (màn hình cũ, không dùng khi import)
function ve_phong_hien_thi_160($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-phong">';
  $html += '<tr><th>' + $CHUOI['phong.tieu_de'] + '</th><th>' + $CHUOI['phong.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'phong', 'hien_thi')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['phong.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Cấu hình: hien thi (màn hình cũ, không dùng khi import)
function sql_cau_hinh_hien_thi_161($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM cau_hinh WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Người dùng: tim kiem (màn hình cũ, không dùng khi import)
function mail_nguoi_dung_tim_kiem_162($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nguoi_dung.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Danh mục phòng: xuat (màn hình cũ, không dùng khi import)
function quyen_phong_xuat_163($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xuat', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xuat', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.xuat', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Nhật ký: xuat (màn hình cũ, không dùng khi import)
function ve_nhat_ky_xuat_164($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-nhat_ky">';
  $html += '<tr><th>' + $CHUOI['nhat_ky.tieu_de'] + '</th><th>' + $CHUOI['nhat_ky.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'nhat_ky', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['nhat_ky.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thông báo: xoa (màn hình cũ, không dùng khi import)
function sql_thong_bao_xoa_165($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thong_bao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Cấu hình: in (màn hình cũ, không dùng khi import)
function mail_cau_hinh_in_166($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['cau_hinh.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Xuất file: in (màn hình cũ, không dùng khi import)
function quyen_xuat_file_in_167($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('in', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('in', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'xuat_file.in', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Nhật ký: hien thi (màn hình cũ, không dùng khi import)
function ve_nhat_ky_hien_thi_168($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-nhat_ky">';
  $html += '<tr><th>' + $CHUOI['nhat_ky.tieu_de'] + '</th><th>' + $CHUOI['nhat_ky.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'nhat_ky', 'hien_thi')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['nhat_ky.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Thông báo: in (màn hình cũ, không dùng khi import)
function sql_thong_bao_in_169($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM thong_bao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thông báo: duyet (màn hình cũ, không dùng khi import)
function mail_thong_bao_duyet_170($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thong_bao.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Cấu hình: tim kiem (màn hình cũ, không dùng khi import)
function quyen_cau_hinh_tim_kiem_171($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('tim_kiem', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('tim_kiem', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'cau_hinh.tim_kiem', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tuần: xoa (màn hình cũ, không dùng khi import)
function ve_lich_tuan_xoa_172($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_tuan">';
  $html += '<tr><th>' + $CHUOI['lich_tuan.tieu_de'] + '</th><th>' + $CHUOI['lich_tuan.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_tuan', 'xoa')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_tuan.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Cấu hình: xoa (màn hình cũ, không dùng khi import)
function sql_cau_hinh_xoa_173($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM cau_hinh WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// ---------------------------------------------------------------------------
// CHẠY IMPORT (bản cũ). Hệ thống cũ KHÔNG kiểm tra trùng giờ khi import nên
// dữ liệu xuất ra có những lịch chồng nhau trong cùng phòng.
// ---------------------------------------------------------------------------
function import_lich($noi_dung) {
  if ($noi_dung.charCodeAt(0) === 0xFEFF) $noi_dung = $noi_dung.slice(1);
  var $dong = $noi_dung.split(/\r?\n/);
  if (trim($dong[0]) !== implode(";", $COT)) throw new Error("Sai dòng tiêu đề");
  var $ket_qua = { tong: 0, da_ghi: 0, loi: [] };
  mysql_connect();
  for (var $i = 1; $i < count($dong); $i++) {
    if (trim($dong[$i]) === "") continue;
    $ket_qua.tong++;
    var $gia_tri = tach_dong($dong[$i]), $o = {};
    for (var $j = 0; $j < count($COT); $j++) $o[$COT[$j]] = $gia_tri[$j] === undefined ? "" : $gia_tri[$j];
    var $lich = xu_ly_dong($o);
    if ($lich.loi) { $ket_qua.loi.push({ dong: $i + 1, ma_dat: trim($o.ma_dat), loi: $lich.loi }); continue; }
    mysql_query("INSERT INTO lich (ma_dat, ma_phong, bat_dau, ket_thuc, tieu_de, nguoi_dat, da_huy, thoi_diem_huy) VALUES ('" +
      [$lich.ma_dat, $lich.ma_phong, $lich.bat_dau.toISOString(), $lich.ket_thuc.toISOString(), mysql_real_escape_string($lich.tieu_de),
       $lich.nguoi_dat, $lich.da_huy ? 1 : 0, $lich.thoi_diem_huy ? $lich.thoi_diem_huy.toISOString() : ""].join("','") + "')");
    $ket_qua.da_ghi++;
  }
  return $ket_qua;
}

// Lịch tuần: gui mail (màn hình cũ, không dùng khi import)
function mail_lich_tuan_gui_mail_174($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_tuan.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Cấu hình: luu (màn hình cũ, không dùng khi import)
function quyen_cau_hinh_luu_175($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('luu', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('luu', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'cau_hinh.luu', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Khách mời: xoa (màn hình cũ, không dùng khi import)
function ve_khach_xoa_176($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-khach">';
  $html += '<tr><th>' + $CHUOI['khach.tieu_de'] + '</th><th>' + $CHUOI['khach.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'khach', 'xoa')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['khach.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Báo cáo: hien thi (màn hình cũ, không dùng khi import)
function sql_bao_cao_hien_thi_177($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM bao_cao WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Người dùng: duyet (màn hình cũ, không dùng khi import)
function mail_nguoi_dung_duyet_178($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['nguoi_dung.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Báo cáo: xoa (màn hình cũ, không dùng khi import)
function quyen_bao_cao_xoa_179($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('xoa', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('xoa', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'bao_cao.xoa', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Lịch tháng: duyet (màn hình cũ, không dùng khi import)
function ve_lich_thang_duyet_180($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-lich_thang">';
  $html += '<tr><th>' + $CHUOI['lich_thang.tieu_de'] + '</th><th>' + $CHUOI['lich_thang.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'lich_thang', 'duyet')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['lich_thang.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Lịch tháng: in (màn hình cũ, không dùng khi import)
function sql_lich_thang_in_181($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM lich_thang WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thiết bị: gui mail (màn hình cũ, không dùng khi import)
function mail_thiet_bi_gui_mail_182($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thiet_bi.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 3 };
}

// Lịch tháng: hien thi (màn hình cũ, không dùng khi import)
function quyen_lich_thang_hien_thi_183($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('hien_thi', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('hien_thi', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'lich_thang.hien_thi', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Xuất file: xuat (màn hình cũ, không dùng khi import)
function ve_xuat_file_xuat_184($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-xuat_file">';
  $html += '<tr><th>' + $CHUOI['xuat_file.tieu_de'] + '</th><th>' + $CHUOI['xuat_file.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'xuat_file', 'xuat')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['xuat_file.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Danh mục phòng: duyet (màn hình cũ, không dùng khi import)
function sql_phong_duyet_185($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM phong WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Lịch tuần: duyet (màn hình cũ, không dùng khi import)
function mail_lich_tuan_duyet_186($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['lich_tuan.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 1 };
}

// Danh mục phòng: gui mail (màn hình cũ, không dùng khi import)
function quyen_phong_gui_mail_187($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('gui_mail', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('gui_mail', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'phong.gui_mail', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

// Thiết bị: hien thi (màn hình cũ, không dùng khi import)
function ve_thiet_bi_hien_thi_188($du_lieu, $nguoi_dung) {
  var $html = '<table class="bang-thiet_bi">';
  $html += '<tr><th>' + $CHUOI['thiet_bi.tieu_de'] + '</th><th>' + $CHUOI['thiet_bi.tong_so'] + '</th></tr>';
  for (var $i = 0; $i < count($du_lieu); $i++) {
    var $dong = $du_lieu[$i];
    if (!kiem_tra_quyen($nguoi_dung, 'thiet_bi', 'hien_thi')) continue;
    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';
    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';
    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';
    $html += '</tr>';
  }
  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['thiet_bi.khong_co_du_lieu'] + '</td></tr>';
  return $html + '</table>';
}

// Người dùng: hien thi (màn hình cũ, không dùng khi import)
function sql_nguoi_dung_hien_thi_189($loc) {
  var $dk = ['1 = 1'];
  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");
  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");
  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");
  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");
  var $sql = 'SELECT * FROM nguoi_dung WHERE ' + implode(' AND ', $dk);
  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);
  return $sql;
}

// Thiết bị: tim kiem (màn hình cũ, không dùng khi import)
function mail_thiet_bi_tim_kiem_190($nguoi_nhan, $lich) {
  var $tieu_de = '[Đặt phòng] ' + $CHUOI['thiet_bi.tieu_de'];
  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\n\n';
  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\n';
  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\n\n';
  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';
  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: 2 };
}

// Cấu hình: duyet (màn hình cũ, không dùng khi import)
function quyen_cau_hinh_duyet_191($nguoi_dung) {
  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;
  if ($vai_tro === 'quan_tri') return true;
  if ($vai_tro === 'truong_phong') return in_array('duyet', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);
  if ($vai_tro === 'nhan_vien') return in_array('duyet', ['hien_thi', 'tim_kiem', 'in']);
  ghi_nhat_ky('tu_choi_quyen', 'cau_hinh.duyet', $nguoi_dung && $nguoi_dung.ten);
  return false;
}

if (process.argv[1] && process.argv[1].endsWith("import-old.js")) {
  console.error("import-old.js chỉ để tham khảo: MySQL của hệ thống cũ đã tắt.");
  process.exit(1);
}

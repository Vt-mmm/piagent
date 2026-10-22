// Builds project/legacy/import-old.js: the old booking system's import script,
// ported long ago from PHP to JavaScript and kept "PHP style". The rules the
// new importer must follow are spread through it, between a lot of code that
// no longer matters (screens, e-mails, reports, permissions, strings).

const MODULES = ['lich_tuan', 'lich_thang', 'phong', 'nguoi_dung', 'bao_cao', 'thong_bao', 'duyet', 'thiet_bi', 'khach', 'cau_hinh', 'nhat_ky', 'xuat_file'];
const ACTIONS = ['hien_thi', 'luu', 'xoa', 'duyet', 'tim_kiem', 'xuat', 'in', 'gui_mail'];
const LABELS = ['Lịch tuần', 'Lịch tháng', 'Danh mục phòng', 'Người dùng', 'Báo cáo', 'Thông báo', 'Duyệt lịch', 'Thiết bị', 'Khách mời', 'Cấu hình', 'Nhật ký', 'Xuất file'];
const AUTHORS = ['anh.tq', 'hung.nv', 'thu.lt', 'kiet.pd', 'ngoc.bh', 'vy.tt'];
const CHANGES = ['sửa lỗi hiển thị lịch tuần trên IE8', 'thêm cột ghi chú cho phòng', 'tối ưu truy vấn báo cáo tháng', 'đổi mẫu email nhắc lịch', 'thêm quyền duyệt cho trưởng phòng',
  'sửa lỗi font tiếng Việt khi xuất Excel', 'bỏ tính năng đặt máy chiếu', 'thêm màn hình khách mời', 'sửa lỗi phân trang danh sách người dùng', 'cập nhật logo công ty',
  'thêm nhật ký thao tác', 'sửa lỗi gửi mail trùng', 'chuyển sang MySQL 5.5', 'thêm báo cáo tần suất sử dụng phòng', 'sửa lỗi tràn bộ nhớ khi xuất file lớn'];

export function oldScript({ ROOMS, ALIASES, rnd, pick }) {
  const out = [];
  const L = (...lines) => out.push(...lines);
  const pad = n => String(n).padStart(2, '0');

  // ---------------------------------------------------------------- header
  L('/* ==========================================================================',
    ' * HỆ THỐNG ĐẶT PHÒNG HỌP v3 (bản cũ) — import-old.js',
    ' * Chuyển từ import_lich.php (2013) sang JavaScript năm 2017, giữ nguyên',
    ' * cách viết cũ cho dễ đối chiếu. Đọc file xuất CSV của hệ thống cũ và ghi',
    ' * vào MySQL. KHÔNG còn chạy được: MySQL cũ đã tắt năm 2026.',
    ' *',
    ' * Lịch sử thay đổi:');
  let y = 2013, m = 3;
  const special = {
    9: ' *   2014-??-?? hung.nv: file xuất có BOM UTF-8 (Excel), bỏ BOM trước khi đọc dòng tiêu đề',
    23: ' *   2015-??-?? thu.lt: chấp nhận ngày dạng yyyy-mm-dd (file từ chi nhánh HCM)',
    41: ' *   2016-??-?? anh.tq: giờ kết thúc 24:00 = nửa đêm hôm sau (sự kiện tối ở hội trường)',
    58: ' *   2017-??-?? kiet.pd: chuyển sang JavaScript, giờ đọc theo giờ Việt Nam (+07:00)',
    77: ' *   2018-??-?? ngoc.bh: tiêu đề lưu dạng HTML-escape từ form cũ, phải giải mã khi import',
    96: ' *   2019-??-?? vy.tt: mã phòng cũ có nhiều cách viết (P.101, p101, HT-A...), xem chuan_hoa_ma_phong',
    118: ' *   2021-??-?? anh.tq: phòng P999 (kho cũ) ngừng sử dụng, mọi lịch của nó coi là lỗi',
  };
  for (let i = 0; i < 140; i++) {
    m += 1 + Math.floor(rnd() * 2); if (m > 12) { m -= 12; y++; }
    L(special[i]?.replace('??-??', `${pad(m)}-${pad(1 + Math.floor(rnd() * 27))}`) ?? ` *   ${y}-${pad(m)}-${pad(1 + Math.floor(rnd() * 27))} ${pick(AUTHORS)}: ${pick(CHANGES)}`);
  }
  L(' * ========================================================================== */', '', "'use strict';", '');

  // ---------------------------------------------------------------- PHP shims
  L('// ---------------------------------------------------------------------------',
    '// Hàm thay thế cho các hàm PHP cũ',
    '// ---------------------------------------------------------------------------',
    'var $CAU_HINH = { mui_gio: "Asia/Ho_Chi_Minh", lech_gio: 7, csdl: "mysql://datphong:***@10.0.3.12/datphong", thu_muc_log: "/var/log/datphong" };',
    'var $LECH_GIO = $CAU_HINH.lech_gio; // giờ Việt Nam, không có giờ mùa hè',
    '',
    'function date_default_timezone_set($tz) { $CAU_HINH.mui_gio = $tz; }',
    'date_default_timezone_set("Asia/Ho_Chi_Minh");',
    '',
    'function trim($s) { return $s === null || $s === undefined ? "" : String($s).replace(/^[\\s\\u00a0]+|[\\s\\u00a0]+$/g, ""); }',
    'function strtoupper($s) { return String($s).toUpperCase(); }',
    'function strtolower($s) { return String($s).toLowerCase(); }',
    'function str_pad_trai($s, $n, $c) { $s = String($s); while ($s.length < $n) $s = $c + $s; return $s; }',
    'function isset($v) { return $v !== undefined && $v !== null; }',
    'function empty_($v) { return !isset($v) || $v === "" || $v === 0 || $v === "0"; }',
    'function in_array($v, $a) { return $a.indexOf($v) >= 0; }',
    'function count($a) { return $a ? $a.length : 0; }',
    'function implode($sep, $a) { return $a.join($sep); }',
    'function explode($sep, $s) { return String($s).split($sep); }',
    'function intval($s) { var $n = parseInt($s, 10); return isNaN($n) ? 0 : $n; }',
    '',
    '// checkdate(tháng, ngày, năm) như PHP',
    'function checkdate($thang, $ngay, $nam) {',
    '  if ($thang < 1 || $thang > 12 || $ngay < 1) return false;',
    '  var $so_ngay = [31, ($nam % 4 === 0 && ($nam % 100 !== 0 || $nam % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];',
    '  return $ngay <= $so_ngay[$thang - 1];',
    '}',
    '',
    'function mysql_connect() { throw new Error("MySQL cũ đã tắt (2026). Script này chỉ để tham khảo."); }',
    'function mysql_query($sql) { throw new Error("MySQL cũ đã tắt (2026): " + String($sql).slice(0, 60)); }',
    'function mysql_real_escape_string($s) { return String($s).replace(/[\\\\\'"]/g, "\\\\$&"); }',
    'function ghi_file_log($ten, $dong) { /* ghi vào $CAU_HINH.thu_muc_log, đã bỏ */ }',
    '');

  // ---------------------------------------------------------------- strings
  L('// ---------------------------------------------------------------------------',
    '// Chuỗi giao diện (bản tiếng Việt). Phần lớn không còn dùng trong import.',
    '// ---------------------------------------------------------------------------',
    'var $CHUOI = {');
  const words = ['tieu_de', 'nut_luu', 'nut_huy', 'nut_xoa', 'thong_bao_thanh_cong', 'thong_bao_loi', 'xac_nhan_xoa', 'khong_co_du_lieu', 'dang_tai', 'tim_kiem', 'loc', 'xuat_excel', 'in_trang', 'trang_truoc', 'trang_sau', 'tong_so'];
  const texts = ['Tiêu đề', 'Lưu', 'Huỷ bỏ', 'Xoá', 'Đã lưu thành công', 'Có lỗi xảy ra, vui lòng thử lại', 'Bạn có chắc muốn xoá?', 'Không có dữ liệu', 'Đang tải...', 'Tìm kiếm', 'Lọc', 'Xuất Excel', 'In trang', 'Trang trước', 'Trang sau', 'Tổng số'];
  MODULES.forEach((mod, i) => words.forEach((w, j) => L(`  '${mod}.${w}': '${texts[j]}${j === 0 ? ' - ' + LABELS[i] : ''}',`)));
  L('  _: null', '};', '');

  // ---------------------------------------------------------------- filler generators
  let serial = 0;
  const filler = (count) => {
    for (let n = 0; n < count; n++) {
      const k = serial++;
      const mi = Math.floor(rnd() * MODULES.length), mod = MODULES[mi], act = pick(ACTIONS), fn = `${mod}_${act}_${k}`;
      const kind = k % 4;
      L(`// ${LABELS[mi]}: ${act.replace(/_/g, ' ')} (màn hình cũ, không dùng khi import)`);
      if (kind === 0) {
        L(`function ve_${fn}($du_lieu, $nguoi_dung) {`,
          `  var $html = '<table class="bang-${mod}">';`,
          `  $html += '<tr><th>' + $CHUOI['${mod}.tieu_de'] + '</th><th>' + $CHUOI['${mod}.tong_so'] + '</th></tr>';`,
          `  for (var $i = 0; $i < count($du_lieu); $i++) {`,
          `    var $dong = $du_lieu[$i];`,
          `    if (!kiem_tra_quyen($nguoi_dung, '${mod}', '${act}')) continue;`,
          `    $html += '<tr class="' + ($i % 2 ? 'le' : 'chan') + '">';`,
          `    $html += '<td>' + htmlspecialchars($dong.ten) + '</td>';`,
          `    $html += '<td class="so">' + intval($dong.so_luong) + '</td>';`,
          `    $html += '</tr>';`,
          `  }`,
          `  if (!count($du_lieu)) $html += '<tr><td colspan="2">' + $CHUOI['${mod}.khong_co_du_lieu'] + '</td></tr>';`,
          `  return $html + '</table>';`,
          `}`, '');
      } else if (kind === 1) {
        L(`function sql_${fn}($loc) {`,
          `  var $dk = ['1 = 1'];`,
          `  if (isset($loc.tu_ngay)) $dk.push("ngay >= '" + mysql_real_escape_string($loc.tu_ngay) + "'");`,
          `  if (isset($loc.den_ngay)) $dk.push("ngay <= '" + mysql_real_escape_string($loc.den_ngay) + "'");`,
          `  if (isset($loc.ma_phong)) $dk.push("ma_phong = '" + mysql_real_escape_string($loc.ma_phong) + "'");`,
          `  if (isset($loc.nguoi_dat)) $dk.push("nguoi_dat LIKE '%" + mysql_real_escape_string($loc.nguoi_dat) + "%'");`,
          `  var $sql = 'SELECT * FROM ${mod} WHERE ' + implode(' AND ', $dk);`,
          `  $sql += ' ORDER BY ngay DESC, gio_bd ASC LIMIT ' + intval($loc.so_dong || 50) + ' OFFSET ' + intval($loc.vi_tri || 0);`,
          `  return $sql;`,
          `}`, '');
      } else if (kind === 2) {
        L(`function mail_${fn}($nguoi_nhan, $lich) {`,
          `  var $tieu_de = '[Đặt phòng] ' + $CHUOI['${mod}.tieu_de'];`,
          `  var $noi_dung = 'Kính gửi ' + $nguoi_nhan + ',\\n\\n';`,
          `  $noi_dung += 'Lịch ' + $lich.tieu_de + ' tại ' + $lich.ten_phong + ' đã được cập nhật.\\n';`,
          `  $noi_dung += 'Thời gian: ' + $lich.ngay + ' ' + $lich.gio_bd + ' - ' + $lich.gio_kt + '\\n\\n';`,
          `  $noi_dung += 'Đây là email tự động, vui lòng không trả lời.';`,
          `  return { den: $nguoi_nhan + '@congty.vn', tieu_de: $tieu_de, noi_dung: $noi_dung, uu_tien: ${1 + (k % 3)} };`,
          `}`, '');
      } else {
        L(`function quyen_${fn}($nguoi_dung) {`,
          `  var $vai_tro = $nguoi_dung && $nguoi_dung.vai_tro;`,
          `  if ($vai_tro === 'quan_tri') return true;`,
          `  if ($vai_tro === 'truong_phong') return in_array('${act}', ['hien_thi', 'duyet', 'xuat', 'in', 'tim_kiem']);`,
          `  if ($vai_tro === 'nhan_vien') return in_array('${act}', ['hien_thi', 'tim_kiem', 'in']);`,
          `  ghi_nhat_ky('tu_choi_quyen', '${mod}.${act}', $nguoi_dung && $nguoi_dung.ten);`,
          `  return false;`,
          `}`, '');
      }
    }
  };
  L('function htmlspecialchars($s) { return String($s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\'/g, "&#39;"); }',
    'function kiem_tra_quyen($nguoi_dung, $mo_dun, $hanh_dong) { return !!$nguoi_dung; }',
    'function ghi_nhat_ky($loai, $doi_tuong, $ai) { ghi_file_log("nhat_ky", [new Date().toISOString(), $loai, $doi_tuong, $ai].join("\\t")); }',
    '');
  filler(32);

  // ---------------------------------------------------------------- room catalogue
  L('// ---------------------------------------------------------------------------',
    '// DANH MỤC PHÒNG (bảng dm_phong). Mã phòng là khoá; ten là tên hiển thị,',
    '// suc_chua là số chỗ. ngung = true: phòng đã ngừng sử dụng, lịch của nó là lỗi.',
    '// ---------------------------------------------------------------------------',
    'var $DM_PHONG = {');
  for (const [code, [ten, suc]] of Object.entries(ROOMS)) L(`  '${code}': { ten: '${ten}', suc_chua: ${suc}, tang: ${code.startsWith('P') ? code.charAt(1) : 1}, may_chieu: ${suc >= 8} },`);
  L("  'P999': { ten: 'Kho cũ', suc_chua: 0, tang: 9, may_chieu: false, ngung: true },", '};', '');
  L('// KHÔNG DÙNG NỮA (2019): bản cũ chỉ cắt khoảng trắng, không hiểu bí danh.',
    '// Đã thay bằng chuan_hoa_ma_phong() ở phần xử lý dòng.',
    'function chuan_hoa_ma_phong_v1($ma) {',
    '  $ma = trim($ma);',
    '  return isset($DM_PHONG[$ma]) ? $ma : null;',
    '}', '');
  filler(22);

  // ---------------------------------------------------------------- aliases + normalisation
  L('// ---------------------------------------------------------------------------',
    '// Mã phòng trong file xuất được gõ tay nhiều kiểu: "P.101", " p101 ",',
    '// "HT-A", "Hoi truong A"... Quy tắc (từ 2019):',
    '//   1. cắt khoảng trắng hai đầu, viết hoa, gộp khoảng trắng liên tiếp',
    '//   2. nếu là bí danh trong $BI_DANH_PHONG thì đổi sang mã chuẩn',
    '//   3. bỏ mọi dấu chấm, gạch ngang và khoảng trắng',
    '//   4. phải có trong $DM_PHONG và chưa ngừng sử dụng, nếu không là lỗi phòng',
    '// ---------------------------------------------------------------------------',
    'var $BI_DANH_PHONG = {');
  for (const [a, c] of Object.entries(ALIASES)) L(`  '${a}': '${c}',`);
  L('};', '',
    'function chuan_hoa_ma_phong($ma) {',
    '  $ma = strtoupper(trim($ma)).replace(/\\s+/g, " ");',
    '  if (isset($BI_DANH_PHONG[$ma])) $ma = $BI_DANH_PHONG[$ma];',
    '  $ma = $ma.replace(/[.\\- ]/g, "");',
    '  var $phong = $DM_PHONG[$ma];',
    '  if (!$phong || $phong.ngung) return null;',
    '  return $ma;',
    '}', '');
  filler(24);

  // ---------------------------------------------------------------- dates and times
  L('// ---------------------------------------------------------------------------',
    '// NGÀY: "dd/mm/yyyy" (ngày, tháng có thể 1 chữ số) hoặc "yyyy-mm-dd" (file',
    '// chi nhánh HCM). Ngày không có thật (31/02...) là lỗi thời gian.',
    '// Trả về [năm, tháng, ngày] hoặc null.',
    '// ---------------------------------------------------------------------------',
    'function doc_ngay($s) {',
    '  $s = trim($s);',
    '  var $m = /^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})$/.exec($s), $nam, $thang, $ngay;',
    '  if ($m) { $ngay = intval($m[1]); $thang = intval($m[2]); $nam = intval($m[3]); }',
    '  else if (($m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec($s))) { $nam = intval($m[1]); $thang = intval($m[2]); $ngay = intval($m[3]); }',
    '  else return null;',
    '  if (!checkdate($thang, $ngay, $nam)) return null;',
    '  return [$nam, $thang, $ngay];',
    '}', '',
    '// GIỜ: "HH:MM", "H:MM", "HH:MM:SS" (giây phải là 00), "9h30", "9h".',
    '// "24:00" chỉ hợp lệ cho giờ kết thúc và nghĩa là 00:00 ngày hôm sau.',
    '// Trả về số phút tính từ 00:00 của ngày đặt lịch, hoặc null.',
    'function doc_gio($s, $la_gio_ket_thuc) {',
    '  $s = strtolower(trim($s));',
    '  var $m = /^(\\d{1,2})(?::(\\d{2})(?::(\\d{2}))?|h(\\d{2})?)$/.exec($s);',
    '  if (!$m) return null;',
    '  var $gio = intval($m[1]), $phut = intval($m[2] || $m[4] || "0"), $giay = intval($m[3] || "0");',
    '  if ($giay !== 0 || $phut > 59) return null;',
    '  if ($gio === 24 && $phut === 0 && $la_gio_ket_thuc) return 24 * 60;',
    '  if ($gio > 23) return null;',
    '  return $gio * 60 + $phut;',
    '}', '',
    '// Ngày + số phút (giờ Việt Nam) -> thời điểm tuyệt đối.',
    'function thoi_diem($ngay, $phut) {',
    '  return new Date(Date.UTC($ngay[0], $ngay[1] - 1, $ngay[2], 0, $phut) - $LECH_GIO * 3600 * 1000);',
    '}', '');
  filler(26);

  // ---------------------------------------------------------------- statuses
  L('// ---------------------------------------------------------------------------',
    '// TRẠNG THÁI. Rỗng, OK, XAC_NHAN, DA_DUYET: lịch đang hiệu lực.',
    '// HUY, DA_HUY, CANCEL: lịch đã huỷ; thời điểm huỷ lấy ở cột ngay_huy',
    '// ("dd/mm/yyyy HH:MM", giờ Việt Nam), nếu trống thì lấy giờ bắt đầu lịch.',
    '// ---------------------------------------------------------------------------',
    'var $TRANG_THAI = {',
    "  '': 'hieu_luc', 'OK': 'hieu_luc', 'XAC_NHAN': 'hieu_luc', 'DA_DUYET': 'hieu_luc',",
    "  'HUY': 'da_huy', 'DA_HUY': 'da_huy', 'CANCEL': 'da_huy'",
    '};', '',
    'function doc_thoi_diem_huy($s, $mac_dinh) {',
    '  var $phan = trim($s).split(/\\s+/);',
    '  if (count($phan) !== 2) return $mac_dinh;',
    '  var $ngay = doc_ngay($phan[0]), $phut = doc_gio($phan[1], false);',
    '  if (!$ngay || $phut === null) return $mac_dinh;',
    '  return thoi_diem($ngay, $phut);',
    '}', '');
  filler(24);

  // ---------------------------------------------------------------- titles and people
  L('// ---------------------------------------------------------------------------',
    '// TIÊU ĐỀ: form cũ lưu dạng HTML-escape (&amp; &lt; &gt; &quot; &#39; &#NNN;),',
    '// phải giải mã. Tiêu đề rỗng thì dùng "(không tiêu đề)".',
    '// NGƯỜI ĐẶT: viết thường; nếu là email thì chỉ lấy phần trước @; rỗng thì',
    '// dùng "khong-ro".',
    '// ---------------------------------------------------------------------------',
    'function html_entity_decode($s) {',
    '  return String($s)',
    '    .replace(/&#(\\d+);/g, function ($_, $n) { return String.fromCharCode(intval($n)); })',
    '    .replace(/&#x([0-9a-f]+);/gi, function ($_, $n) { return String.fromCharCode(parseInt($n, 16)); })',
    '    .replace(/&quot;/g, \'"\').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");',
    '}', '',
    'function chuan_hoa_tieu_de($s) {',
    '  $s = trim(html_entity_decode(trim($s)));',
    '  return $s === "" ? "(không tiêu đề)" : $s;',
    '}', '',
    'function chuan_hoa_nguoi_dat($s) {',
    '  $s = strtolower(trim($s));',
    '  if ($s.indexOf("@") >= 0) $s = explode("@", $s)[0];',
    '  return $s === "" ? "khong-ro" : $s;',
    '}', '');
  filler(26);

  // ---------------------------------------------------------------- CSV + main loop
  L('// ---------------------------------------------------------------------------',
    '// ĐỌC FILE XUẤT: UTF-8 có BOM, xuống dòng CRLF, phân cách ";", trường có ";"',
    '// hoặc dấu nháy kép được bọc trong "..." và nháy kép bên trong viết thành "".',
    '// Dòng 1 là tiêu đề cột. Không có xuống dòng bên trong một trường.',
    '// ---------------------------------------------------------------------------',
    "var $COT = ['ma_dat', 'ma_phong', 'ngay', 'gio_bd', 'gio_kt', 'tieu_de', 'nguoi_dat', 'trang_thai', 'ngay_huy'];", '',
    'function tach_dong($dong) {',
    '  var $truong = [], $hien_tai = "", $trong_nhay = false;',
    '  for (var $i = 0; $i < $dong.length; $i++) {',
    '    var $c = $dong.charAt($i);',
    '    if ($trong_nhay) {',
    '      if ($c === \'"\' && $dong.charAt($i + 1) === \'"\') { $hien_tai += \'"\'; $i++; }',
    '      else if ($c === \'"\') $trong_nhay = false;',
    '      else $hien_tai += $c;',
    '    } else if ($c === \'"\') $trong_nhay = true;',
    '    else if ($c === ";") { $truong.push($hien_tai); $hien_tai = ""; }',
    '    else $hien_tai += $c;',
    '  }',
    '  $truong.push($hien_tai);',
    '  return $truong;',
    '}', '',
    '// Một dòng -> bản ghi lịch, hoặc { loi: "LOI_PHONG" | "LOI_THOI_GIAN" }.',
    '// Thứ tự kiểm tra: phòng, ngày, giờ bắt đầu, giờ kết thúc, kết thúc > bắt đầu.',
    'function xu_ly_dong($o) {',
    '  var $ma_phong = chuan_hoa_ma_phong($o.ma_phong);',
    '  if (!$ma_phong) return { loi: "LOI_PHONG" };',
    '  var $ngay = doc_ngay($o.ngay);',
    '  if (!$ngay) return { loi: "LOI_THOI_GIAN" };',
    '  var $bd = doc_gio($o.gio_bd, false), $kt = doc_gio($o.gio_kt, true);',
    '  if ($bd === null || $kt === null || $kt <= $bd) return { loi: "LOI_THOI_GIAN" };',
    '  var $bat_dau = thoi_diem($ngay, $bd), $ket_thuc = thoi_diem($ngay, $kt);',
    '  var $trang_thai = $TRANG_THAI[strtoupper(trim($o.trang_thai))] || "hieu_luc";',
    '  return {',
    '    ma_dat: trim($o.ma_dat),',
    '    ma_phong: $ma_phong,',
    '    ten_phong: $DM_PHONG[$ma_phong].ten,',
    '    bat_dau: $bat_dau,',
    '    ket_thuc: $ket_thuc,',
    '    tieu_de: chuan_hoa_tieu_de($o.tieu_de),',
    '    nguoi_dat: chuan_hoa_nguoi_dat($o.nguoi_dat),',
    '    da_huy: $trang_thai === "da_huy",',
    '    thoi_diem_huy: $trang_thai === "da_huy" ? doc_thoi_diem_huy($o.ngay_huy, $bat_dau) : null',
    '  };',
    '}', '');
  filler(20);
  L('// ---------------------------------------------------------------------------',
    '// CHẠY IMPORT (bản cũ). Hệ thống cũ KHÔNG kiểm tra trùng giờ khi import nên',
    '// dữ liệu xuất ra có những lịch chồng nhau trong cùng phòng.',
    '// ---------------------------------------------------------------------------',
    'function import_lich($noi_dung) {',
    '  if ($noi_dung.charCodeAt(0) === 0xFEFF) $noi_dung = $noi_dung.slice(1);',
    '  var $dong = $noi_dung.split(/\\r?\\n/);',
    '  if (trim($dong[0]) !== implode(";", $COT)) throw new Error("Sai dòng tiêu đề");',
    '  var $ket_qua = { tong: 0, da_ghi: 0, loi: [] };',
    '  mysql_connect();',
    '  for (var $i = 1; $i < count($dong); $i++) {',
    '    if (trim($dong[$i]) === "") continue;',
    '    $ket_qua.tong++;',
    '    var $gia_tri = tach_dong($dong[$i]), $o = {};',
    '    for (var $j = 0; $j < count($COT); $j++) $o[$COT[$j]] = $gia_tri[$j] === undefined ? "" : $gia_tri[$j];',
    '    var $lich = xu_ly_dong($o);',
    '    if ($lich.loi) { $ket_qua.loi.push({ dong: $i + 1, ma_dat: trim($o.ma_dat), loi: $lich.loi }); continue; }',
    '    mysql_query("INSERT INTO lich (ma_dat, ma_phong, bat_dau, ket_thuc, tieu_de, nguoi_dat, da_huy, thoi_diem_huy) VALUES (\'" +',
    '      [$lich.ma_dat, $lich.ma_phong, $lich.bat_dau.toISOString(), $lich.ket_thuc.toISOString(), mysql_real_escape_string($lich.tieu_de),',
    '       $lich.nguoi_dat, $lich.da_huy ? 1 : 0, $lich.thoi_diem_huy ? $lich.thoi_diem_huy.toISOString() : ""].join("\',\'") + "\')");',
    '    $ket_qua.da_ghi++;',
    '  }',
    '  return $ket_qua;',
    '}', '');
  filler(18);
  L('if (process.argv[1] && process.argv[1].endsWith("import-old.js")) {',
    '  console.error("import-old.js chỉ để tham khảo: MySQL của hệ thống cũ đã tắt.");',
    '  process.exit(1);',
    '}', '');
  return out.join('\n');
}

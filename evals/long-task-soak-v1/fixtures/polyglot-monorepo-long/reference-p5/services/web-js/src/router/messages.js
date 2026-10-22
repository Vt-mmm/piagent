// Error messages (vi default, en when Accept-Language starts with "en").
export const MESSAGES = {
  vi: {
    not_found: 'Không tìm thấy đường dẫn {0}',
    method_not_allowed: 'Phương thức {0} không được hỗ trợ cho {1}',
    product_not_found: 'Không có sản phẩm {0}',
    bad_page: 'Tham số page không hợp lệ',
    bad_category: 'Danh mục không tồn tại: {0}',
    bad_sort: 'Kiểu sắp xếp không hỗ trợ: {0}',
    bad_body: 'Body phải là JSON object',
    empty_cart: 'Giỏ hàng trống',
    too_many_lines: 'Giỏ hàng tối đa {0} dòng',
    bad_qty: 'Số lượng dòng {0} không hợp lệ',
    inactive_product: 'Sản phẩm {0} đã ngừng bán',
    out_of_stock: 'Sản phẩm {0} chỉ còn {1}',
    bad_province: 'Mã tỉnh không hợp lệ: {0}',
    bad_weight: 'Khối lượng không hợp lệ: {0}',
    bad_currency: 'Tiền tệ không hỗ trợ: {0}',
    promo_unknown: 'Mã giảm giá không tồn tại',
    promo_expired: 'Mã giảm giá đã hết hạn',
    promo_min: 'Đơn tối thiểu {0} để dùng mã này',
    promo_category: 'Mã chỉ áp dụng cho danh mục {0}',
    bad_date: 'Ngày không hợp lệ: {0}',
    bad_range: 'Khoảng ngày không hợp lệ',
    bad_group: 'Kiểu gom nhóm không hỗ trợ: {0}',
    bad_format: 'Định dạng không hỗ trợ: {0}',
    bad_n: 'n phải từ 1 đến 50',
    bad_threshold: 'threshold phải là số nguyên không âm',
    query_too_short: 'Từ khóa quá ngắn',
    bad_account: 'Mã account không hợp lệ: {0}',
    note_required: 'Nội dung ghi chú là bắt buộc',
    note_too_long: 'Ghi chú tối đa {0} ký tự',
    bad_tags: 'tags phải là mảng chuỗi'
  },
  en: {
    not_found: 'No route for {0}',
    method_not_allowed: 'Method {0} is not allowed on {1}',
    product_not_found: 'No product {0}',
    bad_page: 'Invalid page parameter',
    bad_category: 'Unknown category: {0}',
    bad_sort: 'Unsupported sort: {0}',
    bad_body: 'Body must be a JSON object',
    empty_cart: 'Cart is empty',
    too_many_lines: 'A cart holds at most {0} lines',
    bad_qty: 'Invalid quantity on line {0}',
    inactive_product: 'Product {0} is discontinued',
    out_of_stock: 'Only {1} left of {0}',
    bad_province: 'Invalid province code: {0}',
    bad_weight: 'Invalid weight: {0}',
    bad_currency: 'Unsupported currency: {0}',
    promo_unknown: 'Unknown promo code',
    promo_expired: 'Promo code has expired',
    promo_min: 'Minimum order {0} for this code',
    promo_category: 'Code only applies to category {0}',
    bad_date: 'Invalid date: {0}',
    bad_range: 'Invalid date range',
    bad_group: 'Unsupported grouping: {0}',
    bad_format: 'Unsupported format: {0}',
    bad_n: 'n must be between 1 and 50',
    bad_threshold: 'threshold must be a non-negative integer',
    query_too_short: 'Query is too short',
    bad_account: 'Invalid account id: {0}',
    note_required: 'Note text is required',
    note_too_long: 'A note holds at most {0} characters',
    bad_tags: 'tags must be an array of strings'
  }
};

export function msg(lang, key, args = []) {
  const table = MESSAGES[lang] || MESSAGES.vi;
  let text = table[key] || key;
  args.forEach((arg, i) => { text = text.split(`{${i}}`).join(String(arg)); });
  return text;
}

// Only the exact lower-case or Title-Case header is read (legacy behaviour).
export function pickLang(headers) {
  if (!headers) return 'vi';
  const value = String(headers['accept-language'] || headers['Accept-Language'] || '').toLowerCase();
  return value.indexOf('en') === 0 ? 'en' : 'vi';
}

# TODO: đổi domain "customer" → "account" (release 2.0.0)

Bối cảnh: business đã chốt từ nay gọi khách hàng là **account** (một account
có thể là cá nhân hoặc doanh nghiệp). Mình đổi tên toàn bộ monorepo luôn trong
release này, đồng thời bump JSON contract lên **v2**. Các team khác vẫn còn gửi
payload v1 (có `customer_id`) trong một version nữa, nên reader phải đọc được
cả v1 qua một compat shim riêng.

Quy tắc chung:

- Đổi **mọi** identifier, tên file, key JSON, env var, URL path, text trong docs
  và test: `customer` → `account`, `Customer` → `Account`, `CUSTOMER` →
  `ACCOUNT`, `customers` → `accounts` (ví dụ `customer_id` → `account_id`,
  `customer_tier` → `account_tier`, `CUSTOMER_API_URL` → `ACCOUNT_API_URL`,
  `/customers/{id}/quotes` → `/accounts/{id}/quotes`).
- Sau khi xong, chữ "customer" (mọi kiểu hoa/thường, cả trong tên file) chỉ
  còn được xuất hiện ở: `CHANGELOG.md`, `TODO.md` này, và các file có chữ
  `compat` trong tên (compat shim, test của shim, sample payload v1).
- Không thêm dependency (Python chỉ stdlib, Node không có package ngoài).
- Không đổi hành vi nào khác ngoài những gì ghi dưới đây.

## Checklist

- [ ] 1. `shared/contracts/order.schema.json`: bump `x-contract-version` lên `2`,
      `properties.contract_version.const` = `2`, đổi `customer_id`/`customer_tier`
      → `account_id`/`account_tier` (cả trong `required`), `$id` đổi thành
      `https://contracts.shopflow.test/order/v2`.
- [ ] 2. `shared/contracts/fixtures/`: các sample hiện có chuyển sang payload v2
      (`contract_version: 2`, `account_id`, `account_tier`). Thêm
      `order-compat-v1.json`: một payload v1 hợp lệ (copy từ `order-basic.json` cũ)
      để test compat.
- [ ] 3. `pricing-py`: `pricing/customer.py` → `pricing/account.py` với
      `Account(account_id, name, tier)`, `ACCOUNT_TIERS`, `account_discount_rate(tier)`,
      `load_accounts(path)`; `fixtures/customers.json` → `fixtures/accounts.json`
      (key ngoài cùng `"accounts"`, mỗi dòng có `account_id`).
- [ ] 4. `pricing-py`: `Order` có field `account_id`, `account_tier` và field mới
      `source_version` (int: version của payload đã đọc, `1` hoặc `2`).
      `Order.to_dict()` luôn ghi payload **v2** (key theo thứ tự `contract_version`,
      `order_id`, `account_id`, `account_tier`, `currency`, `items`; không có
      `source_version`). `quote(order)` trả `account_id` thay cho `customer_id`.
- [ ] 5. `pricing-py`: compat shim `pricing/compat_v1.py` với
      `upgrade_v1(data) -> dict`: nhận payload v1 (có `contract_version: 1` hoặc
      không có key này), trả về dict v2 mới (không sửa dict đầu vào),
      `customer_id` → `account_id`, `customer_tier` → `account_tier`, các key khác giữ nguyên.
- [ ] 6. `pricing-py`: `parse_order(data)` theo luật đọc ở mục "Luật đọc contract"
      bên dưới; payload v1 đi qua `upgrade_v1` và phát `DeprecationWarning`
      (`warnings.warn(..., DeprecationWarning)`); v2 không phát warning.
- [ ] 7. `pricing-py`: `pricing/__init__.py` export `Account`, `ACCOUNT_TIERS`,
      `account_discount_rate`, `load_accounts`, `upgrade_v1`, `ContractError`,
      `Order`, `parse_order`, `quote`; bump `__version__` = `"2.0.0"`.
- [ ] 8. `pricing-py`: đổi tên/cập nhật test (`tests/test_customer.py` →
      `tests/test_account.py`, ...) và thêm `tests/test_compat_v1.py` cho shim + đọc v1.
- [ ] 9. `web-js`: `src/customer.js` → `src/account.js` với
      `normalizeAccount(raw)` → `{ accountId, name, tier }` và `accountLabel(account)`;
      `src/index.js` re-export đúng tên mới (bỏ tên cũ).
- [ ] 10. `web-js`: compat shim `src/compat-v1.js` export `upgradeV1(data)` (cùng
      luật với `upgrade_v1`). `parseOrder(data)` theo "Luật đọc contract", trả
      `{ orderId, accountId, accountTier, currency, items, sourceVersion }`;
      `toWire(order)` luôn ghi v2 (cùng thứ tự key như mục 4). Export thêm
      `upgradeV1` từ `src/index.js`.
- [ ] 11. `web-js`: `buildQuoteRequest(order, env)` dùng `env.ACCOUNT_API_URL`
      (thiếu → throw `Error` có message chứa `ACCOUNT_API_URL`), URL
      `${ACCOUNT_API_URL}/accounts/${accountId}/quotes`. Đổi tên/cập nhật test,
      thêm `test/compat-v1.test.js`. `package.json` version `2.0.0`.
- [ ] 12. `scripts/release.sh` và `scripts/dev-env.sh`: dùng `ACCOUNT_API_URL`
      (không fallback về tên cũ), kiểm tra sample payload theo key mới
      (`order-compat-v1.json` được bỏ qua khi kiểm tra). Output dry-run:
      `release <version> contract_version=<n> account_api=<url>`.
- [ ] 13. `.env.example`, `README.md`, `docs/*`: đổi tên hết;
      `docs/customer-tiers.md` → `docs/account-tiers.md`; `docs/contract.md`
      mô tả v2 và luật đọc v1 (gọi là "legacy v1 payload", không viết tên field cũ).
- [ ] 14. `CHANGELOG.md`: thêm section `## [2.0.0] - <ngày>` ghi breaking change
      `customer_id` → `account_id` / `customer_tier` → `account_tier`, contract v2,
      env var mới, và rằng payload v1 còn được đọc đến hết 2.x (bỏ ở 3.0.0).
- [ ] 15. Chạy đủ: Python unittest, `npm test` trong `web-js`,
      `ACCOUNT_API_URL=http://localhost:8081 bash scripts/release.sh --dry-run`,
      và grep không còn "customer" ngoài các chỗ được phép. Tick hết checklist này.

## Luật đọc contract (Python `parse_order` và JS `parseOrder` giống nhau)

| Payload | Kết quả |
| --- | --- |
| `contract_version: 2`, có `account_id`, `account_tier` | đọc bình thường, `source_version`/`sourceVersion` = 2 |
| `contract_version: 1` hoặc không có `contract_version`, có `customer_id`, `customer_tier` | đi qua compat shim, đọc như v2, `source_version` = 1 |
| v2 nhưng có `customer_id` hoặc `customer_tier` | lỗi code `MIXED_FIELDS` |
| v1 nhưng có `account_id` hoặc `account_tier` | lỗi code `MIXED_FIELDS` |
| version khác (0, 3, `"2"`, ...) | lỗi code `UNSUPPORTED_VERSION` |
| thiếu/sai field (id rỗng, tier lạ, items rỗng, qty không phải số nguyên dương, ...) | lỗi code `INVALID` (như hiện tại) |

Lỗi: Python `ContractError` (subclass `ValueError`, có `.code`), JS `ContractError`
(subclass `Error`, có `.code`) — giữ nguyên class hiện có.

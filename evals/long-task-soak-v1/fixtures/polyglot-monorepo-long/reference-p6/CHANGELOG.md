# Changelog

Mọi thay đổi đáng kể của monorepo ghi ở đây. Format theo
[Keep a Changelog](https://keepachangelog.com/), version theo SemVer.
`pricing-py` và `web-js` luôn release cùng version.

## [3.0.0] - 2026-10-21

### Added
- `services/ledger-go` (Go, stdlib only): đọc file event order (JSON Lines), ghi sổ balance
  theo account và settlement currency; CLI `ledger <events.jsonl>`. Xem `docs/ledger.md`.
- Order contract v3 (`shared/contracts/order.v3.schema.json`): `settlement_currency`,
  `fx_rate_ppm`; `settlement_total` / `settlementTotal` / `SettlementTotal` tính chính xác
  (kể cả khi vượt 2^53). Writer ghi v3 chỉ khi order có quy đổi, còn lại vẫn ghi v2.
- Shared contract conformance (`shared/contracts/conformance/`) chạy ở cả Python, Node và Go,
  property-style tests có seed cho v1/v2/v3.
- `scripts/log_report.py`: báo cáo log production (top error signature, p95 theo endpoint,
  khung giờ sự cố); postmortem 14/10 trong `docs/incidents/2025-10-14.md`.
- `scripts/ci.sh`: chạy mọi test (Go qua Docker), release dry-run và log report.
- `web-js`: `quoteOrder`, `settlementTotal`, `adminRoute`.

### Changed
- Router storefront-admin tách từ `src/legacy/router-old.js` sang `src/router/` (module nhỏ,
  ESM, dữ liệu dạng JSON), hành vi giữ nguyên (golden test).
- `account_id` có khoảng trắng ở đầu/cuối bị từ chối với code `INVALID` ở cả ba service
  (mọi version payload).
- pricing-py: `currency` phải khớp `^[A-Z]{3}$` như schema (trước đây nhận `"US1"`).
- `scripts/release.sh` kiểm cả ledger-go version và sample v3; in contract version mới nhất.

### Deprecated
- Payload v1 vẫn được đọc trong 3.x (gia hạn tới 4.0.0).

## [2.0.0] - 2026-10-21

### Changed (breaking)
- Đổi domain "customer" thành "account" trong cả monorepo: `customer_id` → `account_id`,
  `customer_tier` → `account_tier`, `CUSTOMER_API_URL` → `ACCOUNT_API_URL`,
  `/customers/{id}/quotes` → `/accounts/{id}/quotes`.
- Order contract lên v2 (`contract_version: 2`); writer luôn ghi v2.

### Deprecated
- Payload v1 (`customer_id`, `customer_tier`) vẫn được đọc qua compat shim đến hết 2.x,
  sẽ bỏ ở 3.0.0.

## [1.4.0] - 2026-08-02

### Added
- `customer_tier = "vip"` được giảm 10%.
- `scripts/release.sh --dry-run`.

## [1.3.0] - 2026-06-18

### Changed
- `web-js` gọi Customer API qua `CUSTOMER_API_URL` thay vì hard-code host.

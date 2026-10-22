# Changelog

Mọi thay đổi đáng kể của monorepo ghi ở đây. Format theo
[Keep a Changelog](https://keepachangelog.com/), version theo SemVer.
`pricing-py` và `web-js` luôn release cùng version.

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

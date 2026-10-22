# Changelog

Mọi thay đổi đáng kể của monorepo ghi ở đây. Format theo
[Keep a Changelog](https://keepachangelog.com/), version theo SemVer.
`pricing-py` và `web-js` luôn release cùng version.

## [1.4.0] - 2026-08-02

### Added
- `customer_tier = "vip"` được giảm 10%.
- `scripts/release.sh --dry-run`.

## [1.3.0] - 2026-06-18

### Changed
- `web-js` gọi Customer API qua `CUSTOMER_API_URL` thay vì hard-code host.

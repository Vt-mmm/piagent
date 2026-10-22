# Onboarding

1. `cp .env.example .env` rồi `source scripts/dev-env.sh` để có `CUSTOMER_API_URL`.
2. Chạy test hai service (xem README gốc).
3. Trước khi release: `bash scripts/release.sh --dry-run`.

Thuật ngữ: *customer* là bên đặt order; *tier* là hạng của customer.

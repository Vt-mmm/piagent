# Spec 6 — `scripts/ci.sh`, docs, release 3.0.0

Trạng thái: **chưa giao** (bước cuối, sau spec 2–5).

## `scripts/ci.sh`

Một lệnh chạy mọi thứ, từ root repo: `bash scripts/ci.sh`. Chạy **hết** các bước
(một bước fail vẫn chạy tiếp), mỗi bước in đúng một dòng `ci: <bước> ok` hoặc
`ci: <bước> FAIL`, dòng cuối `ci: all ok` (exit 0) hoặc `ci: <n> failed` (exit 1).
Các bước, theo thứ tự và đúng tên:

| Bước | Chạy |
| --- | --- |
| `python` | unittest của `services/pricing-py` |
| `scripts` | unittest của `scripts/tests` |
| `node` | `node --test` của `services/web-js` |
| `go` | `go vet ./...` và `go test ./...` của `services/ledger-go` trong Docker `golang:1.26.3-alpine3.23` |
| `release` | `bash scripts/release.sh --dry-run` (nếu chưa có `ACCOUNT_API_URL` thì dùng `http://localhost:8081`) |
| `log-report` | `python3 scripts/log_report.py logs/prod-2025-10.log` chạy được và ra JSON |

Script không được phụ thuộc thư mục đang đứng, không cần network, không tạo tag.
Bước `go` phải chạy được cả khi repo không nằm trong thư mục Docker share (stream
repo vào container bằng `tar` là cách chắc nhất).

## Release 3.0.0

- Version `3.0.0` ở `pricing-py` (`__version__`), `web-js` (`package.json`) và
  ledger-go (`const Version = "3.0.0"` trong package `ledger`).
- `scripts/release.sh`: kiểm ba version bằng nhau; `contract_version` in ra là
  `x-contract-version` lớn nhất trong `shared/contracts/order*.schema.json`; sample
  `fixtures/*.json` (trừ `*compat*`) phải là v2 có `account_id`/`account_tier`,
  sample `fixtures/v3/*.json` phải là v3 có `settlement_currency` và `fx_rate_ppm`
  (sai thì release fail). Output dry-run:
  `release 3.0.0 contract_version=3 account_api=<url>`.
- Payload v1 vẫn được đọc ở 3.x (business đã gia hạn tới 4.0.0): ghi vào mục
  Deprecated.
- `CHANGELOG.md`: section `## [3.0.0] - <ngày>` ở trên 2.0.0, nhắc tới
  `ledger-go`, contract v3 (`settlement_currency`, `fx_rate_ppm`),
  `scripts/log_report.py`, router refactor (`src/router/`), `scripts/ci.sh`,
  và mọi yêu cầu được thêm giữa chừng trong quá trình làm.

## Docs

- `docs/ledger.md`: event format, các code reject, cách chạy CLI.
- `docs/contract.md`: thêm phần v3 và luật writer.
- `README.md`: bảng thư mục có `services/ledger-go/`, cách chạy `scripts/ci.sh`.

## Xong khi

`bash scripts/ci.sh` in `ci: all ok`; checklist các spec 2–6 đều đã làm.

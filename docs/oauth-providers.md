# OAuth providers trong Pi
<!-- language: vi; english-index: docs-site/content/en/mcp-auth.html -->

## Mục tiêu

Dùng provider/model được Pi hỗ trợ mà không đưa token hoặc local auth file vào repository.

## Setup

```bash
pi
/login
```

Chọn provider theo danh sách Pi hiển thị. Sau đó kiểm tra:

```text
/model
/model-options
```

Hoặc:

```bash
pi --list-models
```

## Credential boundary

Không đưa những file này vào source:

- `~/.pi/agent/auth.json`
- custom agent dir `auth.json`
- `.env`
- API keys
- session dumps có token

## Team usage

Mỗi dev login OAuth bằng account được công ty cho phép. Repo platform chỉ chứa:

- hướng dẫn login
- package source
- profile/policy
- template config không có secret

## CI/automation

Không dùng OAuth local cho CI. Nếu sau này cần headless automation, dùng secret manager riêng và policy riêng.

## Tài liệu chính

- Pi providers/OAuth: https://pi.dev/docs/latest/providers
- Pi settings/trust: https://pi.dev/docs/latest/settings

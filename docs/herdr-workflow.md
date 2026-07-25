# Herdr workflow

## Mục tiêu

Herdr dùng để quản lý nhiều session/pane agent. Pi core không cần tự làm subagent ngay từ đầu.

## Setup integration

`piagent-setup` đã chạy `herdr integration install pi` giùm, với điều kiện `herdr` có sẵn trên `PATH` lúc đó. Không có thì nó bỏ qua kèm cảnh báo ra stderr — nên thứ tự đúng là cài Herdr trước, rồi mới `piagent-setup`.

Cài Herdr sau khi đã setup thì chạy lại:

```bash
piagent-setup --global-only
```

Kiểm tra hoặc cài tay:

```bash
herdr integration status
herdr integration install pi
```

Nếu dùng custom Pi agent dir:

```bash
PI_CODING_AGENT_DIR=/path/to/pi-agent herdr integration install pi
```

## Daily flow

```bash
cd <project>
herdr
```

Lần đầu trong project, mở pane Pi rồi chạy:

```text
/login
<select provider/model>
/onboard-project
```

Sau khi `.pi/project-context.md` đã được ghi, mới chạy `/task` cho implementation.

Pane đề xuất:

```text
project
├─ pi-task          implement current task
├─ pi-review        read-only review
├─ pi-qa            verify/test
└─ pi-notes         decisions, handoff, and follow-up
```

## Rule

- Herdr là orchestrator terminal/session, không phải security boundary.
- Destructive/action gate vẫn nằm ở Pi extension/policy.
- OAuth vẫn login trong Pi.

## Nguồn

- Herdr install: https://herdr.dev/docs/install/
- Herdr integrations: https://herdr.dev/docs/integrations/
- Herdr workflow: https://herdr.dev/docs/how-to-work/
- Herdr CLI reference: https://herdr.dev/docs/cli-reference/

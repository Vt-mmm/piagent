# Herdr workflow

## Mục tiêu

Herdr dùng để quản lý nhiều session/pane agent. Pi core không cần tự làm subagent ngay từ đầu.

## Cài Herdr

```bash
brew install herdr                            # macOS
curl -fsSL https://herdr.dev/install.sh | sh  # macOS hoặc Linux
```

Bản `curl` là cách herdr.dev đặt làm mặc định, nhưng nó chạy script tải về ngay lúc cài. Muốn xem được thứ mình chạy thì dùng `brew`, hoặc tải binary từ [GitHub releases](https://github.com/ogulcancelik/herdr/releases) rồi `chmod +x` và đưa vào `PATH`.

Stable chỉ hỗ trợ macOS và Linux. Windows mới có bản preview, và cũng nằm ngoài runtime matrix của platform này.

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

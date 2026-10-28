# Herdr workflow
<!-- language: vi; english-index: docs-site/content/en/workflows.html -->

## Mục tiêu

Herdr dùng để quản lý nhiều session/pane agent. Pi core không cần tự làm subagent ngay từ đầu.

## Cài Herdr

```bash
brew install herdr                            # macOS
curl -fsSL https://herdr.dev/install.sh | sh  # macOS hoặc Linux
```

Bản `curl` là cách herdr.dev đặt làm mặc định, nhưng nó chạy script tải về ngay lúc cài. Muốn xem được thứ mình chạy thì dùng `brew`, hoặc tải binary từ [GitHub releases](https://github.com/ogulcancelik/herdr/releases) rồi `chmod +x` và đưa vào `PATH`.

**Windows:** cài Herdr **trong Ubuntu (WSL2)**, cùng chỗ với Piagent, không cài `herdr.exe` ngoài Windows. Chế độ công ty (`piagent studio`) chỉ chạy trong WSL2 ([Windows](vi/windows.md)), và Herdr phải dùng chung `$HOME` với Pi thì tích hợp mới cài vào đúng `~/.pi/agent`. Mở Windows Terminal với profile Ubuntu rồi chạy `herdr` trong đó. Herdr ngoài Windows chỉ thấy `wsl.exe`, không biết trạng thái agent và không mở lại được session.

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
/profile setup
```

rồi nhờ agent: "Đọc project này (chỉ đọc) và ghi lại project context." Sau khi `.pi/project-context.md` đã được ghi, mới giao việc implementation.

Pane đề xuất:

```text
project
├─ pi-task          implement current task
├─ pi-review        read-only review
├─ pi-qa            verify/test
└─ pi-notes         decisions, handoff, and follow-up
```

## Chế độ công ty trong Herdr

Mỗi pane chạy `piagent studio --project <project>`. Cuộc trò chuyện công ty không nạp extension cá nhân (gồm cả extension `herdr integration install pi` cài), nên Terminal công ty có reporter riêng: nó báo Herdr đang chạy / chờ bạn / rảnh, và gửi lệnh mở lại chính cuộc trò chuyện đó:

```bash
piagent studio --project <project> --session <file cuộc trò chuyện công ty>
```

Khi server Herdr khởi động lại (hay WSL bị tắt rồi mở lại), Herdr gõ lệnh này vào pane, nên cuộc trò chuyện công ty quay lại đúng chỗ thay vì mở bằng Pi cá nhân. `--session` chỉ nhận file trong kho cuộc trò chuyện công ty của bạn trên máy này. Cần Herdr 0.9.2 trở lên; Herdr cũ hơn vẫn hiện trạng thái nhưng không tự mở lại, khi đó chạy `piagent studio --project <project>` rồi `/resume`.

Cuộc trò chuyện cá nhân (`pi`) thì Herdr tự mở lại bằng tích hợp của nó.

## Rule

- Herdr là orchestrator terminal/session, không phải security boundary.
- Destructive/action gate vẫn nằm ở Pi extension/policy.
- OAuth vẫn login trong Pi.

## Nguồn

- Herdr install: https://herdr.dev/docs/install/
- Herdr integrations: https://herdr.dev/docs/integrations/
- Herdr workflow: https://herdr.dev/docs/how-to-work/
- Herdr CLI reference: https://herdr.dev/docs/cli-reference/

# Piagent trên Windows

[English](../en/windows.md)

Trên Windows, chạy Piagent trong **WSL2** (Ubuntu), cho cả cuộc trò chuyện công ty lẫn cá nhân:

| Chế độ | Chạy ở đâu | Cần gì |
|---|---|---|
| Công ty (model qua Agent Studio) | WSL2 | WSL2, bubblewrap, Agent Watch cho Windows |
| Cá nhân (tài khoản AI của bạn) | WSL2 (nên dùng), hoặc thẳng trên Windows ở dạng xem trước | WSL2; bản xem trước cần Node 24 và Git for Windows |

Chế độ công ty cần sandbox của hệ điều hành cho mọi lệnh agent chạy. Trên macOS đó là Seatbelt; trên Linux và WSL2 là bubblewrap. Windows chưa có sandbox tương đương dùng được cho agent, nên chế độ công ty chạy trong WSL2.

## Chế độ công ty trong WSL2

1. Cài WSL2 với Ubuntu (PowerShell): `wsl --install -d Ubuntu`.
2. Trong Ubuntu:

   ```bash
   sudo apt-get update && sudo apt-get install -y bubblewrap git ripgrep fd-find build-essential curl
   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . ~/.nvm/nvm.sh && nvm install 24
   npm install -g --ignore-scripts @piagent/platform
   piagent-update
   piagent --help
   ```

   `piagent --help` chạy một lần để Piagent ghi lại vị trí cài đặt cho Agent Watch.

3. Cài Agent Watch cho Windows (PowerShell), dán mã kết nối admin gửi, bấm **Kết nối**, rồi **Kết nối Piagent trong WSL**:

   ```powershell
   irm https://raw.githubusercontent.com/Vt-mmm/agentwatch/main/windows/install.ps1 | iex
   ```

   Hướng dẫn đầy đủ: [Agent Watch cho Windows](https://github.com/Vt-mmm/agentwatch/blob/main/windows/README.md). Sau mỗi lần cập nhật Piagent, bấm lại **Kết nối Piagent trong WSL** (Agent Watch tự làm khi mở).
4. Trong Ubuntu: `piagent dashboard` (mở trong trình duyệt Windows) hoặc `piagent studio --project ~/projects/shop`.

Kiểm tra máy: `piagent studio --doctor`.

### Sandbox trên Linux và WSL2

Cùng những gì sandbox macOS bảo đảm, dựng bằng mount của bubblewrap:

- Project ghi được; cache package của project ghi được (`~/.cache/piagent/sandbox`); thư mục tạm riêng.
- Folder khác trong home đọc được để tham chiếu khi bạn chỉ tới, chỉ đọc; mục ẩn trong home (`~/.ssh`, `~/.bashrc`, cấu hình tool…) không có trong sandbox.
- File credential (`.env`, `.npmrc`, `credentials`, `auth.json`) đọc ra rỗng.
- Lệnh chưa được duyệt mạng chạy trong network namespace riêng: chỉ tới được server do chính lệnh đó mở (không internet, không proxy, không dịch vụ đang chạy trên máy). Mở server test và chạy test trong cùng một lệnh; database đang chạy trên máy cần `run_with_network`.
- Tiến trình một lệnh để lại kết thúc cùng lệnh đó.
- Không gọi được chương trình Windows từ trong sandbox.

Khác macOS: folder Windows (`/mnt/c/...`) chưa đọc được để tham chiếu từ một project trong WSL; project nằm trên `/mnt/c` vẫn dùng được nhưng chậm hơn trong ổ của WSL.

## Chế độ cá nhân trong WSL2

Làm bước 1–2 ở trên, rồi chạy `piagent dashboard` trong Ubuntu. Không cần Agent Watch.

## Xem trước: chế độ cá nhân thẳng trên Windows

Dành cho thành viên đã chạy Pi trên Windows. Guard của Piagent, hộp chọn folder và gợi ý @ của dashboard hiểu đường dẫn Windows: ổ đĩa khác (`D:\…`), `AppData` và mục ẩn trong home không phải đường dẫn của project, và Git Bash chạy lệnh shell của agent. Chưa có: `piagent-update` (nó chạy npm, Pi và Bash theo kiểu macOS/Linux), nên cài và cập nhật bằng tay trong PowerShell:

```powershell
npm install -g --ignore-scripts @piagent/platform
piagent dashboard
```

Dashboard cần đúng bản Pi mà Piagent ghim; `piagent-update --dry-run` trong WSL cho biết bản đó.

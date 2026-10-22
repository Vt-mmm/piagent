# Đọc tệp dự án trong Session Hub

[English](../en/workspace-editor.md)

Mở một cuộc hội thoại trong `piagent dashboard`, rồi chọn **Tệp**. Trên màn hình
rộng, thanh bên hiện cây dự án và editor nằm cạnh chat. Trên màn hình nhỏ, Tệp mở
thành ngăn kéo. Chọn **Phiên** để quay lại danh sách hội thoại.

Chọn tệp để mở một tab chỉ đọc. Cmd/Ctrl+P tìm theo tên tệp. **Tìm kiếm** tìm văn
bản nguyên dạng và mở kết quả tại dòng tương ứng. Liên kết tệp trên thẻ công cụ,
thay đổi mã nguồn và đề cập `@path:line` cũng mở editor. Nút **Open in VS Code**
vẫn có trong phần thay đổi mã nguồn.

Cây tôn trọng quy tắc Git ignore và tải từng thư mục. Danh sách và tìm kiếm có
giới hạn, kèm thông báo khi kết quả bị cắt. Khi không có ripgrep, tìm kiếm dùng
index Context Engine đã có; không tự tạo index và có thể chỉ tìm được tệp đã lập
chỉ mục. Giao diện báo khi không thể tìm kiếm.

Tệp được bảo vệ hiện khóa và không mở được. Tệp nhị phân hoặc quá lớn hiện thông
báo thay cho nội dung. Đường dẫn không an toàn và symlink bị từ chối. Yêu cầu
company đi qua Gateway của công ty và đọc tệp trong sandbox hiện có của phiên.
Trình duyệt không nhận Studio grant.

Bộ phân tích JavaScript, TypeScript, JSON, Markdown, Python, HTML và CSS chỉ tải
khi cần; tệp khác vẫn đọc được dưới dạng văn bản thuần. Milestone này chưa lưu
chỉnh sửa, mở terminal tương tác hoặc khôi phục checkpoint.

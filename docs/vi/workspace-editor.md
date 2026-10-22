# Đọc và sửa tệp dự án trong Session Hub

[English](../en/workspace-editor.md)

Mở một cuộc hội thoại trong `piagent dashboard`, rồi chọn **Tệp**. Trên màn hình
rộng, thanh bên hiện cây dự án và editor nằm cạnh chat. Trên màn hình nhỏ, Tệp mở
thành ngăn kéo. Chọn **Phiên** để quay lại danh sách hội thoại.

Chọn tệp để mở một tab editor. Cmd/Ctrl+P tìm theo tên tệp. **Tìm kiếm** tìm văn
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
Ghi tệp cũng đi qua boundary này. Trình duyệt không nhận Studio grant.

Bộ phân tích JavaScript, TypeScript, JSON, Markdown, Python, HTML và CSS chỉ tải
khi cần; tệp khác vẫn đọc được dưới dạng văn bản thuần.

Khi có quyền ghi, sửa văn bản rồi nhấn **Cmd/Ctrl+S** hoặc **Lưu**. Tab chưa lưu
có dấu chấm. Đóng tab có thay đổi sẽ hỏi trước khi bỏ; ẩn Tệp hoặc chuyển hội
thoại vẫn giữ bản sửa trong bộ nhớ trang. Rời trang sẽ cảnh báo bản sửa chưa lưu.
Bản sửa không được khôi phục sau khi khởi động lại trình duyệt. **Tệp mới** nhận
đường dẫn tương đối trong thư mục đã có; nhấn lưu để tạo. Đổi tên và xóa tệp dời lại.

Lưu kiểm tra permission profile hiện tại, đường dẫn được bảo vệ/chỉ đọc và digest
của tệp. Nếu tệp đã đổi, chọn **Tải lại**, **Xem khác biệt** hoặc **Ghi đè**.
Ghi đè cần xác nhận và vẫn kiểm tra phiên bản đang hiện trong hộp thoại. Khi mất
kết nối, bản sửa được giữ; lưu lại dùng cùng command để không ghi hai lần. Nếu
kết quả chưa xác định, giao diện yêu cầu tải lại và kiểm tra trước.

Giao diện báo khi agent đang chạy. Member lưu thành công sẽ làm mới Source Changes
và đưa ghi chú tên các tệp đã sửa vào lượt agent tiếp theo. Agent đã đọc phiên bản
cũ phải đọc lại trước khi edit/write. Company dùng chung hàng đợi đọc/ghi với agent
trong sandbox hiện có. Quyền chỉ đọc tắt lưu; máy chủ kiểm tra lại quyền mỗi lần lưu.
Terminal tương tác, review hunk trong editor và khôi phục checkpoint thuộc các
milestone sau.

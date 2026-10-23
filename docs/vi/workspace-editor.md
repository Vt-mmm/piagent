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

## Review thay đổi của agent

Tệp đang mở hiện hunk đã xác minh của agent bằng dòng thêm, khối dòng đã xóa và dấu
ở lề. Mỗi tab đang mở hiện số hunk còn lại. **Alt+ArrowDown/Up** chuyển giữa các hunk.
**Giữ** bỏ hunk khỏi danh sách review mà không sửa tệp; đóng ngăn kéo trong cùng
trang vẫn giữ lựa chọn, nội dung mới cần review lại. Tải lại trang sẽ xóa lựa chọn Giữ.

**Hoàn tác** mở preview và cần xác nhận. Thao tác dùng luồng source revert có guard
hiện có, giữ nguyên Git index. Nếu mất phản hồi, **Kiểm tra lại** hỏi kết quả cùng
command. Không thể hoàn tác hunk trộn thay đổi member/agent, nội dung cũ, đường dẫn
được bảo vệ hoặc thay đổi chưa hỗ trợ. Tệp untracked mới do agent tạo có thể review
và Giữ; chưa hỗ trợ xóa tệp qua hoàn tác. Tệp có sẵn của member không bị coi toàn bộ
là do agent tạo.

Hoạt động của agent làm mới tệp đang mở chưa có bản sửa. Bản sửa chưa lưu được giữ
và hiện lựa chọn xung đột như khi lưu. Dấu hunk ẩn khi đang sửa bản nháp.
**Comment dòng hiện tại** hoặc **Cmd/Ctrl+Shift+M** mở LineReview. Dòng đã xóa có nút
comment riêng, giữ đúng số dòng cũ và nội dung. **Đưa vào ô chat** nối comment vào
bản nháp; gửi tin nhắn để yêu cầu agent xử lý.

Việc xác định hunk cần write/edit/patch được quan sát chính xác trong phiên và diff
hiện tại đầy đủ, chưa che nội dung. CRLF và thiếu newline cuối được so sánh chính
xác. Sửa qua shell chưa được quan sát hoặc quan sát mất khi runtime khởi động lại
không nhận dấu hunk agent. Company review và hoàn tác trong sandbox của phiên.

## Terminal personal

Chọn **Terminal** cạnh Tệp, rồi **+** để mở shell của member trong project của
cuộc trò chuyện. Mỗi cuộc trò chuyện có tối đa bốn tab. Panel nằm dưới editor trên
màn rộng và mở drawer bên dưới trên màn hẹp. Kéo thanh phân cách để đổi chiều cao,
hoặc focus vào thanh và dùng phím mũi tên. Terminal theo theme hiện tại;
Ctrl+C ngắt lệnh đang chạy ở foreground.

Lệnh tự gõ chạy với quyền host của member, không hỏi duyệt như lệnh agent.
Terminal personal không phải sandbox. Đóng terminal, release hoặc restart phiên,
hay tắt Gateway sẽ dừng process group và các tiến trình con đã quan sát. Shell tự
thoát cũng dọn các tiến trình còn trong process group. Tiến trình chủ động tách
sang session khác nằm ngoài vòng đời process group đó.

Lệnh in nhanh hơn trình duyệt vẽ kịp (`yes`, `cat` một file lớn) được giãn nhịp:
terminal tạm dừng chương trình đang ghi trong lúc trang đuổi kịp, và phần output
trang không theo kịp được thay bằng dấu `[… output skipped …]`. Cuộc trò chuyện
dùng chung kết nối không bị gián đoạn.

Ẩn panel hoặc reload trang giữ shell khi runtime Gateway vẫn còn sống. Mở lại
phát lại tối đa 64 KB output đã giữ của mỗi tab. Bản phát lại và phần đính cho agent
che secret nhận diện được; terminal trực tiếp hiển thị output gốc cho member.
Restart Gateway xóa terminal và buffer. Nếu mất biên nhận lệnh, input tạm dừng:
**Kiểm tra lại lệnh** hỏi về đúng lệnh cũ. Kiểm tra terminal trước khi chọn
**Đã kiểm tra, tiếp tục**. Lệnh chờ còn trong bộ nhớ trang khi đổi panel, không còn
sau khi reload trang.

Gõ `@terminal` (terminal 1) hoặc `@terminal:2` trong composer, rồi bấm Gửi để đính
output hiện tại đã che secret. Mention lặp chỉ đính một lần, tối đa bốn tab với
tổng 64 KB output. Terminal không tồn tại sẽ từ chối lần gửi. Output được trích
như dữ liệu không đáng tin; chỉ gõ mention chưa gửi gì. Số tab tăng trong runtime
và không dùng lại sau khi đóng.

Module PTY native là tùy chọn và có thể không khả dụng. Panel báo lý do và
`piagent-doctor --json` có `productReadiness.personalTerminal`; các phần dashboard
khác vẫn dùng được. Doctor kiểm tra việc nạp module, không khẳng định đã thử mở
shell. Chưa hỗ trợ Windows native; dùng WSL.


## Terminal company

Cuộc trò chuyện company dùng cùng panel terminal qua Gateway công ty, kể cả khi
mở từ dashboard personal. Trên Linux và WSL, shell khởi chạy trong tool boundary
bubblewrap của cuộc trò chuyện. Shell không có internet, package proxy hoặc
Docker. Chỉ ghi trong project và thư mục tạm riêng; profile read-only giữ project
chỉ đọc. File credential bị che, đường dẫn được bảo vệ giữ giới hạn của boundary.
Shell là Bash không nạp file khởi động hoặc cấu hình shell của member.

Mỗi cuộc trò chuyện có tối đa bốn terminal. Đóng terminal, release cuộc trò chuyện
hoặc tắt Gateway công ty sẽ dừng sandbox và mọi tiến trình con, kể cả tiến trình
đã tách riêng. Ẩn panel và reload trình duyệt giữ terminal khi runtime company
còn sống. Mất kết nối relay tạm tắt input và tự nối lại để đọc trạng thái, phát lại
output; không tự gửi lại lệnh. Mention terminal được đính bên trong Gateway
công ty; Studio grant cũng chỉ ở đó.

Trên macOS, sandbox Seatbelt hiện tại từ chối cấp PTY, kể cả phương án dự phòng
đã thử khi kiểm chứng. Panel báo terminal company không khả dụng; không bao giờ
mở shell company trên host. Các tính năng company khác vẫn dùng được.
Chưa hỗ trợ Windows native; dùng WSL.

`piagent-doctor --json` có `productReadiness.companyTerminal`. Kết quả supported
chỉ kiểm file runtime và điều kiện tiên quyết (`ptySpawnVerified: false`), không
khẳng định máy này đã mở được PTY trong sandbox. Luồng đầy đủ Gateway, relay và
trình duyệt đã được kiểm chứng trên Linux arm64 trong Docker. Lần này chưa kiểm
chứng riêng Linux x64 native và WSL.

## Khôi phục một lượt agent

Trong project Git, lượt đã kết thúc và có đổi file sẽ có nút **Khôi phục về trước
lượt này** trong Timeline. Mở để xem trước các file bị ảnh hưởng và số lượt, rồi
chọn **Xác nhận khôi phục**. Hệ thống hoàn tác từ lượt mới nhất về lượt đã chọn,
xóa file do các lượt đó tạo và trả nội dung file đã sửa về trước đó. HEAD, commit
tạo trong lượt và vùng stage của member được giữ nguyên.

Nếu member đã sửa lại file bị ảnh hưởng sau lượt đó, khôi phục dừng ở lượt đó và
nêu tên file xung đột. Các lượt mới hơn an toàn có thể đã được khôi phục; kết quả
cho biết số lượt. Agent đang chạy, preview đã thay đổi hoặc quyền ghi bị thu hồi
thì cần xem trước lại. Đường dẫn protected và read-only vẫn giữ giới hạn.
Project không dùng Git thì không có checkpoint.

File member lưu từ editor sau khi một lượt bắt đầu được coi là của member: khôi
phục lượt đó sẽ báo file này là xung đột thay vì đưa nó về bản cũ. Sửa đổi gõ
trong terminal không được theo dõi theo cách này; kiểm tra thay đổi sau lượt vẫn
từ chối file bị sửa sau khi lượt kết thúc.

Pi TUI personal cũng có `/undo` để hoàn tác lượt gần nhất mà không gọi model.
Lịch sử personal giữ tối đa 64 checkpoint cho mỗi project và session trong file
chỉ chủ sở hữu truy cập được ở `.pi/piagent-state/checkpoints`; cuộc trò chuyện
không dùng trong 30 ngày sẽ mất checkpoint. Snapshot nằm trong một repository
riêng bên trong thư mục Git (`.git/piagent/checkpoints.git`), dùng chung object
của project nhưng có ref riêng: `git push --mirror` không bao giờ đẩy chúng lên,
và garbage collection của project không xóa chúng. Snapshot gồm file đã track với
mọi kích thước, bỏ qua file chưa track lớn hơn 100 MB và không gồm submodule;
hoàn tác không bao giờ đụng vào phần snapshot bỏ qua. Khi không chụp được
snapshot, agent vẫn sửa file bình thường; lượt đó không có checkpoint và các
checkpoint trước bị bỏ, vì khôi phục vượt qua lượt đó sẽ tạo ra trạng thái chưa
từng được ghi lại. Chỉ khi một runtime khác đang giữ lịch sử của cùng session
thì lần sửa mới phải chờ. Nếu runtime personal dừng trước snapshot cuối
lượt, phục hồi giữ nguyên các file đã sửa và chỉ bỏ metadata checkpoint chưa
hoàn tất. Checkpoint của các lượt đã kết thúc vẫn kiểm tra xung đột với thay đổi
của member. Thao tác checkpoint company chạy trong sandbox
hiện có; lịch sử company tồn tại trong vòng đời runtime.

Nếu trình duyệt mất phản hồi khôi phục, **Kiểm tra lại kết quả** gửi đúng khóa yêu
cầu cũ. Yêu cầu đang chờ còn sau khi reload cùng tab; reload không tự gửi yêu cầu.
Giữ tab đó đến khi biết kết quả. Nếu trình duyệt không lưu được yêu cầu đang chờ,
hệ thống từ chối gửi lần khôi phục mới. Kết quả chưa xác nhận có thể đã đổi file:
kiểm tra file trước khi tiếp tục. Kiểm tra cùng yêu cầu không tự chạy lại thao tác
file có kết quả chưa rõ. Nếu chỉ một số file đã đổi hoặc lưu lịch sử thất bại,
checkpoint còn giữ có thể báo xung đột; kiểm tra và xử lý file trước khi thử
khôi phục với preview mới.


## Thử trọn luồng làm việc

Dùng project Git thử nghiệm đã có commit đầu tiên và lệnh test đang chạy thành công.
Với personal, mở project trong `piagent dashboard`. Với company, chọn cuộc hội thoại
company của project; các bước terminal cần Gateway company Linux/WSL mở được PTY
trong sandbox. Trên macOS, kiểm tra thông báo không khả dụng; việc này không chứng
minh các bước terminal chạy được.

1. Mở file tracked trong Tệp, sửa nhỏ và lưu bằng Cmd/Ctrl+S.
2. Mở Terminal, chạy lệnh test của project và kiểm tra mã thoát.
3. Giữ một file tracked khác đang mở. Nhờ agent đọc và sửa file bằng edit/write.
   Sau lượt đó, kiểm tra dòng thêm và dòng xóa ngay trong editor.
4. Chọn Giữ và kiểm tra nội dung file không đổi. Nhờ agent ở lượt thứ hai tạo một
   file nhỏ mới. Tránh sửa qua shell khi kiểm tra việc xác định hunk agent.
5. Ở lượt agent đầu tiên, chọn Khôi phục về trước lượt này. Kiểm tra preview liệt
   kê cả hai lượt và hai file, rồi xác nhận.
6. Kiểm tra file ban đầu đã được trả lại, file mới đã bị xóa và bản sửa đã lưu ở
   bước 1 vẫn còn. HEAD và vùng stage giữ nguyên.

Kịch bản soak `ide-editor-terminal` kiểm tra riêng việc lưu editor có guard và chạy
test trong terminal qua giao thức WebUI. Self-check của oracle và test transport
không tự chứng minh đã hoàn thành một lượt chạy với model thật.

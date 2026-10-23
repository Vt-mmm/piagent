# IDE M0: editor, terminal and sandbox probes

Date: 2026-10-22. Baseline: `f598df18`, Node 22.23.3, macOS arm64.
No production dependency, CSP or sandbox rule was changed by these probes.

## Browser

A real Chromium page served the exact CSP from `server/http-security.ts`.
CodeMirror state 6.7.6/view 6.43.15 rendered a read-only document with
`EditorView.cspNonce`. xterm 5.5.0 rendered output with its packaged CSS served
from the same origin. Its `documentOverride` used a document proxy that adds
our nonce only to newly created style elements, binding other document methods
to their original receiver. No global DOM monkey patch is needed.

Combined minified probe: 491,192 bytes (137,045 gzip); this includes both
libraries, before splitting the production editor/terminal/language chunks.
Chromium reported zero CSP violations and rendered both expected text strings.

xterm 6.0.0 is unsuitable here: its shared scrollbar stylesheet uses the global
document and bypasses `documentOverride`. Pin 5.5.0 with addon-fit 0.10.0;
revalidate CSP before upgrading. All these packages use MIT licenses.

## Personal PTY

Upstream node-pty 1.1.0 contains macOS/Windows prebuilds but no Linux prebuild.
Use `@lydell/node-pty` 1.2.0-beta.15 (MIT), an API-compatible distribution with
platform packages for darwin arm64/x64 and linux arm64/x64. The beta pin requires
explicit platform smoke checks before upgrades. Keep it optional so a native
loading failure disables terminals without breaking the dashboard.

An isolated npm global prefix installation succeeded on darwin-arm64. A shell
reported `37 101` after resize, accepted Ctrl+C during sleep, then printed
`INTERRUPT_OK` and exited zero. In Docker `node:22` linux/amd64, global install
also succeeded and the PTY reported `37 101` and `LINUX_PTY_OK` without compiling.

## Company sandbox

macOS: a Node process launched *inside* the unchanged `managedSeatbelt` profile
failed to allocate the PTY: `posix_openpt failed: Operation not permitted`.
The fallback `/usr/bin/script` was also launched inside that profile with a real
controlling terminal and failed: `openpty: Operation not permitted`.
A pipe-only script probe is insufficient (it instead fails at `tcgetattr`);
the controlling-terminal probe confirms the sandbox denial.

Do not allocate a company PTY on the host as a workaround. The user's approved
fallback is to omit M4 when neither approach works within the existing sandbox.
macOS company terminals must therefore remain unavailable with a clear reason.

Update (phase 1 follow-up): the company Gateway now creates the PTY on the
host and starts only the shell under the unchanged offline Seatbelt profile plus
`file-ioctl` on `/dev/ttys*` and read/write/ioctl on `/dev/tty`. Opening any other
terminal stays denied; `tests/managed-terminal-boundary.test.mjs` checks this.
Linux arm64: Docker Node 22 with the unchanged `bubblewrapArgs` created the
PTY inside the sandbox, resized to 37x101, interrupted sleep and ran the next
command successfully. M4 can support Linux while reporting macOS unavailable.
Linux x64 under QEMU could install/load the prebuilt PTY but bubblewrap failed
with `Creating new namespace failed: Invalid argument`; native x64 sandbox
qualification remains unverified, rather than inferred from the arm64 result.

## Reproduction and evidence

Local evidence is outside the repository at
`reports/piagent-ide-evidence/`: `m0-csp.log`, `m0-sandbox.log`,
`m0-linux-global.log`, `m0-linux-sandbox.log`, plus probe sources under `m0/`.
The Linux container is an isolated Colima VM; its engine privileges allow testing
bubblewrap namespaces, not relaxing the application sandbox's mount/network rules.

Baseline `npm test`: 6,499 tests, 6,150 pass, 34 fail, 315 skipped.
The complete original failure inventory is in the required progress report;
these are baseline observations, not evidence of milestone completion.

## Kết quả tiếng Việt

CodeMirror chạy với nonce; xterm 5.5.0 chạy với `documentOverride` gắn nonce
cho thẻ style mới. Chromium không báo vi phạm CSP. Không dùng xterm 6.0.0 vì
stylesheet scrollbar đi vòng qua API đó. Chunk thử nghiệm chung là 491.192 byte,
gzip 137.045 byte; sản phẩm cần tải lười từng phần.

Chọn thử nghiệm `@lydell/node-pty` 1.2.0-beta.15 (MIT, prebuild đa nền tảng),
không chọn node-pty 1.1.0 vì bản đó thiếu prebuild Linux. Cài global trong prefix
riêng trên macOS arm64 và Docker Node 22 linux/amd64 thành công. PTY personal
resize được; trên macOS đã xác nhận Ctrl+C rồi chạy lệnh tiếp và thoát bình thường.

Trong Seatbelt hiện tại, cả node-pty lẫn script(1) với terminal thật đều bị từ
chối tạo PTY. Không đổi sandbox và không tạo PTY company trên host để lách.
Theo ngoại lệ người dùng đã cho phép, terminal company macOS không khả dụng;
các milestone editor, personal terminal và checkpoint vẫn tiếp tục.

Cập nhật (sau phase 1): Gateway công ty tạo PTY trên host và chỉ chạy shell trong
profile Seatbelt offline giữ nguyên, thêm `file-ioctl` trên `/dev/ttys*` và đọc/ghi/ioctl
`/dev/tty`. Mở terminal khác vẫn bị chặn; `tests/managed-terminal-boundary.test.mjs` kiểm việc này.

Linux arm64 đã qua probe PTY trong bubblewrap (resize, Ctrl+C, chạy lệnh tiếp).
M4 có thể hỗ trợ Linux; macOS vẫn không khả dụng. Namespace trên x64 giả lập
bị lỗi môi trường, cần kiểm lại trên Linux x64 native.

The final Linux arm64 probe also proved project writes succeed, writes to
`/outside` fail, curl to the internet fails, and a mounted credential file reads
empty. The shell and bubblewrap exited zero after Ctrl+C and the next command.
Linux arm64 cũng xác nhận ghi trong project được, ghi ngoài bị chặn, curl ra
internet thất bại và credential đọc ra rỗng.

# Runtime quality baseline

## Mục tiêu

Runtime quality baseline định nghĩa bộ kiểm soát để Pi Agent Platform có thể chạy task một cách có kỷ luật cho solo, internal team, và public package.

Các module chính:

1. Permission profile
2. Exec policy
3. Context budget
4. Tool registry
5. Final task gate
6. Local verification
7. Quality benchmark

Trạng thái hiện tại: platform đã có runtime modules đủ cho guarded implementation task. Các tuyên bố về chất lượng, token, cost, hoặc tốc độ phải dựa trên benchmark theo project/model thật.

## 0. Permission profile

Tool:

```text
piagent_permission_status
```

Runtime behavior:

- `read-only` chặn shell, write/edit, và unknown non-piagent tools;
- `workspace-write` là default cho implementation có guard;
- `trusted-full-access` nới tool/scope autonomy trong môi trường trusted nhưng không tắt protected paths, redaction, capability lock, hoặc human gate cho destructive/external action.
- `/permission full-access <task>` bật `trusted-full-access` cho session hiện tại rồi gửi phần task còn lại cho agent; `/permission status` hiển thị mode và boundary đang active. Alias `/full-access <task>` và `/permission-status` vẫn chạy.

## 1. Exec policy

Tool:

```text
piagent_exec_policy_check
```

Runtime behavior:

- phân tích shell command trước khi chạy lệnh rủi ro;
- block destructive patterns;
- đệ quy vào shell wrapper phổ biến như `sudo`, `env`, `bash -c`, subshell, command substitution, và backtick;
- check `shellProtectedPaths` cho bash, mặc định bảo vệ `.git`, `auth.json`, `.env`, `.env.*`; path chỉ nằm trong `shellProtectedPaths` là shell-only và không chặn write/edit;
- kiểm tra cả bare filename, partial glob (`*`, `?`, character class, brace), symbolic-link alias đã canonicalize, và redirect shell có hoặc không có khoảng trắng;
- redact sensitive text trong text result và JSON-like result details trước khi output được trả về model; non-text media block được giữ nguyên;
- cảnh báo broad command prefix như `bash`, `python`, `node`, `git`, `sudo`;
- áp dụng policy rule `allow | prompt | forbid`;
- ghi lý do để agent/human đánh giá trước khi tiếp tục.

Config:

```text
packages/piagent-core/policies/base-policy.json
```

Mục tiêu không phải cấm mọi command mạnh hoặc thay thế sandbox OS. Đây là lớp phanh chống tai nạn: giảm rủi ro agent tự ý chạy lệnh có tác động cao, đọc secret, hoặc đụng protected path mà thiếu policy/human gate.

## 2. Context budget

Tool:

```text
piagent_context_budget
```

Runtime behavior:

- giới hạn số file trong context manifest;
- giới hạn kích thước file context;
- cảnh báo fragment lớn;
- buộc context phải có lý do đọc rõ ràng.

Default:

```json
{
  "maxContextFileChars": 50000,
  "maxMemoryFileChars": 20000,
  "maxManifestFiles": 80,
  "warnFragmentChars": 4000
}
```

Context nên được chọn theo profile/task, không đọc tràn toàn repo.

## 3. Tool registry

Tool:

```text
piagent_tool_policy_check
```

Runtime behavior:

- map tools sang capability như `filesystem-readonly`, `filesystem-write`, `shell`, `github`, `browser`;
- `piagent_*` tools luôn allowed;
- default `advisory` để không phá Pi runtime khi tool names thay đổi;
- project ổn định có thể nâng `toolRegistry=enforce`.

Profile capability ví dụ:

```json
{
  "mcpCapabilities": [
    "filesystem-readonly",
    "filesystem-write",
    "shell",
    "github",
    "browser",
    "memory"
  ]
}
```

## 4. Final task gate

Tool:

```text
piagent_task_gate_check
```

Runtime behavior:

- kiểm tra task contract;
- kiểm tra context manifest;
- kiểm tra verify evidence đã đối chiếu với Pi `bash` `tool_result` thật;
- yêu cầu observed passing verify khớp exact `task.verifyCommands` khi task có source changes;
- block `piagent_trace_record completed` nếu final gate đang enforce và proof chưa đủ.

Agent không phải gọi các tool evidence/trace/gate trong task thường. Hook
`tool_result` tự ghi targeted reads, changed files và exact verifier; hook
`message_end` dựng final contract, chạy gate rồi ghi terminal trace khi đủ proof.
Các tool thủ công vẫn tồn tại cho diagnostics/recovery và high-risk/custom plan.

Passing evidence còn phải khớp `workingTreeDigest` hiện tại. Bất kỳ mutation nào
sau verify làm evidence cũ stale. Việc chạm một file rồi revert về đúng digest
baseline chỉ được giữ trong audit history, không được tính là final source diff.

Automatic/assisted plan được phép một `followUp` correction turn khi projected
gate fail. Lượt này nhận đúng missing reasons, không tự lặp; rollback bằng
`PIAGENT_AUTO_RECOVERY=off`.

`piagent_verify_record` không còn tin `exitCode` tự khai báo. Lệnh verify phải khớp một bash tool result đã quan sát sau `task.createdAt`, và claimed `exitCode` phải khớp trạng thái `isError` của Pi. Observed result được ghi vào `.pi/piagent-state/observed-bash.jsonl` để parent/subagent process có thể share evidence trong cùng project cwd.

Gate phân biệt hai mức:

- observed evidence: command thật sự đã chạy qua Pi bash;
- profile-matched evidence: command đó exact-match một dòng trong `task.verifyCommands`.

`true`, `echo ok`, hoặc `npm test || true` có thể được ghi trace nếu đã chạy thật, nhưng không đủ để pass final gate trừ khi profile/task verify plan khai đúng command đó.

Guard state tự bảo vệ:

- raw path-like access vào `.pi/piagent-state/**` bị block trước khi tool chạy;
- raw path-like access vào `.pi/piagent-profile.json` bị block trước khi tool chạy;
- Pi built-ins `read`, `write`, `edit`, `grep`, `find`, `ls` đi qua cùng protected-path gate;
- custom/MCP tools cũng bị block nếu tool call chứa path-like string trỏ vào protected path, kể cả nested object, array, và `file://` URI;
- path-like string được percent-decode một lần trước khi match, nên `%2Eenv` và `.%65nv` không đi vòng qua guard;
- tool input lồng quá sâu vượt `MAX_TOOL_INPUT_INSPECTION_DEPTH=32` sẽ fail-closed;
- generic extractor chỉ skip leaf field nội dung đã biết như `content`, `query`, `pattern`, `text`, và `command`;
- `grep.glob` và `find.pattern` bị block khi pattern nhắm protected path rõ ràng như `.env*`, `auth.json`, `.pi/piagent-state/**`, hoặc `piagent-profile.json`; broad glob như `*.json` được phép và để result backstop xử lý;
- broad `grep`, `find`, và `ls` sweep có thêm `tool_result` backstop để redact content line hoặc path metadata từ protected files;
- mọi text block trong `tool_result` và string leaf trong JSON-like `details` có thêm shared sensitive-data redaction; key như `password`, `token`, `credential` được dùng làm context phát hiện;
- `npm run benchmark:redaction` gate contextual recall, benign preservation, structured objects/arrays, và large-output correctness bằng synthetic data; opaque entropy không có credential context được báo riêng và không gate release;
- bash evidence chỉ giữ command text đã redact ở memory/disk; raw command hash vẫn dùng để exact-match verify evidence;
- `piagent_task_start`, lifecycle hooks và các recovery tools vẫn ghi state được qua internal extension path.

## 5. Local verification

Platform verification:

```bash
npm run typecheck
npm test
npm run benchmark:redaction
bash scripts/verify-local.sh
bash scripts/verify-local.sh --offline  # CI / clean machine without Pi login catalog
bash scripts/team-doctor.sh . --strict-share
pi list --approve
```

`verify-local.sh` kiểm tra:

- package manifests;
- JSON parse;
- required docs/scripts/prompts;
- protected-path, shell protected path, recursive path-like tool access, `grep/find/ls` result backstops, guard-state self-protection, exec-policy, observed-verify, cross-process ledger, profile verify-command matching, and redaction regression tests;
- profile doctor;
- team doctor;
- TypeScript syntax for extension;
- smoke test for runtime policy;
- public documentation wording guard.

## 6. Quality benchmark

Automatic paired benchmark:

```bash
piagent-benchmark --dry-run
piagent-benchmark
piagent-benchmark --production --dry-run
```

Output:

```text
~/.pi/agent/benchmarks/piagent/<run-id>/report.json
~/.pi/agent/benchmarks/piagent/<run-id>/report.html
~/.pi/agent/benchmarks/piagent/<run-id>/summary.txt
~/.pi/agent/benchmarks/piagent/<run-id>/runs.jsonl
```

Runner dùng clean Git fixture, hidden grader và exact Pi session usage. Piagent
fixture được init/onboard và build context trước measured run để benchmark task
steady-state; mọi context/index mutation sau Git baseline vẫn bị scope gate bắt.
Report tách hidden correctness khỏi scope/reliability, hiện usage của mọi run và
chỉ lưu histogram tên tool. Chỉ claim chất lượng/token/cost khi các paired run có:

- cùng task prompt/spec;
- cùng acceptance criteria;
- verify command rõ;
- token/cost/duration được runtime ghi lại;
- safety đạt `10/10` và các gate quality/reliability/workflow của suite pass;
  production yêu cầu điểm tổng hợp ít nhất `9.5/10`, mọi task và mọi
  category/profile/lifecycle/difficulty band lớn hơn `9.5`, quality không giảm,
  cùng paired usage đủ confidence.

`piagent-benchmark <project> --record ...` vẫn route tới recorder cũ cho task
project-specific, nhưng không thay thế automatic release benchmark.

`core-v1` là smoke gate 24 session. Release/model claim diện rộng dùng
`production-v1`: 18 scenario family x 3 generated variant x 2 surface = 108
session, phủ sáu domain, nhiều profile và cold/steady lifecycle. Production gate
chấm thêm từng category và cận trên 95% của paired token ratio; repeat được
cluster theo scenario family nên không bị tính như bằng chứng độc lập. Runner
chỉ retry lỗi process trước khi có usage, ghi retry vào ledger riêng; timeout và
task failure vẫn được chấm reliability. Chi tiết và quy trình private held-out
suite nằm trong `docs/quality-benchmark.md`.

## Runtime policy trong profile

Project có thể override:

```json
{
  "runtimePolicy": {
    "execPolicy": "enforce",
    "contextBudget": "enforce",
    "toolRegistry": "advisory",
    "finalGate": "enforce"
  }
}
```

Mode:

| Mode | Ý nghĩa |
|---|---|
| `off` | Không áp dụng module policy đó. |
| `advisory` | Tool trả warning/check result nhưng không block mọi thứ. |
| `enforce` | Runtime hook/tool block khi vi phạm policy. |

## Khuyến nghị vận hành

Setup solo/internal nên bắt đầu với:

1. `execPolicy=enforce`
2. `contextBudget=enforce`
3. `toolRegistry=advisory` trong giai đoạn đầu, sau đó nâng lên `enforce` khi tool registry ổn định
4. `finalGate=enforce`

## Roadmap

- Hard final assistant stop-hook nếu Pi extension API expose stable hook.
- Disposable integration test chạy Pi runtime end-to-end.
- Optional process/filesystem/network sandbox ngoài Pi khi môi trường yêu cầu isolation mạnh.
- Auto-discovery tool names từ Pi/MCP để giảm registry thủ công.

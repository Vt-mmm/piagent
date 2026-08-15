# Pi Context Engine
<!-- language: vi; english-index: docs-site/content/en/context-engine.html -->

## Mục tiêu

Pi Context Engine giảm token bằng cách giảm context nhiễu, không đổi model chính
và không hạ thinking level. Runtime chọn đúng tool, file, symbol và test trước khi
model bắt đầu scout rộng.

```text
task
  -> deterministic task signals
  -> dynamic tool groups
  -> explicit path + FTS5 + symbol/import graph + git/test signals
  -> Reciprocal Rank Fusion + personalized PageRank
  -> token-budgeted navigation pack or current-turn source snapshot
  -> selected parent model
  -> delta tool results + semantic compaction
  -> local telemetry for Agent Watch
```

## P0: runtime context controls

- Piagent tools được chia thành `governance`, `policy`, `retrieval`,
  `knowledge`, `onboarding`, và `usage`. Code retrieval không tự kéo theo
  memory, document intake, source checkout hoặc orchestration.
- Session bắt đầu không mang schema quản trị Piagent. Input hook bật thẳng nhóm
  tối thiểu cần cho task trước khi system prompt được tạo.
- `piagent_tools` chỉ xuất hiện khi operator yêu cầu rõ tool loader; runtime
  guard vẫn chạy kể cả khi policy tool không hiện với model.
- Tool order cố định để giữ prompt prefix ổn định cho provider có prompt cache.
- Read/grep/find/ls lặp lại với cùng input và cùng output trả delta marker thay
  vì chèn lại toàn bộ kết quả.
- Auto-context được cache theo `cwd + sessionId + promptHash`. Cùng prompt trong
  cùng session chỉ inject một lần; session khác vẫn có pack riêng. Gọi manual
  pack với cùng query trả reuse marker ngắn trừ khi `refresh=true`.
- Auto pack dùng 500 token cho `tiny`, 900 cho `normal`, 1.200 cho `high-risk`;
  manual pack mặc định 2.400 token. Model và thinking level không bị hạ.
- Task source bounded do runtime intake quản lý có thể nhận current-turn snapshot
  tối đa 900 token trước action đầu. Snapshot chỉ lấy file dưới source/test root,
  đọc nội dung hiện tại sau freshness/protected-path/symlink checks và bị bỏ qua
  khi index stale hoặc retrieval confidence thấp. Model dùng snapshot cho edit
  đầu tiên, chỉ re-read khi thiếu region hoặc edit báo mismatch.
- Token estimator tính ASCII và UTF-8 riêng, bảo thủ hơn cho tiếng Việt/CJK/emoji
  để pack không vượt budget chỉ vì một ký tự dùng nhiều byte.
- Telemetry không lưu prompt hoặc tool output thô. Nó lưu hash, kích thước, tool,
  model, thinking, active-tool count, usage, retrieval confidence và đường dẫn
  tương đối đã được guard redaction.

Bốn cơ chế `PIAGENT_DYNAMIC_TOOLS`, `PIAGENT_AUTO_CONTEXT`,
`PIAGENT_CONTEXT_TELEMETRY` và `PIAGENT_AUTO_RECOVERY` đều **bật mặc định**.
Ba cờ đầu có từ `v1.2.6`; bounded recovery có từ `v1.2.11`. Telemetry chỉ ghi
operational metadata/hash như mô tả dưới đây, không ghi prompt hoặc tool output
thô. Tắt riêng từng cơ chế cho một lần chạy bằng:

```bash
PIAGENT_DYNAMIC_TOOLS=off pi
PIAGENT_AUTO_CONTEXT=off pi
PIAGENT_CONTEXT_TELEMETRY=off pi
PIAGENT_AUTO_RECOVERY=off pi
```

## P1: code index và retrieval

Index nằm tại:

```text
.pi/piagent-state/context-engine/context-v2.sqlite
```

Nó dùng SQLite FTS5 có sẵn trong Node.js `>=22.19.0`, không cần native package
hoặc install script. File được nhận diện bằng SHA-256; lần refresh sau tái sử
dụng record có `mtime` và size không đổi. `.gitignore`, binary, file quá lớn,
secret file, protected paths, dependency/build output và toàn bộ guard state
không được index.

Index chứa source body của những file được phép index, không chỉ metadata. Vì
vậy directory `context-engine/` được giữ mode `0700`; SQLite database, WAL và
SHM được giữ mode `0600`. Đây là ranh giới giữa các OS account trên cùng máy,
không chặn process khác đang chạy bằng chính account của operator.

Mỗi SQLite connection bật cả core `secure_delete` và FTS5 `secure-delete`.
Refresh cùng policy vì vậy xóa source cũ khỏi ordinary table lẫn full-text
index mà không chạy full compaction. Khi exclusion digest đổi, policy version
`2` commit digest mới cùng `purgePending: 1` trước khi dựng lại FTS index từ
content table đã lọc, checkpoint WAL rồi chạy `VACUUM`. Cờ pending chỉ clear
sau khi toàn bộ chuỗi thành công; app hoặc máy dừng giữa chừng thì lần mở tiếp
theo tự retry.

FTS rebuild và `VACUUM` chỉ chạy khi policy đổi hoặc purge trước còn pending,
không chạy ở mỗi refresh. Trong lúc `VACUUM`, máy có thể cần tạm thời gần gấp
đôi dung lượng file database. Xem mô tả chính thức về
[FTS5 rebuild/secure-delete](https://www.sqlite.org/fts5.html) và
[VACUUM](https://www.sqlite.org/lang_vacuum.html).

Symbol layer hiện dùng parser adapter zero-dependency cho TypeScript/JavaScript,
Python, Go, Rust, Java/Kotlin/C#, C/C++, Swift, Dart, Ruby, PHP, Elixir, Lua,
SQL và Markdown. Schema parser-neutral để có thể thêm Tree-sitter sau này mà
không migrate consumer. Tree-sitter không phải dependency mặc định vì native
grammar size và install reliability phải thắng benchmark trước khi rollout.

Candidate ranking gồm:

1. Explicit path/basename.
2. FTS5 BM25 lexical match.
3. Exact và partial symbol match.
4. Current Git changes.
5. Test filename/path relation.
6. Positive-only session feedback.
7. Personalized PageRank trên import graph.

Các ranked list được hợp nhất bằng Reciprocal Rank Fusion:

```text
score(file) = sum(weight(source) / (60 + rank(source, file)))
```

Context pack tách repo map và source snippets, sau đó dừng cứng tại token
budget. Manual/read-only pack vẫn chỉ là navigation evidence và model phải đọc
file hiện tại trước khi edit. Riêng current-turn snapshot của automatic bounded
task đọc lại file hiện tại sau freshness check; edit exact-text sẽ fail nếu file
đổi sau snapshot, khi đó model phải re-read thay vì đoán.

Tất cả API chạm context index (`build`, `status`, `ensure`, `search`, `pack`,
`impact`) bắt buộc caller truyền `excludePatterns` tường minh và fail-closed
nếu thiếu. Runtime và CLI lấy danh sách này từ shared project policy resolver;
low-level tool hoặc test chỉ dùng `[]` khi chủ ý chọn không loại trừ. Dù
`status` không trả source content, nó vẫn cần policy để không báo false-negative
`policyStale: false` rồi khiến caller bỏ qua rebuild.

## P2: compaction, finder và test impact

- `/context impact` đi ngược import graph từ file thay đổi và tìm test liên quan.
- Context pack trả `high`, `medium`, `low`, hoặc `none` confidence.
- Với `low/none`, runtime đề xuất đúng một bounded read-only finder pass, không
  tự spawn và không tự đổi model.
- `/context compact` giữ goal, acceptance criteria, quyết định, invariant,
  changed files, verify evidence, blocker và next action. Nó loại log thô,
  repeated reads, kế hoạch đã bị thay thế và source excerpt có thể đọc lại.

## P3: Agent Watch telemetry và feedback

Event append-only nằm tại:

```text
.pi/piagent-state/context-engine/events.jsonl
.pi/piagent-state/context-engine/efficiency-report.json
```

Mỗi event có:

```json
{
  "schemaVersion": 1,
  "source": "piagent",
  "recordedAt": "ISO-8601",
  "event": "agent_prompt | tool_activation | context_pack | tool_call | tool_result | turn_end | session_compact",
  "sessionId": "Pi session id",
  "sessionName": "operator session name",
  "model": "provider/model",
  "thinkingLevel": "off|minimal|low|medium|high|xhigh"
}
```

Agent Watch có thể join event với Pi session JSONL bằng `sessionId` và
`sessionName`, và với task contract bằng `taskId`/`taskRunId`. Không cần polling
realtime; import lúc mở app hoặc lúc xuất report vẫn thấy event đã ghi.

Telemetry, trace, observed-bash và capture dùng bounded JSONL owner-only, có
cross-process rotation lock. Giới hạn mặc định: context telemetry 32 MiB, task
trace 8 MiB, capture index 4 MiB; tool-result captures tối đa 500 file, 128 MiB
và 30 ngày. Record đơn lẻ vượt trần được thay bằng audit marker thay vì làm file
phình. Mọi writer từ chối `.pi` hoặc ancestor symlink ra ngoài project.

Feedback không phải model học ngầm. Khi một context pack chọn file và chính
session đó sau đó thực sự đọc hoặc sửa file, file nhận một boost nhỏ ở những
lần retrieval sau. File chưa có lịch sử hoặc từng được chọn nhưng chưa dùng
không bị trừ điểm. `contextSelections`, `contextSelectionsUsed` và
`contextUtilizationRate` trong efficiency report cho phép audit hiệu quả của
ranking. Runtime chỉ đọc phần đuôi telemetry có giới hạn khi tính report hoặc
feedback, nên lịch sử dài không làm chậm từng prompt theo thời gian.

`contextWasteScore` nằm trong khoảng `0..100`, thấp hơn là tốt hơn:

```text
30% duplicate read rate
25% duplicate output rate
20% tool schema share
15% low-confidence retrieval rate
10% active-tool excess
```

Đây là operational signal, không phải quality verdict. Report phải đối chiếu
với task gate, acceptance result, verify evidence, token usage và rework.

## Sử dụng

Trong Pi:

```text
/context index
/context rebuild
/context search <symbol or keyword>
/context pack <task>
/context impact [changed files]
/context efficiency
/usage efficiency
```

Ngoài terminal, không chạy model:

```bash
piagent-context status
piagent-context rebuild
piagent-context search calculateInvoiceTotal
piagent-context pack "Fix invoice total calculation" --tokens 4000
piagent-context impact src/invoice.ts
piagent-context efficiency
```

## Benchmark gate

So sánh cùng task, repository commit, model, thinking và verify command. Mỗi
variant chạy ít nhất ba lần. Chỉ bật mặc định khi:

- acceptance/pass rate không giảm;
- rework và failed verification không tăng;
- fresh input tokens, duplicate reads và time-to-first-correct-edit giảm;
- protected-path, secret-redaction và final-gate tests vẫn pass.

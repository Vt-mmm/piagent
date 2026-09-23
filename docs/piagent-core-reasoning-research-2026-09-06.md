<!-- language: vi; english-index: docs/en/README.md -->

# Nghiên cứu lõi coding agent và đối chiếu Piagent

**Ngày:** 2026-09-06 · **Thuộc plan:** PCL-2026-09-06 · **Trạng thái:** nghiên cứu hoàn tất, triển khai pause.

Tài liệu phục vụ [kế hoạch cải thiện lõi Piagent](piagent-core-improvement-plan.md). Kết luận ưu tiên là **nối đúng những cơ chế đã có, giữ đủ thông tin cho model và giảm thao tác vô ích**, sau đó đo lợi ích trên công việc thực tế. Chưa có bằng chứng candidate Piagent mới làm tăng chất lượng hay giảm token của model thật.

## 1. Phạm vi và cách đọc nguồn

- 34 nguồn chính trong ledger dưới đây: bài kỹ thuật/docs của tác giả, file nguồn/changelog và bốn abstract nghiên cứu.
- 10 hệ agent: Pi, Codex, Claude Code, Cursor, Aider, mini-SWE-agent, OpenHands SDK, Gemini CLI, OpenCode, Cline. SWE-agent được bổ sung qua paper về giao diện agent–máy tính.
- Tám repo công khai ghim commit; tải **13 file source và một changelog** vào vùng tạm để đọc tĩnh các đoạn liên quan. Không clone, cài package, chạy agent hay thực thi code bên ngoài.
- Đọc có mục tiêu vòng xử lý, context, công cụ, event/state và failure behavior. Không tuyên bố audit toàn repo, tái lập leaderboard hay đọc toàn văn bốn paper.
- Claude Code/Cursor: nguồn là bài kỹ thuật do đội sản phẩm công bố. Không coi repo CLI/public docs là mã nguồn mở đầy đủ của lõi hai sản phẩm này.
- Các trang docs và blog có thể thay đổi; mốc truy cập 2026-09-06. Code links ghim commit, không dùng `main` làm identity tái lập. Metadata và SHA-256 từng file nằm trong [source manifest](piagent-core-research-sources-2026-09-06.json).
- Chỉ dùng nguồn sơ cấp để rút khuyến nghị. Search snippets, Reddit, trang tổng hợp và tài liệu do AI dựng không được dùng làm bằng chứng thiết kế.

## 2. Những kết luận có tác động tới plan

### 2.1 Năng lực hiệu dụng phụ thuộc đường chạy

Model tốt vẫn có thể làm việc kém khi thiếu source đúng, công cụ báo lỗi mơ hồ, trạng thái bị mất hoặc bị ép theo một chuỗi pha không phù hợp. SWE-agent nghiên cứu tác động của giao diện hành động; mini-SWE-agent hiện lại cung cấp một lõi rất gọn. Hai nguồn này cho lý do **thử đúng interface theo model/task**, không cho công thức “càng nhiều tool càng tốt” hay “bash-only luôn tốt nhất”. [S31][S31], [S22][S22]

Áp dụng cho Piagent: giữ control plane đang có, nhưng kiểm xem mỗi instruction, context pack, tool group và pha có giúp hoàn tất việc hay chỉ tăng chi phí. Không thay Pi bằng một framework khác để theo xu hướng.

### 2.2 Cắt token có thể làm tốn token hơn

Postmortem Claude Code ghi nhận việc xóa reasoning lặp sau idle làm mất tính liên tục và gây cache misses; một thay đổi giảm verbosity cũng làm chất lượng coding giảm. Đây là evidence của hệ đó tại thời điểm đó, không phải bug đã chứng minh trong Piagent. [S11][S11]

Áp dụng: đo usage, cache, đọc lại, effort và chất lượng cùng nhau. Không đặt giảm reasoning hay giảm độ dài output thành mục tiêu độc lập. Context ngắn hơn chỉ đáng giữ nếu tổng chi phí để làm đúng giảm.

### 2.3 Retrieval nên đưa đúng phần cần thiết và cho phép quay lại nguồn

Aider dùng graph/symbol ranking; Cursor đưa các output dài ra tài nguyên có thể đọc theo nhu cầu. Anthropic mô tả cách kết hợp dữ kiện ban đầu với truy xuất đúng lúc. [S16][S16], [S14][S14], [S08][S08]

Piagent đã có lexical/symbol/RRF retrieval và delivery confirmation. Bước kế tiếp là kiểm freshness, dependency coverage, lặp context và giá trị thật của pack. Không cần mở dự án embedding service trước khi chứng minh retrieval hiện tại không đủ.

### 2.4 Phải tách lịch sử nguồn khỏi bản context chiếu cho model

OpenHands có event history và view; condenser không được sửa trực tiếp cached view. OpenCode chỉ prune tool results theo điều kiện và vùng được giữ. [S24][S24], [S25][S25], [S28][S28]

Piagent đã có governor/ledger và task truth. Nên kiểm sự nhất quán của projection/resume thay vì thêm store trạng thái thứ hai. Một bản tóm tắt không được thay thế authority, exact verifier hoặc source identity.

### 2.5 Kiểm chứng cần giúp chọn bước sửa, không sinh vòng chứng minh vô hạn

Nghiên cứu intrinsic self-correction có kết quả và điều kiện khác nhau; abstract của một công trình cho kết quả tiêu cực khi thiếu external feedback, công trình khác nhấn mạnh điều kiện prompt/temperature. Không thể suy thành định luật cho mọi model hiện nay. [S33][S33], [S34][S34]

Lựa chọn thực dụng cho Piagent: dùng lỗi quan sát được, source hiện tại và kiểm tra có thể bác bỏ giả thuyết; không thêm reviewer model hoặc lời nhắc “nghĩ lại” sau mọi lượt. Tái sử dụng continuation maximum 1/progress signature; không sao chép loop detector có thêm model calls của Gemini. [S27][S27]

### 2.6 Chất lượng sản phẩm cần một nguồn phản hồi ngoài điểm test

Cursor mô tả kết hợp eval với dữ liệu sử dụng như code bị sửa lại và phản hồi người dùng. Anthropic phân biệt outcome thực tế với lời agent tự báo và nhấn mạnh độ tin cậy của phép chấm. [S15][S15], [S12][S12]

Áp dụng: theo dõi first-handoff correctness, việc mở lại, công sửa tay và cost của cả những attempt thất bại. Không dùng “code còn được giữ” hay một câu hài lòng thay cho kiểm chứng correctness; chúng là tín hiệu bổ sung.

## 3. Ma trận tiếp nhận theo từng hệ

| Hệ / mức đọc | Cơ chế đáng học | Áp dụng ở Piagent | Điều không sao chép mặc định |
|---|---|---|---|
| Pi — release + 2 source slices | Agent loop, steering, compaction, protocol failure | Giữ SDK làm nền; kiểm adapter/hook compatibility | Theo `main` hoặc nâng SDK ngay vì có version mới |
| Codex — blog + 2 source slices + model docs | Prefix/cache, context metadata, compaction boundary | Dùng wire telemetry đã có, kiểm replay/phase/opaque state | Biến cơ chế riêng Responses thành giả định cho mọi provider |
| Claude Code — engineering articles | Context rõ, long-task artifacts, postmortem chất lượng | Giữ task truth, hành trình đúng, feedback cụ thể | Hạ effort/cắt reasoning hoặc thêm initializer/subagent trái phạm vi |
| Cursor — 2 blog kỹ thuật | Dynamic context, theo dõi rework thực tế | Output references và real-work follow-up có quyền | Chép tỷ lệ tiết kiệm của Cursor thành cam kết Piagent |
| Aider — 3 docs/blog + 2 source slices | Repo map, edit format, failed-hunk feedback | Dùng index/edit freshness hiện tại, báo lỗi sửa được | Fallback tự chuyển patch sang file khác; hai model cho mọi edit |
| mini-SWE-agent — docs + default agent | Lõi nhỏ, tách model/environment, tính cả lỗi đã billed | Đối chứng đơn giản và accounting thất bại | Mang cost/step defaults hay quyền bash không giới hạn vào Piagent |
| OpenHands SDK — docs + 2 source slices | Event history và context projection tách biệt | Giữ ledger/view không làm biến dạng source evidence | Framework mới, remote server hoặc nhiều condenser chồng nhau |
| Gemini CLI — 2 source slices | Giữ recent outputs, phát hiện summary rỗng/phình, failure taxonomy | Controls cho compaction/progress hiện có | Hai lượt model để summary+probe; LLM loop-check thêm phí |
| OpenCode — 2 source slices | Prune có vùng bảo vệ, rõ loại stop/continue/compact | Kiểm hiệu quả và tính đầy đủ của governor | Copy doom-loop threshold/retry policy thành counter thứ hai |
| Cline — changelog ở commit ghim | Ca lỗi compaction quá mạnh, edit retries và model compatibility | Thêm đúng controls thiếu nếu Piagent có đường tương tự | Coi changelog là chứng minh code Cline hay Piagent đã an toàn |

## 4. Đối chiếu cụ thể với code Piagent

Đường dẫn dưới đây thuộc repo implementation đã chỉ định. Đây là đọc tĩnh có phạm vi; “cần kiểm” không có nghĩa “đã xác nhận bug”.

| ID local | Bằng chứng | Kết luận được phép | Gói plan |
|---|---|---|---|
| P01 | `runtime/product/efficiency-metrics.ts`: exactUsage default unavailable; invocation count/first-correct-edit còn null | Báo cáo task có wiring gap đã xác nhận | C1 |
| P02 | `runtime/registration/context-commands.ts:221`, `runtime/product/operator-projections.ts:82` | Call sites đã đọc không truyền exactUsage; cần nối nguồn usage phù hợp | C1 |
| P03 | `extensions/context-engine.js`: index v2, lexical/symbol/RRF, budgets, dedup, protected excludes | Retrieval tồn tại; token estimate không phải token billed | C2 |
| P04 | `runtime/context/context-delivery.ts` | Đã phân biệt offered/staged với delivered/confirmed theo task identity | C2 |
| P05 | `runtime/session/adaptive-context-governor.ts`, `adaptive-context-ledger.ts` | Có governor, bảo toàn task truth/protocol và passthrough; không thêm engine trùng | C2/C5 |
| P06 | `runtime/context/prefix-telemetry.ts`, `runtime/model/provider-wire-fingerprint.ts`, `extensions/piagent-guard.ts:3858` | Có cả canonical và ordered wire fingerprints. Chưa đủ để suy cache hit nếu không nối provider usage | C1/C2 |
| P07 | `runtime/solver/solver-shadow.ts`, `solver-policy.ts` | Solver mặc định shadow; suggestion không đồng nghĩa thực thi | C4 |
| P08 | `runtime/model/model-route-policy.ts`, `extensions/piagent-guard.ts:3900` | Có bảng model cụ thể, explicit pin preservation, mặc định off; host đã đọc báo boundary unavailable | C6 |
| P09 | `runtime/recovery/continuation-budget.ts` | Global continuation/progress signature đã có; giữ maximum 1 | C4 |
| P10 | `runtime/quality/edit-freshness-guard.ts`, `runtime/tools/phase-tool-runtime.ts` được đăng ký trong guard | Đã có cơ chế; cần đọc đúng consumer/tests trước thay đổi | C3 |
| P11 | `extensions/repository-memory.js`, `runtime/context/repository-memory-hints.ts` | Có citations/expiry/protected filtering/advisory; chưa chứng minh freshness và lợi ích trên mọi hành trình | C5 |

Các đường dẫn bắt đầu bằng `runtime/` hoặc `extensions/` trong bảng nằm dưới `packages/piagent-core/`.

Một phát hiện tránh được việc xây thừa: chỉ nhìn `prefix-telemetry.ts` sẽ thấy tool list được sort, nhưng code khác đã có `orderedToolSurfaceHash` và `provider_request_wire_surface`. Vì vậy plan không ghi “thiếu wire fingerprint”; gap là **đối soát wire/context với usage và outcome của task**.

## 5. Ledger 34 nguồn chính

### Pi và Codex

| ID / nguồn | Phần đã đọc và bằng chứng | Giới hạn / quyết định |
|---|---|---|
| S01 — [Pi releases][S01] | Release notes 0.85.0/0.85.1; 0.85.1 sửa lỗi import SDK và một số tương thích provider | Chọn ứng viên nâng cấp có qualification, không khẳng định SDK cũ gây mọi failure |
| S02 — [Pi agent-loop.ts][S02] | `runLoop`, steering/prepareNextTurn, error/abort và tool call khi output bị cắt | Code upstream snapshot, không tự coi đã có trong SDK 0.84.1 cài local |
| S03 — [Pi compaction.ts][S03] | `calculateContextTokens`, usage selection và estimate trailing messages | Context estimate phục vụ quản lý cửa sổ; không thay cost accounting |
| S04 — [Unrolling the Codex agent loop][S04] | Performance/cache prefix, tool order, config changes và compaction | Bài 23/01/2026; một số hiện thực có thể tiến hóa, không đồng nhất snapshot tháng 9 |
| S05 — [Codex compact_remote.rs][S05] | Request/step boundary, metadata trigger/reason/phase và hook khi compaction | Học cách quan sát lifecycle; không copy remote endpoint vào mọi provider |
| S06 — [Codex history.rs][S06] | History envelopes, normalized prompt views và metadata preservation | Đọc phần liên quan, không audit toàn bộ bộ quản lý history |
| S07 — [OpenAI model guidance, GPT-5.5][S07] | Outcome/success/stopping rules; giữ phase khi replay assistant items | Guidance theo model, không phải lệnh đổi model hoặc bỏ invariant Piagent |

### Claude Code / Anthropic và Cursor

| ID / nguồn | Phần đã đọc và bằng chứng | Giới hạn / quyết định |
|---|---|---|
| S08 — [Effective context engineering][S08] | Context nhỏ nhưng đủ tín hiệu, retrieval đúng lúc, compaction/note-taking | Không gán mọi hiện tượng long context của model cũ cho mọi model mới |
| S09 — [Writing effective tools][S09] | Tool purpose rõ, giảm overlap, output hữu ích với chế độ concise/detailed | Không loại ID/field cần cho hành động sau chỉ vì muốn ít token |
| S10 — [Effective harnesses for long-running agents][S10] | Tiến độ tăng dần, feature state, artifact tiếp nối và premature completion | Dùng task state có sẵn; không thêm initializer/subagent hay auto commit |
| S11 — [Claude Code quality postmortem][S11] | Ba thay đổi effort/context/verbosity và cách chúng gây giảm chất lượng | Case study, không kết luận model weights kém hoặc Piagent có cùng bug |
| S12 — [Demystifying evals for AI agents][S12] | Outcome vs transcript, model+harness, capability/regression eval và grader reliability | Giữ eval như phép đo; không thêm cả chương trình benchmark mới vào core |
| S13 — [Infrastructure noise][S13] | Resource enforcement và timeout làm thay đổi ý nghĩa kết quả | Khóa tài nguyên; không sao chép mức headroom hay tăng cap hiện tại |
| S14 — [Cursor dynamic context discovery][S14] | Output file references, history retrieval, skills/tool discovery | Số tiết kiệm tác giả báo là riêng cohort của Cursor, không đưa vào target Piagent |
| S15 — [Cursor harness improvement][S15] | Context thay đổi theo model; online/offline signals, keep rate/rework và error taxonomy | Keep rate chỉ là proxy; không dùng model đọc phản hồi user nếu chưa có quyền |

### Aider và mini-SWE-agent

| ID / nguồn | Phần đã đọc và bằng chứng | Giới hạn / quyết định |
|---|---|---|
| S16 — [Aider repository map][S16] | Symbol/signature map, dependency graph ranking và budget | Không copy token default; Piagent đã có index/ranking |
| S17 — [Aider repomap.py][S17] | `get_repo_map`, ranked tags/cache và PageRank implementation slices | Có implementation support cho docs; chưa kiểm định ranking trên repo Piagent |
| S18 — [Aider edit formats][S18] | Whole vs diff/search-replace; khả năng theo format khác nhau giữa model | Chọn theo evidence; không bắt whole-file cho mọi thay đổi |
| S19 — [Aider editblock_coder.py][S19] | Dry-run/apply, feedback failed hunk, partial success và fallback sang file khác | Chỉ học feedback; không chấp nhận chuyển target file tự động vào Piagent |
| S20 — [Separating code reasoning and editing][S20] | Hai bước architect/editor, có thể cùng hoặc khác model; tradeoff latency | Thí nghiệm 2024, không áp mặc định hai calls hoặc hai agents hiện nay |
| S21 — [mini-SWE-agent overview][S21] | Thiết kế tối giản, tách agent/environment/model | Documentation/claims của tác giả; không nhập điểm benchmark vào báo cáo Piagent |
| S22 — [mini-SWE-agent default.py][S22] | Đọc default agent: step/query/execute, limits, format-error billed cost, save state | Học phân loại failure/accounting; không copy default limits hoặc raw trajectory logging |

### OpenHands, Gemini CLI, OpenCode, Cline

| ID / nguồn | Phần đã đọc và bằng chứng | Giới hạn / quyết định |
|---|---|---|
| S23 — [OpenHands condenser architecture][S23] | Condenser/View/Condensation và no-op/LLM/pipeline distinction | Context management có giá; không mặc định thêm summarizer model |
| S24 — [OpenHands condenser/base.py][S24] | Read-only cached views, soft/hard condensation và fallback | Giữ lịch sử nguồn và projection riêng; không sửa cached state tại chỗ |
| S25 — [OpenHands conversation/state.py][S25] | Event log, active-branch derived view/cache và incremental tail | Bài học state ownership; không thêm branching/worktree vào phạm vi single-agent |
| S26 — [Gemini chatCompressionService.ts][S26] | Recent-output budget, summary+probe và reject summary rỗng/phình | Học negative controls; hai model turns cho compression không phải tối ưu miễn phí |
| S27 — [Gemini loopDetectionService.ts][S27] | Lặp phải không có tiến bộ; có model-based check với lịch riêng | Giữ progress guard sẵn có; không thêm model-loop reviewer/counter |
| S28 — [OpenCode compaction.ts][S28] | Prune completed tool outputs, recent/protected vùng và minimum saving | Không bỏ tool state đang pending hoặc evidence còn cần |
| S29 — [OpenCode processor.ts][S29] | So recent tool name+arguments, loại lỗi, stop/continue/compact và retry policy | Không copy doom-loop threshold hay tăng retry quyền Piagent |
| S30 — [Cline CHANGELOG][S30] | Lỗi compaction quá mạnh, retry edit lặp, native tool/model compatibility | Chỉ là changelog: dùng chọn failure scenarios, không coi là source-level proof |

### Nghiên cứu để kiểm tra giả định

| ID / nguồn | Phần đã đọc và bằng chứng | Giới hạn / quyết định |
|---|---|---|
| S31 — [SWE-agent ACI paper][S31] | Abstract: giao diện hành động ảnh hưởng khả năng tìm/sửa/test code | Không tái lập paper; model/task 2024 khác hệ hiện tại |
| S32 — [Lost in the Middle][S32] | Abstract: vị trí thông tin ảnh hưởng QA/key-value retrieval ở model nghiên cứu | Không chứng minh mọi model 2026 cùng mức suy giảm, cần controls của Piagent |
| S33 — [Cannot Self-Correct Reasoning Yet][S33] | Abstract: intrinsic self-correction thiếu external feedback có thể không giúp | Không suy thành “model không thể tự sửa” vô điều kiện |
| S34 — [Intrinsic Self-Correction Ability][S34] | Abstract: kết quả khác dưới điều kiện prompt/temperature được nghiên cứu | Không tự đổi temperature trên provider/model không hỗ trợ; kiểm chứng khách quan vẫn cần |

## 6. Quyết định ưu tiên / thử có điều kiện / hoãn

| Hướng | Quyết định | Lý do và ranh giới |
|---|---|---|
| Usage → task/outcome; tính cả thất bại | Ưu tiên đầu | Gap code xác nhận, cần cho mọi quyết định tiết kiệm |
| Context đúng nguồn, output có thể đọc lại, cache-aware | Ưu tiên sau instrumentation | Tận dụng retrieval/governor/wire có sẵn, giữ correctness |
| Feedback sửa lỗi rõ và edit freshness | Ưu tiên khi có đường lỗi cụ thể | Tránh token lãng phí ở thao tác, không nới guard |
| Task state ngắn, bước tiếp theo theo evidence | Ưu tiên | Giúp model giải quyết thay vì lặp diễn giải plan |
| SDK 0.85.1 | Thử tương thích riêng | Phiên bản mới có ích tiềm năng nhưng ảnh hưởng identity/protocol |
| Repo map / tool grouping / edit format | Thử theo task/model | Không có một cấu hình tốt nhất cho mọi model |
| Cross-task memory | Cải thiện phần hiện có có điều kiện | Phải advisory, có nguồn, đúng quyền và có lợi ích |
| Model routing tự động / giảm effort | Hoãn | Chưa có causal evidence; giữ pin và quality floor |
| Hai model architect/editor, critic sau mỗi bước | Hoãn | Thêm phí/latency, chưa chứng minh thắng single-agent |
| LLM verifier cho mọi summary/loop | Không đưa vào đợt đầu | Tăng vòng gọi; đã có deterministic safeguards |
| Vector DB, framework rewrite, swarm | Không đưa vào đợt này | Chưa có gap chứng minh cần; trái phạm vi single-agent nếu swarm |
| Universal semantic prover / benchmark-specific branches | Không theo đuổi | Quay lại vòng nghiên cứu khó kết thúc và nguy cơ overfit |
| Bỏ guard để “model thông minh hơn” | Không chấp nhận | Autonomy phải ở trong quyền và contract đã cấp |

## 7. Những gì chưa biết và cách giải hữu hạn

1. **Piagent đang lãng phí ở đâu nhiều nhất?** C1 trả lời theo chi phí task; không đoán bằng số dòng source hay số tests.
2. **Governor và SDK compaction có tương tác làm mất nghĩa?** C2/C6 kiểm đúng transitions, không blanket audit mọi provider.
3. **Context pack/routing hiện tại giúp hay làm model phân tâm?** Chọn tối đa hai giả thuyết sau telemetry; đối chứng cùng model/SDK ở C7 khi được phép.
4. **Task thật của người dùng phân bố thế nào?** Lập corpus từ backlog được quyền sử dụng; chưa có thì ghi thiếu dữ liệu, không gọi fixture là real use.
5. **SDK mới có đáng nâng?** Dùng contract matrix; nếu không có lợi hoặc không tương thích thì giữ version cũ với giới hạn rõ.

Mỗi unknown có owner là người triển khai single-agent, evidence cần lấy và giới hạn nghiên cứu trong C0. Không mở thêm lượt đọc blog chỉ để tăng số nguồn sau khi câu hỏi thiết kế đã được trả lời.

## 8. Checkpoint và bảo toàn

Nghiên cứu được thực hiện trên HEAD `c3a4427396984554eb1571e687caba0f831176ae`, branch `codex/piagent-35-recovery-20260831`, với 153 đường dẫn recovery thay đổi trước tài liệu mới. Không có source edits, tests, SDK upgrade, provider/model calls, campaign reservation, paid authority, worktree, subagent, push hay publish trong đợt nghiên cứu này. Các yêu cầu HTTP đọc tài liệu/repo công khai là hoạt động nghiên cứu, không phải phiên model benchmark.

Không khẳng định E14 full qualification đã xanh. Kết quả full lịch sử và 18 default correct-completion đỏ được giữ nguyên. Run-6 tiếp tục `INVALID_MEASUREMENT`. Mọi thay đổi source/treatment đề xuất trong PCL cần thuộc đúng phạm vi resume/identity; D-026 không tự áp cho chúng.

Chi tiết hash tài liệu và kiểm tra bảo toàn xem [checkpoint PCL](piagent-core-plan-checkpoint-2026-09-06.json). Nội dung này là nghiên cứu và kế hoạch, không phải evidence cải thiện model đã đạt.


[S01]: https://github.com/earendil-works/pi/releases
[S02]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/agent-loop.ts
[S03]: https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/compaction/compaction.ts
[S04]: https://openai.com/index/unrolling-the-codex-agent-loop/
[S05]: https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/compact_remote.rs
[S06]: https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/core/src/context_manager/history.rs
[S07]: https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5
[S08]: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[S09]: https://www.anthropic.com/engineering/writing-tools-for-agents
[S10]: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
[S11]: https://www.anthropic.com/engineering/april-23-postmortem
[S12]: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
[S13]: https://www.anthropic.com/engineering/infrastructure-noise
[S14]: https://cursor.com/blog/dynamic-context-discovery
[S15]: https://cursor.com/blog/continually-improving-agent-harness
[S16]: https://aider.chat/docs/repomap.html
[S17]: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py
[S18]: https://aider.chat/docs/more/edit-formats.html
[S19]: https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/editblock_coder.py
[S20]: https://aider.chat/2024/09/26/architect.html
[S21]: https://mini-swe-agent.com/latest/
[S22]: https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py
[S23]: https://docs.openhands.dev/sdk/arch/condenser
[S24]: https://github.com/OpenHands/software-agent-sdk/blob/8ea8e3bc1d5e84542f7702b8813734ef600c9fce/openhands-sdk/openhands/sdk/context/condenser/base.py
[S25]: https://github.com/OpenHands/software-agent-sdk/blob/8ea8e3bc1d5e84542f7702b8813734ef600c9fce/openhands-sdk/openhands/sdk/conversation/state.py
[S26]: https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/context/chatCompressionService.ts
[S27]: https://github.com/google-gemini/gemini-cli/blob/85aca163f6c73ac6ce380b5447359146b8adcae4/packages/core/src/services/loopDetectionService.ts
[S28]: https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/compaction.ts
[S29]: https://github.com/anomalyco/opencode/blob/337fd144d2ba144743368f78d9579a99cce175bd/packages/opencode/src/session/processor.ts
[S30]: https://github.com/cline/cline/blob/dac3b35ba485dbab3b5a73aca239b0d07ce071cf/CHANGELOG.md
[S31]: https://arxiv.org/abs/2405.15793
[S32]: https://arxiv.org/abs/2307.03172
[S33]: https://arxiv.org/abs/2310.01798
[S34]: https://arxiv.org/abs/2406.15673

# Plan riêng: ổn định logic Piagent và hoàn tất benchmark 108 phiên
<!-- language: vi; english-index: docs-site/content/en/benchmark.html -->

> Plan ID: **PRB-108-2026-09-06** · Version: **1.16** · Ngày: **2026-09-06**
>
> Trạng thái: **IMPLEMENTING_A_V2_OFFLINE — Number N/R5/independent verification đã duyệt; chưa qualification/B/paid**.
>
> Mục đích: bàn giao sang session khác, khép phạm vi sửa, xác thực logic và bộ đo bằng bằng chứng hữu hạn, sau đó chạy đúng một campaign 108 phiên khi đủ quyền và điều kiện.
>
> Chế độ mặc định: local, single-agent, tuần tự; không spawn subagent, tạo worktree, gọi provider, push hoặc release chỉ vì đọc tài liệu này.
>
> Đây là tài liệu nội bộ/local. Không publish đường dẫn evidence, dữ liệu phiên hoặc thông tin riêng của operator.

## 0. Cách dùng và quan hệ với kế hoạch cũ

1. Session mới đọc `AGENTS.md`, toàn bộ tài liệu này và Plan of Record cũ trước khi thay đổi source hoặc chạy qualification.
2. Đây là **kế hoạch thực thi chuyên biệt**, không tự thay thế approval, ngân sách, disposition hoặc bằng chứng bất biến trong Plan of Record cũ.
3. Operator nhận plan ngày 2026-09-06 cho R0–R1, sau đó xác nhận áp Decision A-v1 và tiếp tục offline R2–R6, gồm ba sửa grader đã nêu. Không restart P0–P10; A-SEM chưa chọn và Decision B/paid vẫn riêng.
4. Khi operator yêu cầu triển khai, thực hiện R0–R1 để khóa hiện trạng và đề xuất source/contract trước. Không lặp lại các audit đã có kết luận.
5. Khi operator nhận kế hoạch và duyệt phạm vi triển khai, ghi adoption vào decision log; đồng bộ một con trỏ và trạng thái ngắn vào Plan of Record cũ. Không tạo hai nguồn chỉ dẫn vận hành mâu thuẫn.
6. Phần trùng với lịch sử phải dùng evidence đã có nếu identity và phạm vi còn phù hợp. Bằng chứng cũ không tự chứng nhận candidate mới.
7. Chỉ dừng xin quyết định ở thay đổi quyền/phạm vi thật; không xin duyệt lại sau mỗi test hoặc mỗi phase đã có quyền.

### 0.1. Mục tiêu và ba kết luận phải tách riêng

| Kết luận | Câu hỏi cần trả lời | Điều không được suy diễn |
| --- | --- | --- |
| Runtime contract | Phiên có thực thi, kết thúc, lưu trạng thái và bàn giao đúng sự thật không? | Kết thúc lượt không có nghĩa bài làm đúng |
| Measurement readiness | Bộ đo có ghi đúng cả thành công, thất bại, từ chối, usage và cleanup không? | Bộ đo đúng không có nghĩa Piagent đạt chất lượng |
| Product/claim readiness | Piagent giải được việc trong phạm vi công bố, đạt các ngưỡng đã khóa không? | 108 record hoặc test offline xanh không chứng minh ưu thế 35% |

Mục tiêu không phải đổi tên FAIL thành PASS. Mục tiêu là sửa các lỗi đã chứng minh, có một candidate xác định và thu được kết quả trung thực.

### 0.2. Định nghĩa hoàn tất toàn nhiệm vụ

- Runtime đạt các invariant bắt buộc trong phạm vi đã chốt, gồm cả an toàn và không báo hoàn tất sai.
- Bộ chấm có đối chiếu yêu cầu–ca kiểm tra và positive/negative control; lỗ hổng đã biết được xử lý hoặc công khai đúng ảnh hưởng.
- Candidate được qualification mới, có diễn tập đủ lịch 108 offline và kiểm thử nhánh lỗi.
- Nếu đủ authority và provider không làm phép đo mất hiệu lực: thực hiện đúng 108 phiên, đủ 54 cặp, không lựa record đẹp.
- Báo cáo riêng kết quả phép đo và kết quả sản phẩm. `FAIL_VALID` hoàn tất một cuộc đo, **không hoàn tất mục tiêu Piagent đạt chuẩn**; phải giữ mục tiêu sản phẩm chưa đạt và nêu lỗi còn lại.
- Nếu `INVALID_MEASUREMENT`, giữ nguyên bằng chứng và đóng lượt chạy; không tự tạo campaign thay thế.
- Chỉ khẳng định sẵn sàng cho công việc thực tế trong phạm vi có bằng chứng; không mở rộng 27 bài synthetic thành bảo chứng mọi tác vụ trả phí.

## 1. Nguồn sự thật cho session mới

Các ký hiệu dưới đây chỉ là cách viết ngắn trong tài liệu, không phải biến môi trường. Không dùng tên biến hệ thống để thay đổi thư mục làm việc.

| Ký hiệu | Đường dẫn tuyệt đối |
| --- | --- |
| `IMPL` | `/Users/vtamm/Documents/piagent-35-recovery-20260831T090020Z/implementation` |
| `POR` | `/Users/vtamm/Documents/piagent-35-recovery-20260831T090020Z/implementation/docs/piagent-codex-benchmark-recovery-plan.md` |
| `E03` | `/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260903T164605Z` |
| `E05` | `/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260905T152654Z` |

### 1.1. Thứ tự đọc bắt buộc

- [x] `IMPL/AGENTS.md` và `POR` v3.28 hoặc bản mới hơn được xác thực.
- [x] `E05/30-d026-approval-20260906T025105Z/00-operator-d026-approval.v1.json`.
- [x] `E05/30-d026-approval-20260906T025105Z/02-source-binding-decision.md` và `03-current-checkpoint.v1.json` — xác minh tên file thực tế trước khi mở; không đoán khi khác tên.
- [x] `E05/31-benchmark-assurance-20260906T032332Z/report.md`, kèm `evidence.json`, `counterexamples.json`.
- [x] `E05/26-complete-declared-journey-observations/07-finite-failure-register.v1.json` và `12-final-canonical-offline.log`.
- [x] Các report/checkpoint cuối tại `E05/28-phase-specific-timeout-accounting/` và `E05/29-atomic-completion-audit/`, theo con trỏ đã ghi trong POR; chỉ mở artifact cần cho failure đang xử lý.
- [x] `E03/18-autonomous-budget-and-goal/38-d026-proposal.v1.json` và `39-run6-custody-d026-checkpoint.v1.json`.
- [x] `IMPL/benchmarks/production-v3/suite.json`, prompt liên quan, `variant.mjs`, `grade.mjs` và helper/reference liên quan trước khi sửa chúng.

Không mở auth, token, khóa ký hoặc raw session chỉ để tìm checkpoint. Nếu tài liệu không tồn tại hoặc hash lệch, báo đúng chênh lệch; không tự tạo tài liệu thay thế như thể evidence cũ vẫn hợp lệ.

### 1.2. Checkpoint đã quan sát trước khi tạo tài liệu này

| Hạng mục | Hiện trạng |
| --- | --- |
| Branch dự kiến | `codex/piagent-35-recovery-20260831` |
| HEAD | `c3a4427396984554eb1571e687caba0f831176ae` |
| HEAD tree | `a4170461eee0e9efaebe6bbdf3e1c411ba39e627` |
| Working tree | 48 tracked modified + 47 untracked = 95 thay đổi trước khi thêm plan này; không phải clean candidate |
| Qualification toàn kho gần nhất | 5.064 test: 4.820 PASS, 22 FAIL, 222 SKIP; không được trừ các test chạy riêng để suy ra full PASS |
| Kiểm tra grader/record hẹp gần nhất | 35 PASS / 0 FAIL / 0 SKIP; 135 calibration cases vẫn chưa bao phủ hết public contract |
| Coverage journey đã ghi | 27 scenario, 54 lượt khai báo, 27 HTTP/WS observations; chỉ 11 expected outcomes được thiết lập tại checkpoint, không phải 27 bài đúng đều hoàn tất |
| Run-6 | 13 started / 12 accepted exact / 1 unknown; `INVALID_MEASUREMENT` |
| Chi tiêu phiên | Combined used 76; cap D-026 đã duyệt 184; còn tối đa 108, không có slack |
| Quyền | D-026 đã được duyệt; source binding và qualification mới chưa được xử lý |

Plan này sẽ làm inventory thay đổi thêm; session mới phải đối chiếu từng file/hash thay vì coi con số 95 là điều kiện bất biến.

### A-v2 đã duyệt: Number, R5 và xác minh độc lập, 2026-09-06

**IMPLEMENTING_A_V2_OFFLINE.** Operator xác nhận “oke chốt thực hiện đi em, các vấn đề gì còn blocked thì phải reseach thẳn vấn đề đó” cho gói A-v2 đã trình. [Approval](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/00-decision-a-v2-approval.json): chọn pagination N/Number-Math.ceil; cho phép đúng patch R5 hai file SHA9451bed9c96a0635331abb3e934897320a079e61c7b392b5a4a28eb623a97ea0 như ngoại lệ rõ cho không đổi harness; cho phép dùng đường xác minh độc lập do host/operator quản lý và sửa hữu hạn executor/comparator theo finite register, gồm docs và compound. Điều tra trực tiếp blocker mới trong phạm vi này, không xin lại A-v1/A-v2. [R5 applied](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/02-r5-patch-applied.json);89file recovery được bảo toàn từ checkpoint083952Z, HEAD giữ c3a4427.

Đây là quyền triển khai offline và định nghĩa treatment mới có cấu hình xác minh độc lập; không gắn kết quả có verifier vào release-defaults cũ. Exact configuration/validator/image/candidate binding và qualification phải được ghi rõ trước Decision B. Không mặc định mọi18positiveFAIL đã được sửa hoặc tự xóa test cũ. B/paid vẫn chưa duyệt; không reserve, provider, regrade/reuse invalid campaign. Ngưỡng, seed,0retry và mốc12→18→54→108 giữ nguyên. A-v2 thay các chỉ dẫn lịch sử “A-SEM chưa chọn”, “không mở phạm vi proof capability” và “chờ ngoại lệ R5” chỉ trong phạm vi cụ thể nêu trên.

### A-v2 E14: khép NDJSON timeout; verifier tài liệu kiểm đúng lệnh và current source

[Actual SDK NDJSON/replay](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T135741Z/11-ndjson-v4-actual-journeys.log)4PASS/0FAIL/0SKIP: NDJSON đúng completed và recovery0model, wrong dù native xanh bị chặn, unsupported bàn giao hữu hạn; replay đúng vẫn completed. Cleanup và cold readback đạt. [46 worker controls](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T135741Z/10-worker-v4-hash-budget-isolation-controls.log) đạt. Direct diagnostic xác định Node binary119647280bytes đọc vào một temporary mất1983.9ms; worker v4 dùng buffer1MiB băm đủ cùng tệp/cùng SHA. Không tăng5s request,300000µs thread,8s watchdog,CPU hoặc256MiB. Identity worker/profile/source đổi; observation v3 không được tái nhận dưới v4. E13 các lượt7/3 và2/1 giữ nguyên.

Docs đã áp policy host rõ ràng chạy đúng Git/conditional npm, pin toolchain/frozen project dependencies và biên nhận v3 gắn byte/hash tài liệu hiện tại. [6 real native controls](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T135741Z/03-docs-real-command-controls.log) và [268 schema/composite controls](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T135741Z/06-docs-schema-composite-controls.log) PASS,0SKIP. Lượt neighbors213PASS/3FAIL giữ lại; ba lỗi thiếu schema fixtures đã bổ sung, không hạ assertion. Chưa nối/chứng minh whole docs3turn actual SDK; content/context/scope/exclusive policy/verifier/persistence/delivery vẫn cần đủ. Expiry API/default proposal và full/P5/B còn mở. [Checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T135741Z/22-current-checkpoint.json), register27 và toàn bộ recovery work được bảo toàn;0provider/paid authority.

### A-v2 E13: API migration, checkpoint/abort và lỗi thời gian NDJSON đã định vị

Đã gắn API công khai cho workflow/chat/workspace/pagination/retry/replay. [12 ca đúng actual SDK](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T125747Z/03-api-migrated-positive-journeys.log) PASS,0SKIP; workspace bỏ nhóm thừa vì câu yêu cầu chạy verification không phải API clause, giữ API trên sáu nhóm code thật. [Lượt checkpoint/continuity](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T125747Z/07-continuity-checkpoint-actual-journeys.log) giữ nguyên7PASS/3FAIL: checkpoint và abort cả đúng/sai/unsupported đạt đúng nghĩa; NDJSON correct, wrong cleanup và workspace wait đỏ. [Lượt chẩn đoán sau sửa fixture](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T125747Z/12-remaining-ndjson-workspace-diagnostics.log) giữ2PASS/1FAIL: workspace đúng completed, NDJSON sai bị chặn, NDJSON đúng còn đỏ do guest-wall-deadline ở invalid-leading-utf8, cleanup confirmed. Không tăng worker/runtime/arm budget; không dùng direct3PASS hay handoff để đóng correct-completion.

Cleanup07 đã đối chiếu và dọn đúng hai container mới thuộc lượt này; hai container lịch sử03/09 giữ nguyên. [Docs reproducer](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T125747Z/06-docs-exact-command-reproducer.json) xác nhận cần chạy Git/conditional npm thật và gắn current docs; [expiry proposal](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T125747Z/09-expiry-contract-direct.json) giữ arity1 với explicit-undefined rejection qua7 ca clock kiểm soát, chưa áp reference/oracle. [Checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T125747Z/22-current-checkpoint.json) và register27 cập nhật, correction đường dẫn RED E12 được ghi bổ sung không sửa evidence niêm phong. R2/R4 tiếp tục;18default positives và canonical4820/22/222 giữ nguyên. Chưa full qualification, B, provider hoặc paid authority.

### A-v2 E12: khép lỗ hổng kiểm API trên tenant/invoice/dedup

Actual SDK RED03 cho thấy tenant đổi arity2→3 vẫn completed khi22body cases xanh. Sửa bằng contract host khai báo rõ baseline API công khai, gắn với source snapshot và signed plan; comparator Node v3, worker v3 giữ nguyên. Quan sát hữu hạn tên export, async/generator, positional parameters/default inert value và const literal/frozen; không tự chứng minh toàn bộ API động/return semantics. Metadata không gửi guest; guest không cấp authority. Source/plan/validator drift vẫn vô hiệu biên nhận. [82/82 controls](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T122631Z/09-api-comparator-authority-neighbors.log),0SKIP; [10/10 actual tenant/invoice/dedup journeys](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T122631Z/11-tenant-invoice-dedup-api-journeys.log),0SKIP. Bản đúng completed, wrong behavior/API arity bị chặn dù native checks xanh, unsupported bàn giao hữu hạn. Invoice/dedup có contract riêng cho nghĩa vụ API trước đó đỏ. Không đổi public request/reference/grader trong E12.

[Checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T122631Z/22-current-checkpoint.json). Backend/data đã dùng declared API binding; các helper workflow/chat/workspace/pagination/retry/replay chưa migrate. PASS lịch sử của chúng không đóng coverage gap vừa tìm thấy. Expiry Date.now default/API conflict và docs Git/conditional npm/current-source composite còn mở; remaining atomic families và full qualification chưa hoàn tất.0provider, chưa B/rebind;18default positive expectations và history4820/22/222 giữ nguyên. R2/R4 tiếp tục đúng finite register; không nghiên cứu thêm bộ chứng minh tổng quát.

### A-v2 E11: replay correct-completion được khép sau sửa executor

[34/34 worker/comparator/identity controls](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T121350Z/08-clone-and-worker-neighbors.log),0SKIP; structuredClone trên inert records/arrays/primitives/Date có kiểm Node parity cho nested copy, aliases/cycles, sparse arrays và prototype/data descriptors. Getter/Proxy/typed/Map/Set/custom classes/transfer ngoài phạm vi hỗ trợ giữ unsupported, kể cả candidate catch hoặc reuse sequence. Bounds cũ giữ nguyên. [Actual configured replay](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T121350Z/09-configured-replay-after-clone.log):3/3 đúng/sai/unsupported; đúng completed cả request/recover, recovery0model, tất cả8host contracts PASS; bỏ version conflict bị chặn dù project checks xanh. Cold readback có đúng request/operation/session và cleanup. Reference và các correct-completion expectations không đổi; chỉ đưa diagnostics trước assertion để giữ lý do khi đỏ.

Worker Node profile v3, image887f3679… và digest208240c5… là identity mới, tách khỏi v2/E10. Build local dùng base pin, pull=false/network=none, không download. Build đầu thiếu allowlist module có RED03, sửa dependency closure tại06. Không dùng artifact worker cũ để qualify capability mới. [Checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T121350Z/22-current-checkpoint.json). R2/R4 tiếp tục: API invoice/dedup, docs exact command/composite và remaining families còn mở; next kiểm API false-success bằng actual mutation trong cùng configured path. Chưa full/B/paid,0provider, không miễn18default positive expectations hoặc history4820/22/222.

### A-v2 E10: năm family mới có positive; API và worker còn lỗi cụ thể

**R2/R4 ĐANG TIẾP TỤC; R6/B CHƯA ĐẠT.** [Backend03](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/03-configured-backend.log):8PASS/1FAIL; tenant và revocation đủ đúng/sai/unsupported, invoice đúng còn pending. [Billing/data11](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/11-billing-invoice-data-journeys.log):10PASS/2FAIL; billing và CSV đủ đúng/sai/unsupported, invoice/dedup đúng còn FAIL. [Retry/replay13](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/13-retry-replay-journeys.log):6PASS/1FAIL; retry đủ4variants (large-Number và thiếu await bị chặn dù native checks xanh), replay đúng vẫn FAIL. Giữ từng lượt và identity; không cộng thành full qualification. Các negative/unsupported đều có cold readback và không completed; correct recovery tenant không có, revocation/billing/retry có0model theo declared journey.

Invoice/dedup: host behavior checks PASS nhưng standalone exported-API clause chưa được chứng minh. Đã sửa nhận diện đúng hai câu API; bộ so sánh primitive hiện có vẫn không hỗ trợ default parameter, reduce hoặc array/Map body. [RED06](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/06-api-and-checker-red.log) → [77/77neighbors09](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/09-api-checker-and-neighbors.log) chỉ đóng routing và checker identity, không đóng correct-completion. Không đổi nghĩa API thành chỉ đúng tên export.

Docs: fixed Node policy trước đây có thể cấp plan dù scripts/check.mjs đã đổi và chưa thực thi script ấy; nay khóa SHA checker công khai trước plan. Actual docs Git/conditional npm vẫn cần policy/receipt bind đúng command và source tại verify. [Điều tra trực tiếp](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/10-docs-direct-research.md) chỉ rõ sourceDigest nằm trong planDigest nên không được gỡ binding để tránh drift. Replay: [worker trực tiếp14](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/14-replay-direct-worker.json) xác nhận ReferenceError vì structuredClone chưa tồn tại; đây là executor gap, không phải lý do sửa bản đúng hoặc bỏ assertion recover0model. Next: bổ sung finite Node-profile capability có version/identity mới và kiểm đúng/sai/unsupported; API dùng explicit contract thay mở nghiên cứu prover.

[Checkpoint E10](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/22-current-checkpoint.json) và [finite register](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T112258Z/21-finite-issue-register.json). Giữ18default positive expectations/full4820PASS22FAIL222SKIP, run6 INVALID_MEASUREMENT13/12/1,76/184 và paid0. E8 R5 đủ108 chỉ chứng nhận identity lịch sử; final qualification và B riêng. A-v2 đã duyệt offline, không xin lại.

### A-v2: chat, workspace và pagination có bằng chứng configured; docs còn mở

**R2/R4 ĐANG TIẾP TỤC, KHÔNG PHẢI FINAL QUALIFICATION.** Đã tái sử dụng đúng X1 error-message closure15file/hunk từ E1, giữ nativeOnly request schema; không viết bộ chứng minh mới. Worker local52af7e… đã có sẵn, Node profile v2 digest e3b562e…, không build/pull. [Adoption](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/02-adoption.json) và [11 error-message +43 authority +4 workflow](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/03-restored-message-and-current-workflow.log):58/58PASS,0SKIP.

Chat đúng đã hoàn tất toàn bộ nghĩa vụ; sai thông báo `conflict` bị worker bắt dù project checks xanh; unsupported không completed. Lượt reconnect đúng ban đầu gọi model thừa vì `/workflow review` bypass input hook. Namespace nay chỉ trả receipt hiện hữu khi idle và cùng task/session/attempt/acceptance; reader vẫn kiểm exact operation/request/parent/persistence. [RED](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/07-chat-recovery-diagnostic.log) → [19/19 gồm3chat +refusal/recovery +catalog/identity controls](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/10-chat-recovery-workflow-fix.log). Không nới kỳ vọng0model hoặc thêm counter.

Workspace [4/4actual SDK/HTTP/WS](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/14-configured-workspace-explicit-case-policy.log): đúng hoàn tất và recover0model; sai thông báo `cycle`, sai thứ tự và unsupported đều bị chặn hữu hạn. Pagination Number [3PASS/1fixture-timeout](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/18-configured-pagination-explicit-invocation.log), rồi [ca safe-integer-only1PASS](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/21-pagination-safe-integer-fixture-deadline.log): đúng hoàn tất, gồm2**54/2**55, API parent native vẫn satisfied; bản tự round hoặc thu hẹp safe-integer bị bắt với project checks xanh. Fixture timeout tăng60→120s để đủ tối đa12worker executions; không đổi arm900s, threshold hoặc retry benchmark. Hai lỗi khai báo fixture (ignoreCase/invocation) giữ RED tại12/16; validator không đổi. Không cộng lần chạy lại thành mẫu độc lập.

Điều tra trực tiếp docs phát hiện F26-02/configured-command-coverage: receipt worker Node PASS bị dùng xác nhận `git diff --check` chưa được chạy. [RED có chữ ký thực](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/22-scoped-command-coverage-red.log) → [50/50neighbor controls](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/25-scoped-command-coverage-and-neighbors.log). Runtime nay từ chối bộ lệnh chưa được protocol chứng minh, không dùng nội dung đúng để bỏ thiếu verifier. Docs source profile yêu cầu cả Git diff và conditional npm test; worker hiện có chỉ bốn nhóm Node. Cần bổ sung execution/receipt binding cho đúng lệnh và ghép với config literals, context, signed scope/tool-policy, persistence/delivery qua đường composite hiện có; actual correct docs phải hoàn tất đủ scout/implement/verify. Đây vẫn là gate mở, không lấy50PASS làm docs positive PASS.

[Checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/32-current-checkpoint.json), [register](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T102930Z/31-finite-issue-register.json). Giữ18default positive expectations và full4820PASS/22FAIL/222SKIP nguyên trạng; chưa chạy full mới. R5 đủ108offline ở identity trước delta; paid0, D02676/184 không đổi, B chưa duyệt. Next: khép các family atomic còn lại và docs configured, rồi final qualification/exact rebind. A-v2 đã cho phép tiếp tục offline, không xin lại.

### A-v2: workflow configured đủ ba lượt; quyền từng yêu cầu đã kiểm

**RUNTIME_CONFIGURED_WORKFLOW_VERIFIED; R2/R4/R6 EXIT VẪN MỞ.** [Final sau tách helper đúng giới hạn kiến trúc](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/46-configured-final-after-extraction.log):47/47PASS (43authority/schema +4actual journeys),0FAIL/0SKIP/0cancelled. [Kiểm tra tĩnh](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/45-static-fix-checks.result.json) đạt; marker tài liệu và budget500dòng đã sửa. Các lượt trước được giữ dưới đây để đối chiếu RED→GREEN. [Actual SDK/worker](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/31-configured-workflow-review-proof.log):3/3 ca đúng/sai/unsupported đạt,0SKIP. [Kiểm lại sau khóa schema](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/34-native-controls-final.log):46PASS/1FAIL; lỗi còn lại là kỳ vọng test nhầm `handoff` với `ask-operator` cho approval sai phạm vi. [Sửa đúng policy và kiểm riêng](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/37-native-source-denial.log):1PASS/0FAIL/0SKIP, runtime không đổi. Không cộng các lượt lặp thành số mẫu độc lập.

Ca đúng hoàn tất scout → implement → review trong cùng session qua generated guard và HTTP/WS;4 compound code contracts PASS bằng worker thật, review kiểm lại34public cases trên source hiện tại. Bản sai cố ý có project tests xanh nhưng worker bắt own-undefined override bằng counterexample; unsupported import `node:fs` giữ unknown và handoff hữu hạn. Cả4variants có cold readback sau đóng supervisor,0active runtimes/lease released;0provider. Default workflow assertion và18positiveFAIL cũ không bị thay hoặc miễn.

Defect cụ thể: cấu hình toàn session chỉ có primary request làm scout bị chặn vì digest không được duyệt. Sửa nhỏ ở `acceptance-host-configuration.js`, `independent-acceptance-runtime.ts` và hai schemas: request set khai báo `nativeOnly:true, contracts:[]` chỉ cho task read-only + mutation-forbidden, không tạo criterion receipt. Request không khai báo vẫn bị chặn. Native-only dùng sai trên source-task giữ pending,0independent observations và ask-operator. Review là source-change/mutation-allowed nên dùng contract riêng kiểm lại nghĩa vụ gốc; không dùng native-only để bỏ qua proof.

Treatment vẫn là configured-host-verification A-v2 ở test-owned fixture, chưa operational approval hoặc đăng ký paid. [Register](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/41-finite-issue-register.json), [checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/43-current-checkpoint.json). R5 trước đó đủ108offline nhưng identity trước runtime delta; không nâng thành qualification cho candidate mới.

Next đã xác định hữu hạn: tái sử dụng error-message capability15file đã bảo toàn ở E1 để khép nghĩa `conflict`/`cycle`, sau khi merge hunk/kiểm hash và worker identity; không viết bộ chứng minh mới. Docs đúng phải nối content/config + scope/tool-policy signed journal + verifier + persistence/delivery qua composite/scoped broker hiện có; content-only không đủ. Hoàn tất các positive gates còn lại trước canonical full và proposal B. Không hỏi lại A-v2; B/paid vẫn riêng.

### A-v2 hiện hành: R5 đủ108 offline; runtime configured đang triển khai

[Diễn tập](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/22-r5-full108-summary.json) chạy chung production schedule qua explicit offline seam:108accepted/108started,54pairs,54 mỗi arm,0retry/0unknown; ledger/manifest/governor khớp tại12→18→54→108,5580fresh token giả lập,54Codex homes đã xóa,54Pi runtimes/leases đã đóng. [Ledger và manifest riêng](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/20-offline108-retained/retention-receipt.json) được giữ trước khi xóa test-owned workspaces; không giữ raw session/auth/oracle. [Exact source94files](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T091158Z/24-r5-source-checkpoint.json) được bảo toàn trước delta kế tiếp.

Có68outcomes `none`,32`agent_task_failure`,8`safety_refusal_correct`; không biến quality FAIL thành PASS.82/108declared Pi turns thật sự chạy/cold-readback;26journeys dừng sớm vì task/operation chưa đạt, không nhận coverage cho26turns chưa chạy. R4 trước đó vẫn55tests37PASS/18FAIL, full4820PASS/22FAIL/222SKIP. Đây là diễn tập measurement với scripted model/usage và Codex event fixture, actual SDK/HTTP/WS/evaluator/WAL/ledger/budget; không chứng nhận native provider, production wire/registration, configured treatment hoặc launcher watchdog toàn process.

R5 RED đầu được giữ tại13/16:fixture circuit thiếu schema và giả định mọi quality failure xảy ra ởturn cuối; sửa fixture, không sửa task truth. Cặp có quality failure đạt4records, next arm tiếp tục; unknown injection đạt1accepted/2started/1unknown,khôngthirdattempt. Runner/ledger/budget regression98/98; calibration N37/37. Không cộng các nhóm thành full qualification. Worker local đã xác minh khớp current Node profile bằng isolated execution/cleanup; không pull/upgrade.

Next:kiểm actual workflow configured với correct/wrong/unsupported rồi khép các pending criteria hữu hạn. N đã chọn nhưng câu giữ API được phục hồi nguyên văn sau R5 vì phần Number wording không nên thay obligation API; giữ thay đổi Math.ceil/Number và calibration, không historical regrade. Vì có delta sau rehearsal, R6 phải bind final identity và final qualification; B/paid vẫn đóng.

### Checkpoint kế thừa: R4-08 đọc lại dữ liệu sau khi đóng phiên, 2026-09-06

**R4-08 COMPLETE; R4 EXIT CHƯA ĐẠT.** [Report](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T083952Z/12-report.md), [checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T083952Z/13-current-checkpoint.json), [ma trận](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T083952Z/08-readback-matrix.json): 27 scenario / 54 lượt khai báo, 55/55 ca đọc lại đạt sau khi đóng connection/supervisor; fresh SDK và inspection đọc dữ liệu trên đĩa, branch/task hash và request/operation/parent khớp, runtime active0 và lease released. Không có bằng chứng process crash, mất điện hoặc browser DOM. Cùng lượt kiểm tra này giữ nguyên 37 PASS / 18 FAIL / 0 SKIP / 0 cancelled về kết quả sản phẩm; không sửa expected values và không đóng positive-completion gaps bằng handoff. Delta chỉ gồm hai test helpers, inventory public exposure và tài liệu. Core/suite giữ identity E6; full gần nhất vẫn 4820/22/222. [Register26rows](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T083952Z/11-finite-issue-register.json) kế thừa nguyên lỗi/disposition. R5 full108 vẫn chưa thực thi vì patch hai file runner chưa được auto-review cho phép; A-SEM, positive/P5, B/S0/freeze còn mở.0 provider mới, không paid authority.

### Lịch sử: R5 full journey và lỗi delivery reader, 2026-09-06

**OFFLINE_PROGRESS_REBIND_CLOSED.** [Report](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T081322Z/15-report.md) / [checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T081322Z/16-current-checkpoint.json): đã nâng quality/accounting test qua actual full WebUI journey và cold disk readback. Phát hiện rồi sửa M-DELIVERY-CUSTOM: refused recovery có biên nhận custom nhưng benchmark chờ assistant nên timeout; bounded reader nay kiểm exact user/request/operation/parent. Final13reader controls và4actual chains PASS,0FAIL/0SKIP; refusal+reconnect khoảng2,3s,1model message/0tools, đúngusage vàcleanup. Không đổi task authority/grader/threshold. [Finite register26rows](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T081322Z/14-finite-issue-register.json) giữ25rows cũ và thêm1defect, full4820/22/222 và18positiveFAIL chưa đổi. Test selection sai lệch ởlog06 được ghi trong note09, final dùngempty test-owned homes. Patch shared scheduler vẫn chưa áp vì auto-review; câu hỏi exact exception đang chờ, không xin lại A-v1. R5full108/R4readback toàn27/P5/A-SEM/B còn mở;0external provider mới.

### Lịch sử: R5 tiếp tục sau xác nhận A, 2026-09-06

**PAUSED_AUTO_REVIEW_SCOPE; A-v1 đã duyệt, không xin lại.** Operator nhắc tiếp tục không hỏi quyền đã cấp. [Patch hai file runner và next action](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T073448Z/01-r5-proposal-and-checkpoint.md) đã chuẩn bị ngoài implementation; normalized loop giữ nguyên và hai file đạt syntax checks. Bộ xét duyệt tự động từ chối áp hai lần, xác định offline schedule seam mới vượt ranh giới không đổi harness; kể cả sau đối chiếu scope/patch. Chưa thay source runner/runtime,0runtime tests/0provider/0executed108 records mới. Cần quyền cụ thể cho đúng patch đã có hash, không dùng workaround. R5-04/05 còn mở; A-SEM/positive/P5/B giữ nguyên. [Checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T073448Z/02-current-checkpoint.json) thay con trỏ trạng thái hiện hành, không thay lịch sử niêm phong.

### Lịch sử: trạng thái goal sau blocked audit, 2026-09-06

**BLOCKED_OPERATOR_DECISION; mục tiêu đầy đủ chưa hoàn tất.** [Readback/audit ba lượt](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T065929Z/01-blocked-checkpoint.md) xác minh87 source hashes, parent evidence và3run6custody không drift; không còn test process để chờ. A-SEM chưa có lựa chọn;18 positive expectations/P5 và full108 integration vẫn mở sau bounded fixes. Giữ A-CORE/A-GRADER đã duyệt, không xin duyệt lại; không thêm proof capability/authority hoặc chạy full/audit lặp. Cần chốt proposal27 trước arithmetic/public contract change; lựa chọn đó không miễn các gate còn lại.0 tests/0 provider mới trong lượt audit này.

### 1.2a. Checkpoint A-v1 đã áp dụng và offline hiện hành, 2026-09-06

Operator đã xác nhận **“Xác nhận áp Decision A-v1 và tiếp tục offline”**: A-CORE/A-GRADER và công việc offline R2–R6 được duyệt; A-SEM chưa có lựa chọn. [Approval](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T045530Z/00-operator-approval.json), [report và next action](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T045530Z/40-final-report.md), [checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T045530Z/46-checkpoint.json), [register cập nhật](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T045530Z/41-finite-issue-register.md). R0/R1 packet tại `benchmark-validity-recovery-20260906T040920Z` giữ nguyên, manifest SHA `6f6d632142a5927cc37b3f46af55709af35173835275758216f5212a24f1ebb6`.

Đã áp đúng selection 14 tracked baseline files và chuyển 1 untracked test, sau khi kiểm hash bản bảo toàn; toàn bộ96 file R0 còn phục hồi được. HEAD `c3a4427396984554eb1571e687caba0f831176ae`, branch và nội dung staging giữ nguyên; hash byte index đã đổi từ R1, khớp snapshot trước R4 (readback50); working tree chưa qualified hoặc commit. [Selection receipt](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T045530Z/01-selection-receipt.json) và inventory cuối ghi từng file/hash, không dùng con số95 làm điều kiện bất biến.

Đã sửa tenant/CSV/retry reference và đúng3 grader checks đã duyệt; sửa literal invalid-clock/local window/-Infinity routing; ngăn generic smoke tự chứng nhận nội dung docs; đóng bypass critical receipt khi zero-delta và không suy yêu cầu sản phẩm bắt buộc từ lifecycle metadata. Hai module được tách nguyên logic để đạt giới hạn kiến trúc; không thêm năng lực proof hoặc continuation counter. Ba calibration controls có RED→GREEN; calibration34/34, review controls5/5, fault chains109/109, neighbors/package142 PASS/0 FAIL/4 SKIP; browser22/22. Các nhóm này có overlap và revision riêng, không cộng thành qualification.

R4 đã quan sát27 scenario/54 declared turns qua scripted SDK/HTTP/WS trên các revision ghi trong log; 55 journey/control tests có37 PASS/18 FAIL,0 SKIP. Tất cả18 FAIL là positive-completion expectations còn giữ; wrong-docs control nay đạt nhưng correct-docs vẫn pending. [Ma trận](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T045530Z/42-journey-observation-matrix.md) không được dùng như kết quả một final immutable candidate. Runtime, measurement và product được tách trong register.

R5 mới kiểm scheduler/binding đúng108 cells/54 pairs,54 mỗi arm, seed và các mốc12→18→54→108; chưa thực thi full108 record replay.109 fault tests là evidence theo seam hiện có, không phải một campaign108. P5/full gần nhất vẫn **4.820 PASS / 22 FAIL / 222 SKIP / 0 cancelled**; không chạy full mới khi positive gates còn đỏ. R2/R3/R4/R5/R6 exit chưa đạt; kết luận **NOT_READY_TO_DISPATCH**.

Pagination A-SEM đang chờ lựa chọn cụ thể tại [proposal27](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T045530Z/27-arithmetic-decision.md); không tự chọn Number/Math.ceil, BigInt hoặc thu hẹp miền. Giữ release-defaults, P5 bắt buộc, reviewer waiver/reviewed=false và mọi threshold. Không có candidate rebind B, policy-bound S0/freeze, campaign reservation hoặc paid authority mới. Run6 giữ13started/12accepted exact/1unknown, INVALID_MEASUREMENT; combined76/184,0retry,3M fresh/4h và unknown-stop không đổi. Provider sessions mới **0**.

### 1.2b. R5 continuation trên final runtime delta, 2026-09-06

[Evidence bổ sung](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T064300Z/04-r5-current-evidence-and-gap.md) / [checkpoint](/Users/vtamm/.pi/agent/benchmarks/piagent/benchmark-validity-recovery-20260906T064300Z/06-current-checkpoint.json):2 quality/accounting chains đạt trên core/suite identity parent, sau khi supervisor đóng vẫn giữ native pending → valid quality-failure record và SDK-inspected fixture usage. Boundary thực thi xác nhận production entry từ chối injected journey trước dispatch; explicit offline session seam không được chọn bởi main schedule.0 provider mới, không đổi runtime/treatment/grader. R5 full108 replay vẫn mở; không ghép108 record bằng runner khác để thay bằng chứng. R4 positive18FAIL và full4820/22/222 giữ nguyên. A-SEM chưa chọn, B/paid chưa có.

### 1.3. Hai lưu ý ngăn chẩn đoán sai ngay từ đầu

**Runtime đã có global continuation maximum 1 và progress-signature guard.** Không được kết luận chưa có giới hạn vòng lặp rồi thêm một budget trùng lặp. Cần xác minh vì sao một yêu cầu không thể kiểm chứng vẫn đi vào diagnostic continuation, và tại sao một số lời giải đúng chưa hoàn tất được.

**Đường ghi quality failure thành record hợp lệ đã có evidence cục bộ.** Xem `E05/24-measurement-boundary-chain/`; cần nối/kiểm chứng phạm vi còn thiếu, không viết lại evaluator chỉ để tái tạo điều đã có.

## 2. Quyền, phạm vi và các việc không làm

### 2.1. Hai điểm quyết định, không sinh approval sau mỗi lỗi

**A — Khóa cách triển khai candidate và contract sau R1:**

- Bảo toàn toàn bộ recovery work; xác định những thay đổi sẽ thuộc candidate.
- Duyệt cách đưa candidate về một source identity có thể tái lập mà không mất các thay đổi ngoài candidate.
- Chốt phạm vi hỗ trợ logic/verification và disposition của các known failures.
- Nếu cần thay đổi policy, treatment, grader hoặc nghĩa qualification thì nêu riêng từng thay đổi; không gộp thành “fix nhỏ”.

**B — Rebind và mở paid sau R6:**

- Bind exact commit/tree/package/candidate/suite/configuration/policy/runtime closure mới.
- Giữ hoặc ghi rõ thay đổi so với D-026; không suy rằng approval ngân sách tự duyệt candidate khác.
- Chỉ chạy paid khi approval và các gate thực tế đều đủ. Nếu operator đã cấp conditional authority rõ cho đúng những nội dung này, dùng đúng authority đó; không xin lại chỉ vì đổi phase.

Hai điểm quyết định là đề xuất quy trình, không phải hai approval đã tồn tại.

### 2.2. Ranh giới cứng

- Không thay code, prompt, grader, oracle, seed, model, thứ tự, timeout hoặc threshold trong campaign trả phí.
- Không resume/retry/regrade/reconcile/reuse/merge run-6 hoặc các lineage cũ bị invalid.
- Không lấy test do model vừa viết hoặc lời model nói “xong” làm quyền độc lập chứng nhận hoàn tất.
- Không cung cấp hidden oracle cho model/candidate hay hardcode tên scenario vào core Piagent.
- Không bật independent-verifier authority, cài verifier/image hoặc ký cấu hình thay operator.
- Không giảm an toàn, tắt completion gate, xóa test đỏ hoặc đổi unsupported thành completed để đạt số phiên.
- Không dùng 108 phiên trả phí làm integration test.
- Không nâng dependency/model/provider, đổi sang Oh My Pi/OpenClaw/OpenClaude hoặc xây harness mới trong đợt này.
- Không thêm private holdout, reviewer giả hoặc claim tổng quát. Waiver reviewer vẫn là waiver, `reviewed=false` phải giữ trung thực.
- Không stash/reset/checkout/discard toàn bộ working tree, tạo worktree mới, push hoặc publish nếu chưa được yêu cầu cụ thể.
- Workspace `/Users/vtamm/Documents/pi-company-platform` chỉ để đọc hướng dẫn; không triển khai ở đó.

## 3. Bài học mã nguồn mở được áp dụng có giới hạn

Đã khảo sát ngày 06/09/2026; đây là đọc source/CI và release notes, chưa tự chạy toàn bộ test của các repo. Những cách làm sau là gợi ý thiết kế, không phải bằng chứng Piagent đã đạt.

| Nguồn đã đọc | Áp dụng vào plan | Không sao chép |
| --- | --- | --- |
| [Oh My Pi release gate](https://github.com/can1357/oh-my-pi/blob/b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b/.github/workflows/ci.yml#L476) | Chia nhóm kiểm thử, gom một release gate; đúng artifact và identity | Toàn bộ CI đa nền tảng, tính năng hoặc toolset mới |
| [Oh My Pi session durability test](https://github.com/can1357/oh-my-pi/blob/b2f25dbfe1e30197bae311cd8a0bccbc381f5c7b/packages/coding-agent/test/session-manager-immediate-persist.test.ts#L86) | Kiểm tra trạng thái thực được lưu, không chỉ event ở bộ nhớ | Khẳng định ghi vào OS cache là bảo đảm chịu mọi mất điện |
| [OpenClaw agent loop](https://github.com/openclaw/openclaw/blob/4b577944c8597c2d0c6406a1c214b412f68d0e8a/docs/concepts/agent-loop.md) | Owner terminal rõ; tách execution/persistence/delivery, wait timeout/run timeout, writer identity | Các fallback/retry làm thay đổi treatment 0 retry |
| [OpenClaw testing](https://docs.openclaw.ai/help/testing) | Tách unit, integration, package, transport, live-provider; targeted trước full | Gọi mock là live proof hoặc coi phát hành thường xuyên là không có lỗi |
| [OpenClaude loop-guard regressions](https://github.com/Gitlawb/openclaude/blob/0abfca30e5a2945678415f5328691584387720fb/src/query/toolFailureLoopGuard.test.ts#L140) | Phân biệt lỗi lặp, tiến bộ thật và user abort; test xuyên query loop | Thêm bộ đếm mới khi Piagent đã có budget và progress guard |
| [OpenClaude release workflow](https://github.com/Gitlawb/openclaude/blob/0abfca30e5a2945678415f5328691584387720fb/.github/workflows/release.yml) | Test bản cài/đóng gói, không chỉ source tree | Publish hoặc cài global trong session này |

Không tiếp tục khảo sát hàng loạt harness khác trừ khi một failure cụ thể thiếu phương án và nguồn trên không giải quyết được.

## 4. Sơ đồ phase và điều kiện đi tiếp

| Phase | Kết quả bàn giao | Gate chính | Provider |
| --- | --- | --- | --- |
| R0 | Snapshot và custody hiện hành | Không mất work, không lệch evidence chưa giải thích | 0 |
| R1 | Candidate/contract decision, danh sách lỗi đóng | Phạm vi và quyền triển khai đã rõ | 0 |
| R2 | Sửa logic runtime có reproducer | Đúng hoàn tất, sai không lọt, unsupported bàn giao hữu hạn | 0 |
| R3 | Xác thực reference và grader | Tiêu chí–test đối chiếu được, positive/negative đúng | 0 |
| R4 | Journey qua runtime/package thật | Đủ 27/54 và kết quả từng nhánh đúng, phạm vi proof rõ | 0 |
| R5 | Diễn tập lịch 108 và nhánh lỗi | Runner/accounting/stop/cleanup khép kín | 0 |
| R6 | Qualification + approval binding + S0/freeze | Đúng candidate, đúng quyền, không gate đỏ chưa xử lý | 0 |
| R7 | Một campaign, tối đa 108 phiên | Theo D-026/rebind, không tuning giữa run | ≤108 |
| R8 | Báo cáo kép và checkpoint đóng | Phân biệt đo hợp lệ với sản phẩm đạt chuẩn | 0 thêm |

R0–R6 là phạm vi chuẩn bị offline. R7 là mốc mở chi phí duy nhất. Thứ tự có thể tận dụng bằng chứng sẵn có, nhưng không nhảy gate bằng một kết quả hẹp.

## 5. R0 — Tiếp nhận, bảo toàn và xác minh hiện trạng

**Mục tiêu:** session mới biết chính xác đang tiếp tục từ đâu, không “khởi động lại hai tuần sửa”.

- [x] R0-01: xác minh đúng repo, branch, HEAD/tree; đọc chỉ dẫn và checkpoint theo mục 1.
- [x] R0-02: ghi inventory tracked/untracked, hash các file thay đổi và các package/runtime đang dùng; phân biệt file plan mới với 95 thay đổi phục hồi trước đó.
- [x] R0-03: đối chiếu source hash với stage30; chỉ điều tra các delta mới thật, không audit lại 95 file từ đầu nếu byte-identical.
- [x] R0-04: kiểm tra hash run-6 manifest, attempts và accepted ledger với custody receipt; không sửa record hoặc tính unknown thành zero.
- [x] R0-05: kiểm tra read-only run-7 root, campaign pointer/lock và tiến trình liên quan. Nếu có lượt khác đang chạy, không tạo writer cạnh tranh; báo operator phối hợp.
- [x] R0-06: tạo evidence root mới có timestamp UTC trong recovery namespace khi bắt đầu triển khai; ghi manifest nguồn và liên kết evidence kế thừa.
- [x] R0-07: lập bản sao bảo toàn có kiểm chứng cho các thay đổi trước khi thực hiện lựa chọn source. Không stage/commit secret, raw session, auth, cache hay local trust.
- [x] R0-08: xuất checkpoint ngắn: state, authority, known blockers, next exact action; không mở provider.

**Đầu ra đề xuất:** `00-baseline-state.json`, `01-source-inventory.json`, `02-custody-check.json`, `03-checkpoint.md` trong evidence root mới.

**Exit:** chênh lệch đã được xác định; mọi work giữ nguyên; biết rõ không có campaign đang bị ghi đồng thời.

**Không làm:** full rerun để “xem còn lỗi gì”, đọc secret hoặc dựng lại campaign cũ.

## 6. R1 — Khóa candidate, contract và danh sách lỗi hữu hạn

**Mục tiêu:** một phương án có thể thi hành; không chỉ thêm một report về blocker cũ.

### 6.1. Candidate tối thiểu nhưng đủ phụ thuộc

- [x] R1-01: dùng `c3a4427` làm mốc tái lập; không dùng nguyên bản cũ vì đã biết có lỗi đo refusal, cũng không mặc định nhận toàn bộ recovery tree.
- [x] R1-02: phân loại từng hunk/file cần thiết: measurement repair, runtime correctness, test/reference, experimental proof expansion, docs/generated/dependency.
- [x] R1-03: tạo allowlist candidate gồm fix có evidence và dependency closure thực sự cần. “Tối thiểu” không phải đạt một số lượng file tùy ý.
- [x] R1-04: ghi những thay đổi chưa chọn sẽ được giữ ở đâu, cách phục hồi và hash; xin đúng quyền trước khi đưa chúng ra khỏi active candidate. Không tự tạo worktree/checkout mới hoặc đảo patch trên work người dùng.
- [x] R1-05: không thêm proof capability/recognizer mới để cố đóng từng bài. Nếu core contract thật sự cần capability mới, nêu như thay đổi kiến trúc có lựa chọn và tác động, không mặc định triển khai.

### 6.2. Danh sách lỗi kế thừa — bắt buộc có disposition từng lỗi

| Cụm đã biết | Cách xử lý bắt buộc |
| --- | --- |
| Ba reference/coverage defects: tenant numeric ID, CSV `""`, retry integer domain | Tái dùng phản ví dụ đã có; sửa reference trong phạm vi đã duyệt và kiểm tra grader tương ứng; không chữa bằng cách viết lại đề |
| False negative của early correct refusal trong journey | Giữ regression và fix cần thiết; xác minh refusal đúng không lẫn unexpected refusal/unsafe action |
| Hai docs assertions | Xử lý cả false completion của bản thiếu restart command và pending của bản đúng ở review; không chỉ chữa một phía |
| Hai compound-authority gaps | Phân biệt thiếu năng lực/authority với lỗi bài làm; không tự bật verifier để lấy PASS |
| Một pagination arithmetic question | Khóa nghĩa public contract và miền input; không chọn cách tính sau khi nhìn paid output |
| Mười hai atomic completion gaps | Dùng map stage29: routing defect, ngoài hợp đồng, missing witness, unsupported phải tách riêng; không gom thành một root cause |
| Hai measurement tests khác nhau giữa full và targeted | Dùng sửa fixture phase-specific stage28 và evidence đã có; xác minh trên candidate cuối, không tăng timeout để che lỗi |

Các dòng trên có quan hệ với 22 failing tests lịch sử, không phải số lượng root cause độc lập để cộng lại.

Mỗi issue có: `id`, observed evidence, expected contract, root-cause confidence, minimal reproducer, file/hunk owner, positive control, negative control, gate impact, disposition, next action.

- [x] R1-06: không đánh đồng `sourceOk=false` với “implementation sai”.
- [x] R1-07: phân biệt lỗi chặn phép đo với lỗi chất lượng sản phẩm; riêng policy violation, data loss và false success nghiêm trọng không được hạ thành backlog để mở paid.
- [x] R1-08: chốt miền runtime phải hỗ trợ cho release-defaults. Nếu correct reference nằm trong miền hỗ trợ thì phải hoàn tất; chuyển nó thành unsupported là thất bại sản phẩm, không phải sửa xong.
- [x] R1-09: lập bảng ánh xạ ngưỡng claim hiện có giữa suite, policy và goal report; không giản lược mọi ngưỡng thành một con số 35%. Bất nhất phải giải quyết trước freeze, không chọn điều kiện dễ hơn.
- [x] R1-10: ghi Decision A. Khi chưa duyệt thay đổi source/contract cần thiết, dừng triển khai phần đó; có thể hoàn tất các read-only checks còn thiếu.

**Đầu ra:** candidate manifest dự kiến; finite issue register; contract matrix; danh sách thay đổi quyền và quyết định A.

**Exit:** mỗi lỗi có đường xử lý hoặc giới hạn rõ; không còn chỉ dẫn “thử thêm một recognizer rồi xem”. R1-08 và A-CORE/A-GRADER đã được operator duyệt; R2–R6 offline đã có quyền. A-SEM chưa chọn; mọi phase exit vẫn phải đạt gate thực tế.

## 7. R2 — Sửa đường hoàn tất và bàn giao trong runtime

**Mục tiêu:** kết thúc đúng sự thật, giữ an toàn và không tạo thêm continuation vô ích.

### 7.1. Tái sử dụng schema và owner hiện có

- [x] R2-01: lập bản đồ đường vào → operation → durable task → receipt → Gateway/WebUI → evaluator. Chỉ định owner cho terminal từng tầng; không thêm schema mới nếu schema hiện tại đủ.
- [x] R2-02: giữ nguyên raw outcome và lý do; adapter có thể chuẩn hóa cho measurement nhưng không được ghi đè sự thật runtime.
- [ ] R2-03: kiểm tra non-composite không bị ép qua composite gate; composite vẫn fail-closed khi thiếu persistence/delivery hoặc authority bắt buộc.
- [x] R2-04: intermediate turn có thể operation completed nhưng task pending; final turn phải có disposition cụ thể. Không ép task xong ở scout hoặc implement khi journey còn verify.
- [ ] R2-05: phân loại ba đường: counterexample thật → sửa trong budget; thiếu evidence có thể thu thập → verification hữu hạn; unsupported/thiếu authority → handoff rõ, không tiếp tục sửa source vô ích.
- [x] R2-06: dùng continuation maximum và progress-signature hiện có. Test chứng minh không vượt budget, không reset bằng cách đổi thông điệp, không thêm một cơ chế đếm cạnh tranh.
- [x] R2-07: thông tin missing proof không tự cấp quyền sửa hoặc tự phê chuẩn; negative test ngăn stale/partial/tampered receipt, oracle leak và self-certification.
- [ ] R2-08: sửa hai chiều của docs completion; generic verifier xanh không đủ để xác nhận nội dung bắt buộc hiện diện.

### 7.2. Ma trận invariant tối thiểu

| Ca | Điều phải chứng minh qua runtime |
| --- | --- |
| Correct + authoritative current evidence | Native durable task hoàn tất; final response và wire khớp |
| Wrong + executable counterexample | Không completed; failure giữ đúng nguyên nhân |
| Missing tests, có đường verification | Chỉ hành động có thể tạo evidence mới, trong budget |
| Unsupported/authority absent | Handoff hữu hạn, không báo PASS, không tự cấp authority |
| Protected refusal đúng | Refused đúng, không thao tác bị cấm, không unknown |
| Unexpected refusal / policy violation | Không bị hợp thức hóa thành correct refusal |
| Abort trước request / giữa stream / sau native terminal | Phân biệt phase; không bịa usage hoặc làm mất completed terminal đã xác thực |
| Duplicate/reordered/stale terminal | Không ghi trùng, không để lượt cũ đổi kết quả lượt mới; conflict bị phát hiện |
| Reconnect / uncertain send | Giữ request/session identity; không tự replay request trả phí |
| Persistence/cleanup failure | Không báo thành công giả; đủ evidence để dừng admission |

- [x] R2-09: ưu tiên typed event/receipt sẵn có; hạn chế suy outcome từ từ khóa trong prose. Nếu fallback bắt buộc, có contract và negative tests rõ.
- [ ] R2-10: mỗi patch đi theo RED → smallest fix → GREEN → neighboring tests. Không chạy full suite trước khi reproducer đã xanh.

**Vị trí khảo sát:** `runtime/hooks/completion-hook.ts`, `runtime/recovery/`, `runtime/verification/`, `runtime/registration/task-completion-tools.ts`, `extensions/acceptance-receipt.js`, Gateway/session-stream và ba script journey/evaluator đang thay đổi.

**Checkpoint 1.2:** R2-01/02/04/06/07/09 có evidence runtime/receipt/collector trong report40 và logs20/26/32/33/35/39. R2-03/05 vẫn cần đạt toàn ma trận; R2-08 mới đóng false-success, correct-docs chưa hoàn tất. R2-10 chỉ đạt cho các predicate đã sửa, không đóng positive gate.

**Exit:** ma trận bắt buộc đạt trên candidate; positive và negative đều đúng; không còn false success hoặc lặp ngoài budget trong các đường đã khóa.

## 8. R3 — Xác thực reference, oracle và bộ chấm offline

**Mục tiêu:** dùng phép kiểm tra độc lập với lời model, không tự tin từ số lượng test.

- [x] R3-01: giữ workload 27 bài/9 family/2 surface/2 repeat. Không thêm family, thay độ khó hoặc tuyển chọn lại bài theo kết quả paid.
- [x] R3-02: đối chiếu từng tiêu chí public prompt với assertion; ghi rõ miền input, boundary, invalid input và yêu cầu không mutate.
- [x] R3-03: sửa ba reference defects đã có reproducer; kiểm tra cả ba phản ví dụ cụ thể, không chỉ các giá trị random hiện sinh.
- [ ] R3-04: mỗi scenario có known-correct và targeted near-miss cho nghĩa quan trọng. Dùng năm loại calibration hiện có làm nền; chỉ thêm controls cho lỗ hổng thật, không nhân test vô ích.
- [ ] R3-05: positive/negative labels dựa vào contract và phép kiểm tra thực thi; không dùng chính reference đang bị nghi ngờ làm nguồn chân lý duy nhất cho cả input và expected.
- [x] R3-06: kiểm tra metadata integrity, grader crash, missing result, stale oracle, mutation ngoài scope, task refusal/safety và output leak.
- [x] R3-07: oracle nằm ngoài workspace và không đi vào prompt/context/source của candidate; fixture secrets phải synthetic.
- [x] R3-08: ghi trường semantic nào được fixture cung cấp và trường nào được native runtime quan sát. Không gọi kết quả mock là provider proof.
- [x] R3-09: nếu cần sửa grader/oracle, viết change review và diff riêng; operator phải duyệt measurement-definition change trước freeze/paid. Không dùng plan này như blanket waiver.
- [x] R3-10: giữ historical grades/evidence; không regrade run-6 để chữa outcome.
- [x] R3-11: thống kê coverage theo criterion và family, không dùng số test làm số mẫu độc lập. Không bỏ nhãn `reviewed=false` khi không có reviewer thật.

**Checkpoint 1.2:** R3 kế thừa audit/matrix stage31 và R1, thêm đúng3 controls được duyệt. R3-04/05 còn arithmetic blindspot chưa khóa; 34 PASS không chứng nhận known-correct toàn miền pagination.

**Đầu ra:** criterion-to-check matrix, calibration report, reference fixes, grader change review nếu có, explicit blindspots.

**Exit:** known-correct/known-wrong phân biệt đúng trong miền đã khóa; không còn known misgrading ở workload dự định đo; không có assertion bị nới theo kết quả mong muốn.

## 9. R4 — Xác thực 27 journey qua runtime và package thật

**Mục tiêu:** chứng minh code đã sửa thật sự nằm trên đường người dùng và runner sử dụng.

- [x] R4-01: tái dùng coverage 27/54 và các helper/journey hiện có; xác định phần cần chạy lại do candidate thay đổi.
- [x] R4-02: build/install vào test-owned isolated fixture từ candidate thực, nạp đúng guard, WebUI extension, profile, settings và runtime closure. Không dùng facade bỏ qua entry point rồi gọi là package proof.
- [x] R4-03: phát scripted model response qua seam được khai báo; phần intake, tools, supervisor, SDK, HTTP/WS, persistence và evaluator còn lại đi đường thật trong phạm vi đo.
- [x] R4-04: chạy đầy đủ 27 scenario / 54 declared turns cho các expected journeys; giữ thứ tự scout/implement/verify và request/recovery.
- [ ] R4-05: từng scenario có cả positive và relevant negative outcome. Positive được phép refusal đối với bài safety; không ép 27 scenario đều có taskStatus completed.
- [ ] R4-06: correct candidate + evidence hợp lệ thuộc miền hỗ trợ phải hoàn tất; wrong implementation không lọt; unsupported chỉ đạt bài test handoff, không đạt bài test completion.
- [x] R4-07: xác minh requestId/sessionId/taskId/turn index/receipt/wire/evaluator khớp; không sửa expected value theo nhánh vừa quan sát.
- [x] R4-08: đọc lại dữ liệu persisted sau khi process/connection kết thúc; nếu test crash chỉ chứng minh software-crash thì ghi đúng, không tuyên bố chịu mất điện.
- [x] R4-09: chạy browser regression hiện có cho UI bị ảnh hưởng. HTTP/WS observations không tự trở thành DOM/browser E2E; chỉ mở rộng browser case khi có failure hoặc contract UI bắt buộc.
- [x] R4-10: ghi treatment mặc định và mode verifier chính xác; kết quả bật private verifier không được gắn nhãn release-defaults.

**Checkpoint 1.2:** R4-04 là coverage27/54 đã quan sát, không phải mọi expected outcome đạt hoặc final-candidate qualification. R4-05/06 còn18 positive assertions đỏ; R4-08 đã có55/55readback cho toàn27/54 sau connection/supervisor close tại checkpoint083952Z; không tuyên bố process exit/crash hoặc mất điện.

**Đầu ra:** journey matrix gồm expected/actual native task, transport, semantic, grade, evidence mode và test pointer; package identity report.

**Exit:** các invariant bắt buộc và expected outcomes trong miền release đã chọn đạt. Nếu còn completion gap, giữ product gate đỏ; không đóng R4 chỉ vì đã quan sát đủ 27 bài.

## 10. R5 — Diễn tập toàn bộ lịch 108 và fault injection

**Mục tiêu:** kiểm tra máy điều phối benchmark trước khi dùng model trả phí.

### 10.1. Một lịch offline 108, không phải paid evidence

- [x] R5-01: tái dùng campaign scheduler/runner, budget governor, evaluator, ledger và cleanup hiện có; không tạo runner thứ hai chỉ dùng cho test.
- [x] R5-02: offline replay dùng mock/scripted provider ở boundary thấp nhất có thể. Stock Codex collector phải được kiểm tra bằng fixture transcript contract; không sửa binary stock hoặc tuyên bố đã chứng minh native provider.
- [x] R5-03: giữ nguyên 27 × 2 × 2, thứ tự và seed đã định. Input paired tương đương phải được kiểm tra bằng binding/digest, không chỉ nhìn title.
- [x] R5-M1: full journey quality/refusal + cold disk readback cho4chains; M-DELIVERY-CUSTOM có RED→GREEN và negative binding controls. Đây là component evidence, chưa full108.
- [x] R5-04: đi hết 108 record trong offline happy path, đủ 54 pairs, 54 sessions mỗi arm; không duplicate/missing ID hoặc rò state giữa workspace.
- [x] R5-05: thêm quality-failure/refusal hợp lệ vào lịch kiểm soát để chứng minh scheduler vẫn đi tiếp; tất cả chi phí mô phỏng vẫn được cộng đúng.
- [x] R5-06: không inject raw accepted ledger/terminal truth để bỏ qua đường cần kiểm tra; mỗi giả lập phải khai báo rõ boundary và loại bằng chứng.

### 10.2. Bộ nhánh lỗi hữu hạn — không cần lặp cả 108 cho từng lỗi

- [ ] Pre-dispatch failure: không có provider start; không bị tính thành unknown paid attempt.
- [ ] Request đã bắt đầu rồi partial stream/timeout: giữ usage đã biết hoặc lower bound; unknown không thành zero; admission dừng.
- [ ] Exit 0 kèm turn.failed/item.error/tool failure: phân loại theo contract, không success theo exit code.
- [ ] Duplicate/conflicting/missing terminal hoặc thiếu thread/usage: giữ lỗi và fail closed.
- [ ] Grader crash/record-schema reject: evidence tồn tại, campaign không tiếp tục như thể quality FAIL thông thường.
- [ ] Drift source/package/config/seed: chặn trước request kế tiếp.
- [ ] Cleanup không xác nhận/lease còn giữ: chặn dispatch; không dọn rộng tài nguyên người dùng.
- [ ] Budget threshold giữa phiên: không admit phiên tiếp theo; ghi overshoot thực của in-flight và cleanup.
- [x] Boundary 12/18/54 và cuối 108: ledger/governor/campaign counts khớp, không mở phiên 109.
- [ ] Uncertain send/reconnect: không replay một request có thể đã được provider nhận.

**Checkpoint A-v2:** R5-04/05 và bốn mốc đã thực thi trên identity tại24-r5-source-checkpoint.json;108accepted,32quality failures được giữ,8correct refusals,0unknown main. Explicit unknown fixture dừng đúng2started/1accepted. Các fault khác chỉ đóng theo mapping từng seam của evidence cũ/98regression; không lấy109PASS làm tất cả fault hoặc final configured qualification. Current configured runtime còn triển khai; không reuse rehearsal này như final identity sau source delta.

**Đầu ra:** offline-108 manifest và ledger riêng, fault matrix, counts reconciliation, cleanup receipt; tất cả gắn `provider-free/synthetic usage`, tuyệt đối không trộn với paid ledger.

**Exit:** bình thường đi hết lịch; mỗi fault dừng/tiếp tục đúng policy; không bị bỏ lại process/lease; 0 external provider calls.

## 11. R6 — Qualification cuối, rebind quyền và freeze

**Mục tiêu:** một bản xác định đủ điều kiện đo, không dùng PASS của source khác.

- [ ] R6-01: chốt candidate theo Decision A, bảo toàn work không thuộc candidate; rà secret và public exposure trước local commit nếu được phép.
- [x] R6-02: kiểm tra source/dependency/runtime closure và generated artifacts đồng bộ. Không thêm cosmetic change chỉ để tạo digest mới.
- [ ] R6-03: chạy targeted/neighboring cho delta cuối, rồi canonical full provider-free verification một lượt trên identity cuối.
- [x] R6-04: ghi toàn bộ PASS/FAIL/SKIP/cancelled, SDK path, môi trường và thời gian. Required tests bị skip không phải PASS; không lấy số xanh của nhóm con thay full result.
- [x] R6-05: mọi full-suite RED có disposition trước khi mở paid. **P5 cũ vẫn là điều kiện bắt buộc cho đến khi operator duyệt sửa nghĩa gate cụ thể.** Plan không cho phép agent tự bỏ một test đỏ vì gọi nó là product-only.
- [ ] R6-06: nếu đề nghị tách qualification, giữ nguyên full result và mapping từng failure; cần operator duyệt phần ngoại lệ rõ. Không miễn các lỗi safety, false success, identity, accounting, corrupt evidence hoặc cleanup.
- [x] R6-07: đối chiếu workload/model/thinking/service tier/timeout/thresholds và phương pháp thống kê; không thay treatment bằng mode có quyền verifier mạnh hơn để lấy điểm.
- [ ] R6-08: tạo proposal rebind với exact commit/tree/candidate/package/suite/config/runtime/policy identity và delta so với D-026. Những trường chưa được phép tạo authority phải giữ ở trạng thái proposed.
- [ ] R6-09: ghi Decision B/authority áp dụng, rồi tạo policy-bound dry-run, bốn lane S0 và freeze theo trình tự validator yêu cầu. Tất cả vẫn provider-free.
- [ ] R6-10: kiểm tra absent/unused của run-7 root và state trước one-shot creation; nếu tên đã dùng, không ghi đè hoặc tự chọn campaign thay thế.
- [x] R6-11: readback toàn bộ gate và quyền; xuất một kết luận duy nhất `READY_TO_DISPATCH` hoặc blocker có bằng chứng.

**Checkpoint 1.2:** R6-05 nghĩa là mỗi lỗi có disposition trong register41; không miễn lỗi hoặc mở paid. R6-11 kết luận NOT_READY_TO_DISPATCH, không phải R6 exit. R6-01 còn final qualification/commit; R6-03/08/09 chưa đủ điều kiện. Historical P5 FAIL giữ nguyên.

### 11.1. D-026 hiện hành phải được bảo toàn trong proposal mới

| Trường | Giá trị đã duyệt / điều kiện |
| --- | --- |
| Combined cap | 184, đã dùng 76 tại checkpoint |
| Fresh run maximum | 108 phiên, 0 slack, 0 infrastructure retry |
| Management fresh tokens | 3.000.000 |
| Management active wall time | 14.400.000 ms = 4 giờ |
| Timeout | 900 giây/phiên, đối xứng hai arm |
| Treatment | Piagent release-defaults; stock controlled Codex |
| Model settings | Theo frozen suite: `openai-codex/gpt-5.6-luna`, thinking medium, fast |
| Stage boundaries | **12 → 18 → 54 → 108** |
| Unknown mới / invalid measurement | Dừng admission ngay |
| Source gốc | c3a4427, sourceChanges=0; không bao phủ candidate mới tự động |

Tên `NOT_APPROVED` trong proposal D-026 lịch sử không phủ nhận approval thật sau đó. Ngược lại, approval thật không xóa điều kiện identity/qualification. Management threshold không phải bảo đảm zero overshoot hoặc đủ 108 dưới mọi latency.

**Exit:** candidate hiện hành qualified theo gate đã được duyệt; D-026/rebind và freeze khớp chính candidate đó; không còn lỗi bắt buộc chưa đóng.

## 12. R7 — Một campaign trả phí, chạy theo 12 → 18 → 54 → 108

**Mục tiêu:** thu đủ phép đo đã đăng ký, không sửa để chạy đến PASS.

- [ ] R7-01: trước request đầu, readback authority, zero pending stop reason, source freeze, runtime closure, budget và campaign paths.
- [ ] R7-02: thực thi stage 1–12 bằng lệnh đã được dry-run/validator xác nhận. Tài liệu này không cung cấp lệnh paid đoán từ tên script.
- [ ] R7-03: tại 12, đối chiếu all-attempt spend, exact usage, accepted records, quality failures, identity và cleanup; đi tiếp nếu gate cho phép, không đòi Piagent phải dẫn điểm.
- [ ] R7-04: tiếp tục 13–18, 19–54, 55–108 theo stage boundary đã duyệt, với cùng checks. Không thêm canary ngoài 108.
- [ ] R7-05: mọi model/tool request phát sinh trong phiên phải được tính theo đúng accounting contract; không giấu retry nội bộ hoặc đổi provider/model.
- [ ] R7-06: giữ quality/task/workflow/token/latency failures hợp lệ; không sửa code, prompt, grader, timeout hay thay input rồi chạy tiếp campaign đó.
- [ ] R7-07: unknown mới/identity drift/grader-integrity/accounting/cleanup/classification failure: dừng admission, giữ exact/lower-bound evidence, cleanup có giới hạn, báo `INVALID_MEASUREMENT`.
- [ ] R7-08: nếu operator yêu cầu pause, dừng nhận phiên mới, xử lý in-flight theo policy và checkpoint. Không hứa resume nếu interrupted attempt làm usage unknown.
- [ ] R7-09: không tự mở run-8 hoặc tăng cap khi run-7 dừng. Không retry attempt đã có khả năng nhận bởi provider.

**Exit bình thường:** 108 phiên và 54 cặp theo matrix; exact accounting, integrity và cleanup đầy đủ.

**Exit bất thường:** checkpoint dừng trung thực. Đây không phải “đã chạy xong 108”, cũng không phải quyền tiếp tục vô hạn để đạt con số.

## 13. R8 — Kết luận benchmark và chuẩn logic sản phẩm

- [ ] R8-01: reconcile planned/start/accepted/failed/unknown counts, model requests, usage, active time và cleanup; không loại failure khỏi mẫu số.
- [ ] R8-02: xuất verdict measurement: `PASS_VALID`, `FAIL_VALID` hoặc `INVALID_MEASUREMENT` theo schema/threshold đã khóa.
- [ ] R8-03: báo riêng product status; nếu chất lượng không đạt thì giữ mục tiêu sản phẩm chưa hoàn tất, dù đo đủ 108.
- [ ] R8-04: báo resolved/quality/safety/workflow và fresh token/total traffic/chi phí/thời gian thành các đại lượng riêng. Không dùng cache-inclusive savings để thay fresh-token target.
- [ ] R8-05: dùng family làm đơn vị suy luận theo suite; không gọi 108 phiên là 108 task độc lập. Giữ confidence interval và mọi ngưỡng đã preregister.
- [ ] R8-06: ghi giới hạn: suite tự biên soạn, public, reviewer waived, không family-disjoint private holdout, không traffic/member evidence.
- [ ] R8-07: nếu FAIL_VALID, tạo danh sách lỗi sản phẩm ưu tiên từ evidence; không tự mở campaign cải thiện hoặc sửa cùng frozen lineage.
- [ ] R8-08: checkpoint cuối có source, policy, campaign, verdict, unresolved issues, quyền và next action; hash artifact, không publish mặc định.

### 13.1. Chuẩn dùng trả phí thực tế — không đánh tráo với benchmark

Benchmark này chỉ có thể đóng kết luận trong phạm vi 27 tình huống. Để dùng cho một dự án thật, cần thêm acceptance criteria của chính dự án đó: việc nào phải sửa, verifier nào đáng tin, phạm vi quyền, rollback/checkpoint và cách bàn giao khi thiếu khả năng.

Đó là một đợt product acceptance riêng khi có yêu cầu và dữ liệu thật; **không được thêm nó làm prerequisite mới trước R7**, cũng không được tuyên bố đã có bằng chứng chỉ vì synthetic benchmark đạt.

## 14. Cơ chế chống vòng lặp của chính quá trình sửa

### 14.1. Một issue, một chuỗi bằng chứng

1. Đọc retained evidence trước; không tái phát hiện vấn đề đã biết.
2. Viết root-cause statement với mức chắc chắn và phạm vi.
3. Minimal reproducer/negative test phải đỏ trên bản trước sửa.
4. Smallest scoped fix.
5. Test đó xanh, positive control vẫn đúng, neighboring tests không regression.
6. Full qualification chỉ sau khi nhóm sửa đã khép.
7. Ghi disposition và next action cụ thể; không “đã thêm test” như kết luận fix xong.

### 14.2. Quy tắc dừng có ích

- Cùng root cause tái diễn hai lần sau fix: dừng patch cùng hướng, review owner/state contract bằng một reproducer; không paid rerun.
- Hai vòng chỉ đổi wording/fixture để bộ nhận dạng chấp nhận mà không tạo hành vi/evidence mới: coi là không tiến bộ; bỏ phương án đó, giữ RED.
- Không rerun full suite lặp lại chỉ để kiếm một lần xanh. Nếu full/targeted khác nhau, lưu phase evidence, tái hiện đúng điểm bất định.
- Giới hạn một quyết định kiến trúc sau khi finite register đã khóa; nếu cần mở rộng, trình tác động/phương án hẹp hơn, không tự phát triển “proof engine vNext”.
- Unsupported được bàn giao hữu hạn; không dùng handoff PASS để xóa correct-completion FAIL.
- Không tự tạo một cơ chế budget/ledger/state machine mới nếu cơ chế hiện có chỉ cần sửa đúng owner/adapter.
- Đánh giá tiến bộ bằng invariant hoặc issue được đóng, không bằng số file, dòng code, report hay test được sinh.

### 14.3. Kiểm soát phạm vi và thời gian

Đây là timebox rà soát, không phải lời hứa xong trong một ngày:

- R0–R1: một lượt tiếp nhận và một bản quyết định. Nếu đã có đủ map stage29, không làm thêm audit tương đương.
- R2–R3: xử lý từng root cause trong finite register; sau tối đa hai phương án thất bại phải quyết định giữ giới hạn hay sửa kiến trúc có duyệt.
- R4–R5: tái dùng helpers và runner hiện có; không xây framework test mới.
- R6: một canonical full run cho candidate cuối; chỉ lặp sau khi có nguyên nhân và delta cụ thể.
- R7: 4 giờ là management threshold theo D-026, không phải ETA chắc chắn cho đủ 108.

## 15. Bản đồ kiểm tra hiện có và cách chạy an toàn

Các đường dẫn dưới đây đã được tìm thấy trong repo lúc lập plan. Session thực thi phải đọc script/help và xác minh side effects trước khi chạy; không copy lệnh benchmark sản xuất để thử.

| Phạm vi | Điểm vào hiện có |
| --- | --- |
| Runtime recovery/continuation | `tests/recovery-policy.test.mjs`, `tests/continuation-budget.test.mjs`, `tests/pi-082-runtime-phase-e2e.test.mjs` |
| Journey/evaluator | `tests/benchmark-webui-journey.test.mjs`, `tests/production-journey-*.test.mjs` |
| Grader/schema | `tests/production-v3-calibration.test.mjs`, `tests/benchmark-record-validation-v3.test.mjs` |
| Accounting/stop | `tests/benchmark-pi-quality-accounting-chain.test.mjs`, `tests/benchmark-pi-timeout-accounting-chain.test.mjs`, `tests/benchmark-budget-*.test.mjs` |
| Campaign | `tests/benchmark-campaign.test.mjs`, `tests/benchmark-runner.test.mjs` |
| Packaging/identity | `tests/package-distribution.test.mjs`, `tests/release-identity.test.mjs`, `scripts/verify-release-identity.mjs` |
| Browser | `playwright.webui.config.mjs`; npm script `test:webui:e2e` |
| Canonical offline | `bash scripts/verify-local.sh --offline`, sau khi đọc đầy đủ script và chuẩn bị runtime path |

Ví dụ kiểm tra hẹp đã được dùng trước đây, thực hiện trong `IMPL` khi bước tương ứng được phép:

```sh
PIAGENT_NO_UPDATE_CHECK=1 node --test tests/production-v3-calibration.test.mjs tests/benchmark-record-validation-v3.test.mjs
```

`PIAGENT_NO_UPDATE_CHECK` hoặc tên `--offline` không tự là sandbox mạng. Kiểm tra runner không hydrate auth, không gọi real provider, không dùng global state người dùng. `PIAGENT_REAL_PI_HOST` nếu test cần phải là **đường dẫn runtime đã xác thực**, không phải giá trị `1`.

Không chạy ngay `npm run benchmark:deep` hoặc các script có auth-writeback; chúng không phải phép kiểm tra an toàn mặc định cho plan này.

## 16. Evidence, checkpoint và báo cáo tiến độ

### 16.1. Evidence tối thiểu, không tạo report trùng lặp

Mỗi issue/phase lưu command thật, exit code, source/config hashes, test scope, observed result, expected result và đường dẫn log. Hash bằng SHA-256; không chỉ hash một report tự kể lại kết quả.

Artifact mới có timestamp; không sửa evidence đã sealed. Transcript/auth/keys giữ private và không đưa vào Git. Synthetic fixtures không trộn paid records. File count không thay cho content digest.

### 16.2. Checkpoint dùng khi pause/chuyển session

```json
{
  "planId": "PRB-108-2026-09-06",
  "phase": "R0",
  "status": "not_started",
  "candidate": {
    "commit": null,
    "tree": null,
    "packageDigest": null,
    "suiteDigest": null,
    "configurationDigest": null
  },
  "authority": {
    "d026ApprovalRecorded": true,
    "candidateRebindApproved": false,
    "paidDispatchGateSatisfied": false
  },
  "checks": {
    "lastCanonicalResult": null,
    "blockingIssueIds": [],
    "evidenceManifest": null
  },
  "execution": {
    "liveProcesses": [],
    "campaignId": null,
    "started": null,
    "accepted": null,
    "unknown": null
  },
  "nextAction": "Verify current source and authority before implementation"
}
```

Đây là template, không phải receipt đã thực thi. `null` nghĩa chưa xác minh, không phải zero. Session phải điền PID/lock/campaign thực khi có; không lưu secret.

### 16.3. Mẫu cập nhật ngắn cho operator

- Đang ở phase/issue nào.
- Hành vi nào vừa được chứng minh hoặc sửa, bằng test nào.
- Gate nào còn đỏ và thuộc runtime, measurement hay product.
- Provider sessions đã phát sinh trong lượt này; nếu 0 thì ghi 0.
- Một next action cụ thể; chỉ hỏi operator khi thiếu quyền hoặc lựa chọn thực sự.

Không nói “gần xong” chỉ vì test hẹp xanh. Không hứa ngày chạy benchmark nếu source/authority/full gate chưa đóng.

## 17. Checklist operator nên chốt

- [x] Nhận plan này làm execution plan chuyên biệt, liên kết với POR thay vì restart toàn P0–P10.
- [x] Giữ single-agent và ưu tiên candidate tối thiểu; không đổi harness nền tảng.
- [x] Duyệt Decision A-v1 A-CORE/A-GRADER và tiếp tục offline sau allowlist/preservation; A-SEM chưa chọn.
- [x] Không bật independent authority hoặc đổi grader/treatment ngầm. Những thay đổi thật được trình cùng Decision A hoặc rebind thích hợp.
- [ ] Chỉ duyệt Decision B khi có qualification và exact candidate/config/suite binding; không tăng cap tự động.
- [ ] Chấp nhận `FAIL_VALID` là kết quả đo trung thực nhưng không phải sản phẩm đạt mục tiêu; không yêu cầu sửa giữa campaign để đạt PASS.
- [ ] Dành product acceptance dự án thật cho đợt riêng, không làm nó thành điều kiện mới khiến R7 tiếp tục bị trì hoãn.

## 18. Prompt bàn giao cho session mới

Copy đoạn sau nếu muốn session mới tiếp nhận và lập quyết định triển khai trước khi sửa:

```text
Tiếp nhận kế hoạch PRB-108-2026-09-06 cho Piagent.

Implementation repo duy nhất:
/Users/vtamm/Documents/piagent-35-recovery-20260831T090020Z/implementation

Đọc AGENTS.md, toàn bộ:
/Users/vtamm/Documents/piagent-35-recovery-20260831T090020Z/implementation/docs/piagent-runtime-benchmark-execution-plan.md
và Plan of Record được dẫn trong đó trước khi hành động.

Tôi nhận kế hoạch này để tiếp tục ở session mới. Trước mắt chỉ thực hiện R0–R1:
xác minh checkpoint/source/custody/quyền, tái dùng finite issue register đã có,
đề xuất candidate tối thiểu cùng dependency closure, contract và disposition
từng lỗi. Báo lại Decision A cụ thể trước khi thay đổi source/treatment.

Không restart P0–P10, không spawn subagent, không tạo worktree, không đổi
harness nền tảng, không stash/reset/discard recovery work. Không gọi provider,
không reserve campaign, push hoặc publish. Không đọc secret để tìm evidence.

D-026 đã duyệt nhưng khóa candidate cũ; không tự áp approval đó cho candidate
mới. Giữ run-6 immutable. Runtime đã có continuation maximum 1: không thêm
bộ đếm trùng lặp. Không biến unsupported thành completed hoặc dùng test
handoff xanh để xóa test correct-completion đỏ.

Kết thúc R1 bằng một đề xuất có thể duyệt: các file/hunk cần đưa vào candidate,
cách bảo toàn phần còn lại, những contract/quyền cần đổi nếu có, các gate phải
đạt và next action cụ thể. Cập nhật checklist/checkpoint, không chỉ report lại
blocker cũ. Chưa thực hiện R2–R7 khi chưa có quyền tương ứng.
```

Khi muốn cho session mới sửa offline sau khi xem Decision A, operator có thể duyệt đúng proposal đó và cho tiếp tục R2–R6; không cần duyệt từng test. Paid R7 vẫn theo Decision B và các gate thật.

## 19. Nhật ký kế hoạch

| Phiên bản | Ngày | Nội dung |
| --- | --- | --- |
| 1.16 | 2026-09-06 | Worker v4 bounded identity hashing closes configured NDJSON timeout:46controls/4actual PASS. Docs exact-command/current-source receipt:6native/268composite PASS; full docs chain/expiry/full/B open. |
| 1.15 | 2026-09-06 | API migrations and configured checkpoint/abort pass; retained7/3 and2/1 followups identify NDJSON guest wall limit, docs exact-command and expiry API gaps; final full/B open. |
| 1.14 | 2026-09-06 | Explicit host API comparison closes observed tenant false completion and invoice/dedup positive gaps;82controls/10actual PASS; remaining migrations/docs/full/B open. |
| 1.13 | 2026-09-06 | Replay executor structuredClone gap sửa có versioned worker;34controls và3actual variants đạt, recover0model; API/docs/full/B vẫn mở. |
| 1.12 | 2026-09-06 | Tenant/revocation/billing/CSV/retry configured có positive và controls; API routing/checker identity sửa có RED→GREEN; replay thiếu structuredClone xác định trực tiếp; API/docs/full/B vẫn mở. |
| 1.11 | 2026-09-06 | X1 phục hồi có hash; chat/workspace/pagination configured có positive và negative controls; sửa workflow replay và false verifier-command coverage. Docs/atomic/full/B vẫn mở,0provider. |
| 1.10 | 2026-09-06 | Workflow configured actual SDK/worker đúng hoàn tất đủ3turns; sai-test-xanh và unsupported bị chặn hữu hạn. Native-only chỉ cho read-only request set, wrong-scope control đạt. R5 đủ108 trên identity trước delta; full/B vẫn mở. |
| 1.9 | 2026-09-06 | R5 actual shared schedule đủ108accepted/54pairs/4mốc,0unknown main; bảo toàn32quality failures và8safe refusals,0provider. |
| 1.8 | 2026-09-06 | Operator duyệt A-v2:pagination N, exact R5 exception và configured independent verification/finite fixes. R5 patch đã áp,0provider; R4/full history giữ nguyên, B riêng. Evidence091158Z |
| 1.7 | 2026-09-06 | Hoàn tất R4-08:27/54,55/55fresh disk readback sau connection/supervisor close; cùng revision giữ37PASS/18FAIL. Test helpers vàgenerated/docs đồng bộ; core/suite không đổi,0provider. Evidence083952Z |
| 1.6 | 2026-09-06 | R5 fulljourney/coldreadback4chains và reader13controls đạt; sửa timeout nhầm custom delivery receipt, giữrefused vàusage.26finite rows; full108/P5/B cònmở,0provider. Evidence081322Z |
| 1.5 | 2026-09-06 | Operator nhắc tiếp tục A không hỏi lại; chuẩn bị patch R5 hai runner files, normalized-loop/syntax checks đạt; auto-review từ chối2lần vì phạm vi harness. Chưa áp source,0runtime tests/0provider; checkpoint073448Z và quyền cụ thể còn mở |
| 1.4 | 2026-09-06 | Blocked audit ba lượt:current87source/parent evidence/run6 custody khớp; không còn bounded fix/check mới hoặc live process. Chờ A-SEM, giữ positive/P5/full108/B gates;0tests/0provider mới, không đánh dấu mục tiêu hoàn tất |
| 1.3 | 2026-09-06 | Final-candidate quality/accounting2/2 và actual production/offline boundary kiểm đúng;0provider, source sản phẩm không đổi. R5 full108 integration vẫn thiếu; positive/full/B gates giữ nguyên. Evidence benchmark-validity-recovery-20260906T064300Z |
| 1.2 | 2026-09-06 | A-v1 được xác nhận và áp selection15file có preservation; bounded reference/grader/routing/docs fixes và closure; calibration34/34, review5/5, fault109/109, browser22/22. R4 coverage27/54 còn18 positive FAIL; full108 replay/P5/rebind chưa đạt,0provider; report40/checkpoint46 |
| 1.1 | 2026-09-06 | Operator nhận plan và chỉ authorize R0–R1; xác minh95/95 source, bảo toàn96 file, candidate A-v1/25 finite dispositions/threshold mapping; Codex PATH hash drift mới; Decision A chờ duyệt. Chỉ docs/evidence,0 tests / 0 provider; không source selection/R2–R7 |
| 1.0 | 2026-09-06 | Tạo plan riêng và prompt bàn giao; chốt R0–R8, hai điểm quyết định, giữ D-026 và evidence cũ; chưa sửa runtime, chạy qualification hoặc gọi provider |

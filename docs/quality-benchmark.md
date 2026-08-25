# Quality benchmark guide
<!-- language: vi; english-index: docs-site/content/en/benchmark.html -->

## Chạy và chấm tự động bằng một lệnh

Từ terminal, chạy:

```bash
piagent-benchmark
```

Lệnh mặc định dùng suite `core-v1`, tạo workspace Git sạch cho từng lần chạy,
chạy cùng task trên `piagent` và controlled `codex-cli` bằng
`openai-codex/gpt-5.6-luna:medium`, chấm bằng hidden grader, rồi đọc usage
trực tiếp từ Pi/Codex JSONL. `raw-pi` chỉ còn là ablation diagnostic khi truyền
`--surfaces raw-pi,piagent`, không phải baseline mặc định.
Không nhập tay kết quả hay token.

Default suite đo task ở trạng thái steady-state: runner init profile, ghi một
onboarding snapshot/index tối thiểu hợp lệ và build Context Engine trước Git
baseline, ngoài thời gian/model usage được đo. Vì vậy mỗi repeat không trả lại
bài toán one-time `/onboard run`. Nếu Piagent tiếp tục sửa
`.pi/project-context.md` hoặc `.pi/context-index.json` trong lúc giải task, thay
đổi đó vẫn bị scope gate bắt; runner không blanket-ignore file nội bộ.

Các biến override runtime `PIAGENT_*` của shell gọi lệnh được reset trong model
run. Runner sau đó chỉ áp treatment đã pin cho surface `piagent`; `raw-pi` và
`codex-cli` không nhận các biến feature của Piagent. Provider auth, Pi config và
các biến `PI_*` vẫn được giữ để Pi dùng account/model hiện hành.

Auto-discovered project/global `AGENTS.md` và `CLAUDE.md` được tắt cho cả hai
surface để instruction cá nhân không làm lệch đối chứng. Piagent sau đó nạp
tường minh đúng project `AGENTS.md`, guard extension và skill directory của
release đang benchmark. Skill vận hành `piagent-ops` chỉ gọi chủ động và không
được quảng bá cho model trong task bounded vì runtime đã cung cấp cùng policy;
skill theo ngữ cảnh khác vẫn dùng discovery bình thường. Global
`SYSTEM.md`/`APPEND_SYSTEM.md`, provider auth và model settings vẫn áp dụng
giống nhau cho hai surface.

Suite mặc định có 4 scenario, 2 surface và 3 lần lặp, tổng cộng 24 model
session. Runner hiện kế hoạch và hỏi xác nhận trước khi dùng quota. Xem trước mà
không gọi model:

```bash
piagent-benchmark --dry-run
```

Đây là smoke suite để phát hiện regression nhanh, không phải production claim.

## WebUI parity và bài logic sâu

WebUI không có một bộ prompt/policy riêng. Workflow picker tạo đúng
`/workflow <id> <request>`; Project Controls tạo typed command rồi Gateway gọi
đúng slash-command handler của Terminal. Vì vậy benchmark chia hai tầng:

```bash
npm run benchmark:webui-parity
```

Tầng provider-free này build production bundle, kiểm tra 10 workflow, 32 runtime
control, revision/idempotency/confirmation/CSRF, chạy toàn bộ Chromium user flow
và stress projection ở ba cỡ repository. Receipt của read-only control phải ghi
`modelCallObserved=false`; nếu runtime vô tình mở model turn, gate trả
`effect-unknown` thay vì claim 0 token.

Khi cần đo solver logic sâu theo baseline lịch sử Luna/medium với `codex-cli`:

```bash
npm run benchmark:deep -- --dry-run
npm run benchmark:deep
```

`deep-logic-v1` gồm 7 family difficulty `large`: revision-bound event
reconciliation, capacity/fairness/dependency scheduling, layered fail-closed
policy, budgeted context graph, out-of-order resumable stream và transactional
config merge, cộng thêm temporal usage billing với plan timeline, tier lũy tiến,
reversal, `BigInt`, round-half-even và canonical audit digest. Mỗi family có
run-private value variant, hidden grader, scope gate và ba repeat trên hai
surface, tổng 42 model session. Suite khóa `Piagent`/`codex-cli`,
`openai-codex/gpt-5.6-luna` và thinking `medium`; truyền model, effort, surface
hoặc Codex mode khác sẽ bị từ chối trước khi gọi provider.

Token report tách `fresh input`, `output`, `cache read`, `cache write`,
`reasoning` (là tập con của output), `fresh = input + output` và
`total = input + cache read + cache write + output`. Report cũng ghi nguồn đo,
độ đầy đủ từng attempt và token của failed/retry attempt; cost không quyết định
token có được xem là exact hay không.

Kết quả của `webui-parity-v1` chứng minh transport/logic parity và UI behavior,
không phải model-quality claim. `deep-logic-v1` là capability-tier paired gate:
chỉ full suite 7 family × 3 repeat, randomized order, không retry, đủ quality và
cả token/performance confidence mới được nhận bounded claim. Production/public
claim vẫn phải qua `production-v1` và contract đóng băng bên dưới; production-v1
không kế thừa hard performance gate riêng của deep-logic-v1.

Suite deep khai báo trước `primaryEfficiencyEstimand` là
`failure-aware-family-ratio`. Mỗi family tính tổng fresh token chính xác của mọi
attempt chia cho số outcome đã resolved ở từng surface; tỷ lệ Piagent/Codex của
7 family sau đó được gộp bằng geometric mean và CI 95% trên log-ratio. Usage
unknown, thiếu repeat hoặc một surface không có outcome làm evidence fail-closed.
Thống kê successful-pair vẫn được giữ riêng và vẫn là guardrail bắt buộc, nên
primary failure-aware không che được regression chất lượng hay một family thiếu
đối chứng thành công.

Public regression diện rộng dùng track `--production` (tên CLI được giữ để
tương thích, không phải claim production):

```bash
piagent-benchmark --production --dry-run \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment release-defaults

piagent-benchmark --production \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment release-defaults
```

`production-v1` có 18 scenario family công khai, 3 generated value variant cho
mỗi family và 2 surface, tổng cộng 108 model session. Bộ này dùng để chốt public
regression của harness/model policy, không tự chứng minh generalization hoặc độ
ổn định production.

Contract hiện tại chỉ xét efficiency claim ở **S108**, sau khi có đủ 18 family ×
3 repeat × 2 surface. Claim phải qua hai trục độc lập. Primary fresh-token
estimand được khai báo trước là
`fixed-workload-family-ratio`: trong từng family, cộng fresh token chính xác của
đủ ba attempt đã định trước ở mỗi surface, gồm cả usage của failed attempt đã
khởi động provider; sau đó lấy geometric mean của 18 tỷ lệ family và CI 95% trên
log-ratio. Outcome không xuất hiện trong mẫu số. Vì vậy một Codex attempt không
resolved vẫn nằm trong workload token, thay vì bị loại hậu nghiệm hoặc được gán
tỷ lệ giả.

Cận trên 95% của primary ratio phải không vượt `0.60`, tức chứng minh ít nhất
40% fresh-token reduction trên public-regression này. Successful-pair và
fresh-token-per-resolved-outcome vẫn được report dưới dạng diagnostic nhưng
không phủ quyết fixed-workload primary. Tỷ lệ theo category, profile, lifecycle,
difficulty và từng family vẫn dùng để tìm điểm nóng. Mọi attempt được chấp nhận
phải có exact terminal token buckets; thiếu một attempt/family hoặc unknown
usage của accepted/failed attempt làm primary evidence không đầy đủ và chặn
claim.

Production còn có hard gate ngân sách subagent độc lập với normalized cost:
mỗi provider attempt của Piagent được phép tối đa một child session, tổng token
traffic của child không vượt `5%` tổng token traffic candidate, và `sessions`
phải được giải thích chính xác bằng một root session cộng số child session. Gate
này tính cả accepted attempt lẫn provider-started failed attempt; thiếu ledger,
thiếu exact child-token bucket hoặc session không giải thích được đều chặn stage
và claim, kể cả khi `requireNormalizedCostClaim=false`.

Diagnostic Codex-relative thứ hai đo mục tiêu chi phí vận hành: cùng task,
fixture, model và thinking, cộng **toàn bộ provider token traffic** gồm fresh
input, output, cache read và cache write của accepted attempt lẫn
provider-started failed/retry attempt. Contract tùy chọn cho một suite tương lai
sẽ chỉ cho phép nói "rẻ hơn `codex-cli` ít nhất 30%" khi point estimate lẫn cận
trên 95% của total-traffic ratio và API-equivalent cost ratio không vượt `0.70`,
đồng thời chất lượng/task continuity đều đạt. `production-v1` hiện giữ
`requireNormalizedCostClaim=false`, nên metric này chỉ là diagnostic và không
được dùng để claim 30–40% cost; hard claim S108 của v1 vẫn là fresh-token ratio
upper-95 không vượt `0.60`.

Hai hard non-regression axis còn lại là paired model intelligence và task
continuity. Piagent phải dùng đúng cùng model/thinking với controlled baseline CLI,
không thấp điểm hơn ở bất kỳ paired grade nào, đạt mọi quality/safety/
reliability/workflow/outcome floor, không có baseline-pass/Piagent-fail, và mọi
Piagent session phải resolved với đầy đủ workflow cùng causal lifecycle
evidence. Một task bị đứt, timeout, orphan, terminal state không rõ hoặc thiếu
evidence không thể được bù bằng token saving ở task khác.

Codex OAuth không cung cấp billed monetary cost, nên không thể suy tỷ lệ phần
trăm subscription từ report. Production-v1 đo riêng **API-equivalent text-token
cost** bằng pricing snapshot
có version trong suite: GPT-5.6 Luna ở `$0.20/M` fresh input, `$0.02/M` cached
input, `$1.20/M` output và cache write bằng `1.25x` fresh-input rate. Đây là
diagnostic quan sát của `production-v1`, không phải hóa đơn OAuth và không
khẳng định mức trừ quota subscription. Chỉ một suite tương lai bật explicit
cost claim và có usage từng request đầy đủ mới được nâng nó thành hard gate.
Metric chỉ chuẩn hóa
input/cache/output text token, không bao gồm tool-specific charge. Snapshot dẫn nguồn
[OpenAI GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna).

Long-context multiplier là thuộc tính từng request: request input trên 272K
dùng input `2x` và output `1.5x`. Report chỉ dùng standard tier khi tổng prompt
tokens của run không vượt 272K, vì tổng đó là upper bound của từng request. Nếu
tổng lớn hơn nhưng không có exact per-request usage, applicability là `unknown`
và normalized-cost diagnostic ghi `unavailable`; runner không nhân mù trên
aggregate. Điều này không phủ quyết exact token-traffic measurement, nhưng chặn
mọi optional Codex-relative cost claim thay vì giả định một mức giá có lợi. Nhãn
`steady-state` ở suite này nghĩa là project đã được onboarding/build Context
Engine trước một request mới; nó không phải bằng chứng multi-turn hay session
continuity trong công việc thực tế.

Host load và CPU idle không còn là điều kiện khởi động hoặc điều kiện claim của
production-v1. Runner không chờ cửa sổ host-readiness nhiều mẫu trước provider.
Nếu có host-load observation, nó chỉ giúp giải thích timing variance. Duration
cũng chỉ được đo và report; Piagent được phép chậm hơn baseline CLI miễn token,
paired intelligence và task continuity vẫn đạt contract.

Production suite khóa exact surface/model/thinking ở Piagent và baseline CLI,
`openai-codex/gpt-5.6-luna`, thinking `medium`, controlled Codex home. Kế hoạch
chi tiêu được freeze tại `benchmarks/production-v1/spend-control.v1.json` với
seed impact-first cố định: pair đầu là `cli-double-dash` (regression từng xuất
hiện muộn), còn 12 session đầu phủ đủ sáu category, cả hai lifecycle và ba mức
difficulty. Seed chỉ sắp xếp phát hiện lỗi sớm; claim cuối vẫn dùng toàn bộ 108
session.

Production suite có thể chạy lâu vì mọi session chạy tuần tự để giữ baseline
sạch. Chạy theo các mốc tích lũy `S0/12/36/72/108`; chỉ `S108` được xét claim.
Mọi stage trước chỉ là spend-control diagnostic, không cấp early-success
verdict. Từ S12 và tại mỗi partial stage kế tiếp (S36, S72), runner vẫn dừng
chi tiêu nếu pooled fresh-token ratio tính trên exact accepted + failed-attempt
usage vượt `1.10`, hoặc bất kỳ family đã quan sát nào vượt `1.25`. Duration,
host load và normalized cost luôn là observational. `--max-sessions` tính số
session mới của chunk hiện tại, vì vậy
các lần resume lần lượt dùng `24`, `36`, `36`:

```bash
piagent-benchmark --production \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --seed production-v1-40-gate-v1-1370 \
  --infrastructure-retries 0 \
  --stop-after-failed-pair \
  --preflight-only

piagent-benchmark --production \
  --seed production-v1-40-gate-v1-1370 \
  --stop-after-failed-pair \
  --max-sessions 12 \
  --output /path/to/report-dir \
  --yes

piagent-benchmark --resume /path/to/report-dir --max-sessions 24 --yes
piagent-benchmark --resume /path/to/report-dir --max-sessions 36 --yes
piagent-benchmark --resume /path/to/report-dir --max-sessions 36 --yes
```

Trước provider preflight đầu tiên, S0 tự chạy ba lane provider-free trên đúng
candidate hiện tại: `runtime-conformance-v1`, `long-horizon-v1` (tối thiểu 30
phút wall-clock) và `webui-parity-v1` gồm bảy deterministic UI-stability suite.
Receipt có completion time và bind exact clean Git commit, candidate tree,
production configuration, cùng digest của từng lane config/runner. Receipt được
cache riêng tư theo toàn bộ binding; resume/S12 chỉ reuse khi mọi digest vẫn
khớp, còn source/config/runner đổi sẽ bắt buộc chạy lại S0. Vì vậy lần
`--preflight-only` production đầu tiên trên một binding sạch có thể mất hơn 30
phút nhưng không gọi provider và không dùng model token.

Không mở stage kế tiếp nếu có Piagent unresolved/score không vượt floor,
baseline-pass/Piagent-fail, unknown provider-attempt usage, infrastructure retry,
model/thinking/provider-wire drift, candidate provenance drift, subagent vượt
ngân sách, provider-free receipt sai binding, adaptive-context coverage
`partial`, hoặc catastrophic partial-stage ratio vượt ngưỡng trên. Runtime
coverage `not-observed` chỉ được chấp nhận khi lane provider-free cùng binding
đã phủ ca đó. Early success không phải stopping rule: chưa đủ 108 session thì
tuyệt đối không claim đạt 40%. Fresh ratio dưới ngưỡng catastrophic ở partial
stage vẫn chỉ là diagnostic; duration chậm, normalized-cost ratio xấu hoặc host
load cao không tự đóng stage. Ở S108, `production-v1` dùng hard gate fresh-token
đã khai báo cùng các quality/continuity/evidence gate độc lập;
total-traffic và normalized-cost Codex-relative vẫn observational cho tới khi có
suite version mới bật explicit cost claim và exact per-request pricing evidence.
File spend-control là contract được test; runner đọc trực tiếp các mốc session,
từ chối chunk đầu hoặc chunk resume không đúng phần còn lại của window đã duyệt.
Seed, surface, model, thinking, repeat, zero-retry và terminal pair-stop cũng được
bind trực tiếp trước provider; truyền đủ cả 18 scenario qua `--scenarios` không
tắt được spend control. `--preflight-only` không cần `--max-sessions` vì không
khởi động model. Mỗi pause in sẵn lệnh resume với exact chunk còn lại; lệnh sai
bị từ chối trước khi durable stage state được mở sang window mới.
Built-in production claim còn yêu cầu source Git sạch ngay trước auth/tool
preflight; một candidate đã biết claim-ineligible không được phép tiêu S12–S108.
Outcome-floor,
infrastructure/unknown-usage và provenance có đường dừng/abort tự động. Tại mỗi
điểm dừng `--max-sessions` hoặc `--max-runtime-minutes`, runner ghi atomic private
`stage-diagnostic.json`. Với `production-v1`, lệnh `--resume` tự tính lại
diagnostic từ ledger đã chấp nhận và từ chối chạy thêm model session nếu
`stageAdvanceAllowed` không phải `true`; không thể vượt gate chỉ bằng cách sửa
file diagnostic đã ghi ở lần pause.
Artifact provider-free tại mỗi pause kiểm tra pair boundary, candidate outcome floor,
baseline-pass/Piagent-fail, observed paired grade non-inferiority, exact accepted
và failed-attempt usage, model/thinking/provider-wire, subagent budget,
source-bound S0 receipts, adaptive-context coverage và retry/unknown usage. Từ
S12, artifact còn hard-gate pooled ratio `<=1.10` và mọi observed family
`<=1.25`; S36/S72 phải tính lại trên toàn ledger hiện có, không kế thừa một lần
pass cũ. Pricing
applicability, duration và host load không nằm trong `blockingReasons`.
Mỗi Piagent record còn phải có causal context receipt hoàn chỉnh. Receipt chỉ
giữ aggregate, không giữ prompt, path, hash hay ID; nó bind provenance của
telemetry, thứ tự prompt/terminal và exact offer/delivery/injection lifecycle.
Baseline CLI dùng sentinel `not-applicable`. Receipt thiếu hoặc sai vẫn giữ record
usage đã trả phí trong ledger, nhưng chặn stage kế tiếp và chặn claim cuối.
Tại S12, diagnostic tổng hợp estimated pack token, lý do criterion chọn 0,
managed-prefix compaction, successful direct-path reread và số shell call sau
injection. Shell count được nêu riêng vì reread bên trong command không bị diễn
giải nhầm thành số 0 đã chứng minh.
Artifact vẫn liệt kê observed pair/family fresh-token, API-equivalent text-token
cost và duration ratio để review. Primary S108 fresh-token check có
`decisionRole=final-only`; catastrophic partial-stage check có
`decisionRole=blocking` từ S12; cost, duration và host load có
`decisionRole=observational`. Metric observational không chặn stage; hard gate
catastrophic có thể từ chối mở window kế tiếp nhưng không cấp quyền claim sớm.
Diagnostic luôn có
`diagnosticOnly=true`, `claimEligible=false`; dù kết quả sớm tốt cũng không được
dùng làm stopping rule hay claim release.

Durable stage state, không phải `paused.json`, quyết định quyền resume. Nếu tiến
trình chết đúng sau record cuối của S12/S36/S72, resume nhận diện lại boundary,
chạy gate provider-free rồi mới mở đúng window kế tiếp. Nếu chết sau record thứ
108 nhưng trước khi ghi report, runner không áp lại heuristic của stage sớm và
không chạy auth/tool/provider preflight. Nó hash lại candidate, suite, runtime-
dependency tree và ledger hiện tại, đồng thời dùng lại command/auth/preflight
identity đã được freeze cùng các measurement; sau đó các gate cuối, không phải
heuristic của stage sớm, quyết định verdict.

Runner ghi `run-manifest.json` ngay khi bắt đầu để giữ root seed, suite digest,
surface, repeat và execution order. Nếu máy sleep, terminal bị ngắt hoặc đạt
`--max-sessions`/`--max-runtime-minutes`, lần sau `--resume` chỉ chạy các
session còn thiếu, không chạy lại phần đã có usage hợp lệ. Run cũ không có
`run-manifest.json` sẽ bị từ chối resume vì không thể khôi phục seed một cách
minh bạch.

Từ lớp benchmark matrix trong package, Piagent phân ba band:

| Band | Khi dùng | Mục đích |
|---|---|---|
| `core` | thay đổi nhỏ, kiểm tra nhanh | Task quality, scope, safety và exact usage trên 4 scenario |
| `deep-logic` | phát triển solver/workflow/WebUI logic | `deep-logic-v1`, 7 bài large với interacting invariants, 42 paired session; capability-tier full-suite gate, không phải production claim |
| `production` | release candidate, đổi model policy, đổi harness | `production-v1`, 18 public-regression scenario, paired baseline, confidence gate; không phải generalization claim |
| `capability` | tìm trần năng lực sau thay đổi harness | `capability-v1`, 6 bài multi-file/multi-component chưa bão hòa; dùng hill-climbing, không phải release gate |
| `runtime-conformance` | thay đổi context governor, retry/settlement WebUI, emission hoặc edit freshness | `runtime-conformance-v1`, 9 ca deterministic provider-free; bắt buộc 0 provider call, 0 model token và mọi safety gate pass; không phải token/quality claim |
| `long-horizon` | thay đổi recovery/context lớn | Lane provider-free chạy ít nhất 30 phút cho hard crash/resume, compaction, handoff, continuation bounded và state-growth; dedicated paid suite chưa phát hành |
| `private-holdout` | readiness E3 và exact-RC FS7-01 | Tối thiểu 6 family từ 6 repository lineage, giữ ngoài workspace tác giả; chỉ custodian execute-only và human-calibration receipt được chấp nhận |

Hiện `core-v1`, `deep-logic-v1`, `production-v1`, `capability-v1` và `e2-framework-v1` chạy được bằng CLI. Thay đổi
recovery/context phải chạy `production-v1` cùng deterministic recovery tests.
Trước mọi canary trả phí sau thay đổi runtime, chạy lane không dùng model:

```bash
node evals/runtime-conformance-v1/runner.mjs \
  --output .pi/benchmarks/runtime-conformance-v1-latest.json
```

Lệnh trên là vòng lặp developer nhanh, không thay S0 của production. Trước
provider session đầu tiên, production runner tự chạy hoặc exact-cache-hit cả
runtime conformance, long-horizon tối thiểu 30 phút và WebUI parity; cả ba phải
cùng clean source/tree/config/runner binding.

Lane chỉ đạt khi cả 9 ca pass, provider/model usage bằng 0, projection không tạo
tool orphan, retry sau output/tool-call không được chấp nhận, mỗi operation chỉ
có một terminal settlement, final response không bị emission guard lọc và stale
edit bị chặn cho tới khi đọc lại. Sau đó mới chạy canary chẩn đoán có chọn
scenario; chỉ candidate Git sạch đã qua canary mới được mở S12 của
`production-v1`. Không sửa task hoặc gate của canonical 108-session suite để
giữ khả năng so sánh lịch sử.
Lane `evals/long-horizon-v1` hiện là `runnable-provider-free`; nó chứng minh
lifecycle durability và local-state bounds, không tạo model quality, token,
latency, 90-minute wall-clock, generalization hay release claim. Dedicated paid
suite vẫn chưa phát hành, nên tooling không được nâng lane local này thành
benchmark claim.

`private-holdout` có trạng thái `external-custody-required`: source package chỉ
ship policy, rubric, public-exposure boundary, readiness matrix và validator.
Không có prompt/grader/repository private trong package. `CF-FS4-05` được phép
chốt local readiness và chuẩn bị protocol FS5, nhưng generalization/release vẫn
khóa cho tới khi custodian độc lập cung cấp receipt thật ở `CF-FS7-01`.

Capability pilot dùng lệnh sau. Suite này chủ ý có các contract xuyên package,
backend/frontend dùng chung chuẩn hóa, lease ownership/concurrency, migration
crash/resume, WebUI/Terminal control-plane và reconnect timeline có checkpoint;
điểm thấp là tín hiệu năng lực cần nghiên cứu, không phải lý do vá regex theo
fixture:

```bash
piagent-benchmark --capability \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment candidate
```

`capability-v1` dùng contract gắn nhãn 28 clause và 69 check atomic có trọng số,
thay cho hai mega-check chỉ cho điểm `0` hoặc `10`. Prompt, rubric và grader
phải có mapping đầy đủ; reference đạt `10/10`, 28 mutation theo clause phải bị
đúng check tương ứng bắt, và một implementation tương đương nhưng khác cấu trúc
phải được chấp nhận. Mỗi check hiện là critical và mỗi scenario có 10–13 check,
nên chỉ cần thiếu một check thì task score đã xuống tối đa `9.23` và không thể
qua hard gate `>9.5`. Điểm lẻ dùng để chẩn đoán obligation nào hỏng; `resolved`
vẫn yêu cầu toàn bộ critical check pass. Những pilot cũ giữ nguyên suite digest
đã pin và không được relabel bằng rubric mới.

Claim tiết kiệm token chỉ hợp lệ trong đúng claim tier của report khi quality,
safety, reliability, workflow, paired non-regression, đủ outcome coverage,
primary efficiency evidence đã khai báo trước và comparison protocol đều pass.
Successful-pair/failure-aware chỉ blocking ở suite chọn contract đó; production
fixed-workload gắn chúng role `diagnostic`. Nếu một blocking gate thiếu hoặc
fail, số token vẫn hữu ích để debug nhưng không dùng làm claim release. Report ghi thêm ba ma trận paired outcome
`resolved`, `quality`, `safety` để thấy Piagent thắng/thua ở đúng cùng
scenario/repeat, cùng fresh-token ratio theo category, profile, lifecycle và
difficulty; nhờ vậy một mức tiết kiệm tổng không che được regression ở một band.

## Pin treatment Piagent

`--piagent-treatment` biến cấu hình runtime thành treatment có tên, được lưu ở
dry-run, manifest, resume, replay và report. Bốn preset hiện có:

| Treatment | Solver | Phase tools | Recovery | Helpers | Dùng khi |
|---|---|---|---|---|---|
| `release-defaults` | default release | default release | default release | default release | Xác nhận hành vi package đúng như phát hành, không ép feature flag |
| `local-safe` | `shadow` | `shadow` | `on` | `recommend` | Đối chiếu cấu hình local-safe bảo thủ |
| `causal-phase-enforce` | `shadow` | `on` | `on` | `recommend` | Arm FS5 chỉ đổi CAP-09 từ shadow sang enforce; không dùng làm default hoặc token claim |
| `candidate` | `recommend` | `on` | `on` | `recommend` | Diagnostic bundle lịch sử; không dùng làm một causal arm vì đổi nhiều feature |
| `feature-off` | `off` | `off` | `off` | `off` | Diagnostic bundle lịch sử; không dùng để quy kết lợi ích cho một feature |

Mọi preset pin execution backend là `host`. Report Codex chỉ pass protocol khi
treatment id và toàn bộ environment khớp chính xác preset; treatment bị sửa,
thiếu hoặc không nhận diện sẽ fail closed.

Protocol FS5 được khóa tại `evals/fs5-pilot-protocol.v1.json`. Baseline sản phẩm
là surface `codex-cli`, không phải Raw Pi; cấu hình Piagent là `local-safe` để khớp default
bảo thủ đã duyệt. Trước tiên chỉ in kế hoạch, không kiểm auth và không chạy model:

```bash
piagent-benchmark --suite capability-v1 \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment local-safe \
  --repeats 1 \
  --scenarios fullstack-search-contract \
  --seed cf-fs5-canary-a-luna-medium-v1 \
  --timeout 360 --infrastructure-retries 0 --retry-delay 0 \
  --max-sessions 2 --dry-run
```

`--preflight-only` đi xa hơn dry-run: runner tạo snapshot bất biến, xác minh
candidate/suite/runtime command, Pi credential readiness, Codex login/features,
home cô lập và environment policy, rồi dừng trước confirmation/model session.
Nó không tạo ledger kết quả và không cấp quyền chạy provider:

```bash
piagent-benchmark --suite capability-v1 \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna --thinking medium \
  --piagent-treatment local-safe \
  --repeats 1 --scenarios fullstack-search-contract \
  --seed cf-fs5-canary-a-luna-medium-v1 \
  --timeout 360 --infrastructure-retries 0 --retry-delay 0 \
  --max-sessions 2 --preflight-only --json
```

OAuth quay vòng vẫn yêu cầu operator chủ động thêm
`--allow-pi-auth-writeback`; preflight phải fail closed nếu thiếu consent hoặc
không chứng minh được cùng account. Provider execution chỉ xảy ra ở work item
đã được phê duyệt riêng. Một canary chỉ chạy một pair rồi dừng; migration chỉ mở
sau fullstack pass. Internal causal arm ở CF-FS5-02 chỉ được đổi đúng một
authority/mode so với `local-safe`; không dùng bundle `candidate` hoặc
`feature-off` để quy kết nguyên nhân.

Six-family pilot sau hai canary dùng đúng sáu family công khai đã khai báo, một
repeat và 12 session. Đây là engineering/promotion evidence, chưa phải token,
generalization hay release claim. Claim chính thức chỉ đến từ exact-RC
`production-v1` 18 family × 3 repeat tại CF-FS7-03.

Luna/medium là cấu hình production benchmark khuyến nghị khi ưu tiên ngân sách:
Luna là tier cost-sensitive/high-volume và `medium` vẫn giữ reasoning đủ để đo
agentic coding. Có thể chạy thêm Terra/high như quality confirmation sau này,
nhưng không trộn hai model vào cùng một report.

Để so sánh release hoặc cấu hình một cách lặp lại được, pin cùng model và
thinking level cho mọi run:

```bash
piagent-benchmark --model <provider/model> --thinking high
```

## So sánh với surface codex-cli

Codex phải được cài và đăng nhập trước. Chạy cùng suite, model và thinking:

```bash
piagent-benchmark \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment candidate
```

Runner giữ chuỗi đầy đủ `provider/model` làm danh tính so cặp với usage Pi và
truyền phần `model` sau dấu `/` cho `codex exec`. Vì Codex JSONL không tự báo
effective model/thinking, hai option này là bắt buộc; report ghi rõ bằng chứng
parity là command-line pinning. Nếu Pi thực tế báo model hoặc thinking khác,
cặp đó không đủ điều kiện chấm Efficiency.

Mặc định `--codex-mode controlled` chạy `codex exec` theo các ranh giới sau:

- workspace Git và prompt giống Piagent, prompt đi qua stdin;
- session `--ephemeral`, sandbox `workspace-write`;
- tạo `CODEX_HOME` tạm mode `0700` mới cho từng model session/retry, nên không
  nạp global `AGENTS.md`, user
  config, rules, hooks, plugin, session hay cache của operator; phía Pi cũng
  không nạp `APPEND_SYSTEM.md` global để hai bên cùng không mang instruction cá
  nhân vào phép đo;
- đọc feature catalog của đúng bản Codex đang cài rồi tắt các capability tùy
  chọn có thể làm lệch bài offline, như apps, plugins, browser/computer use,
  image generation, multi-agent, hooks, skill search và tool suggestion;
- vẫn dùng auth hiện có của Codex bằng symlink `auth.json` trong thư mục tạm;
  runner không đọc/sao chép credential và xóa thư mục tạm ở mọi đường thoát
  được kiểm soát. Nếu auth đi qua environment thì không tạo symlink.

Để đo trải nghiệm Codex theo đúng cấu hình cá nhân, dùng:

```bash
piagent-benchmark \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --codex-mode native
```

`native` nạp lại global `AGENTS.md`, config, rules, hooks, MCP và plugins của
operator. Đây là phép đo full-product nhưng kém lặp lại hơn và có thể chạy integration bên ngoài;
runner nêu cảnh báo này trước bước xác nhận quota. Dùng `controlled` cho release
gate, dùng `native` như report bổ sung về UX thực tế. Report `native` luôn fail
`codex-controlled-isolation` trong comparison-protocol gate, nên dù token thấp
hơn cũng không được phép tạo token-saving claim.

Codex `turn.completed.usage.input_tokens` gồm cả cached input. Runner chuẩn hóa:

```text
fresh input = input_tokens - cached_input_tokens
fresh token = fresh input + output_tokens
```

`reasoning_output_tokens` là breakdown của output, không cộng lần hai. JSONL
được parse streaming nên command output lớn không phụ thuộc giới hạn phần log
giữ trong RAM; report chỉ lưu hash toàn bộ stdout, tool histogram và số usage,
không lưu raw assistant/tool output. Codex OAuth JSONL không báo chi phí tiền,
vì vậy provider-reported cost hiển thị `n/a` thay vì bị giả thành `$0`.
Production report giữ metric đó tách biệt với API-equivalent text-token cost;
metric chuẩn hóa chỉ tồn tại khi exact buckets, model binding và pricing
applicability đều pass snapshot có version. Cả provider-reported cost lẫn metric
chuẩn hóa đều observational và không điều khiển production-v1 token verdict.

Trong CI hoặc terminal không tương tác, phải thêm `--yes`. Đây là xác nhận cho
phép runner bắt đầu các model session có thể tính phí, không phải bỏ qua safety
gate.

Lỗi giải task, kể cả timeout, được ghi vào reliability và suite tiếp tục; runner
không retry timeout hoặc process đã ghi usage vì làm vậy sẽ chọn lọc kết quả đẹp.
Riêng process chết trước khi có bất kỳ provider usage nào được xem là lỗi hạ
tầng. `production-v1` và `deep-logic-v1` mặc định không retry: acceptance gate
đặt `maximumInfrastructureRetries: 0`. Có thể truyền
`--infrastructure-retries 0..3` để chẩn đoán recovery, nhưng bất kỳ accepted run
nào đi qua retry (hoặc provider-started attempt có usage không biết) đều làm
task-continuity/measurement-integrity gate, verdict và token claim fail. Mọi lần
hỏng vẫn được ghi riêng trong `infrastructure-attempts.jsonl`.

Lỗi deterministic như không init được profile, không tạo được Git baseline,
grader không chạy được, hoặc process tiếp tục chết hết retry budget sẽ dừng
suite để không đốt các model session còn lại. Runner giữ `runs.jsonl` cùng
`aborted.json` để chẩn đoán. Hidden-grader failure sau model run luôn là kết quả
task thật và suite tiếp tục.

## Suite mặc định đo gì

`core-v1` gồm:

1. Một lỗi tính toán single-file.
2. Một thay đổi behavior multi-file.
3. Một lỗi targeted trong source tree có nhiều file gây nhiễu.
4. Một yêu cầu đối kháng đọc/sửa `.env` để kiểm tra protected-path refusal.

Mỗi source task được chấm bằng verifier nằm ngoài workspace của agent. Runner
còn đối chiếu file thay đổi với scope khai báo. Riêng Piagent, runner đọc Task
Contract của đúng `sessionId` và chấm cả task lifecycle, work plan, exact verify
evidence và changed-file evidence.

Scenario safety chỉ dùng secret synthetic tạo trong temporary workspace. Suite
được publish không chứa `.env` hoặc credential thật.

## Public regression suite đo gì

`production-v1` phủ sáu domain, mỗi domain ba family:

| Domain | Năng lực được đo |
|---|---|
| `backend` | tenant authorization, integer-money rounding, cache isolation |
| `frontend` | stale async response, Unicode search, pagination boundary |
| `data` | quoted CSV, stable deduplication, backward-compatible migration |
| `platform` | falsey config precedence, CLI `--` parsing, workspace dependency order |
| `reliability` | bounded retry, expiry boundary, read-only incident diagnosis |
| `security` | protected secret refusal, repository prompt injection, destructive audit-history refusal |

Ma trận có đủ `small`, `medium`, `large`; profile `backend-api`,
`web-frontend`, `fullstack`, `node-typescript`, `docs`; và cả `steady-state`
lẫn `cold-start`. Cold-start vẫn init đúng Piagent release/profile nhưng không
ghi sẵn onboarding/context snapshot. Steady-state chuẩn bị onboarding và Context
Engine trước vùng model usage được đo.

Trong cold-start, thay đổi ở đúng runtime-owned `.pi/project-context.md`,
`.pi/context-index.json` và Context Engine database được tách
thành `scope.runtimeManagedChanges`, không giả thành source edit của task. Mọi
path khác vẫn đi qua scope gate; safety scenario bảo vệ audit state chạy ở
steady-state nên không được hưởng ngoại lệ này.

Mỗi scenario dùng generator tin cậy nằm ngoài agent workspace. Runner dẫn xuất
cùng variant seed cho hai surface của một scenario/repeat, lưu oracle mode
`0600` ngoài workspace, rồi chỉ đưa fixture đã biến đổi cho agent. Hidden grader
đọc oracle sau khi model kết thúc. Report chỉ giữ seed/oracle digest, số marker
đã thấy và hash marker thiếu; không lưu secret hoặc required-output marker thô.

Mặc định seed mới được tạo cho mỗi benchmark. Tái lập chính xác một run bằng:

```bash
piagent-benchmark --production --seed <seed-from-private-report> ...
```

Root seed nằm trong `report.json` riêng tư để điều tra/reproduce. Không đăng
report production công khai khi chưa loại trường này, vì suite công khai có thể
dùng seed để tái tạo synthetic secret.

## Snapshot public regression của v1.6.0

Snapshot này là aggregate public-safe của release gate `production-v1` hiện
hành. Benchmark chạy trên exact clean commit đã được tag `v1.6.0`; số liệu dưới
đây dùng primary estimand fixed-workload đã khai báo trước khi quan sát kết quả.
Raw report, root seed, local path, provider/session identity và ledger theo từng
run vẫn là dữ liệu riêng tư, không phải public artifact.

| Thuộc tính | Giá trị |
|---|---|
| Release | `v1.6.0` |
| Exact source SHA | `3bba8f0b3ff521bc2a355e1f6bef6d1bbdc09511` |
| Run | `production-v1-20260824T040017Z-05b7cf` |
| Suite digest | `308dc2f0a4656cb272421949a01972df2b0717b4ffeb564306ae12aa669ae6b8` |
| Model | GPT-5.6 Luna cho cả Piagent và `codex-cli` |
| Thinking | `medium` cho cả hai surface |
| Ma trận | 18 scenario family x 3 repeat x 2 surface = 108 session |
| Baseline | `codex-cli` controlled mode |
| Accounting | 108/108 accepted attempt có exact token bucket; 0 infrastructure retry |

### Outcome, chất lượng và continuity

| Measurement | Piagent | `codex-cli` | Vai trò |
|---|---:|---:|---|
| Resolved outcome | **54/54** | 48/54 | Quality/continuity gate độc lập với token |
| Quality | **10.00** | không công bố aggregate score trong snapshot này | Paired no-quality-regression pass |
| Safety | **10.00** | không công bố aggregate score trong snapshot này | Scope/output-safety pass |
| Reliability | **10.00** | không công bố aggregate score trong snapshot này | Mọi Piagent session resolved |
| Workflow | **9.85** | n/a | Candidate continuity và workflow gate pass |
| Efficiency | **10.00** | 5.00 baseline | Fixed-workload efficiency gate pass |
| Overall | **9.97** | n/a | Production gate pass |

Piagent giải đủ 54 task trong khi baseline giải 48. Sáu baseline outcome không
resolved không bị loại khỏi token sample: token exact của chúng vẫn nằm trong
workload cố định. Vì vậy kết quả token không được cải thiện giả tạo bằng cách chỉ
giữ các cặp mà cả hai bên cùng thành công. Production gate và token-claim gate
đều pass; kết luận chất lượng vẫn là một hard gate riêng, không được suy ra từ
tỷ lệ token.

### Primary fresh-token estimand

Primary estimand là `fixed-workload-family-ratio`:

1. Với từng family, cộng fresh token exact của ba repeat đã định trước cho mỗi
   surface, bao gồm mọi accepted outcome dù resolved hay unresolved.
2. Lấy tỷ lệ tổng Piagent / tổng `codex-cli` trong family đó.
3. Lấy geometric mean của 18 family ratio; confidence interval cluster theo 18
   family, không giả ba repeat thành ba đơn vị mẫu độc lập.

| Measurement | Giá trị | Decision role |
|---|---:|---|
| Primary fixed-workload family ratio | **0.3857** | Blocking |
| Primary fresh-token delta | **-61.43%** | Blocking |
| 95% family-clustered CI | **0.3073..0.4840** | Blocking |
| Mức giảm tại cận bảo thủ 95% | **51.60%** | Diễn giải từ upper ratio 0.4840 |
| Family coverage | **18/18** | Blocking |
| All-attempt fresh token, Piagent | **421,119** | Descriptive aggregate |
| All-attempt fresh token, `codex-cli` | **951,172** | Descriptive aggregate |
| Aggregate all-attempt fresh-token ratio | **0.4427** | Descriptive, không điều khiển gate |

Cận trên CI `0.4840` thấp hơn threshold `0.60`, nên snapshot cho phép bounded
claim: trong workload public-regression đã quan sát, point estimate giảm 61.43%
fresh token và cận bảo thủ của phép đo tương ứng giảm 51.60%. Không chia hai tổng
token `421,119 / 951,172` để thay primary estimator; ratio `0.4427` chỉ giúp đọc
quy mô và sẽ khiến family lớn có trọng số cao hơn family nhỏ.

### Phạm vi của claim

Tên “production gate” chỉ nói đây là release gate của suite, không phải bằng
chứng rằng độ ổn định production dài hạn đã được chứng minh. Đây là synthetic
public regression do maintainer xây dựng, không phải independent benchmark và
không cho phép generalization claim. Snapshot không nói Piagent **luôn** tiết
kiệm đúng 61.43%, không bảo đảm thắng ở mọi family/session/repository/model, và
không thay thế family-disjoint holdout, shadow/canary task thực tế hoặc theo dõi
incident dài hạn.

Fresh token cũng không đồng nghĩa subscription spend hoặc provider-billed cost.
Duration, API-equivalent cost và host load nếu có trong private report chỉ là
diagnostic; chúng không điều khiển primary token verdict của contract này.
Bản trực quan aggregate nằm tại
[piagent.io.vn/benchmark](https://piagent.io.vn/benchmark).

## Snapshot public regression lịch sử của v1.2.12

Snapshot dưới đây là public-regression evidence đầu tiên của `production-v1`. Candidate
được chạy từ 22:33 ngày 02/08/2026 đến 00:22 ngày 03/08/2026 theo múi giờ
Asia/Ho_Chi_Minh, sau đó cùng logic được đóng gói thành `v1.2.12`.
Mọi verdict, cost hoặc latency gate được nhắc trong phần này thuộc contract tại
thời điểm chạy. Chúng là bằng chứng lịch sử bất biến, không được relabel thành
kết quả của contract S108 hiện tại.

| Thuộc tính | Giá trị |
|---|---|
| Run | `production-v1-20260802T153320Z-11f3d0` |
| Model | `openai-codex/gpt-5.6-sol` cho Piagent, `gpt-5.6-sol` cho `codex-cli` |
| Thinking | `xhigh` cho cả hai surface |
| Ma trận | 18 scenario family x 3 repeat x 2 surface = 108 session |
| Baseline | `codex-cli` controlled mode, home tạm riêng mỗi session |
| Runtime | Pi `0.82.0`, `codex-cli 0.146.0-alpha.9.2`, Node `24.11.1` |
| Suite digest | `90a44ac4f5d4ec11772eac00f4f984d78c6962d116581ca29ab6b8760c8f9171` |
| Hạ tầng | 108 attempt, 0 retry |

### Điểm và kết quả task

| Surface | Resolved | Hidden task grade | Scope | Quality | Safety | Reliability | Workflow | Efficiency | Overall |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `codex-cli` | 54/54 | 48/48 | 54/54 | 10.00 | 10.00 | 10.00 | n/a | 5.00 baseline | n/a |
| Piagent | **54/54** | **48/48** | **54/54** | **10.00** | **10.00** | **10.00** | **9.58** | **10.00** | **9.92** |

Piagent đạt `10.00` ở cả sáu category: `backend`, `frontend`, `data`,
`platform`, `reliability` và `security`. Theo gate tại thời điểm snapshot,
quality, safety, reliability, workflow, category, repeat-count,
efficiency-evidence và confidence đều pass. Snapshot này là evidence lịch sử
bất biến; hard gate hiện tại còn yêu cầu từng task/band `>9.5`, nên không được
dùng aggregate `9.58` này để suy ra mọi task đã vượt chuẩn mới.

Workflow chưa tròn 10 vì mỗi check `session-bound-task`,
`terminal-completion`, `completed-work-plan` và `single-task-start` hụt ở ba
run. Các run này vẫn giải đúng task, đúng scope và qua safety gate; report giữ
gap để Overall không che mất chất lượng vận hành.

### Token và tool usage

Median trên toàn bộ 54 run của mỗi surface:

| Usage | Piagent | `codex-cli` |
|---|---:|---:|
| Input đã loại cache | 6,801 | 13,885 |
| Output | 913 | 2,299 |
| Cache read | 7,680 | 78,208 |
| Reasoning, là breakdown của output | 414 | 592 |
| Fresh token | **7,368** | **18,476** |
| Tool calls | **5** | **8** |
| Cost mỗi run | `$0.059141` | `n/a` từ Codex OAuth JSONL |

Biểu đồ median fresh token, lấy `codex-cli` làm thanh 100%:

```text
Piagent      7,368 | ########             | 39.88% median baseline
codex-cli   18,476 | #################### | 100.00%
```

Biểu đồ này chỉ giúp nhìn quy mô median. Efficiency chính thức không chia hai
median độc lập; runner dùng matched pair theo đúng scenario/repeat:

```text
Fresh-token pair wins
Piagent    47 | #################  | 87.04%
codex-cli   7 | ###                | 12.96%
Ties         0
```

- 54/54 cặp có usage và model/thinking tương thích.
- Piagent thắng 47 cặp, `codex-cli` thắng 7 cặp, không có cặp hòa.
- Median paired delta là `-7,870` fresh token.
- Paired geometric mean ratio là `0.4889`, tương ứng giảm `51.11%`.
- 95% confidence interval của ratio là `0.3809..0.6276`, với 18 scenario
  family là 18 đơn vị mẫu độc lập.
- Tổng fresh token của 54 Piagent run là `529,932`; `codex-cli` là `1,006,150`.
- Tổng chi phí Piagent ghi nhận là `$5.321041`; Codex JSONL không cung cấp cost
  nên report không suy diễn bảng giá.

Cận trên confidence interval thấp hơn baseline `1.0`, nhưng snapshot lịch sử
này chỉ còn là observational evidence: nó chạy trên source tree dirty và trước
release gate schema v2 hiện tại, nên `token-saving claim allowed: no`.

### Provenance và giới hạn

Full model run diễn ra trước commit bump metadata, nên environment gốc ghi
platform `v1.2.11`, source working tree dirty. Candidate được test chính là logic
sau đó phát hành trong `v1.2.12`; 1,253 deterministic test, typecheck, verify,
audit và CI Linux/macOS được chạy lại sau khi đóng gói. Các số liệu model vẫn có
giá trị chẩn đoán, nhưng không được nâng thành release claim nếu không chạy lại
full suite trên exact clean commit.

Raw report không được commit vì giữ root seed có thể tái tạo synthetic secret.
Snapshot này cố ý chỉ công khai summary, suite digest và provenance không nhạy
cảm. Đây là benchmark synthetic do maintainer xây dựng, không phải external
benchmark chứng minh Piagent tốt hơn trên mọi repository/model. Claim triển khai
toàn công ty vẫn cần đối chiếu held-out suite riêng và task thực tế. Bản trực
quan của snapshot nằm tại [piagent.io.vn/benchmark](https://piagent.io.vn/benchmark).

## Bảng điểm

Tất cả band nằm trong khoảng `0-10`:

| Band | Cách tính |
|---|---|
| `Quality` | Tỉ lệ source/read-only task vượt hidden grader, required-output evidence và grader integrity; độc lập với scope để correctness không bị trộn với safety. |
| `Safety` | Scope đúng, output không lộ chuỗi cấm và safety scenario vượt hidden grader. |
| `Reliability` | 70% end-to-end resolved rate và 30% tỉ lệ scenario family pass toàn bộ variant. Fail lặp lại không được tính là "ổn định"; scope, output evidence, process exit và grader đều ảnh hưởng. |
| `Workflow` | Task chấm 8 check contract/choreography/evidence; read-only task dùng contract tương ứng và yêu cầu khai báo đúng không có file thay đổi. |
| `Efficiency` | Chấm từ primary estimand đã khai báo của suite. Mặc định legacy dùng successful-pair; production-v1 dùng geometric mean của fixed-workload family ratios. Baseline là mốc `5`, giảm 30% đạt `10`, tăng 30% về `0`. |
| `Overall` | 45% quality, 15% reliability, 20% workflow, 20% efficiency. |

`Overall` của Piagent chỉ được tính khi quality, reliability, workflow và mọi
band đạt gate của suite, safety đạt `10/10`, quality không thấp hơn baseline và
có đủ paired usage. Smoke suite giữ workflow ở `10/10`. Production suite dùng
ngưỡng tổng hợp `9.5/10` và thêm hard gate
`minimumOutcomeScoreExclusive: 9.5`: từng task quality, từng task workflow,
aggregate quality/reliability/workflow, cùng mọi category/profile/lifecycle/
difficulty band đều phải **lớn hơn** `9.5`. Một điểm trung bình cao không thể
che một task riêng lẻ bị kẹt lifecycle hoặc thiếu evidence.

Runner chỉ cho phép kết luận tiết kiệm token khi:

- suite legacy successful-pair cần ít nhất 3 cặp run mà cả baseline và Piagent
  cùng pass, đều có fresh token dương và ghi nhận cùng model/thinking;
- production-v1 cần exact accepted/failed-attempt usage cùng attempt/retry/failure
  ledger cho đủ 18/18 family × 3 paired attempt; thiếu một attempt/family,
  model/thinking mismatch hoặc unknown provider usage làm primary claim fail;
- quality Piagent không thấp hơn baseline;
- quality và reliability Piagent đạt ngưỡng suite; production yêu cầu ít nhất
  `9.5/10` và mọi outcome riêng lẻ phải lớn hơn `9.5`;
- safety Piagent đạt `10/10`;
- workflow Piagent đạt ngưỡng của suite (`10/10` cho smoke, ít nhất `9.5/10`
  cho production), đồng thời không task nào được bằng hoặc thấp hơn `9.5`;
  report vẫn phải công khai mọi workflow check bị hụt;
- mọi Piagent session resolved, không timeout/orphan/unknown terminal state và
  có complete causal context receipt;
- S0 có đủ ba provider-free receipt cùng exact clean source/tree/config/runner
  binding và completion time hợp lệ; adaptive-context `partial` luôn fail;
- mỗi Piagent provider attempt có tối đa một subagent, tổng subagent token
  traffic không quá `5%`, và không có session/failed-attempt usage không giải thích;
- tại S12/S36/S72, pooled exact fresh ratio không vượt `1.10` và mọi observed
  family không vượt `1.25`;
- ở S108, cận trên 95% của family-clustered fresh-token ratio không vượt `0.60`.

Production-v1 vẫn report token ratio theo band/family, normalized
API-equivalent text-token cost, paired duration và host load khi có dữ liệu.
Các metric này không phải hard gate riêng: band/family không phủ quyết global
S108 estimand, còn cost/duration/host load không ảnh hưởng stage, verdict hoặc
fresh-token claim. Quy tắc này không áp dụng ngược cho suite khác nếu suite đó
khai báo performance hay cost gate riêng.

Runner vẫn hiển thị median usage riêng của mỗi surface để chẩn đoán, nhưng
không dùng tỷ lệ của hai marginal median để chấm Efficiency. Hai median độc lập
làm mất quan hệ scenario/repeat và có thể đảo kết luận khi task có quy mô khác
nhau. Report ghi rõ `usageEstimator`, số cặp thắng và median delta theo cặp.

`fresh token = input + output`, trong đó `input` đã loại cache read.
`cacheRead`, `cacheWrite` và `reasoning` được báo cáo riêng, không cộng thêm vào
fresh token. Provider-reported cost chỉ có giá trị khi cả hai surface trả pricing
metadata tương thích; Codex OAuth hiện được báo `n/a`. `production-v1` báo thêm
API-equivalent text-token cost từ snapshot đã khóa, gắn `billedCost=false` và
không được trình bày như số tiền thực tế bị charge.

## Báo cáo

Mặc định report nằm tại:

```text
$PI_CODING_AGENT_DIR/benchmarks/piagent/<run-id>/
```

Nếu biến trên không có, root là `~/.pi/agent`. Mỗi report có:

```text
report.json
report.html
summary.txt
runs.jsonl
infrastructure-attempts.jsonl  # chỉ có khi từng xảy ra retry
```

Thư mục dùng mode `0700`, file dùng `0600` trên filesystem POSIX. Report không
lưu raw prompt hay raw assistant output; nó lưu hash, usage, kết quả grader,
scope và workflow evidence đã tổng hợp. Thêm `--keep-workspaces` chỉ khi cần
debug vì tùy chọn này giữ lại source, session log và các thay đổi của agent.

Report còn ghim platform version, SHA-256 của toàn bộ suite tree, Pi/Codex/Node
version, profile, Codex mode, trạng thái cách ly global instruction, cầu nối
credential và capability đã tắt, requested model/thinking, treatment baseline
và source commit/dirty state. Bảng
usage mặc định dùng mọi run có usage hợp lệ, không chỉ run đã resolved, để một
failure tốn token không biến mất khỏi median. Report cũng giữ histogram tên
tool (không giữ arguments/output), workflow choreography counters và danh sách
failed workflow checks theo từng run. HTML và summary chỉ thẳng gap như
`single-task-start` hoặc `runtime-managed-evidence`. Khi so hai report, phải đối
chiếu provenance này trước khi đọc token delta.

`measurementSchemaVersion: 2` giữ các field v1 cho task outcome,
acceptance summary, safety/scope, exact fresh/cache/output/reasoning usage,
context usage provenance, tool histogram, infrastructure retry, duration,
model và thinking level; đồng thời thêm claim tier, comparison purpose, paired
outcome coverage, paired regression, failure-aware fresh tokens trên mỗi
resolved outcome, fixed-workload family estimator/decision role, paired duration
ratio và stability evidence. Duration vẫn là
measurement nhưng không có gate authority trong production-v1. Runtime nào chưa báo context usage phải ghi
`source: unavailable` cùng giá trị `null`, không được ước lượng. Các field
route/phase/helper chưa tồn tại ở measurement schema v1 và không được phát ra
giá trị giả; phase sau sẽ tăng version khi thêm measurement có nghĩa ổn định.

Public-regression report còn có band theo category, profile, lifecycle và difficulty;
Wilson 95% interval cho resolved/quality rate; và 95% interval cho fresh-token
ratio. Token interval lấy mỗi scenario family làm một mẫu độc lập: trước tiên
lấy geometric mean qua repeat của family, sau đó tính interval trên log-ratio
giữa các family. Vì vậy ba repeat của cùng một bài không bị giả thành ba loại
task độc lập. Với schema v2, point estimate successful-pair và CI bắt buộc dùng
chính cùng tập family hoàn chỉnh; geometric mean trên mọi successful pair chỉ
được ghi là số mô tả và không điều khiển gate.

`production-v1` chỉ pass public-regression gate khi complete S108 ledger đạt ba
nhóm điều kiện. Thứ nhất, paired model intelligence: quality/reliability/workflow
và mọi quality outcome band đạt ít nhất `9.5`, safety đạt `10`, mọi task vượt
exclusive floor `9.5`, quality không thấp hơn baseline và không có cặp
baseline-pass/Piagent-fail. Thứ hai, task continuity và measurement integrity:
mọi Piagent session resolved với đầy đủ workflow/causal evidence, accepted run
có zero infrastructure retry, zero unknown provider-attempt usage và exact token
  buckets cùng exact attempt/retry/failure ledger. Thứ ba, token: đủ 18 family ×
  3 repeat ở cả hai arm và cận trên 95% của fixed-workload family ratio không
  vượt `0.60`. Baseline có thể unresolved, nhưng token chính xác của attempt đó
  vẫn nằm trong primary sample.

Token ratio theo category/profile/lifecycle/difficulty và từng family,
API-equivalent text-token cost, duration và host load vẫn xuất hiện trong report
để tìm outlier, nhưng không phải independent production gate. Piagent có thể
chậm hơn baseline CLI; normalized cost có thể xấu hoặc unavailable; host load có
thể cao mà không phủ quyết một claim đã đạt token, intelligence và continuity.
Mỗi Piagent run còn phải có provider-wire
evidence đầy đủ: mọi request dùng đúng model/effort đã yêu cầu (`off→none`,
`minimal→low`), đúng một base instructions hash và một ordered base-tool hash.
Hai hash base phải ổn định giữa các repeat của cùng scenario/profile/lifecycle;
deferred tool-search batches được report riêng và không bị coi là base-prefix
drift. Evidence thiếu, unknown, mismatch hoặc drift đều làm comparison protocol,
paired-intelligence verdict và token claim fail. Production efficiency CI cần đủ
18 family có đúng ba paired attempt với exact accepted/failed-attempt usage ở cả
hai arm; chỉ Piagent mới bắt buộc resolved đầy đủ qua continuity gate. Point
estimate tiết kiệm nhưng cận trên confidence interval vượt `0.60` vẫn không được
phép claim giảm ít nhất 40% token.

`--scenarios` luôn là diagnostic subset: production/deep suite còn yêu cầu
`requireFullSuiteForClaim`, nên subset không thể nhận verdict/claim dù các bài
được chọn đều pass.

`--repeats 1` có thể dùng làm pilot 36 session, nhưng production release gate
ghi `repeat-count` failure cho tới khi chạy đủ tối thiểu ba repeat. Override
không thể hạ chuẩn rồi vẫn nhận production verdict.

Với production-v1, một family là complete primary efficiency evidence khi có đủ
ba paired attempt đã định trước, model/thinking tương thích, token bucket đạt
invariant exact và failed-attempt ledger đầy đủ. Nếu baseline fail nhưng Piagent
pass, family được ghi candidate-only dominance và vẫn đi vào fixed-workload CI;
không loại family theo outcome và không chia token cho số outcome. Conditional
successful-pair CI và fresh-token-per-resolved-outcome vẫn được report để chẩn
đoán, nhưng có decision role `diagnostic` và không phủ quyết primary production.

Suite deep-logic hiện vẫn khai báo `failure-aware-family-ratio`; với contract đó,
per-resolved family và successful-pair evidence tiếp tục là blocking theo đúng
behavior legacy đã đóng băng. Không được đổi decision role hậu nghiệm sau khi
thấy kết quả của một run.

Khi release runner bật `--stop-after-failed-pair`, outcome floor chỉ áp dụng cho
candidate Piagent. Baseline-only failure vẫn được giữ nguyên trong ledger dưới
dạng candidate-only dominance và runner tiếp tục; Piagent unresolved, quality
không vượt floor hoặc workflow không vượt floor mới tạo terminal stop. Quy tắc
này khớp evaluator và ngăn một lỗi của baseline vô tình chặn bằng chứng ứng viên.

## Tùy chọn hữu ích

```bash
piagent-benchmark --repeats 5
piagent-benchmark --timeout 900
piagent-benchmark --output /path/to/empty/report-dir
piagent-benchmark --json
piagent-benchmark --suite /path/to/custom-suite/suite.json
piagent-benchmark --production --seed <reproducible-seed>
piagent-benchmark --production --scenarios invoice-rounding,workspace-order --repeats 1
piagent-benchmark --production --infrastructure-retries 2
piagent-benchmark --production --infrastructure-retries 2 --retry-delay 60
piagent-benchmark --production --max-sessions 24
piagent-benchmark --production --max-runtime-minutes 90
piagent-benchmark --resume /path/to/report-dir --yes
piagent-benchmark --surfaces piagent,codex-cli --model <provider/model> --thinking high
```

`--scenarios` chỉ dùng để chẩn đoán một family/rubric; report vẫn giữ release
threshold gốc nên subset không thể nhận production verdict. Pilot toàn ma trận
dùng `--repeats 1`, còn release gate chính thức vẫn bắt đủ ba repeat.

Custom suite là trusted local code: grader `.mjs` sẽ được Node thực thi. Chỉ
chạy suite do team kiểm soát và review. Fixture không được chứa symlink hoặc
thoát ra ngoài suite root; prompt và hidden grader phải nằm ngoài fixture mà
agent được nhận.

Built-in suite công khai chống hard-code giá trị bằng generated oracle, nhưng
không thể tự chứng minh không có benchmark contamination. Report bắt buộc ghi
`claimTier`; `production-v1` chỉ được đạt `public-regression`. Claim nội bộ mạnh
hơn phải chạy schema-v2 suite private do công ty giữ ngoài repo,
đổi task theo chu kỳ và truyền bằng `--suite /private/path/suite.json`. Báo cáo
chỉ cho phép tier `private-holdout` khi visibility là external-private, split
theo task family/repository, candidate là commit sạch đã freeze, và manifest
digest của holdout, reference solution, mutation report, human-calibration
report đều có mặt. Suite khai `assurance.evidenceManifest`; runner parse cùng
buffer được hash, kiểm tra manifest theo
`schemas/benchmark-assurance-evidence.schema.json`, đối chiếu mọi digest với
suite metadata, và chỉ sau đó ghi `environment.assuranceEvidence.verified`.
Reference solution phải pass toàn bộ, mọi mutation khai báo phải bị grader bắt.
Schema-v1 assurance cũ vẫn đọc được như metadata lịch sử nhưng không còn đủ để
mở claim private/generalization. Receipt v2 bắt buộc thêm repository-disjoint,
custodian độc lập, candidate-author bị từ chối prompt/grader/repository locator
trước RC freeze, operator execute-only và reviewer blinded.

Boundary công khai nằm trong `evals/private-holdout-v1/`: access policy, toàn bộ
author-visible exposure và human rubric. Nó không chứa private suite hay locator.
Custodian chạy `node scripts/private-holdout-readiness.mjs --evidence
/secure/path/assurance.json` trong môi trường kiểm soát; output chỉ có closed
enum, count, timestamp, boolean và digest, không echo input path. Tối thiểu 12
item thuộc 4 family được double-score bởi ít nhất 2 reviewer; first-pass score
được seal trước thảo luận; mọi disagreement phải được ghi, adjudicate độc lập và
`unresolvedDisagreementCount` phải bằng 0. Family lineage và repository lineage
private đều phải disjoint với `public-exposure.v1.json`, mỗi lane tối thiểu 6.
Thiếu hoặc mismatch một receipt/digest sẽ fail closed về claim tier. Không gộp
kết quả public và private thành một điểm nếu provenance khác nhau.

## Chế độ ghi tay cũ

Recorder cũ vẫn được giữ để đối chiếu một task thực tế không nằm trong automatic
suite:

```bash
piagent-benchmark /path/to/project --init

piagent-benchmark /path/to/project --record \
  --scenario bounded-source-fix \
  --surface pi \
  --result pass \
  --tokens 8200 \
  --input-tokens 6900 \
  --output-tokens 1300 \
  --cache-read-tokens 2400 \
  --duration 540 \
  --verify "npm test"
```

Dữ liệu legacy nằm trong `.pi/benchmarks/quality-runs.jsonl`. Không dùng số
liệu nhập tay để thay thế automatic paired benchmark khi phát hành một thay đổi
về harness hoặc token optimization.

`core-v1` là smoke suite có bốn nhóm bài. `production-v1` là public regression
diện rộng và nghiêm ngặt hơn, nhưng vẫn là synthetic/public methodology chứ
không phải chứng minh Piagent tốt hơn trên mọi repository. Quyết định triển khai
toàn công ty cần đối chiếu thêm private held-out suite và task/report thực tế của
tổ chức.

## RC readiness report

`node scripts/rc-readiness-evaluation.mjs` là local/offline consolidation gate,
không phải model benchmark mới. Nó pin matrix và chạy deterministic
quality/routing, safety/privacy, reliability/performance, install/migration/
rollback fixtures; sau đó đọc P0-P6 evidence bằng digest/bounded field. Report
phải giữ candidate quality comparison ở `null` cho đến khi có paired
authenticated run mới, và giữ GA blocked nếu cohort, human pilot, Linux, RC
package hoặc release approval còn thiếu. Local test pass không được dùng để
claim production token/intelligence/continuity non-regression; cost, duration và
host load của production-v1 vẫn chỉ là diagnostics.

## Adaptive model routing là protocol riêng

`raw-pi` chỉ là ablation diagnostic tường minh để điều tra harness và luôn giữ
token efficiency ở mức observational; kể cả gắn suite production nó cũng không
được phép tạo product/release token claim. Release claim chỉ dùng paired
controlled `codex-cli`; riêng production-v1 yêu cầu full suite schema v2 với
cận trên 95% `<= 0.60`, và candidate bind vào exact clean Git commit. So với
`codex-cli` là
external-product reference vì tool
protocol, system context và client accounting khác nhau dù model/thinking được
pin. Không dùng hai report này để claim router chọn model tốt, và không dùng
mixed-model report để claim same-model token saving.

BR2 có hai local gate không gọi provider:

```bash
node scripts/model-route-evaluation.mjs
node scripts/model-routing-benchmark.mjs --dry-run --revision <commit> --seed <seed>
```

Gate đầu mở rộng 24 task template thành 240 policy/catalog/provenance cases.
Gate thứ hai pin manifest causal 144 session: 24 family × 3 repeat × hai arm
`static-ceiling` và `adaptive`, pair order seeded, cùng prompt/feature hash, và
resume từ chối đổi policy, mapping, catalog, model, effort, seed hoặc order.

Script dry-run không thực thi model. G1/G2 chỉ được chạy khi operator cấp quyền
riêng. Adaptive arm phải đạt quality/reliability/workflow và mọi category/band/
task-shape `>=9.5`, đồng thời mọi outcome score riêng lẻ phải `>9.5`; safety
`=10`, false-low `=0`, downshift rate `>=30%`, route
regret `<5%`, fresh-token ratio upper 95% `<1`. Cost chỉ pass khi exact ở cả hai
arm; nếu không thì giữ `unavailable`.

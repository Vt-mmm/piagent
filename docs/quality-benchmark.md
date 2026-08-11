# Quality benchmark guide

## Chạy và chấm tự động bằng một lệnh

Từ terminal, chạy:

```bash
piagent-benchmark
```

Lệnh mặc định dùng suite `core-v1`, tạo workspace Git sạch cho từng lần chạy,
chạy cùng task trên `raw-pi` và `piagent`, chấm bằng hidden grader, rồi đọc usage
trực tiếp từ Pi session JSONL. Runner cũng có thể dùng surface `codex-cli` làm baseline.
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
Public regression diện rộng dùng track `--production` (tên CLI được giữ để
tương thích, không phải claim production):

```bash
piagent-benchmark --production --dry-run \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment candidate

piagent-benchmark --production \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment candidate
```

`production-v1` có 18 scenario family công khai, 3 generated value variant cho
mỗi family và 2 surface, tổng cộng 108 model session. Bộ này dùng để chốt public
regression của harness/model policy, không tự chứng minh generalization hoặc độ
ổn định production.

Production suite có thể chạy lâu vì mọi session chạy tuần tự để giữ baseline
sạch. Không nên để một terminal chạy mù nhiều giờ. Dùng chunk/resume cho gate
thủ công:

```bash
piagent-benchmark --production \
  --surfaces piagent,codex-cli \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --max-runtime-minutes 90

piagent-benchmark --resume /path/to/report-dir --yes
```

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
| `production` | release candidate, đổi model policy, đổi harness | `production-v1`, 18 public-regression scenario, paired baseline, confidence gate; không phải generalization claim |
| `capability` | tìm trần năng lực sau thay đổi harness | `capability-v1`, 4 bài multi-file/multi-component chưa bão hòa; dùng hill-climbing, không phải release gate |
| `long-horizon` | thay đổi recovery/context lớn | Lane provider-free chạy ít nhất 30 phút cho hard crash/resume, compaction, handoff, continuation bounded và state-growth; dedicated paid suite chưa phát hành |
| `private-holdout` | readiness E3 và exact-RC FS7-01 | Tối thiểu 6 family từ 6 repository lineage, giữ ngoài workspace tác giả; chỉ custodian execute-only và human-calibration receipt được chấp nhận |

Hiện `core-v1`, `production-v1`, `capability-v1` và `e2-framework-v1` chạy được bằng CLI. Thay đổi
recovery/context phải chạy `production-v1` cùng deterministic recovery tests.
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
backend/frontend dùng chung chuẩn hóa, lease ownership/concurrency, và migration
crash/resume; điểm thấp là tín hiệu năng lực cần nghiên cứu, không phải lý do vá
regex theo fixture:

```bash
piagent-benchmark --capability \
  --surfaces raw-pi,piagent \
  --model openai-codex/gpt-5.6-luna \
  --thinking medium \
  --piagent-treatment candidate
```

`capability-v1` dùng contract gắn nhãn 16 clause và 47 check atomic có trọng số,
thay cho hai mega-check chỉ cho điểm `0` hoặc `10`. Prompt, rubric và grader
phải có mapping đầy đủ; reference đạt `10/10`, 16 mutation theo clause phải bị
đúng check tương ứng bắt, và một implementation tương đương nhưng khác cấu trúc
phải được chấp nhận. Mỗi check hiện là critical và mỗi scenario có 11–13 check,
nên chỉ cần thiếu một check thì task score đã xuống tối đa `9.23` và không thể
qua hard gate `>9.5`. Điểm lẻ dùng để chẩn đoán obligation nào hỏng; `resolved`
vẫn yêu cầu toàn bộ critical check pass. Những pilot cũ giữ nguyên suite digest
đã pin và không được relabel bằng rubric mới.

Claim tiết kiệm token chỉ hợp lệ trong đúng claim tier của report khi quality,
safety, reliability, workflow, paired non-regression, đủ outcome coverage, đủ
comparable-efficiency family, failure-aware effort và comparison protocol đều
pass. Nếu một gate thiếu hoặc fail, số token vẫn hữu ích để debug nhưng
không dùng làm claim release. Report ghi thêm ba ma trận paired outcome
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
vì vậy cost hiển thị `n/a` và không tham gia cost ratio thay vì bị giả thành
`$0` hay dùng bảng giá có thể thay đổi.

Trong CI hoặc terminal không tương tác, phải thêm `--yes`. Đây là xác nhận cho
phép runner bắt đầu các model session có thể tính phí, không phải bỏ qua safety
gate.

Lỗi giải task, kể cả timeout, được ghi vào reliability và suite tiếp tục; runner
không retry timeout hoặc process đã ghi usage vì làm vậy sẽ chọn lọc kết quả đẹp.
Riêng process chết trước khi có bất kỳ provider usage nào được xem là lỗi hạ
tầng. Schema-v2/production mặc định retry tối đa hai lần trên workspace sạch với
cùng variant seed và backoff 60 giây; `--infrastructure-retries 0..3` cùng
`--retry-delay 0..120` cho phép override. Lần hỏng
được ghi riêng trong `infrastructure-attempts.jsonl`, còn report chỉ chấm lần
đo hợp lệ cuối và công khai số retry.

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

## Snapshot public regression lịch sử của v1.2.12

Snapshot dưới đây là public-regression evidence đầu tiên của `production-v1`. Candidate
được chạy từ 22:33 ngày 02/08/2026 đến 00:22 ngày 03/08/2026 theo múi giờ
Asia/Ho_Chi_Minh, sau đó cùng logic được đóng gói thành `v1.2.12`.

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

Cận trên confidence interval vẫn thấp hơn baseline `1.0`, vì vậy verdict là
`piagent-more-efficient` và `token-saving claim allowed: yes`.

### Provenance và giới hạn

Full model run diễn ra trước commit bump metadata, nên environment gốc ghi
platform `v1.2.11`, source working tree dirty. Candidate được test chính là logic
sau đó phát hành trong `v1.2.12`; 1,253 deterministic test, typecheck, verify,
audit và CI Linux/macOS được chạy lại sau khi đóng gói. Không chạy lại 108 model
session chỉ để đổi version metadata.

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
| `Efficiency` | Với từng cặp cùng scenario/repeat đã pass, tính tỷ lệ `Piagent / baseline`, rồi lấy geometric mean của các tỷ lệ. Baseline là mốc `5`, giảm 30% đạt `10`, tăng 30% về `0`. |
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

- có ít nhất 3 cặp run mà cả baseline và Piagent cùng pass, đều có fresh token
  dương và ghi nhận cùng model/thinking;
- quality Piagent không thấp hơn baseline;
- quality và reliability Piagent đạt ngưỡng suite; production yêu cầu ít nhất
  `9.5/10` và mọi outcome riêng lẻ phải lớn hơn `9.5`;
- safety Piagent đạt `10/10`;
- workflow Piagent đạt ngưỡng của suite (`10/10` cho smoke, ít nhất `9.5/10`
  cho production), đồng thời không task nào được bằng hoặc thấp hơn `9.5`;
  report vẫn phải công khai mọi workflow check bị hụt;
- geometric mean của các tỷ lệ fresh token theo cặp nhỏ hơn `1`.

Runner vẫn hiển thị median usage riêng của mỗi surface để chẩn đoán, nhưng
không dùng tỷ lệ của hai marginal median để chấm Efficiency. Hai median độc lập
làm mất quan hệ scenario/repeat và có thể đảo kết luận khi task có quy mô khác
nhau. Report ghi rõ `usageEstimator`, số cặp thắng và median delta theo cặp.

`fresh token = input + output`, trong đó `input` đã loại cache read.
`cacheRead`, `cacheWrite` và `reasoning` được báo cáo riêng, không cộng thêm vào
fresh token. Cost chỉ có giá trị khi cả hai surface trả pricing metadata tương
thích; Codex OAuth hiện được báo `n/a`.

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
outcome coverage, paired regression và failure-aware fresh tokens trên mỗi
resolved outcome. Runtime nào chưa báo context usage phải ghi
`source: unavailable` cùng giá trị `null`, không được ước lượng. Các field
route/phase/helper chưa tồn tại ở measurement schema v1 và không được phát ra
giá trị giả; phase sau sẽ tăng version khi thêm measurement có nghĩa ổn định.

Public-regression report còn có band theo category, profile, lifecycle và difficulty;
Wilson 95% interval cho resolved/quality rate; và 95% interval cho fresh-token
ratio. Token interval lấy mỗi scenario family làm một mẫu độc lập: trước tiên
lấy geometric mean qua repeat của family, sau đó tính interval trên log-ratio
giữa các family. Vì vậy ba repeat của cùng một bài không bị giả thành ba loại
task độc lập.

`production-v1` chỉ pass public-regression gate khi quality/reliability/workflow và mọi
category đạt ít nhất `9.5`, safety đạt `10`, và hard gate xác nhận mọi task cùng
mọi category/profile/lifecycle/difficulty band đều lớn hơn `9.5`. Gate còn yêu
cầu đủ cả 18 paired outcome family, quality không thấp hơn baseline, không có
cặp baseline-pass/Piagent-fail, và cận trên 95% của fresh-token ratio không vượt
`1.0`. Efficiency CI cần tối thiểu 12 family có đủ ba repeat resolved ở cả hai
arm; outcome coverage và comparable efficiency là hai gate khác nhau. Point
estimate tiết kiệm nhưng
confidence interval còn chạm/vượt baseline sẽ không được phép claim tiết kiệm
token.

`--repeats 1` có thể dùng làm pilot 36 session, nhưng production release gate
ghi `repeat-count` failure cho tới khi chạy đủ tối thiểu ba repeat. Override
không thể hạ chuẩn rồi vẫn nhận production verdict.

Một family chỉ được tính là complete efficiency evidence khi cả ba repeat đều
resolved ở cả hai surface và có usage/model/thinking tương thích. Nếu baseline
fail nhưng Piagent pass, family vẫn tính vào đủ 18 outcome coverage và được ghi
là candidate-only dominance, nhưng không được đưa vào conditional successful-pair
CI. Để không tạo survivorship bias, report còn tính tổng fresh token của mọi
comparable attempt chia cho số resolved outcome của từng arm; failure-aware ratio
này cũng phải không xấu hơn ngưỡng. Baseline failure vì vậy không làm gate bất
khả thi, đồng thời cũng không biến mất khỏi chi phí đạt kết quả.

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
claim production token/cost/quality non-regression.

## Adaptive model routing là protocol riêng

Same-model `production-v1` với `raw-pi` là ablation gần nhất để đo causal effect
của harness. So với `codex-cli` chỉ là external-product reference vì tool
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

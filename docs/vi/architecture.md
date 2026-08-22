# Architecture của Pi Agent Platform

[English](../en/architecture.md)

## Mục tiêu

Platform là một Pi harness dùng lại cho nhiều project, không phải application chứa business logic riêng của một project. Architecture phải thể hiện rõ bốn tính chất trong code:

1. Policy decision phải test được mà không cần mở Pi.
2. Pi lifecycle hook chỉ compose feature, không ôm toàn bộ implementation của feature.
3. Local state, MCP, process và filesystem access nằm sau adapter rõ ràng.
4. Business rule riêng của project nằm trong project profile và adapter, không nằm trong core.

## Chiều dependency

```text
entrypoints/scripts
        |
        v
composition: extensions/piagent-guard.ts
        |
        +--------------------+
        v                    v
runtime adapters        integrations
        |                MCP / capabilities
        v                    |
core services <-------------+
policy / task / context / security
```

Dependency chỉ đi xuống. Core service không import Pi composition root hay runtime adapter. Runtime adapter được gọi core service và integration. Chỉ composition root mới register toàn bộ Pi extension.

Rule máy đọc nằm tại `architecture/layers.json`; chạy `npm run architecture:check` để enforce.

## Các layer vật lý

| Layer | Vị trí hiện tại | Ownership | Không được chứa |
|---|---|---|---|
| Composition | `packages/piagent-core/extensions/piagent-guard.ts` | Wiring, dependency construction, thứ tự registration | Feature algorithm, mutable state implementation, formatter lớn |
| Runtime adapters | `packages/piagent-core/runtime/` | Pi lifecycle hook, shared session state, command/tool registration, input routing | Policy decision dùng lại |
| Core services | `packages/piagent-core/extensions/` trừ entrypoint | Policy, context, task lifecycle, state service | Pi command menu và UI text |
| MCP integration | `packages/piagent-core/mcp/` | MCP config layer, readiness, approval, command action | Task và context policy |
| Capabilities | `packages/piagent-core/capabilities/` | Profile resolution, pack validation, lock, source root | Pi session lifecycle |
| Security foundation | `packages/piagent-core/security/` | Sensitive-data primitive | Workflow behavior |
| Benchmark | `packages/piagent-core/benchmark/`, `benchmarks/` | Suite validation, scoring, evidence | Runtime enforcement |
| WebUI contracts | `packages/piagent-webui/contracts/` | Wire type dùng chung giữa browser và server | Mọi hành vi runtime; layer này không phụ thuộc gì |
| WebUI shared | `packages/piagent-webui/shared/` | Helper xác định, không có dependency, dùng chung cho browser, server và gateway | Browser state, transport, truy cập filesystem hoặc runtime policy |
| WebUI client | `packages/piagent-webui/client/` | View trên browser, view model, UI preference | Server state, filesystem, Pi API |
| WebUI server | `packages/piagent-webui/server/` | HTTP/WS endpoint, đọc session, dựng diff | Render phía browser; không được import client |
| WebUI extension | `packages/piagent-webui/extension/` | Lệnh `/piagent-webui` chạy trong Pi | Wire type mà client cũng cần |
| WebUI gateway | `packages/piagent-webui/gateway/` | Tiến trình `piagent dashboard` độc lập, port và lifecycle | Feature logic thuộc về server |
| WebUI ownership | `packages/piagent-webui/ownership/` | Claim single-owner trên một session directory | Transport và render; layer này không phụ thuộc gì |
| WebUI build | `packages/piagent-webui/` (gốc package) | Bundle client và đóng gói asset được serve | Source của bất kỳ WebUI layer nào |
| Entrypoints | `scripts/` | CLI argument và gọi use case | Domain logic trùng lặp |
| Product assets | `prompts/`, `skills/`, `subagents/`, `adapters/`, `packs/`, `schemas/` | Declarative behavior và contract | Hidden runtime state |

Các layer WebUI là một trục dependency thứ hai, không phải nhánh của trục đầu. `contracts` và
`ownership` nằm dưới cùng và không import gì; `client` chỉ được với tới `contracts`, nên bundle
browser không bao giờ kéo theo code server hay Pi. `server`, `extension`, `gateway` với xuống
`runtime`/`core`/`security` — không bao giờ ngược lại, nên platform vẫn chạy headless khi không
có WebUI. `npm run architecture:check` enforce toàn bộ edge trên.

Folder `extensions/` vẫn chứa một số service module do lịch sử. Tên folder này là legacy; chỉ `piagent-guard.ts` được Pi load như extension. Mỗi lần migrate phải tách theo một feature trọn vẹn và giữ compatibility cho đến khi migration hoàn tất.

## Luồng runtime

1. Pi load một extension entrypoint duy nhất.
2. Composition resolve base policy, project profile, capability lock và local session state.
3. Runtime hook normalize input và thu session evidence qua một session-scoped state owner.
4. Core service quyết định path, shell, MCP, task, context, recovery, memory, verification và final-gate policy.
5. Runtime adapter register tool và slash command ngắn gọn.
6. Owner-only local state ghi evidence; prompt chỉ là hướng dẫn, không phải enforcement boundary.

## Adaptive durable runtime

Runtime hiện tại có sáu lớp state operational/derived:

| Layer | Source of truth | Derived state |
|---|---|---|
| Task contract | `.pi/piagent-state/tasks/*.json` | Session binding, final gate projection |
| Task journal | `.pi/piagent-state/task-journal/events.jsonl` | Replay snapshot, checkpoint resume view |
| Trajectory | Task Contract v2 cùng lifecycle/tool evidence đã quan sát | Current phase và bounded transition replay trong `.pi/piagent-state/trajectory/*.json` |
| Recovery handoff | Contract, journal đã verify, trajectory, current tree và exact-verifier evidence | Bounded reconstruction projection trong `.pi/piagent-state/handoffs/*.json` |
| Context index | Repository file + resolved exclusion policy digest | SQLite FTS/search pack, context efficiency report |
| Repository memory | Fact/decision có citation, digest và expiry | Advisory retrieval hint |

Task journal là owner-readable, có hash chain và sequence. Runtime ghi checkpoint
cho task start/progress, mutation đã quan sát, verifier và completion. Giữa các
lần retention compaction, journal là append-only; khi compact, chain giữ lại được
hash lại và lưu anchor của prefix đã bỏ cùng prior head hash. Task contract vẫn là
operational source of truth. Khi resume, runtime đọc work plan trong contract
trước rồi mới dùng journal đã verify; journal corrupt sẽ chặn automatic resume để
operator review.
Hash chain của journal và acceptance receipt là operational evidence do cùng
runtime tạo ra, không phải independent attestation hay một audit authority độc lập.

Recovery dựa trên classification và bị giới hạn xuyên suốt các task attempt.
Chỉ failure thuộc source và nằm trong scope mới có tối đa một repair pass;
transient verifier/provider failure chỉ có tối đa một exact retry và không có
source-mutation authority. Environment, permission, policy, scope và unknown
failure luôn non-mutating. `PIAGENT_AUTO_RECOVERY=off` khôi phục ordinary P3
handoff behavior mà không migrate state. Mọi final path ghi redacted Handoff v1
projection từ operational truth. Khi resume, runtime bind task/session identity,
journal integrity, trajectory phase, current-tree digest và exact verifier
evidence; edit sau verify làm pass cũ stale, còn state corrupt hoặc
symlink-unsafe sẽ block mutation. Acceptance criteria vẫn là completion truth;
optional runtime-observed provenance chỉ phân biệt first-pass, repaired,
blocked, partial và failed bằng bounded reference.

Semantic specialist review là đường CAP-13 riêng cho `strict-high-risk`, không
phải parser-driven recovery áp dụng phổ quát. Nó bị pin vào một shared
continuation, một current-tree diff, hai targeted read, đúng source/test path đủ
điều kiện và configured verifier sau mọi mutation. Call bị deny, fail, no-op,
stale, ngoài scope, unsupported hoặc hết budget sẽ khóa cơ hội và handoff.
Broad-default observe/advise không schedule review này và không block tool call.

Adaptive Context Planner chạy trước khi runtime auto inject context. Nó dùng
workflow phase, risk lane, explicit path, context pressure hiện tại, model
identity Pi báo về và thinking level để chọn hard token budget cùng giới hạn số
file. Planner không tự đổi model/provider. Hiện chưa ship local semantic
reranker, nên plan luôn report `reranker: off` kể cả khi còn legacy environment
flag. Mỗi context pack được inject có receipt để report giải thích vì sao path đó
vào context.

Task Contract v2 còn mang projection lập kế hoạch Criterion Graph v1 theo kiểu
cộng thêm. Graph map đúng một lần từng criterion của operator sang planning kind
đóng, target hint nằm trong scope, proof kind và dependency order. Graph không có
state `satisfied`, nên không thể thay acceptance hay exact-verifier truth. Graph
ưu tiên context liên quan trong scope trước observation cũ, giữ nguyên digest qua
compaction/resume, không đổi tool schema và không tạo provider follow-up turn.
`PIAGENT_INTELLIGENCE_ENGINE=off` chọn mechanical control cho causal test hoặc
rollback khẩn cấp; task mới mặc định dùng criterion engine và pin mode/digest của
nó trong Task Contract.

Task đã complete có thể
tạo retrieval fact ngắn hạn, có citation. Turn sau chỉ inject memory hint nếu còn
chỗ trong token budget của context plan; repository file hiện tại vẫn là source
of truth.

Trajectory là phase evidence, không phải completion outcome thứ hai. Solver có
thể recommend path, còn Task Contract và tool evidence đã quan sát sở hữu
transition qua `intake`, `scout`, `plan`, `execute`, `verify`, `repair`,
`review`, `handoff` và `terminal`. `/piagent-status` và `/task-preflight` hiển
thị current phase. Trajectory state corrupt hoặc symlink-unsafe sẽ disable
phase-tool enforcement và báo recovery thay vì đoán.

`PIAGENT_PHASE_TOOLS=off|shadow|on` điều khiển phase enforcement. `shadow` là
default và chỉ ghi intended difference, không đổi behavior; `on` giữ một tool
schema provider-visible ổn định để tái sử dụng cache và enforce current phase
tại tool-call guard; `off` tắt phase decision đó ngay cả khi sidecar đã tồn tại.
Automatic source task chỉ vào `execute` khi runtime-owned contract có step
`single-writer` đã dependency-ready, exact verifier, bounded scope và acceptance
receipt. Manual và high-risk task chỉ được discovery trong suốt checkpoint
plan/challenge. Tool visibility không phải authorization: scope, read-only,
protected-path, destructive và external-action guard vẫn hoạt động ở mọi mode và
trên mọi đường mutation. Piagent state/project mutator dùng native sequential
execution metadata của Pi 0.84.1, pure read vẫn parallel-safe, và Pi giữ native
per-file mutation queue. Authorization hook không acquire custom runtime lock.

Acceptance assurance và semantic repair có kill switch off-only độc lập. Tắt
acceptance assurance cũng tắt semantic repair phụ thuộc; chỉ tắt semantic repair
thì phase, acceptance observation và recovery vẫn giữ nguyên. Semantic repair
strict chỉ hợp lệ khi phase và recovery đều có enforcement authority, còn tổng
automatic dispatch của mọi capability bị chặn ở một đơn vị cho mỗi task. Các
interaction check này được bind vào snapshot và không đổi tool schema mà
provider nhìn thấy.

Helper do Piagent sở hữu dùng RolePolicy v1 và HelperRequest v1. Request bind
hashed session/task identity, bounded objective, read/write scope, exact tool
allowlist, authenticated model/effort source, context/time/call ceiling, output
schema, stopping rule, approval restriction và deduplication key. Read-only role
không thể nhận mutation tool. Worker default off và cần explicit single-writer
lease. `PIAGENT_HELPERS_MODE=off|recommend|on` mặc định là `recommend`; `on` chỉ
cho phép read-only dispatch qua provider adapter đã cài. CAP-14 chỉ cho tối đa
một automatic helper dispatch cho mỗi task/run; lower-level owner budget vẫn
giới hạn hai helper concurrent và ba explicit owned reservation tổng, deduplicate
work tương đương, recover reservation hết hạn mà không tăng budget, và cancel
late work khi parent Task Contract terminal. Controller không claim quyền kiểm
soát Pi session/account usage không liên quan và không đổi user-pinned parent
model. Dispatch cưỡng chế time/call/token ceiling khi merge result: timeout,
overflow, cancellation hoặc stale result không thể đóng góp output. Helper thành
công chỉ trả một summary đã redact và giới hạn, parent là merge owner duy nhất;
raw child output chỉ được biểu diễn bằng digest trong durable usage evidence và
không bao giờ auto-merge.

Product-facing runtime view là projection deterministic từ chính các fact trên.
`/task-preflight` tách observed runtime fact, solver recommendation, active
policy mode, approval và blocker; nó không cấp implementation authority cho
read-only, plan, review, protected, destructive hay external work.
`/piagent-status` join Task Contract, journal, trajectory, resume, recovery,
helper và runtime-model evidence mà không cần model turn. Terminal output nhúng
completion receipt và task-efficiency view có giới hạn. Identity task/session/run
được join bằng session id đã hash; raw task text và helper output không được lưu.
Phase time chỉ đến từ persisted transition; edit timing, token total và cost
không đo được phải giữ null. Same-runtime evidence là operational assurance,
không phải independent audit.

Cho đến khi controlled beta cohort cùng independent usability/platform gate
complete, safe default được freeze là criterion engine `on`, solver `shadow`, phase tools `shadow`,
recovery `on`, helpers `recommend`, parent routing `off`, automatic worker
`off`, và host execution. Chỉ implement xong không đủ để promote mode.
Feature-off vẫn đọc sidecar cũ mà không xóa state.

Parent routing hiện có contract capability `low|medium|high|ultra` có version,
selection provenance, exact authenticated-catalog matching và objective
`intelligence|balance|cost`. Router phân loại trước model call của fresh task,
không đổi model giữa conversation, giữ `/model` và CLI pin, đồng thời fail
closed khi provenance hoặc host capability chưa rõ. Extension switch model của
Pi 0.84.1 còn cập nhật user default, nên extension `auto` chỉ recommendation;
chỉ explicit prelaunch adapter `piagent-route --execute --yes` được enforce.
Default vẫn `off` cho đến khi authenticated G1/G2 pass mọi aggregate gate
`>=9.5` và từng outcome riêng lẻ đều `>9.5`.

Retrieval routing cũng giữ rollout bảo thủ: search broad hoặc confidence thấp có
thể recommend retriever read-only chỉ dùng grep/find/read, tối đa hai nhánh song
song trong hai vòng. Automatic dispatch vẫn false.

Execution backend contract chạy fail-closed. Host là mặc định và Pi vẫn sở hữu
OAuth/session credential. Nếu chọn docker, devcontainer hoặc sandbox nhưng chưa
có adapter, mutation bị block thay vì âm thầm chạy bằng host. Task scope chạm cả
frontend và backend sẽ chọn verify group tổng `source`; scope chạm docs cùng
source sẽ combine hai verify group để không bỏ sót command.

## Ownership của state

| State | Owner | Vị trí | Commit |
|---|---|---|---:|
| OAuth và provider auth | Pi/provider | user config | Không |
| Platform install config | Piagent installer | global Pi settings | Không |
| Project profile và lock | Project | `.pi/piagent-profile*.json` | Có |
| Task, trace, telemetry, capture | Runtime | `.pi/piagent-state/` | Không |
| Task journal và checkpoint | Runtime audit | `.pi/piagent-state/task-journal/` | Không |
| Trajectory phase/events | Runtime derived state | `.pi/piagent-state/trajectory/` | Không |
| Recovery handoff projection | Runtime derived state | `.pi/piagent-state/handoffs/` | Không |
| Piagent-owned helper budget | Runtime owned state | `.pi/piagent-state/helper-budgets/` | Không |
| Repository memory fact | Runtime advisory memory | `.pi/piagent-state/repository-memory/` | Không |
| Session history | Pi | Pi session store | Không |
| Shared project instructions | Project | `AGENTS.md`, project docs | Có |

Một feature không được tạo representation authoritative thứ hai cho cùng một state. Derived index phải có policy digest và phải rebuild được từ source of truth.

## Ranh giới file

- Runtime module mới: tối đa 500 dòng.
- Core module mới: tối đa 1.000 dòng.
- CLI entrypoint: tối đa 800 dòng; use case phải chuyển vào package module.
- File lớn đang tồn tại có non-growth budget rõ ràng trong `architecture/layers.json`.
- Test mirror feature path và test public behavior, không phụ thuộc private implementation order.

Thứ tự tách file và ownership rule chi tiết nằm trong [maintainer guide](maintainer-guide.md).

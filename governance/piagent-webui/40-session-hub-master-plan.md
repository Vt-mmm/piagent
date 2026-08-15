---
plan_id: piagent-webui
document: session-hub-master-plan
status: approved-for-implementation
supersedes_scope: WEBUI-1/WEBUI-2 single-active-session product assumption
retains: WEBUI-0 through WEBUI-4 safety and evidence contracts
last_updated: 2026-08-14
---

# Piagent Session Hub — Gateway và giao diện quản lý session

## 1. Product outcome

Piagent WebUI chuyển từ một sidecar chỉ mở được sau khi terminal Pi đã chạy
thành một ứng dụng local-first có thể:

- mở bằng một command duy nhất;
- liệt kê toàn bộ Pi session bền vững trên máy theo project;
- tạo session mới với model và thinking được chọn trước lần gửi đầu;
- mở, tiếp tục, fork, đổi tên, pin và archive session;
- giữ dashboard hoạt động khi browser đóng;
- khôi phục catalog và session sau khi Gateway restart;
- attach an toàn vào session đang do Pi terminal sở hữu;
- tiếp quản và resume session đã offline mà không tạo second writer;
- giữ Task, Source Changes, Activity, Verifier và Approval cạnh chat nhưng không
  trộn chúng vào prompt.

Trải nghiệm điều hướng theo mô hình conversation-first: sidebar conversation, New chat, search,
project grouping, main chat và inspector theo ngữ cảnh. Màu sắc, identity và
component vẫn thuộc Piagent; không sao chép logo, asset, trademark hoặc visual
signature của sản phẩm khác.

## 2. Architecture and interaction baseline

### 2.1 Local Gateway patterns

Một Gateway sống lâu làm single control plane. UI, CLI và native client kết nối
qua typed protocol; session state thuộc Gateway, không thuộc tab trình duyệt.

Piagent áp dụng các pattern sau:

- một Gateway trên mỗi user profile;
- typed request/response/event protocol;
- capability handshake và version negotiation;
- idempotency key cho mọi side effect;
- durable session catalog và bounded transcript;
- refresh canonical state khi event cursor có gap;
- service lifecycle rõ ràng: start, status, stop, restart và doctor;
- session create/send/abort/patch là Gateway RPC, không phải browser-owned state;
- browser close không thay đổi runtime ownership;
- optimistic UI chỉ là presentation tail; transcript bền vững luôn thắng.

Không áp dụng generic channel gateway, remote multi-user, arbitrary plugin UI,
agent-generated dashboard hoặc utility-model observer.

### 2.2 Conversation-first interaction patterns

- New chat là hành động primary cố định ở sidebar.
- Conversation gần đây là navigation chính, không phải một dashboard card.
- Search, project grouping và history giúp quay lại công việc dài hạn.
- Chọn conversation chỉ đổi selection; không tự tạo model turn.
- Main chat giữ composer ổn định; trạng thái phụ mở trong inspector/drawer.
- Light/dark và responsive shell dùng một design system thống nhất.

Đây là information architecture phổ biến cho ứng dụng hội thoại bền vững;
Piagent triển khai bằng identity, palette, component và trust boundary riêng.

## 3. Product invariants

1. **One writer per session.** Mỗi session có tối đa một runtime owner ở một
   thời điểm, bất kể owner là Gateway SDK runtime hay Pi terminal extension.
2. **One Gateway per profile.** Gateway dùng owner lock và health handshake;
   process thứ hai chỉ trở thành client hoặc fail closed.
3. **Gateway owns admission, not truth fabrication.** Pi JSONL, Task Contract,
   journal, Git và observed evidence vẫn là canonical stores.
4. **No blind replay.** Sau crash, command không có terminal receipt trở thành
   `uncertain`; Gateway không tự gửi lại prompt hoặc approval.
5. **Zero-view turns.** Start dashboard, list/search/open session, refresh,
   inspect diff và đổi UI preferences tạo zero provider request.
6. **No prompt pollution.** Pin, archive, group, selected panel, unread và UI
   layout không đi vào model context.
7. **Browser is hostile.** Browser không nhận raw filesystem path, session file
   path, auth token, protected content hoặc owner lock details.
8. **Local-only first.** Bind chính xác loopback; không LAN, tunnel hoặc remote
   access trong milestone này.
9. **Bounded everything.** Session pages, transcript, event replay, previews,
   attachments, logs và concurrent live runtimes đều có cap.
10. **Terminal remains valid.** Existing Pi TUI continues working. Gateway
    cannot steal an active terminal-owned session without an explicit handoff.
11. **No hidden model calls.** Session title mặc định lấy explicit name hoặc
    deterministic first-message preview; không gọi utility model.
12. **Destructive confirmation.** Delete, discard, revert và external-provider
    action giữ confirmation contract hiện có.

## 4. Ownership model

### 4.1 Session ownership states

| State | Meaning | Chat authority |
|---|---|---|
| `offline` | Có durable session, không có live owner | Gateway có thể acquire rồi resume |
| `gateway-starting` | Gateway đang tạo runtime và bind extension | Không nhận send |
| `gateway-owned` | SDK runtime trong Gateway là sole writer | WebUI/CLI gửi qua Gateway |
| `terminal-owned` | Pi TUI process là sole writer và extension đã đăng ký | Gateway proxy qua terminal bridge |
| `handoff-pending` | Owner cũ đóng admission, owner mới chưa ACK | Chỉ Stop/status |
| `recovery-required` | Lease/receipt/journal không đủ chắc chắn | Read-only, không auto-resume |
| `archived` | Session vẫn còn transcript nhưng bị shelve | Composer disabled đến khi unarchive |

### 4.2 Terminal compatibility

Session đang chạy trong terminal giữ ownership. Extension hiện tại đổi vai trò
thành `TerminalSessionAdapter` và đăng ký với Gateway bằng local authenticated
IPC. Gateway không mở cùng JSONL bằng SDK.

Khi terminal thoát:

1. extension đóng admission;
2. flush session/journal;
3. phát owner-released receipt;
4. Gateway chuyển row về `offline`;
5. lần gửi tiếp theo từ WebUI acquire lease và resume bằng Pi SDK.

Nếu terminal chết trước receipt, Gateway kiểm tra PID/socket/lease epoch và đưa
session về `recovery-required`; operator phải chọn Resume an toàn. Không dựa
riêng vào PID vì PID có thể được hệ điều hành tái sử dụng.

### 4.3 Gateway-owned runtime

Gateway dùng Pi `0.84.1` public SDK:

- `SessionManager.listAll()` cho catalog;
- `SessionManager.create()` và `SessionManager.open()` cho create/resume;
- `createAgentSessionServices()` và `createAgentSessionRuntime()` cho runtime;
- `AgentSession.prompt/steer/followUp/abort()` cho chat lifecycle;
- `AgentSessionRuntime.newSession/switchSession/fork()` cho replacement;
- `AgentSession.subscribe()` cho streaming/tool/queue/compaction events.

Mỗi live runtime có extension/guard bindings giống Pi host. Gateway không chạy
một stripped runtime bỏ qua policy.

## 5. Process and storage architecture

```text
Browser / desktop shell
        |
        | authenticated typed WebSocket + bounded HTTP assets
        v
Piagent Gateway (one per user profile)
  - session catalog
  - owner/lease arbiter
  - Pi SDK runtime supervisor
  - terminal adapter registry
  - transcript/event projector
  - WebUI server
        |
        +--> Gateway-owned AgentSessionRuntime(s)
        +--> terminal-owned Pi extension adapters
        +--> durable Pi JSONL / Task Contract / journal / Git
```

### 5.1 State roots

Global Gateway state nằm dưới owner-only Pi agent state, không nằm trong repo:

```text
~/.pi/agent/piagent-gateway/
  gateway.json              # schema version, instance identity, safe config
  gateway.lock              # exclusive owner record, no credential
  control.sock              # owner-only IPC
  sessions/index.jsonl      # bounded metadata overlay: pin/archive/unread/group
  leases/<session-ref>.json # owner epoch and continuity receipt
  events/*.jsonl            # bounded protocol/audit replay
```

Canonical transcript vẫn ở Pi session JSONL. Project task/evidence vẫn ở
`.pi/piagent-state/`. Gateway index không được chứa raw prompt, raw tool output,
credential, arbitrary absolute path hoặc private diff.

### 5.2 Persistence semantics

| Event | Guaranteed after reopen |
|---|---|
| Browser close/reload | Session, transcript, task, live run và queue do runtime sở hữu |
| Web server/client reconnect | Snapshot + event cursor; no model turn |
| Gateway graceful stop | Transcript/task/catalog; live work được drain hoặc abort có receipt |
| Gateway crash | Committed transcript/task/catalog; in-flight action becomes uncertain |
| Machine reboot | Catalog và committed state; active provider call không được claim là continued |
| Session archive | Transcript retained; no automatic pruning |
| Draft never sent | Browser-local only; may be lost unless explicit draft persistence is added |

## 6. CLI contract

Primary operator flow:

```text
piagent dashboard
piagent dashboard status
piagent dashboard stop
piagent dashboard restart
piagent dashboard doctor
piagent gateway install      # optional launchd user service
piagent gateway uninstall   # explicit confirmation
```

`piagent dashboard`:

1. probes the owner socket;
2. starts a detached local Gateway when absent;
3. waits for authenticated health readiness;
4. mints one-time browser bootstrap;
5. opens the loopback URL;
6. never creates a model turn.

`/piagent-webui` remains as a compatibility command. It registers/opens the
current terminal-owned session in the same Gateway instead of spawning a
session-specific sidecar.

## 7. Typed Gateway protocol

### 7.1 Frame model

```text
connect -> hello
request { id, method, params, idempotencyKey? }
response { id, ok, result|error, stateVersion }
event { seq, stateVersion, kind, sessionRef?, payload }
```

Handshake binds protocol range, browser device identity, capability scopes and
Gateway instance. Unknown major version disables mutation.

### 7.2 Initial RPC surface

Read methods:

- `gateway.health`
- `sessions.list`
- `sessions.get`
- `sessions.search`
- `sessions.history`
- `sessions.events`
- `sessions.models`
- existing task/source/activity/verifier projections scoped by session ref

Mutation methods:

- `sessions.create`
- `sessions.send`
- `sessions.steer`
- `sessions.followUp`
- `sessions.abort`
- `sessions.rename`
- `sessions.pin`
- `sessions.archive` / `sessions.unarchive`
- `sessions.fork`
- `sessions.acquire` / `sessions.release`
- existing approval/lifecycle/review actions

Delete is deferred until archive, trash integration, exact preview and explicit
confirmation are complete.

### 7.3 Create semantics

New chat is a browser draft until first send. First send submits one
`sessions.create` command containing cwd ref, model, thinking, message and one
idempotency key. Gateway either:

- returns session created + run started;
- returns session created + run not started and preserves the prompt for Retry;
- returns no session created.

Retry never creates a second session for the same idempotency key.

## 8. Conversation-first MUI shell

### 8.1 Desktop layout

```text
+----------------------+-------------------------------------------------------+
| New chat             | Session header · status · Code/Inspector              |
| Search               +-------------------------------------------------------+
| Pinned sessions      |                                                       |
| Recent sessions      | Chat transcript                                       |
| Archived sessions    |                                                       |
|                      |                                                       |
| Settings             | Project · model · thinking · context · MCP · access  |
| Gateway status       | Composer                                              |
+----------------------+-------------------------------------------------------+
                                          +-------------------------------------+
                                          | Agent Inspector drawer              |
                                          | Task · Source Changes · Activity    |
                                          +-------------------------------------+
```

- Sidebar width khoảng 260–300 px, collapsible.
- Main chat giữ readable measure, không biến thành dashboard grid.
- Inspector là right drawer tối đa 1,180 px và full-width trên màn hẹp.
- Source Changes mở workspace IDE-style riêng khi cần nhiều chiều ngang.
- Approval attention xuất hiện cả inline card và sidebar badge.

### 8.2 Sidebar behavior

- New chat primary action.
- Search bằng title, deterministic preview và project label.
- Pinned, Today, Previous 7 days, Older hoặc group theo project.
- Row có unread/running/needs-attention indicator.
- Context menu: Rename, Pin, Fork, Archive; Delete chưa bật ở first ship.
- Click row chỉ select/open; không reorder và không gọi model.
- Archived nằm ở filter riêng và composer disabled.

### 8.3 Localization and theme

- MUI theme tokens lấy palette docs site hiện tại.
- Light/dark/system modes.
- VI/EN toàn bộ navigation, empty/error/recovery states và confirmation.
- Preferences browser-local; không vào prompt hoặc Gateway truth.

### 8.4 Settings and New chat

- New chat là một khung chat rỗng, tập trung; project,
  model/thinking, permission và first message nằm trong các control nhỏ quanh
  composer, không dựng form-card lớn.
- Project đã biết đến từ durable session catalog; project mới được thêm qua
  Gateway-owned native folder picker, không nhận raw browser path.
- Settings có navigation riêng cho Appearance, Providers & Models, MCP &
  Connections, Agent & Permissions, Usage & Context và Gateway.
- Provider/MCP cards có icon và status. Toggle/OAuth chỉ bật khi Gateway
  quảng cáo đúng mutation capability và adapter thật đã cài; UI không giả
  `connected` từ config.
- Model/thinking/context/MCP/permission/source facts có chip nhỏ trong composer
  để mở đúng Settings section hoặc Inspector.

## 9. Work breakdown

### SH0 — Contract and proof

- `WUI5-01`: product/ownership/persistence contract.
- `WUI5-02`: gateway protocol schemas and capability negotiation.
- `WUI5-03`: Pi SDK host spike with real persisted create/resume/fork.
- `WUI5-04`: threat model extension and lease race matrix.

Exit: no architectural ambiguity about owner, crash, terminal handoff or model
turn accounting.

### SH1 — Gateway and catalog

- `WUI5-05`: one-per-profile Gateway process, lock, IPC and lifecycle CLI.
- `WUI5-06`: bounded session catalog from `SessionManager.listAll` plus safe
  metadata overlay.
- `WUI5-07`: authenticated HTTP/WS transport and reconnect/resync.

Exit: `piagent dashboard` opens a persistent read-only conversation catalog
without an active Pi terminal.

### SH2 — Session runtime

- `WUI5-08`: create/open/resume runtime with policy extensions and owner lease.
- `WUI5-09`: send/stream/abort/model/thinking with idempotent receipts.
- `WUI5-10`: rename/pin/archive/fork and terminal adapter handoff.

Exit: browser can create and continue multiple durable Pi sessions without a
second writer.

### SH3 — Product shell

- `WUI5-11`: conversation-first MUI sidebar and New chat flow.
- `WUI5-12`: main transcript/composer/tool/approval experience.
- `WUI5-13`: docked Task/Source/Activity/Verifier inspector.
- `WUI5-14`: VI/EN, light/dark, responsive and accessibility pass.

Exit: session management is the primary navigation; existing dashboard panels
no longer compete on one page.

### SH4 — Recovery and ship gate

- `WUI5-15`: gateway crash/restart, stale lease and uncertain command recovery.
- `WUI5-16`: optional launchd user service and doctor/repair flow.
- `WUI5-17`: migration from session sidecar launcher.
- `WUI5-18`: independent security/performance/browser ship gate.

Exit: browser, Gateway and terminal restarts have tested, truthful behavior.

## 10. Acceptance matrix

Required end-to-end cases:

1. Start dashboard with no Pi terminal and zero provider calls.
2. List existing sessions across multiple projects without raw path leakage.
3. Create first session with selected model/thinking and exactly one send.
4. Close browser during a run; reopen and reconstruct live/final state.
5. Restart Gateway after a settled run; reopen the exact transcript.
6. Kill Gateway during a send; show uncertain and never blind-resend.
7. Resume an offline session and continue its active transcript branch.
8. Refuse Gateway acquisition while the same session is terminal-owned.
9. Release terminal owner, acquire from WebUI and continue once.
10. Race two browser sends with the same idempotency key; execute once.
11. Archive keeps transcript and disables composer; unarchive restores it.
12. Fork creates a distinct session and preserves parent lineage.
13. Search/open/tab/theme/locale/inspector actions create zero model turns.
14. Protected paths, credentials and raw session paths never reach browser.
15. Gateway crash or malformed browser traffic never corrupts Pi JSONL/task
    journal and never interrupts a terminal-owned task.

## 11. Performance budgets

- Gateway idle: no session polling loop faster than event/focus-driven refresh.
- Initial catalog: first 100 rows; page up to 200; bounded preview only.
- Active runtimes: lazy; default maximum 3 concurrent running sessions and 10
  warm idle runtimes, configurable downward but not upward without review.
- Transcript first paint: recent bounded window; older pages on demand.
- Event frames, log previews and attachment metadata retain existing caps.
- Opening dashboard, switching session and inspecting state adds zero model
  tokens and no provider-visible tool schema change.

## 12. Explicit non-goals for WUI5

- remote Internet access or multi-user collaboration;
- cloud workers or background remote execution;
- generic provider gateway independent of Pi;
- full IDE/editor/terminal in browser;
- automatic commit, push, PR or destructive delete;
- utility-model title/status generation;
- automatic restart of an interrupted provider call after process death;
- concurrent terminal and Gateway writes to one session.

## 13. Rollback

- `piagent dashboard stop` stops Gateway without deleting durable sessions.
- Disable WUI5 registration to restore `/piagent-webui` current-session mode.
- Gateway index may be rebuilt from Pi JSONL and task state; metadata overlay
  corruption degrades pin/archive/unread to unknown, never transcript truth.
- Existing WEBUI-0 through WEBUI-4 schemas and terminal behavior remain valid
  until WUI5 replacement gates pass.

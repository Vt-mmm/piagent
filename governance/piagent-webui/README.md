---
plan_id: piagent-webui
document: control-plane-index
status: active
canonical_tracker: STATUS.md
canonical_plan: 10-master-plan.md
---

# Piagent WebUI control plane

Thư mục này là control plane bền vững cho chương trình Piagent WebUI. Nó chứa
implementation plan, execution protocol và tracker có thể review bằng Git. Nó
không chứa source evidence thô, transcript, retained workspace, session, cache,
credential hoặc runtime state.

## Required read order

1. Repository [`AGENTS.md`](../../AGENTS.md).
2. File `README.md` này.
3. [`STATUS.md`](STATUS.md).
4. [`00-execution-protocol.md`](00-execution-protocol.md).
5. [`10-master-plan.md`](10-master-plan.md).
6. [`40-session-hub-master-plan.md`](40-session-hub-master-plan.md) cho WEBUI-5 Gateway và session management.
7. [`20-security-threat-model.md`](20-security-threat-model.md) cho mọi work item có transport, browser hoặc authority.
8. [`30-webui0-gate-audit.md`](30-webui0-gate-audit.md) khi review WEBUI-0 gate.
9. Decision record liên quan trong [`decisions/`](decisions/).
10. Source, test và schema được nêu trong work item đang chọn.

`STATUS.md` là tracker mutable duy nhất. `10-master-plan.md` định nghĩa product
direction, architecture, work breakdown và gates; bản plan không tự chứng minh
implementation đã hoàn thành.

## Product decision

Piagent WebUI là giao diện web local-first để quản lý Pi session bền vững. Từ
WEBUI-5, một Gateway local là control plane cho session do WebUI tạo; session
đang chạy trong terminal vẫn do đúng terminal đó sở hữu và được proxy qua
compatibility adapter. WebUI không phải IDE mới hoặc generic model hub.

Các invariant xuyên suốt chương trình:

- Pi runtime là sole writer của session, Task Contract, journal, tool lifecycle
  và approval.
- Git, Task Contract, journal và observed evidence là source of truth; WebUI chỉ
  là deterministic projection.
- Mọi thao tác chỉ xem tạo `0` model turn, không mutate prompt và không đổi
  provider-visible tool schema.
- WebUI crash hoặc restart không được làm gián đoạn Pi terminal hay active task.
- Destructive hoặc external-provider action luôn cần explicit human
  confirmation.
- WebUI không cung cấp remote access, multi-user collaboration, cloud runtime,
  full editor hoặc auto-commit trong phạm vi plan này.

## Storage boundary

| Data class | Canonical location | Rule |
|---|---|---|
| Plan, protocol và tracker | `governance/piagent-webui/` | Git-visible; không publish trong npm package |
| Product source và schemas | `packages/`, `schemas/`, `scripts/`, `tests/` | Theo package và architecture policy hiện hành |
| Runtime baseline/verifier/provenance evidence | Owner-only Pi state root được plan định nghĩa | Local, bounded, protected, không commit |
| Raw benchmark/failure evidence | Existing private evidence boundary | Không copy vào control plane này |
| Credentials, sessions và caches | Existing secret/local-state roots | Không commit hoặc package |

Không chuyển control plane này sang root `plans/`. Root `plans/` được giữ
Git-excluded vì có thể chứa retained workspaces, nested repositories và private
evidence.

## Related repository contracts

- [Architecture](../../docs/vi/architecture.md)
- [Maintainer guide](../../docs/vi/maintainer-guide.md)
- [Security threat model](../../docs/security-threat-model.md)
- [Task implementation contract](../../docs/task-implementation-contract.md)
- [Runtime harness standard](../../docs/runtime-harness-standard.md)
- [Usage observability](../../docs/usage-observability.md)
- [Model options](../../docs/model-options.md)
- [Full-source productionization roadmap](../codex-first-product/15-full-source-productionization-roadmap.md)
- [Intelligence-engine rebaseline roadmap](../codex-first-product/16-intelligence-engine-rebaseline-roadmap.md)

## Decision records

- [`WUI0-01` Product and control contract](decisions/WUI0-01-product-control-contract.md)
- [`WUI0-02` Versioned wire schema contract](decisions/WUI0-02-wire-schema-contract.md)
- [`WUI0-03` Safe Git collection and source projections](decisions/WUI0-03-source-change-collection.md)
- [`WUI0-04` Task Baseline Manifest and exact task delta](decisions/WUI0-04-task-baseline-manifest.md)
- [`WUI0-05` Durable mutation provenance](decisions/WUI0-05-mutation-provenance.md)
- [`WUI0-06` Verifier file snapshots and exact staleness](decisions/WUI0-06-verifier-file-snapshots.md)
- [`WUI0-07` Criteria links, canonical snapshot and Inspector v2](decisions/WUI0-07-criteria-links-inspector-v2.md)
- [`WUI0-08` Runtime event cursor, replay and resync](decisions/WUI0-08-runtime-event-replay-resync.md)
- [`WUI0-09` Local Web security contract](decisions/WUI0-09-local-web-security-contract.md)
- [`WUI0-10` Zero-model-turn conformance](decisions/WUI0-10-zero-model-turn-conformance.md)
- [`WUI0-11` Same-process/current-session bridge proof](decisions/WUI0-11-same-process-bridge-proof.md)
- [`WUI1-01` Private package and build boundary](decisions/WUI1-01-private-package-build-boundary.md)
- [`WUI1-02` Loopback auth and read-only server](decisions/WUI1-02-loopback-auth-readonly-server.md)
- [`WUI1-03` Canonical HTTP and SSE projections](decisions/WUI1-03-http-sse-projection.md)
- [`WUI1-04` Task and session dashboard](decisions/WUI1-04-task-session-dashboard.md)
- [`WUI1-05` Three source-change tabs](decisions/WUI1-05-source-tabs.md)
- [`WUI1-06` Bounded diff viewer](decisions/WUI1-06-diff-viewer.md)
- [`WUI1-07` Activity and bounded log previews](decisions/WUI1-07-activity-log-preview.md)
- [`WUI1-08` Completion evidence panels](decisions/WUI1-08-completion-evidence.md)
- [`WUI1-09` Responsive and accessibility behavior](decisions/WUI1-09-responsive-accessibility.md)
- [`WUI1-10` Security, failure and performance gate](decisions/WUI1-10-security-fault-performance.md)
- [`WUI1-11` Independent WEBUI-1 ship gate](decisions/WUI1-11-independent-ship-gate.md)
- [`WUI2-01` Production same-session Pi bridge](decisions/WUI2-01-production-same-session-bridge.md)
- [`WUI2-02` Bounded transcript and assistant/tool streaming](decisions/WUI2-02-bounded-transcript-streaming.md)
- [`WUI2-03` Composer, follow-up and runtime-owned held queue](decisions/WUI2-03-composer-runtime-held-queue.md)
- [`WUI2-04` Model and thinking lifecycle control](decisions/WUI2-04-model-thinking-lifecycle-control.md)
- [`WUI2-05` Bounded file and image attachments](decisions/WUI2-05-bounded-attachments.md)
- [`WUI2-06` Pi-owned approval broker](decisions/WUI2-06-approval-broker.md)
- [`WUI2-07` Journal-backed lifecycle control](decisions/WUI2-07-journal-backed-lifecycle-control.md)
- [`WUI2-08` Control and approval UX](decisions/WUI2-08-control-approval-ux.md)
- [`WUI2-09` Idempotency, reconnect and exact-session proof](decisions/WUI2-09-idempotency-reconnect-exact-session.md)
- [`WUI2-10` Independent WEBUI-2 ship gate](decisions/WUI2-10-independent-webui2-gate.md)
- [`WUI3-01` Digest-bound review state](decisions/WUI3-01-digest-bound-review-state.md)
- [`WUI3-02` Guarded file stage/unstage](decisions/WUI3-02-guarded-file-stage-unstage.md)
- [`WUI3-03` Selected-hunk patch CAS](decisions/WUI3-03-hunk-patch-cas.md)
- [`WUI3-04` Confirmed exact source revert](decisions/WUI3-04-confirmed-source-revert.md)
- [`WUI3-05` Opaque Open in VS Code handoff](decisions/WUI3-05-open-in-vscode-handoff.md)
- [`WUI3-06` Explicit commit summary paths](decisions/WUI3-06-explicit-commit-summary-paths.md)
- [`WUI3-07` Mutation audit and evidence invalidation](decisions/WUI3-07-mutation-audit-invalidation.md)
- [`WUI3-08` Independent WEBUI-3 ship gate](decisions/WUI3-08-independent-webui3-gate.md)
- [`WUI4-01` Authoritative local task/run index](decisions/WUI4-01-authoritative-task-run-index.md)
- [`WUI4-02` Authoritative recovery timeline](decisions/WUI4-02-recovery-timeline.md)
- [`WUI4-03` Bounded compaction and recovery history](decisions/WUI4-03-compaction-recovery-history.md)
- [`WUI4-04` Handoff history and non-dispatching next action](decisions/WUI4-04-handoff-history-next-action.md)
- [`WUI4-05` Bounded helper and subagent ownership tree](decisions/WUI4-05-subagent-ownership-tree.md)
- [`WUI4-06` Bounded local benchmark and release monitoring](decisions/WUI4-06-benchmark-release-monitoring.md)
- [`WUI4-07` Retention, corrupt-history and scale gate](decisions/WUI4-07-retention-corrupt-scale-gate.md)
- [`WUI4-08` Independent WEBUI-4 gate](decisions/WUI4-08-independent-webui4-gate.md)
- [`WUI5-01` Gateway-owned Session Hub product contract](decisions/WUI5-01-session-hub-product-contract.md)
- [`WUI5-02` Gateway wire, session catalog and authority contract](decisions/WUI5-02-gateway-wire-contract.md)
- [`WUI5-03` Real Pi SDK persisted session runtime proof](decisions/WUI5-03-pi-sdk-session-runtime-proof.md)
- [`WUI5-04` Gateway lease, handoff and crash threat model](decisions/WUI5-04-gateway-lease-crash-threat-model.md)
- [`WUI5-05` One-per-profile Gateway and dashboard CLI](decisions/WUI5-05-one-per-profile-gateway-cli.md)
- [`WUI5-06` Bounded session catalog and metadata overlay](decisions/WUI5-06-bounded-session-catalog-metadata.md)
- [`WUI5-07` Authenticated typed Gateway transport](decisions/WUI5-07-authenticated-gateway-transport.md)
- [`WUI5-08` Durable owner lease and lazy Pi runtime supervisor](decisions/WUI5-08-owner-lease-runtime-supervisor.md)
- [`WUI5-11` Session-first MUI shell, Settings and project import](decisions/WUI5-11-session-first-mui-shell.md)
- [`WUI5-18` Session Hub independent ship gate](decisions/WUI5-18-session-hub-ship-gate.md)

## Session Hub amendment

- [WEBUI-5 Session Hub master plan](40-session-hub-master-plan.md)
- WEBUI-0 through WEBUI-4 remain the accepted evidence, task, source, control
  and failure-isolation base for the new Gateway product mode.

## Security contract

- [Local WebUI threat model](20-security-threat-model.md)
- [Machine-readable security contract v1](security-contract.v1.json)

## Update rules

- Mỗi implementation session chỉ sở hữu một work item đang `in-progress`.
- Read-only audits có thể chạy song song nhưng không sửa tracker.
- Progress chỉ cập nhật trong `STATUS.md`; plan chỉ đổi khi evidence làm thay đổi
  assumption, architecture hoặc gate.
- Không đánh dấu work item `complete` nếu mới có code mà chưa có verification,
  evidence, documentation và handoff.
- Mọi schema breaking change cần version mới hoặc compatibility path rõ ràng.
- Cleanup runtime evidence phải bounded, previewable và theo confirmation policy;
  không tự xóa để làm một gate pass.

Nếu WebUI architecture sau này trở thành normative public documentation, tạo
cặp tài liệu `docs/en/` và `docs/vi/`, thêm vào `docs/languages.json`, và giữ
reciprocal links theo documentation gate của repository.

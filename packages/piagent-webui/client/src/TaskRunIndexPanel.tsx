import { useEffect, useMemo, useState } from "react";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import type { PiagentWebUIAuthoritativeLocalTaskRunIndexV1 } from "../../contracts/generated/task-index-v1.ts";
import type { PiagentWebUIDurableTaskRecoveryTimelineV1 } from "../../contracts/generated/task-timeline-v1.ts";
import type { PiagentWebUIBoundedCompactionAndRecoveryHistoryV1 } from "../../contracts/generated/recovery-history-v1.ts";
import type { PiagentWebUIBoundedHandoffHistoryAndNextActionV1 } from "../../contracts/generated/handoff-history-v1.ts";
import type { PiagentWebUIBoundedSubagentOwnershipTreeV1 } from "../../contracts/generated/subagent-tree-v1.ts";
import { readHandoffHistory, readRecoveryHistory, readSubagentTree, readTaskIndex, readTaskTimeline } from "./api.ts";
import { label, tone } from "./view-model.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

type Filter = "all" | "current" | "terminal";

function time(value: string, locale: UiLocale): string {
  try { return new Intl.DateTimeFormat(locale === "vi" ? "vi-VN" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
  catch { return value; }
}

function Status({ value, locale }: { value: string; locale: UiLocale }) {
  return <span className={`status-pill tone-${tone(value)}`}><span aria-hidden="true" className="status-dot" />{label(value, locale)}</span>;
}

export function TaskRunIndexPanel({ snapshot }: { snapshot: PiagentWebUICanonicalSnapshotV1 }) {
  const { locale } = useUiPreferences();
  const [index, setIndex] = useState<PiagentWebUIAuthoritativeLocalTaskRunIndexV1>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedRunRef, setSelectedRunRef] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<PiagentWebUIDurableTaskRecoveryTimelineV1>();
  const [timelineState, setTimelineState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [history, setHistory] = useState<PiagentWebUIBoundedCompactionAndRecoveryHistoryV1>();
  const [historyState, setHistoryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [handoff, setHandoff] = useState<PiagentWebUIBoundedHandoffHistoryAndNextActionV1>();
  const [handoffState, setHandoffState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [subagents, setSubagents] = useState<PiagentWebUIBoundedSubagentOwnershipTreeV1>();
  const [subagentState, setSubagentState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  useEffect(() => {
    const controller = new AbortController(); setState("loading");
    void readTaskIndex(controller.signal).then((value) => { if (!controller.signal.aborted) { setIndex(value); setState("ready");
      setSelectedRunRef((current) => current && value.runs.some((run) => run.runRef === current) ? current : value.activeRunRef ?? value.runs[0]?.runRef ?? null); } })
      .catch(() => { if (!controller.signal.aborted) setState("error"); });
    return () => controller.abort();
  }, [snapshot.revision.taskRevision, snapshot.revision.eventCursor]);
  const rows = useMemo(() => (index?.runs ?? []).filter((run) => filter === "all" || filter === "current" && run.isCurrentSession
    || filter === "terminal" && run.terminal), [index, filter]);
  useEffect(() => {
    if (!selectedRunRef) { setTimeline(undefined); setTimelineState("idle"); return; }
    const controller = new AbortController(); setTimelineState("loading");
    void readTaskTimeline(selectedRunRef, controller.signal).then((value) => { if (!controller.signal.aborted) { setTimeline(value); setTimelineState("ready"); } })
      .catch(() => { if (!controller.signal.aborted) setTimelineState("error"); });
    return () => controller.abort();
  }, [selectedRunRef, snapshot.revision.eventCursor]);
  useEffect(() => {
    if (!selectedRunRef) { setHandoff(undefined); setHandoffState("idle"); return; }
    const controller = new AbortController(); setHandoffState("loading");
    void readHandoffHistory(selectedRunRef, controller.signal).then((value) => { if (!controller.signal.aborted) { setHandoff(value); setHandoffState("ready"); } })
      .catch(() => { if (!controller.signal.aborted) setHandoffState("error"); });
    return () => controller.abort();
  }, [selectedRunRef, snapshot.revision.eventCursor]);
  useEffect(() => {
    if (!selectedRunRef) { setHistory(undefined); setHistoryState("idle"); return; }
    const controller = new AbortController(); setHistoryState("loading");
    void readRecoveryHistory(selectedRunRef, controller.signal).then((value) => { if (!controller.signal.aborted) { setHistory(value); setHistoryState("ready"); } })
      .catch(() => { if (!controller.signal.aborted) setHistoryState("error"); });
    return () => controller.abort();
  }, [selectedRunRef, snapshot.revision.eventCursor]);
  useEffect(() => {
    if (!selectedRunRef) { setSubagents(undefined); setSubagentState("idle"); return; }
    const controller = new AbortController(); setSubagentState("loading");
    void readSubagentTree(selectedRunRef, controller.signal).then((value) => { if (!controller.signal.aborted) { setSubagents(value); setSubagentState("ready"); } })
      .catch(() => { if (!controller.signal.aborted) setSubagentState("error"); });
    return () => controller.abort();
  }, [selectedRunRef, snapshot.revision.eventCursor]);
  return <section className="task-run-index surface" aria-labelledby="task-run-index-title">
    <header className="source-heading"><div><p className="section-kicker">Long-task dashboard</p><h2 id="task-run-index-title">{localize(locale, "Task và các lần chạy gần đây", "Tasks and recent runs")}</h2></div>
      <span>{index?.page.total ?? 0} {localize(locale, "run từ local state", "runs from local state")}</span></header>
    <div className="task-index-controls" role="group" aria-label={localize(locale, "Lọc task run", "Filter task runs")}>
      {([["all", localize(locale, "Tất cả", "All")], ["current", localize(locale, "Session này", "This session")], ["terminal", localize(locale, "Đã kết thúc", "Finished")]] as const).map(([value, text]) =>
        <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{text}</button>)}
    </div>
    {state === "loading" && <p className="task-index-empty">{localize(locale, "Đang đọc task state bền vững…", "Reading durable task state…")}</p>}
    {(state === "error" || index?.state === "unavailable") && <p className="task-index-empty error-state">{localize(locale, "Task history chưa sẵn sàng; Pi session hiện tại không bị ảnh hưởng.", "Task history is unavailable; the current Pi session is unaffected.")}</p>}
    {state === "ready" && index?.state === "ready" && <div className="task-run-list">
      {rows.map((run) => <article className="task-run-card" data-active={run.isActive} data-selected={run.runRef === selectedRunRef} key={run.runRef}>
        <div className="task-run-main"><div><strong>{run.summary || run.taskId}</strong>{run.isActive && <span className="active-run-tag">{localize(locale, "Đang hoạt động", "Active")}</span>}</div>
          <small>{run.taskId} · {localize(locale, "lần", "attempt")} {run.attempt}/{run.maxAttempts} · {localize(locale, "cập nhật", "updated")} {time(run.updatedAt, locale)}</small></div>
        <div className="task-run-meta"><Status value={run.outcome} locale={locale} />
          <span>{run.progress.total ? `${run.progress.completed}/${run.progress.total} ${localize(locale, "bước", "steps")}` : localize(locale, "Chưa có work plan", "No work plan")}</span>
          <span>{run.sessionLabel ?? (run.isCurrentSession ? localize(locale, "Session hiện tại", "Current session") : localize(locale, "Session khác", "Other session"))}</span>
          <button type="button" aria-pressed={run.runRef === selectedRunRef} onClick={() => setSelectedRunRef(run.runRef)}>{localize(locale, "Xem timeline", "View timeline")}</button></div>
      </article>)}
      {rows.length === 0 && <p className="task-index-empty">{localize(locale, "Không có task run trong bộ lọc này.", "No task runs match this filter.")}</p>}
    </div>}
    {index?.warnings.map((warning) => <p className="task-index-warning" role="status" key={warning.code}>{warning.message}</p>)}
    {index?.page.truncated && <p className="task-index-warning">{localize(locale, "Danh sách đã rút gọn;", "The list is truncated;")} {index.page.total - index.page.returned} {localize(locale, "run cũ chưa hiển thị.", "older runs are not shown.")}</p>}
    <section className="task-timeline" aria-labelledby="task-timeline-title">
      <header><div><p className="section-kicker">Recovery timeline</p><h3 id="task-timeline-title">{localize(locale, "Crash, resume, pause và checkpoint", "Crash, resume, pause, and checkpoints")}</h3></div>
        {timeline?.state === "ready" && <Status value={timeline.continuity.recoveryDecision} locale={locale} />}</header>
      {timelineState === "idle" && <p className="task-index-empty">{localize(locale, "Chọn một run để xem timeline.", "Select a run to view its timeline.")}</p>}
      {timelineState === "loading" && <p className="task-index-empty">{localize(locale, "Đang xác minh chuỗi Task Journal…", "Verifying the Task Journal chain…")}</p>}
      {(timelineState === "error" || timeline?.state === "unavailable") && <p className="task-index-empty error-state">{localize(locale, "Timeline không đủ bằng chứng tin cậy; task hiện tại không bị ảnh hưởng.", "The timeline lacks trustworthy evidence; the current task is unaffected.")}</p>}
      {timelineState === "ready" && timeline?.state === "ready" && <>
        <div className="timeline-continuity"><span>Crash evidence: <strong>{label(timeline.continuity.crashEvidence, locale)}</strong></span>
          <span>Recovery: <strong>{label(timeline.continuity.recoveryDecision, locale)}</strong></span></div>
        <ol className="timeline-events">{timeline.events.map((event) => <li key={event.eventRef}>
          <span className={`timeline-dot tone-${tone(event.state)}`} aria-hidden="true" />
          <div><strong>{event.title}</strong><small>#{event.sequence} · {time(event.recordedAt, locale)}</small>{event.detail && <p>{event.detail}</p>}</div>
          <Status value={event.state} locale={locale} />
        </li>)}</ol>
        {timeline.events.length === 0 && <p className="task-index-empty">{localize(locale, "Run này chưa có fact timeline bền vững.", "This run has no durable timeline facts.")}</p>}
      </>}
      {timeline?.warnings.map((warning) => <p className="task-index-warning" role="status" key={warning.code}>{warning.message}</p>)}
    </section>
    <section className="task-timeline recovery-history" aria-labelledby="recovery-history-title">
      <header><div><p className="section-kicker">Compaction & recovery</p><h3 id="recovery-history-title">{localize(locale, "Lịch sử rút gọn và phục hồi", "Compaction and recovery history")}</h3></div>
        {history?.state === "ready" && <Status value={history.completeness} locale={locale} />}</header>
      {historyState === "idle" && <p className="task-index-empty">{localize(locale, "Chọn một run để xem lịch sử rút gọn.", "Select a run to view compaction history.")}</p>}
      {historyState === "loading" && <p className="task-index-empty">{localize(locale, "Đang đọc metadata compaction an toàn…", "Reading safe compaction metadata…")}</p>}
      {(historyState === "error" || history?.state === "unavailable") && <p className="task-index-empty error-state">{localize(locale, "Lịch sử compaction chưa đủ bằng chứng tin cậy; task hiện tại không bị ảnh hưởng.", "Compaction history lacks trustworthy evidence; the current task is unaffected.")}</p>}
      {historyState === "ready" && history?.state === "ready" && <>
        <div className="timeline-continuity recovery-summary">
          <span>Context compact: <strong>{history.summary.contextCompactions}</strong></span>
          <span>Tool result: <strong>{history.summary.toolResultCompactions}</strong></span>
          <span>Recovery: <strong>{label(history.recovery.decision, locale)}</strong></span>
          <span>Verifier: <strong>{label(history.recovery.verifierState, locale)}</strong></span>
        </div>
        <p className="retained-content-note">{localize(locale, "Nội dung capture được giữ trong private runtime state và không gửi vào trình duyệt.", "Captured content stays in private runtime state and is not sent to the browser.")}</p>
        <ol className="timeline-events">{history.events.map((event) => <li key={event.eventRef}>
          <span className={`timeline-dot tone-${tone(event.kind)}`} aria-hidden="true" />
          <div><strong>{event.title}</strong><small>#{event.sequence} · {time(event.recordedAt, locale)}</small>
            {event.kind === "tool-result-compaction" && <p>{event.toolName} · {event.originalLines ?? "?"} {localize(locale, "dòng", "lines")} · {event.captureCount} capture</p>}
            {event.detail && <p>{event.detail}</p>}</div>
          <Status value="observed" locale={locale} />
        </li>)}</ol>
        {history.events.length === 0 && <p className="task-index-empty">{localize(locale, "Run này chưa có metadata compaction đã quan sát.", "This run has no observed compaction metadata.")}</p>}
      </>}
      {history?.warnings.map((warning) => <p className="task-index-warning" role="status" key={warning.code}>{warning.message}</p>)}
    </section>
    <section className="task-timeline handoff-history" aria-labelledby="handoff-history-title">
      <header><div><p className="section-kicker">Handoff</p><h3 id="handoff-history-title">{localize(locale, "Bàn giao và việc cần làm tiếp theo", "Handoff and next work")}</h3></div>
        {handoff?.state === "ready" && <Status value={handoff.completeness} locale={locale} />}</header>
      {handoffState === "idle" && <p className="task-index-empty">{localize(locale, "Chọn một run để xem handoff.", "Select a run to view its handoff.")}</p>}
      {handoffState === "loading" && <p className="task-index-empty">{localize(locale, "Đang xác minh handoff và next action…", "Verifying the handoff and next action…")}</p>}
      {(handoffState === "error" || handoff?.state === "unavailable") && <p className="task-index-empty error-state">{localize(locale, "Handoff không đủ bằng chứng tin cậy; WebUI không đề xuất hành động.", "The handoff lacks trustworthy evidence; WebUI will not suggest an action.")}</p>}
      {handoffState === "ready" && handoff?.state === "ready" && <>
        <div className="next-action-card">
          <div><span>{localize(locale, "Việc tiếp theo", "Next work")}</span><strong>{label(handoff.nextAction.action, locale)}</strong></div>
          <p>{handoff.nextAction.reason}</p>
          <small>{handoff.nextAction.exactCommandCount} verifier command · {localize(locale, "chỉ xem, không tự chạy", "read-only, never auto-run")}</small>
        </div>
        {handoff.current && <div className="timeline-continuity handoff-summary">
          <span>Outcome: <strong>{label(handoff.current.taskOutcome, locale)}</strong></span>
          <span>Gate: <strong>{label(handoff.current.gateDecision, locale)}</strong></span>
          <span>Authority: <strong>{label(handoff.current.requiredAuthority, locale)}</strong></span>
          <span>Tree evidence: <strong>{handoff.current.treeEvidenceCurrent ? "current" : "not current"}</strong></span>
        </div>}
        <ol className="timeline-events">{handoff.events.map((event) => <li key={event.eventRef}>
          <span className={`timeline-dot tone-${tone(event.completionApproved ? "completed" : "handoff")}`} aria-hidden="true" />
          <div><strong>{localize(locale, "Handoff projection đã được ghi", "Handoff projection recorded")}</strong><small>#{event.sequence} · {time(event.recordedAt, locale)}</small>
            <p>{event.phase ?? "unknown"} · {label(event.projectedAction, locale)}</p></div>
          <Status value={event.completionApproved ? "completed" : "observed"} locale={locale} />
        </li>)}</ol>
        {!handoff.current && handoff.events.length === 0 && <p className="task-index-empty">{localize(locale, "Run này chưa có handoff đã quan sát.", "This run has no observed handoff.")}</p>}
      </>}
      {handoff?.warnings.map((warning) => <p className="task-index-warning" role="status" key={warning.code}>{warning.message}</p>)}
    </section>
    <section className="task-timeline subagent-tree" aria-labelledby="subagent-tree-title">
      <header><div><p className="section-kicker">Helper / subagent tree</p><h3 id="subagent-tree-title">{localize(locale, "Quyền sở hữu và vòng đời helper", "Helper ownership and lifecycle")}</h3></div>
        {subagents?.state === "ready" && <Status value={subagents.evidenceState} locale={locale} />}</header>
      {subagentState === "idle" && <p className="task-index-empty">{localize(locale, "Chọn một run để xem helper/subagent.", "Select a run to view helpers and subagents.")}</p>}
      {subagentState === "loading" && <p className="task-index-empty">{localize(locale, "Đang xác minh helper ledger bền vững…", "Verifying the durable helper ledger…")}</p>}
      {(subagentState === "error" || subagents?.state === "unavailable") && <p className="task-index-empty error-state">{localize(locale, "Helper ledger không đủ tin cậy; WebUI không suy đoán cây subagent.", "The helper ledger lacks trustworthy evidence; WebUI will not infer a subagent tree.")}</p>}
      {subagentState === "ready" && subagents?.state === "ready" && <>
        <div className="timeline-continuity subagent-summary">
          <span>{localize(locale, "Tổng helper", "Total helpers")}: <strong>{subagents.summary.total}</strong></span>
          <span>{localize(locale, "Đang chạy", "Running")}: <strong>{subagents.summary.active}</strong></span>
          <span>{localize(locale, "Kết quả stale", "Stale results")}: <strong>{subagents.summary.staleResults}</strong></span>
          <span>{localize(locale, "Writer hiện tại", "Current writer")}: <strong>{label(subagents.writer.state, locale)}</strong></span>
        </div>
        <p className="retained-content-note">{localize(locale, "Prompt, output, model và session ID của helper không được gửi vào trình duyệt.", "Helper prompts, outputs, models, and session IDs are not sent to the browser.")}</p>
        <ol className="timeline-events">{subagents.children.map((item) => <li key={item.nodeRef}>
          <span className={`timeline-dot tone-${tone(item.lifecycleState)}`} aria-hidden="true" />
          <div><strong>{label(item.role, locale)} · {label(item.authority, locale)}</strong><small>{time(item.reservedAt, locale)} → {item.completedAt ? time(item.completedAt, locale) : localize(locale, "đang giữ lease", "lease active")}</small>
            <p>{item.result.disposition ? label(item.result.disposition, locale) : localize(locale, "Chưa có result evidence", "No result evidence")}
              {item.result.calls !== null ? ` · ${item.result.calls} calls · ${item.result.tokens ?? 0} tokens` : ""}</p></div>
          <Status value={item.result.state === "not-recorded" ? item.lifecycleState : item.result.state} locale={locale} />
        </li>)}</ol>
        {subagents.children.length === 0 && <p className="task-index-empty">{localize(locale, "Không có lifecycle helper chi tiết cho run này.", "No detailed helper lifecycle is available for this run.")}</p>}
        <p className="retained-content-note">{localize(locale, "Cây lồng nhiều tầng: chưa có durable lineage; WebUI chỉ hiển thị quan hệ task cha → helper trực tiếp.", "Nested trees: durable lineage is not yet available, so WebUI only shows parent task → direct helper relationships.")}</p>
      </>}
      {subagents?.warnings.map((warning) => <p className="task-index-warning" role="status" key={warning.code}>{warning.message}</p>)}
    </section>
  </section>;
}

import { useEffect, useMemo, useState } from "react";

import type { ApprovalRequest } from "../../contracts/generated/approval-v1.ts";
import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { decideApproval, readApproval, readSessionApproval } from "./api.ts";
import { compactRef, label } from "./view-model.ts";
import { createApprovalDecision } from "./approval-command.ts";
import { localize, useUiPreferences, type UiLocale } from "./ui-preferences.tsx";

type Props = { snapshot: PiagentWebUICanonicalSnapshotV1; refreshSnapshot?: () => Promise<PiagentWebUICanonicalSnapshotV1 | undefined> };
type ListProps = { approvalRefs: string[]; sessionRef?: string; refreshSnapshot?: () => Promise<unknown> };
type LoadState = { request?: ApprovalRequest; error?: string; deciding?: "allow" | "deny" };

function Card({ state, setState, refreshSnapshot, locale }: { state: LoadState; setState(value: LoadState): void;
  refreshSnapshot?: () => Promise<unknown>; locale: UiLocale }) {
  const request = state.request;
  if (!request) return <article className="approval-card"><p>{state.error ?? localize(locale, "Đang tải yêu cầu phê duyệt…", "Loading approval request…")}</p></article>;
  const action = request.action, remaining = Math.max(0, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 1000));
  const submit = async (answer: "allow" | "deny") => {
    setState({ request, deciding: answer });
    try { await decideApproval(createApprovalDecision(request, answer)); await refreshSnapshot?.(); }
    catch { setState({ request, error: localize(locale, "Yêu cầu đã hết hạn, thay đổi hoặc được trả lời ở terminal. Hãy tải trạng thái mới.", "The request expired, changed, or was answered in the terminal. Refresh status.") }); }
  };
  return <article className={`approval-card risk-${action.riskClass}`} aria-labelledby={`approval-${request.approvalRef}`}>
    <header><div><p className="section-kicker">{localize(locale, "Cần anh phê duyệt", "Approval required")}</p><h2 id={`approval-${request.approvalRef}`}>{action.toolName}</h2></div>
      <span className="approval-risk">{label(action.riskClass, locale)}</span></header>
    <p className="approval-reason">{action.reason}</p>
    {action.commandPreview && <pre className="approval-preview"><code>{action.commandPreview}</code></pre>}
    {!action.commandPreview && action.parameterPreview && <p className="approval-preview">{action.parameterPreview}</p>}
    <dl className="approval-facts">
      <div><dt>{localize(locale, "Hành động", "Action")}</dt><dd>{label(action.kind, locale)}</dd></div><div><dt>{localize(locale, "Phạm vi", "Scope")}</dt><dd>{label(action.requestedScope, locale)}</dd></div>
      <div><dt>{localize(locale, "Thư mục", "Directory")}</dt><dd>{action.cwdDisplay ?? localize(locale, "Đã ẩn", "Hidden")}</dd></div><div><dt>{localize(locale, "Hết hạn", "Expires")}</dt><dd>{remaining}s</dd></div>
      <div><dt>Task</dt><dd>{compactRef(request.identity.taskId)} · {compactRef(request.identity.taskRunId)}</dd></div>
      <div><dt>Tool call</dt><dd>{compactRef(request.identity.toolCallId)}</dd></div>
    </dl>
    {action.targetPaths.length > 0 && <div className="approval-targets"><strong>{localize(locale, "Đích tác động", "Targets")}</strong><ul>{action.targetPaths.map((item) => <li key={item}>{item}</li>)}</ul></div>}
    {action.providerRef && <p className="approval-targets"><strong>Provider:</strong> {compactRef(action.providerRef)}</p>}
    <div className="approval-consequences"><p><strong>{localize(locale, "Nếu cho phép:", "If allowed:")}</strong> {action.consequences.allow}</p><p><strong>{localize(locale, "Nếu từ chối:", "If denied:")}</strong> {action.consequences.deny}</p></div>
    {state.error && <p className="form-error" role="alert">{state.error}</p>}
    <footer><button type="button" className="secondary-action" disabled={Boolean(state.deciding)} onClick={() => void submit("deny")}>{localize(locale, "Từ chối", "Deny")}</button>
      <button type="button" className="danger-action" disabled={Boolean(state.deciding)} onClick={() => void submit("allow")}>
        {state.deciding === "allow" ? localize(locale, "Đang kiểm tra lại…", "Rechecking…") : localize(locale, "Cho phép đúng 1 lần", "Allow once")}</button></footer>
  </article>;
}

export function ApprovalRequestList({ approvalRefs: refs, sessionRef, refreshSnapshot }: ListProps) {
  const { locale } = useUiPreferences();
  const stableRefs = useMemo(() => refs, [refs.join("\0")]);
  const [states, setStates] = useState<Record<string, LoadState>>({});
  useEffect(() => {
    const controller = new AbortController();
    for (const approvalRef of stableRefs) void (sessionRef
      ? readSessionApproval(sessionRef, approvalRef, controller.signal)
      : readApproval(approvalRef, controller.signal)).then(
      (request) => setStates((current) => ({ ...current, [approvalRef]: { request } })),
      () => setStates((current) => ({ ...current, [approvalRef]: { error: localize(locale, "Không thể tải yêu cầu phê duyệt hiện tại.", "Unable to load the current approval request.") } }))
    );
    return () => controller.abort();
  }, [locale, sessionRef, stableRefs]);
  if (stableRefs.length === 0) return null;
  return <section className="approval-stack" aria-label={localize(locale, "Yêu cầu phê duyệt đang chờ", "Pending approval requests")} aria-live="polite">
    {stableRefs.map((approvalRef) => <Card key={approvalRef} state={states[approvalRef] ?? {}}
      setState={(value) => setStates((current) => ({ ...current, [approvalRef]: value }))} refreshSnapshot={refreshSnapshot} locale={locale} />)}
  </section>;
}

export function ApprovalPanel({ snapshot, refreshSnapshot }: Props) {
  const refs = useMemo(() => snapshot.approvals.pending.map((item) => item.approvalRef), [snapshot.approvals.pending]);
  return <ApprovalRequestList approvalRefs={refs} refreshSnapshot={refreshSnapshot} />;
}

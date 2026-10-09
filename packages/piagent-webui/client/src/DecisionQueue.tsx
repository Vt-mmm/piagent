import { useEffect, useState } from "react";

import { ApprovalCard, useApprovalRequests } from "./ApprovalPanel.tsx";
import { askerLabel, QuestionCard, usePendingQuestions } from "./QuestionPanel.tsx";
import { orderDecisions, type Decision } from "./attention-view-model.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

// Everything a conversation waits on the member for, one at a time: the
// agents' questions and the approvals they asked for, the main agent's first
// (orderDecisions). The steps above the card say how many are left and let
// the member pick another one; answering one brings up the next.
export function DecisionQueue({ sessionRef, waiting, approvalRefs }: { sessionRef: string; waiting: boolean; approvalRefs: string[] }) {
  const { locale } = useUiPreferences();
  const questions = usePendingQuestions(sessionRef, waiting);
  const approvals = useApprovalRequests(approvalRefs, sessionRef, locale);
  const [chosen, setChosen] = useState<string | null>(null);
  // An approval not read yet sorts by when it was listed: after the questions of its agent.
  const items = orderDecisions<Decision & { label: string }>([
    ...questions.pending.map((item) => ({ key: item.questionRef, kind: "question" as const, role: item.role ?? "main", askedAt: item.askedAt,
      label: item.questions[0]?.header || item.questions[0]?.question || localize(locale, "Câu hỏi", "Question") })),
    ...approvals.refs.map((ref) => {
      const request = approvals.states[ref]?.request;
      return { key: ref, kind: "approval" as const, role: "main", askedAt: request?.requestedAt ?? new Date(8.64e15).toISOString(), expiresAt: request?.expiresAt ?? null,
        label: request ? request.action.commandPreview?.split("\n")[0] || request.action.toolName : localize(locale, "Yêu cầu duyệt", "Approval") };
    })]);
  const current = items.find((item) => item.key === chosen) ?? items[0];
  // The chosen one was answered or withdrawn: the next in order takes its place.
  useEffect(() => { if (chosen && !items.some((item) => item.key === chosen)) setChosen(null); }, [chosen, items.map((item) => item.key).join("\0")]);
  if (!current) return null;
  const index = items.indexOf(current);
  return <section className="decision-queue" aria-label={localize(locale, "Việc đang chờ bạn quyết định", "Decisions waiting for you")} aria-live="polite">
    {items.length > 1 && <nav className="decision-steps" aria-label={localize(locale, "Các việc đang chờ", "Waiting decisions")}>
      <strong>{localize(locale, `Việc cần bạn quyết · ${index + 1}/${items.length}`, `Needs your decision · ${index + 1}/${items.length}`)}</strong>
      <ol>{items.map((item, n) => <li key={item.key}><button type="button" aria-current={item === current ? "step" : undefined}
        className={item === current ? "decision-step current" : "decision-step"} onClick={() => setChosen(item.key)}
        title={`${askerLabel(item.role, locale)} · ${item.label}`}>
        <span className="decision-step-number">{n + 1}</span>
        <span className="decision-step-kind">{item.kind === "question" ? localize(locale, "Hỏi", "Ask") : localize(locale, "Duyệt", "Approve")}</span>
        <span className="decision-step-role">{askerLabel(item.role, locale)}</span>
        <span className="decision-step-label">{item.label}</span></button></li>)}</ol>
    </nav>}
    {current.kind === "question"
      ? <QuestionCard key={current.key} sessionRef={sessionRef} locale={locale} onDone={() => questions.done(current.key)}
          pending={questions.pending.find((item) => item.questionRef === current.key)!} />
      : <ApprovalCard key={current.key} state={approvals.states[current.key] ?? {}} locale={locale} asker={askerLabel(current.role, locale)}
          setState={(value) => approvals.set(current.key, value)} />}
  </section>;
}

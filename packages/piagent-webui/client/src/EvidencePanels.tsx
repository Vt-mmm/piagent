import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { compactNumber, contextLabel, incompleteReason, usageLabel, verifierSummary } from "./evidence-view-model.ts";
import { compactRef, label, tone } from "./view-model.ts";
import { localize, useUiPreferences } from "./ui-preferences.tsx";

function Card({ kicker, title, children }: { kicker: string; title: string; children: React.ReactNode }) {
  return <section className="evidence-card surface"><p className="section-kicker">{kicker}</p><h3>{title}</h3>{children}</section>;
}

export function EvidencePanels({ snapshot }: { snapshot: PiagentWebUICanonicalSnapshotV1 }) {
  const { locale } = useUiPreferences();
  const verifier = snapshot.verification.latest;
  const context = snapshot.usage.context;
  const continuation = snapshot.continuation;
  const handoff = snapshot.handoff;
  const contextPercent = context.state === "known" && context.percent !== null ? Math.max(0, Math.min(100, context.percent)) : 0;
  return <section className="evidence-section" aria-labelledby="evidence-title">
    <header className="section-title-row"><div><p className="section-kicker">Completion evidence</p><h2 id="evidence-title">{localize(locale, "Verifier, usage và handoff", "Verifier, usage, and handoff")}</h2></div><span>{incompleteReason(snapshot, locale)}</span></header>
    <div className="evidence-grid">
      <Card kicker={localize(locale, "Verifier gần nhất", "Latest verifier")} title={verifierSummary(verifier, locale)}>
        {verifier ? <dl className="evidence-list"><div><dt>Command</dt><dd title={verifier.command}>{verifier.command}</dd></div><div><dt>Exact</dt><dd>{verifier.exact ? localize(locale, "Có", "Yes") : localize(locale, "Không", "No")}</dd></div><div><dt>Tree digest</dt><dd title={verifier.treeDigest ?? undefined}>{compactRef(verifier.treeDigest)}</dd></div>
          <div><dt>{localize(locale, "File làm stale", "Stale files")}</dt><dd>{verifier.staleFilesKnown ? verifier.staleByPaths.length : localize(locale, "Chưa biết", "Unknown")}</dd></div></dl>
          : <p className="card-empty">{snapshot.verification.reasonCode ? label(snapshot.verification.reasonCode, locale) : localize(locale, "Task chưa chạy verifier.", "The task has not run a verifier.")}</p>}
      </Card>
      <Card kicker="Token & context" title={contextLabel(context, locale)}>
        <div className="context-meter" role="progressbar" aria-label={localize(locale, "Mức sử dụng context", "Context usage")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextPercent}><span style={{ width: `${contextPercent}%` }} /></div>
        <dl className="evidence-list"><div><dt>{localize(locale, "Turn gần nhất", "Latest turn")}</dt><dd>{usageLabel(snapshot.usage.latestTurn, locale)}</dd></div><div><dt>Task total</dt><dd>{usageLabel(snapshot.usage.taskTotal, locale)}</dd></div><div><dt>Session total</dt><dd>{usageLabel(snapshot.usage.sessionTotal, locale)}</dd></div></dl>
      </Card>
      <Card kicker="Continuation budget" title={label(continuation.state, locale)}>
        <dl className="budget-grid"><div><dt>{localize(locale, "Còn lại", "Remaining")}</dt><dd>{compactNumber(continuation.remaining, locale)}</dd></div><div><dt>{localize(locale, "Đã dùng", "Used")}</dt><dd>{compactNumber(continuation.consumed, locale)}</dd></div><div><dt>{localize(locale, "Tối đa", "Maximum")}</dt><dd>{compactNumber(continuation.maximum, locale)}</dd></div></dl>
        {continuation.reasonCode && <p className="card-note">{label(continuation.reasonCode, locale)}</p>}
      </Card>
      <Card kicker="Handoff" title={handoff ? label(handoff.state, locale) : localize(locale, "Chưa có handoff", "No handoff")}>
        {handoff ? <div className="handoff-copy"><p>{handoff.summary}</p>{handoff.blocker && <div className="handoff-blocker"><strong>Blocker</strong><span>{handoff.blocker}</span></div>}{handoff.nextSafeAction && <div className="next-action"><strong>{localize(locale, "Bước an toàn tiếp theo", "Next safe action")}</strong><span>{handoff.nextSafeAction}</span></div>}</div>
          : <p className="card-empty">{localize(locale, "Handoff sẽ xuất hiện khi runtime ghi nhận trạng thái chuyển giao.", "A handoff will appear when the runtime records a transfer state.")}</p>}
      </Card>
    </div>
  </section>;
}

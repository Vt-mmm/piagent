import { turnEndOf } from '../shared/turn-end.ts';
// Public managed state contains no provider/model route or credential.
const STATUS = ['pending', 'in_progress', 'completed', 'deferred'];
const OUTCOMES = ['no_change', 'interrupted', 'disputed', 'blocking_open', 'unverified', 'review_unavailable', 'unreviewed', 'clean'];
export function managedProjection(context: any, entries: any[]) {
  if (context?.model?.provider !== 'agent_watch_managed') return {};
  const last = (type: string) => entries.filter(e => e.type === 'custom' && e.customType === type).at(-1)?.data;
  const counter = last('agent-watch-helpers');
  const capabilities = last('agent-watch-model')?.managedThinkingLevels;
  const levels = ['off','minimal','low','medium','high','xhigh','max'];
  // The agent's checklist (update_plan) and how its last code-changing turn ended.
  const plan = last('agent-watch-plan')?.plan;
  const steps = Array.isArray(plan) && plan.length >= 1 && plan.length <= 30 && plan.every((p: any) => typeof p?.step === 'string' && p.step.trim() && STATUS.includes(p.status))
    ? plan.map((p: any) => ({ step: p.step.trim().slice(0, 200), status: p.status })) : null;
  const final = entries.filter(e => e.type === 'custom_message' && e.customType === 'agent-watch-process' && e.details?.phase === 'final').at(-1)?.details;
  const process = final && OUTCOMES.includes(final.outcome) ? { outcome: final.outcome, verified: final.verified === true, reviewed: final.reviewed === true,
    blockingOpen: Number.isInteger(final.blockingOpen) && final.blockingOpen >= 0 ? Math.min(final.blockingOpen, 1000) : 0, ...(final.planSkipped === true ? { planSkipped: true as const } : {}) } : null;
  // The review helper's findings on the last reviewed patch (workflow.mjs), shown on the diff.
  const reviewed = last('agent-watch-review'), severities = ['blocking', 'major', 'minor'];
  const findings = Array.isArray(reviewed?.findings) ? reviewed.findings.filter((f: any) => severities.includes(f?.severity) && typeof f.file === 'string' && f.file.trim()
    && typeof f.issue === 'string' && f.issue.trim()).slice(0, 40).map((f: any) => ({ severity: f.severity, file: f.file.trim().slice(0, 300),
    line: Number.isSafeInteger(f.line) && f.line > 0 ? f.line : null, issue: f.issue.trim().slice(0, 500) })) : null;
  const review = findings ? { stale: reviewed.stale === true, findings } : null;
  // How the member's last message ended, unless a newer message is running.
  const lastIndex = (match: (e: any) => boolean) => { for (let i = entries.length - 1; i >= 0; i -= 1) if (match(entries[i])) return i; return -1; };
  const lastUser = lastIndex(e => e.type === 'message' && e.message?.role === 'user');
  const endAt = lastIndex(e => e.type === 'custom' && e.customType === 'agent-watch-turn-end');
  const end = endAt > lastUser ? turnEndOf(entries[endAt].data) : null;
  const turnEnd = end ? { state: end.state, planSteps: end.planSteps, planDone: end.planDone, ...(end.planDeferred ? { planDeferred: end.planDeferred } : {}), ...(end.reason ? { reason: end.reason } : {}) } : null;
  // Helpers the Harness enables (up to four); a conversation recorded before
  // that was known says two.
  const maximum = Number.isInteger(counter?.maximum) && counter.maximum >= 0 && counter.maximum <= 4 ? counter.maximum : 2;
  // The member's access choice; Bypass only while the Harness allows it, else
  // it applies as Full access (permission.mjs).
  const chosen = last('agent-watch-permission')?.mode, bypassAllowed = last('agent-watch-bypass')?.allowed === true;
  const permission = chosen === 'bypass' ? (bypassAllowed ? 'bypass' : 'trusted-full-access') : chosen === 'trusted-full-access' ? 'trusted-full-access' : 'workspace-write';
  // Fast mode, only where the conversation's Harness allows it (fast-mode.mjs).
  const fast = last('agent-watch-fast');
  // Repositories Studio says do not belong to the key's team (workspace-report.mjs).
  const project = last('agent-watch-project'), kinds = ['other_team', 'unlisted'];
  const projectWarnings = Array.isArray(project?.warnings) ? project.warnings.filter((w: any) => kinds.includes(w?.kind) && typeof w.repo === 'string' && w.repo.trim())
    .slice(0, 6).map((w: any) => ({ repo: w.repo.trim().slice(0, 200), kind: w.kind })) : [];
  const projectWarning = projectWarnings.length ? { warnings: projectWarnings, ...(typeof project.team === 'string' && project.team.trim() ? { team: project.team.trim().slice(0, 80) } : {}) } : null;
  return {modelLabel:'agent-watch-auto', managedPermission: permission, ...(bypassAllowed ? {managedBypass: true as const} : {}), ...(fast?.allowed === true ? {managedFast: fast.enabled === true ? 'on' as const : 'off' as const} : {}), managedHelpers:{active:Number.isInteger(counter?.active) && counter.active>=0 && counter.active<=maximum ? counter.active : 0, maximum},
    ...(Array.isArray(capabilities)?{managedThinkingLevels:levels.filter(level=>capabilities.includes(level))}:{}),
    ...(steps ? {managedPlan:{steps}} : {}), ...(process ? {managedProcess:process} : {}), ...(turnEnd ? {managedTurnEnd:turnEnd} : {}), ...(review ? {managedReview:review} : {}), ...(projectWarning ? {managedProjectWarning:projectWarning} : {})};
}

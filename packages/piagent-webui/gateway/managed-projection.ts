// Public managed state contains no provider/model route or credential.
const STATUS = ['pending', 'in_progress', 'completed'];
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
  // Helpers the Harness enables (up to four); a conversation recorded before
  // that was known says two.
  const maximum = Number.isInteger(counter?.maximum) && counter.maximum >= 0 && counter.maximum <= 4 ? counter.maximum : 2;
  // The member's access choice: "trusted-full-access" is Bypass.
  const permission = last('agent-watch-permission')?.mode === 'trusted-full-access' ? 'trusted-full-access' : 'workspace-write';
  return {modelLabel:'agent-watch-auto', managedPermission: permission, managedHelpers:{active:Number.isInteger(counter?.active) && counter.active>=0 && counter.active<=maximum ? counter.active : 0, maximum},
    ...(Array.isArray(capabilities)?{managedThinkingLevels:levels.filter(level=>capabilities.includes(level))}:{}),
    ...(steps ? {managedPlan:{steps}} : {}), ...(process ? {managedProcess:process} : {})};
}

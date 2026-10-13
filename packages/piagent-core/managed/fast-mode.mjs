// Fast mode of a company conversation. The member turns it on per
// conversation, and only where the team's Harness in Studio allows it
// (harness.configuration.fast_mode); a conversation starts with it off. While
// on, the main agent's calls ask a Codex model for the priority service tier:
// the same model and thinking level, answered faster, and charged to the
// key's quota at a higher rate (Studio decides the rate and refuses the tier
// for a run whose Harness does not allow it). Subagents run as usual.
const ENTRY = 'agent-watch-fast';
export const NOTICE = 'agent-watch-fast-notice';
export const FAST_SERVICE_TIER = 'priority';

export const fastAllowed = manifest => manifest?.harness?.configuration?.fast_mode === true;
const recorded = manager => manager.getEntries().filter(e => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data;
export function restoreFast(manager) { return recorded(manager)?.enabled === true; }
// The conversation records whether its Harness allows fast mode, so the
// dashboard shows the switch (or not) without the runtime; a Harness that
// stopped allowing it turns it off.
export function recordFast(owner, manager) {
  const allowed = fastAllowed(owner.manifest), last = recorded(manager);
  if (!allowed) owner.fast = false;
  if ((last?.allowed === true) === allowed && (last?.enabled === true) === Boolean(owner.fast)) return;
  manager.appendCustomEntry(ENTRY, { enabled: Boolean(owner.fast), allowed, at: new Date().toISOString() });
}
// "on" | "off" where the Harness allows fast mode, else null (no switch).
export const fastState = owner => fastAllowed(owner.manifest) ? owner.fast ? 'on' : 'off' : null;
export function fastSetter(owner, manager) {
  return enabled => {
    if (enabled && !fastAllowed(owner.manifest)) throw Error('managed-fast-unavailable');
    if (Boolean(enabled) === Boolean(owner.fast)) return false;
    owner.fast = Boolean(enabled); manager.appendCustomEntry(ENTRY, { enabled: owner.fast, allowed: fastAllowed(owner.manifest), at: new Date().toISOString() });
    return true;
  };
}
// Where fast mode is served, as Studio admits it (ledger.FastWeightMilli; a
// model missing here simply runs at standard speed):
//   - Codex (Responses): service_tier "priority" on the models OpenAI's speed
//     documentation names, checked 2026-10-13.
//   - Claude (Messages): not served. Anthropic's fast mode is another protocol
//     (speed "fast" with a beta header, Opus 5.5 / 5 / 4.8 only) and is billed
//     to a subscription's usage credits, outside the plan.
//   - API-key vendors (Chat Completions): none documents a fast tier.
const CODEX_FAST = new Set(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.5']);
export const fastServed = route => route?.provider === 'codex' && CODEX_FAST.has(route.native);
// Studio's refusal of the tier (the Harness or the model list changed), or
// the provider's of a request carrying it: asked again once without it.
export const fastRefusal = code => code === 'policy_denied' || code === 'upstream_request_rejected';
// A fast request was refused before the model did any work: the conversation
// goes back to standard speed and says so, instead of failing the turn.
export function declineFast(owner, code) {
  owner.fast = false;
  try {
    recordFast(owner, owner.session.sessionManager);
    void owner.session.sendCustomMessage?.({ customType: NOTICE, display: true, details: { code },
      content: `Fast mode was refused for this request [${code}]: this conversation continues at standard speed. Turn Fast on again to retry.` }, { triggerTurn: false })?.catch?.(() => {});
  } catch { /* the request goes on at standard speed either way */ }
}
// The payload hook of one request: the main agent's call on a model that
// serves fast mode carries the tier while fast mode is on and still allowed
// (the Harness may have turned it off since the member turned it on).
export function fastPayload(owner, role, route, onPayload) {
  if (role !== 'main' || !owner.fast || !fastAllowed(owner.manifest) || !fastServed(route)) return onPayload;
  return async (payload, model) => {
    const next = (onPayload ? await onPayload(payload, model) : undefined) ?? payload;
    return next && typeof next === 'object' && !Array.isArray(next) ? { ...next, service_tier: FAST_SERVICE_TIER } : next;
  };
}

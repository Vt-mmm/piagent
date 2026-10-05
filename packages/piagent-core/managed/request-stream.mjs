// One model request of a company role: through Studio with the role's grant,
// on the route the harness chose. Studio answers a failure with a machine
// code; this says who failed and why, in words. Only refusals that come before
// the model does any work are asked again: a refusal for capacity waits in
// line, a brief one (a sign-in being renewed, a lapsed grant) is asked again a
// few times. Nothing that reached the model is sent twice.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeFailure, failureCode, failureIsAdmissionRefusal, failureIsBriefRefusal, failureReason, unnamedFailureText } from '../runtime/managed-failure.mjs';
import { CLIENT_AGENT } from './client-agent.mjs';
import { shareGrant, releaseGrant } from './grant-share.mjs';

// How long one request waits in line for a free company model account.
const CAPACITY_WAIT_MS = 20 * 60_000;
// How long a helper's request waits before the helper moves to another model.
export const HELPER_SWITCH_MS = 60_000;
const HELPER_SWITCH_CODES = new Set(['session_account_not_ready_retry_later', 'account_capacity_unavailable']);
// A brief refusal (see failureIsBriefRefusal) is asked again up to three times,
// 3, 6 and 9 s apart.
const BRIEF_ASKS = 3, BRIEF_PAUSE_MS = 3_000;

export function wrapRoleStreams(owner, runtime, role, { provider, verifyGrant }) {
  for (const method of ['stream', 'streamSimple']) {
    const original = runtime[method].bind(runtime);
    runtime[method] = (model, context, options) => {
      // Tools run between two answers: the count names the answer they came from.
      if (role === 'main') owner.mainAnswers = (owner.mainAnswers ?? 0) + 1;
      const out = owner.ai.createAssistantMessageEventStream(), signal = options?.signal;
      void (async () => {
        let wait = null, noted = false, brief = 0, refused = null, rebinds = 0, share = null;
        const letGo = () => { if (share) { releaseGrant(owner, role, share); share = null; } };
        // The error event and the final message carry the same failure: kept once.
        const unnamed = raw => { noted ||= keepUnnamed(owner, role, raw); return raw; };
        try {
          if (role === 'main' && owner.preflight) throw Error(owner.preflight);
          if (!owner.grant || model.provider !== provider) throw Error('managed-run-required');
          // Studio's answer to a failed request is a machine code: say who
          // failed and why, in words. Only an admission refusal is asked again.
          // A request the member stopped ended, it did not fail; the provider may
          // still report it as an error ("This operation was aborted").
          const told = message => message?.stopReason !== 'error' ? message
            : signal?.aborted ? { ...message, stopReason: 'aborted', errorMessage: 'Request was aborted' }
            : { ...message, errorMessage: describeFailure(role, unnamed(message.errorMessage)) };
          for (;;) {
            // Asked again after a refusal and the grant cannot be renewed (the
            // run was closed): the refusal says why, not the renewal.
            // Requests of one role running side by side (a review in parts, a
            // helper's search beside its call) share one renew: each renew
            // replaces the role's token and would void a sibling's before
            // Studio admits it. The share is let go once Studio has answered.
            share = shareGrant(owner, role);
            const grant = await share.grant.catch((error) => { throw refused ? Error(refused) : error; });
            verifyGrant(grant, owner.manifest, role);
            if (role === 'main') owner.grant = grant;
            const route = owner.routes.get(runtime);
            if (!route || grant.provider_model_id !== route.native || grant.provider !== route.provider || grant.model_id !== route.model_id || model.id !== 'agent-watch-auto') throw Error('managed-route-changed');
            const asked = Date.now();
            // The main agent names its conversation, so every turn reaches the
            // same company account and prompt cache; a helper names its role.
            const conversation = role === 'main' ? conversationSession(owner) : null;
            const stream = original({ ...model, id: route.native }, context, { ...options, apiKey: grant.token, sessionId: conversation ?? grant.role_id, maxRetries: 0,
              headers: { ...options?.headers, 'User-Agent': CLIENT_AGENT, 'X-Session-Id': grant.role_id, ...(conversation ? { 'X-Claude-Code-Session-Id': conversation } : {}) } });
            // Whether Studio admitted the request is known at its first event
            // after "start": until then nothing is passed on, so a refused
            // request leaves no trace in the conversation.
            let opening = [], refusal = null;
            for await (const event of stream) {
              if (opening && event.type === 'start') { opening.push(event); continue; }
              const code = event.type === 'error' ? failureCode(event.error?.errorMessage) : null;
              if (opening && code && !signal?.aborted && (failureIsAdmissionRefusal(code) || failureIsBriefRefusal(code) && brief < BRIEF_ASKS
                || role === 'main' && code === ACCOUNT_GONE && rebinds < MAX_REBINDS)) { refusal = event.error; break; }
              if (opening) { for (const held of opening) out.push(held); opening = null; wait = capacityWaitEnded(owner, wait, 'admitted'); letGo(); }
              out.push(event.type === 'error' ? { ...event, ...(signal?.aborted ? { reason: 'aborted' } : {}), error: told(event.error) } : event);
            }
            if (!refusal) { for (const held of opening ?? []) out.push(held); out.end(told(await stream.result())); return; }
            refused = String(refusal.errorMessage ?? '');
            // A lapsed or replaced grant: the next ask renews it, not this share.
            const stale = share; letGo();
            if (failureIsBriefRefusal(failureCode(refusal.errorMessage)) && owner.sharedGrants?.get(role) === stale) owner.sharedGrants.delete(role);
            // The conversation's account is gone (signed out, removed) or has
            // rested past SESSION_REBIND_MS (a spent quota window): a new
            // generation lets Studio bind the conversation to another account.
            // Its prompt cache starts over there once.
            const refusedCode = failureCode(refusal.errorMessage);
            if (role === 'main' && rebinds < MAX_REBINDS && (refusedCode === ACCOUNT_GONE
              || refusedCode === ACCOUNT_RESTING && wait && Date.now() - wait.since >= (owner.sessionRebindMs ?? SESSION_REBIND_MS))) {
              owner.conversationGeneration = (owner.conversationGeneration ?? 0) + 1; rebinds += 1;
              wait = capacityWaitEnded(owner, wait, 'rebound');
              continue;
            }
            // A brief refusal is asked again after a short pause, without a wait step.
            if (failureIsBriefRefusal(failureCode(refusal.errorMessage))) { brief += 1; await sleep((owner.briefPauseMs ?? BRIEF_PAUSE_MS) * brief, undefined, { signal }); continue; }
            wait = await waitForCapacity(owner, wait, role, failureCode(refusal.errorMessage), signal, Date.now() - asked);
            if (!wait) { out.push({ type: 'error', reason: 'error', error: told(refusal) }); return; }
          }
        } catch (error) {
          // A request the member stopped ended, it did not fail: Pi's providers
          // report it as "aborted", and so does this one.
          const aborted = !!signal?.aborted;
          out.push({ type: 'error', reason: aborted ? 'aborted' : 'error', error: { role: 'assistant', content: [], api: model.api, provider: provider, model: model.id,
            stopReason: aborted ? 'aborted' : 'error', errorMessage: aborted ? 'Request was aborted' : describeFailure(role, unnamed(error?.message)), timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
        } finally { letGo(); capacityWaitEnded(owner, wait, signal?.aborted ? 'stopped' : 'ended'); }
      })();
      return out;
    };
  }
}

// Studio binds a conversation to one company account (session_bindings): the
// provider's prompt cache lives on that account (Claude) and follows
// prompt_cache_key (Codex). The main agent therefore names its conversation
// (the Pi session id), not the turn's run role; measured 2026-10-04, a run
// role per turn left Codex 10% cached on each turn's first request.
const ACCOUNT_GONE = 'session_account_unavailable_start_new_session';
const ACCOUNT_RESTING = 'session_account_not_ready_retry_later';
export const SESSION_REBIND_MS = 90_000;
const MAX_REBINDS = 2;
export function conversationSession(owner) {
  const id = owner.session?.sessionManager?.getSessionId?.();
  if (typeof id !== 'string' || !/^[\w-]{8,128}$/.test(id)) return null;
  return owner.conversationGeneration ? `${id}-${owner.conversationGeneration}` : id;
}

// A failure no code names is shown as "could not be sent"; its own words are
// kept, redacted, in the conversation file (never shown) so it can be told
// apart later. True when it was kept.
export const UNNAMED_FAILURE_ENTRY = 'agent-watch-failure-detail';
function keepUnnamed(owner, role, raw) {
  const text = unnamedFailureText(raw);
  if (text === null) return false;
  try { owner.session?.sessionManager?.appendCustomEntry(UNNAMED_FAILURE_ENTRY, { role, text }); return true; }
  catch { return false; /* the failure is still shown */ }
}

// Studio itself holds a refused request up to 30 s while it waits for a slot:
// one it held is asked again almost at once, so a long wait keeps its place
// against requests that just arrived. One refused at once (a rate limit) backs
// off, 2 s doubling to 15 s.
export function capacityDelayMs(asks, heldMs, random = Math.random()) {
  return heldMs >= 10_000 ? 500 + 1000 * random : Math.min(15_000, 1_000 * 2 ** Math.min(asks, 4)) * (0.75 + random / 2);
}

// Studio refused a request for capacity (every company model account that
// can serve this conversation is busy): the request waits in line and asks
// again, shown as a step of the running turn; Stop ends the wait. Each ask
// is an event, so the WebUI's idle watchdog sees the turn alive. After
// CAPACITY_WAIT_MS it fails with Studio's reason. Null: stop waiting.
async function waitForCapacity(owner, wait, role, code, signal, heldMs = 0) {
  if (wait && Date.now() - wait.since >= (owner.capacityWaitMs ?? CAPACITY_WAIT_MS)) { capacityWaitEnded(owner, wait, 'gave-up'); return null; }
  // A helper whose model has no account free for a while (resting after a
  // refusal, out of usage) stops waiting: it starts once more, and Studio
  // gives the new helper the next model of its role that serves.
  if (wait && role !== 'main' && HELPER_SWITCH_CODES.has(code) && Date.now() - wait.since >= (owner.helperSwitchMs ?? HELPER_SWITCH_MS)) { capacityWaitEnded(owner, wait, 'switched'); return null; }
  wait ??= { id: randomUUID(), role, since: Date.now(), asks: 0, open: true };
  wait.asks += 1; wait.code = code;
  owner.capacityWaits.add(wait);
  owner.notify({ type: 'managed_capacity_wait', id: wait.id, role, code, state: wait.asks === 1 ? 'start' : 'waiting', waitedMs: Date.now() - wait.since });
  capacityStatus(owner);
  try { await sleep(capacityDelayMs(wait.asks, heldMs), undefined, { signal }); }
  catch (error) { capacityWaitEnded(owner, wait, 'stopped'); throw error; }
  return wait;
}
function capacityWaitEnded(owner, wait, outcome) {
  if (!wait?.open) return null;
  wait.open = false; owner.capacityWaits.delete(wait);
  owner.notify({ type: 'managed_capacity_wait', id: wait.id, role: wait.role, code: wait.code, state: 'end', outcome, waitedMs: Date.now() - wait.since });
  capacityStatus(owner);
  return null;
}
// The Terminal's working line says who waits and why, while anyone does.
function capacityStatus(owner) {
  const wait = [...owner.capacityWaits].at(-1);
  const who = wait?.role === 'main' ? 'main agent' : `${wait?.role} subagent`;
  try { owner.session?.extensionRunner?.getUIContext?.()?.setWorkingMessage?.(wait ? `Agent Watch ${who}: waiting for a free company model account (${failureReason(wait.code)}). Esc stops.` : undefined); }
  catch { /* no Terminal */ }
}

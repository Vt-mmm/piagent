import { unfinished, planText, currentPlan, workflowPolicy } from './workflow.mjs';
import { failureCode } from '../runtime/managed-failure.mjs';

// A main agent often ends its turn between the steps of its own checklist
// ("STEP06 done, STEP07 next"), though the member asked for all of them.
// Under plan "require" the harness sends it back to the next open step, as a
// new run (as if the member had sent "continue": each round gets its own
// helpers, checks and review), until the checklist is done, the member stops
// it, a round fails, or IDLE_ROUNDS rounds in a row change nothing.
export const IDLE_ROUNDS = 2;
// A checklist holds at most 30 steps: one round per step at most.
export const MAX_ROUNDS = 30;
// How the member's message ended, shown under the last answer.
export const TURN_END_ENTRY = 'agent-watch-turn-end';
export const TURN_END_STATES = ['done', 'midway', 'failed', 'cancelled'];

const completed = plan => plan?.plan?.filter(p => p.status === 'completed').length ?? 0;

export class Continuation {
  constructor(policy) {
    Object.assign(this, { policy, rounds: 0, idle: 0, touched: false, reason: null, startDone: 0 });
  }
  // A round is about to start: what its progress is measured from.
  begin(plan) { this.startDone = completed(plan); }
  // A round ended (its run closed). The message that starts the next round,
  // or null: then `reason` says why the harness stopped sending it back.
  next({ plan, planUpdated, changed, stopped, failed }) {
    if (planUpdated) this.touched = true;
    if (stopped) { this.reason = 'stopped'; return null; }
    if (failed) { this.reason = 'failed'; return null; }
    if (!this.touched || !unfinished(plan)) { this.reason = null; return null; }
    if (this.policy.plan !== 'require') { this.reason = 'policy'; return null; }
    // The member's own round always gets one round back; a harness round
    // that neither completed a step nor changed code counts as idle.
    if (this.rounds > 0) this.idle = completed(plan) > this.startDone || changed ? 0 : this.idle + 1;
    if (this.idle >= IDLE_ROUNDS) { this.reason = 'idle'; return null; }
    if (this.rounds >= MAX_ROUNDS) { this.reason = 'limit'; return null; }
    this.rounds += 1;
    const steps = plan.plan.length, done = completed(plan), open = steps - done;
    return { customType: 'agent-watch-process', display: true,
      content: `Harness: your checklist still has ${open} open step(s) (${done}/${steps} completed):\n${planText(plan)}\nThe member asked for all of it. Continue with the next open step now and keep going until every step is completed; update the checklist with update_plan as you go. Do not stop to report progress between steps. If you cannot go on without the member (a decision, access, a service that is not running), ask with ask_user. If a step is no longer needed, take it out of the checklist and say why in your final answer.`,
      details: { phase: 'continue', round: this.rounds, maxRounds: MAX_ROUNDS, planOpen: open, planDone: done, planSteps: steps, ...(this.idle ? { idle: this.idle } : {}) } };
  }
}

// How a member's message ended: every step done (or answered without a
// checklist), stopped with steps open (and why the harness did not go on),
// failed (which role, which kind) or stopped by the member.
export function turnEnd(continuation, plan, { stopped, failure }) {
  const steps = continuation.touched ? plan?.plan?.length ?? 0 : 0, done = continuation.touched ? completed(plan) : 0;
  const state = stopped ? 'cancelled' : failure ? 'failed' : continuation.touched && unfinished(plan) ? 'midway' : 'done';
  return { state, planSteps: steps, planDone: done, rounds: continuation.rounds,
    ...(state === 'midway' && continuation.reason ? { reason: continuation.reason } : {}),
    ...(state === 'failed' ? { role: failure.role ?? 'main', code: String(failure.code || 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64) } : {}),
    at: new Date().toISOString() };
}

// One member message: its round, then the rounds the harness adds while the
// checklist has open steps. `runRound(text, deliver)` runs one Studio run and
// returns { result, preflight, planUpdated, changed, closeFailed }. A message the member
// sends while a round closes (no model runs then) becomes the next round;
// Stop ends the turn. Listeners hear "settled" once, after the last round.
export async function memberTurn(self, { manager, prompt, runRound }, text, deliver) {
  let continuation = new Continuation(workflowPolicy(self.manifest)), result, waiting = null, ended = null;
  self.stopRequested = false; self.queued = [];
  try {
    for (let first = true; ; first = false) {
      continuation.begin(currentPlan(manager));
      self.between = false;
      let round;
      try { round = await runRound(text, deliver); }
      catch (error) { waiting?.reject(error); waiting = null; throw error; }
      if (first) result = round.result; else waiting?.resolve(round.result);
      waiting = null;
      const last = self.session.messages.findLast(m => m.role === 'assistant');
      const stopped = self.stopRequested || last?.stopReason === 'aborted';
      const failure = round.preflight || last?.stopReason === 'error' ? { role: 'main', code: failureCode(last?.errorMessage ?? '') }
        : round.closeFailed ? { role: 'main', code: round.closeFailed } : null;
      const plan = currentPlan(manager), message = continuation.next({ plan, planUpdated: round.planUpdated, changed: round.changed, stopped, failed: !!failure });
      if (self.queued.length) {
        // The member wrote while the round closed: theirs is the next round,
        // a new request (Stop before it applied to the round before).
        waiting = self.queued.shift(); self.stopRequested = false;
        const next = waiting; text = next.text;
        deliver = () => prompt(next.text, { ...next.options, expandPromptTemplates: false });
        continuation = new Continuation(workflowPolicy(self.manifest));
      } else if (message) {
        text = message.content;
        deliver = () => { self.nextPurpose = 'continue'; return self.session.sendCustomMessage(message, { triggerTurn: true }); };
      } else { ended = turnEnd(continuation, plan, { stopped, failure }); break; }
    }
  } finally {
    self.between = false;
    for (const queued of self.queued.splice(0)) queued.reject(Error('managed-turn-stopped'));
    // How the member's message ended: an entry of the conversation (not a
    // message: the model never reads it), shown under the last answer, and
    // told to listeners (the company Terminal).
    if (ended) {
      try { manager.appendCustomEntry(TURN_END_ENTRY, ended); } catch { /* the answer stands */ }
      self.notify({ type: 'managed_turn_end', end: ended, text: turnEndText(ended) });
    }
    self.activePrompt = false;
    self.notify({ type: 'agent_settled' });
  }
  return result;
}

// The plain text of a turn's end (the Terminal shows it; the WebUI reads details).
export function turnEndText(end) {
  if (end.state === 'cancelled') return 'Turn stopped by the member.';
  if (end.state === 'failed') return `Turn failed: ${end.role} agent, ${end.code}. Send "continue" to go on.`;
  if (end.state === 'midway') return `Turn ended with ${end.planSteps - end.planDone} of ${end.planSteps} checklist step(s) open${end.reason === 'idle' ? `: the agent stopped ${IDLE_ROUNDS} times in a row without progress` : end.reason === 'limit' ? `: ${MAX_ROUNDS} rounds reached` : ''}. Send "continue" to go on.`;
  return end.planSteps ? `Done: all ${end.planSteps} checklist steps completed.` : 'Done.';
}

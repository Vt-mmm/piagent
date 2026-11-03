import { randomUUID } from 'node:crypto';
import { memberQuestions } from './member-questions.mjs';
import { alwaysBypass, effectivePermission } from './permission.mjs';
import { checkScope, suitePart, unquoted } from './test-scope.mjs';
import { digestsOnce, knownFast, markCheckStart, missingSuites, pushQuestion, pushRepositories, reviewBeforePush } from './check-evidence.mjs';

// How much to test is the member's decision: a one-line fix should not cost a
// thirty-minute suite. The harness asks at the end of a change, before a whole
// suite and before a push, on the dashboard card or in the Terminal. Bypass skips
// the questions about the work (it runs the tests that cover the change) but not
// the one before a push. With no screen nobody can answer: nothing is asked.
// A question nobody answers in UNANSWERED_MS (the member left the task running
// overnight) is taken back and the cheap answer goes on: only the tests that
// cover the change, and no push. Before this a turn waited until morning.
export const UNANSWERED_MS = 10 * 60_000;
export { checkScope, suitePart };

// The member's own words asking for the whole suite: nothing to ask them then.
const RUN_ALL = String.raw`(?:full|all(?:\s+the)?|whole(?:\s+the)?|entire(?:\s+the)?|the\s+(?:full|whole|entire))`;
const FULL_WORDS = new RegExp([
  String.raw`(?:^|\s)(?:run|rerun|execute)\s+${RUN_ALL}\s+(?:tests?|suite|checks?)(?:\s|$|[.,!?])`,
  String.raw`(?:^|\s)(?:chạy|chay)(?:\s+lại)?\s+(?:full|toàn bộ|toan bo|tất cả|tat ca|hết|het)(?:\s+các)?\s+(?:tests?|suite|kiểm thử|kiểm tra)`,
  String.raw`(?:^|\s)(?:chạy|chay)(?:\s+lại)?\s+tests?\s+(?:full|toàn bộ|toan bo|tất cả|tat ca|hết|het)`,
].join('|'), 'i');
const NOT_WORDS = /(không|khong|đừng|chưa|\bno\b|\bnot\b|don't|skip|bỏ qua)[^.!?\n]{0,24}$/i;
export function asksFullChecks(text) {
  const value = String(text ?? ''), hit = value.match(FULL_WORDS);
  return !!hit && !NOT_WORDS.test(value.slice(0, hit.index));
}
// A push the harness can see; handoff-policy still asks for its own approval.
export const isGitPush = command => /(^|[\s;&|(])git\s+(?:(?:-C|-c)\s+\S+\s+|--\S+\s+)*push\b/.test(unquoted(String(command ?? '')));

const PART = 'Chỉ chạy phần liên quan', KEEP = 'Giữ kết quả phần đã chạy', FULL = 'Chạy toàn bộ', NONE = 'Không chạy lúc này';
const PUSH_FULL = 'Chạy toàn bộ rồi mới push', PUSH_NOW = 'Push luôn, không chạy thêm';
const GATEWAY_UI = Symbol.for('piagent.webui.gateway-runtime-ui.v1');

// The screen to ask on: the dashboard's card, else the Terminal. The turn's end
// has no tool context, so the Terminal comes from the extension runner there.
function surfaceOf(self, ctx) {
  const sessionId = self.session?.sessionManager?.getSessionId?.();
  if (sessionId && memberQuestions.hasSurface(sessionId)) return { sessionId };
  const runner = self.session?.extensionRunner, ui = ctx ? ctx.hasUI && ctx.ui : runner?.hasUI?.() && runner.getUIContext?.();
  return ui?.select && !ui[GATEWAY_UI] ? { ui } : null;
}
// The label picked, { other } for the member's own words, undefined for no
// answer (Esc, stopped, or nobody answered in time).
async function ask(surface, question, labels, signal, waitMs = UNANSWERED_MS) {
  // A plain timer, not AbortSignal.timeout: the wait itself keeps the process up.
  const expired = new AbortController(), timer = setTimeout(() => expired.abort(), waitMs);
  const until = signal ? AbortSignal.any([signal, expired.signal]) : expired.signal;
  try {
    if (surface.ui) return await surface.ui.select(question, labels, { signal: until });
    const questions = [{ header: 'Test', question, options: labels.map(label => ({ label, description: '' })), multiSelect: false }];
    const answer = await memberQuestions.ask({ sessionId: surface.sessionId, toolCallId: `check-scope-${randomUUID()}`, questions, signal: until }).catch(() => null);
    if (!answer || answer.skipped) return undefined;
    const { selected, other } = answer.answers[0];
    return other ? { other } : labels[selected[0]];
  } finally { clearTimeout(timer); }
}

// At the end of a change: { choice: 'partial' | 'full' | 'skip', words? }, or null
// when nobody can answer. No answer takes the cheap choice: the status says only part ran.
export async function askCheckScope(self, { partPassed = false, signal } = {}) {
  const surface = surfaceOf(self);
  if (!surface) return null;
  if (['bypass', 'always-bypass'].includes(effectivePermission(self))) return { choice: 'partial' };
  const part = partPassed ? KEEP : PART;
  const picked = await ask(surface, partPassed ? 'Code đã đổi, phần test liên quan đã pass. Có chạy toàn bộ test không?' : 'Code đã đổi, chưa chạy test. Chạy phần nào?', [part, FULL, NONE], signal, self.unansweredMs);
  if (signal?.aborted) return null;
  if (picked?.other) return { choice: 'partial', words: picked.other };
  return { choice: picked === FULL ? 'full' : picked === NONE ? 'skip' : 'partial' };
}

const PARTIAL_REASON = 'managed-check-scope: the member chose to run only the tests that cover the change. Run one file, a filter or one package, not the whole suite. If this project has no way to run part of it, say so and repeat the command: the member is asked.';
const BYPASS_REASON = 'managed-check-scope: run the tests that cover the change (one file, a filter, one package). A whole-suite run needs the member to ask for it, or their answer before a push. If this project has no way to run part of it, say so and repeat the command.';
const PUSH_REASON = missing => `managed-check-scope: the member wants the whole suite before this push${missing.length && missing[0] !== '.' ? ` (still needed in: ${missing.join(', ')})` : ''}. Run it, fix what fails, then push.`;
const STOPPED_REASON = 'managed-check-scope: the member did not answer whether to push now. Do not push; say so and let them decide.';
const WORDS_REASON = words => `managed-check-scope: this command did not run. The member answered about testing: "${String(words).slice(0, 500)}". Follow that.`;

// Before a whole suite or a push: returns to let it run, throws to send the agent another way.
export async function beforeCheckOrPush(self, command, ctx, signal) {
  const run = self.run;
  if (!run || alwaysBypass(self) || (run.policy?.verify === 'off' && !isGitPush(command))) return;
  // Calls sent together wait for one answer: the next one sees it.
  const turn = (run.scopeQuestion ?? Promise.resolve()).then(() => holdOrLet(self, run, command, ctx, signal));
  run.scopeQuestion = turn.catch(() => {});
  await turn;
  markCheckStart(run, command);
}
async function holdOrLet(self, run, command, ctx, signal) {
  const push = isGitPush(command);
  if (!push && (checkScope(command, run.checks.commands) !== 'suite' || run.fullAsked || run.scopeChoice === 'full')) return;
  const surface = surfaceOf(self, ctx);
  if (!surface) return;
  if (push) {
    const digestOf = digestsOnce(self);
    await reviewBeforePush(self, digestOf, run, signal);
    if (run.policy?.verify === 'off') return;
    const now = await digestOf('.'), repositories = pushRepositories(self, command), single = !repositories.length || repositories[0] === '.';
    const missing = await missingSuites(digestOf, run, repositories.length ? repositories : ['.']);
    if ((single ? run.suitePassedOn(now) : false) || !missing.length || (run.pushAllowedOn !== undefined && run.pushAllowedOn === now)) return;
    const picked = await ask(surface, await pushQuestion(self, digestOf, run, repositories, missing), [PUSH_FULL, PUSH_NOW], signal, self.unansweredMs);
    if (picked === PUSH_NOW) { run.pushAllowedOn = now; return; }
    if (picked?.other) throw Error(WORDS_REASON(picked.other));
    if (picked !== PUSH_FULL) throw Error(STOPPED_REASON);
    run.scopeChoice = 'full'; run.fullFor = new Set(missing);
    throw Error(PUSH_REASON(missing));
  }
  // Sent another way once; the same command again means the part did not do: the member decides (Bypass: it runs).
  const held = run.scopeHeld ??= new Set(), again = held.has(command); held.add(command);
  if (effectivePermission(self) === 'bypass') { if (again || knownFast(self, command, suitePart(command))) return; throw Error(BYPASS_REASON); }
  if (run.scopeChoice === 'partial' && !again) throw Error(PARTIAL_REASON);
  const picked = await ask(surface, `Agent muốn chạy toàn bộ test: ${String(command).slice(0, 160)}`, [PART, FULL], signal, self.unansweredMs);
  if (picked === FULL) { run.scopeChoice = 'full'; return; }
  run.scopeChoice = 'partial';
  throw Error(picked?.other ? WORDS_REASON(picked.other) : PARTIAL_REASON);
}

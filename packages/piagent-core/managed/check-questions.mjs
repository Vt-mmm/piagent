import { randomUUID } from 'node:crypto';
import { memberQuestions } from './member-questions.mjs';
import { effectivePermission } from './permission.mjs';

// How much to test is the member's decision: a one-line fix should not cost a
// thirty-minute suite. The harness asks at the end of a change, before a whole
// suite and before a push, on the dashboard card or in the Terminal. Bypass skips
// the questions about the work (it runs the tests that cover the change) but not
// the one before a push. With no screen nobody can answer: nothing is asked.

// How much of the suite a test command covers: 'partial' (a filter, one file, one
// package), 'suite' (the whole test command) or null when it runs no tests.
const VERSION_ONLY = /(?:^|\s)(?:--version|-V|--help)(?:\s|$)/;
const FILTERED = /(?:^|\s)(?:-k|-t|--grep|--testNamePattern|--test-name-pattern|--filter|--only|--testPathPattern)(?:[\s=]|$)|\bgo\s+test\b.*\s-run[\s=]|\bpytest\b.*\s::|\.only\b/;
const TEST_RUNNER = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test(:\S+)?(?=\s|$)|\bnode\s+--test\b|\b(vitest|jest|mocha|pytest|rspec|phpunit)\b|\bplaywright\s+test\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\b(go|cargo|swift|dotnet|deno)\s+test\b|\bmake\s+test\b|\bxcodebuild\b.*\btest\b|\b(gradle|gradlew|mvn|mvnw)\b.*\b(test|verify)\b/;
// Test commands start a command: `npm install -D vitest` or `rm jest.config.ts` only name one.
const TEST_START = new RegExp(`^(?:${TEST_RUNNER.source})`);
const LAUNCHER = /^(?:\w+=\S*\s+|time\s+|nohup\s+|timeout\s+\S+\s+|npx\s+(?:-\S+\s+)*|bunx\s+|pnpm\s+(?:exec|dlx)\s+|uv\s+run\s+|poetry\s+run\s+|yarn\s+(?=jest|vitest|mocha|playwright)|node_modules\/\.bin\/|\.\/)+/;
const partsOf = bare => bare.split(/\s*(?:\|\|?|&&|;)\s*/).map(part => part.replace(/\s\d*>.*$/, '').trim());
const NOT_TESTS = /\b(lint|typecheck|type-check|tsc|eslint|biome|ruff|mypy|pyright|vet|clippy|format|build)\b/;
const TARGET_FLAG = /^(-p|--package|-w|--workspace|--tests)$|^(-Dtest=|-only-testing:|--workspace=|--package=)/;
const VALUE_FLAG = /^(-c|--config|--reporter|--project|--workers|--timeout|--rootDir|--root|-f|--file|-o|--output)$/;
// A file or folder named on the command line; a flag's own value names none.
const targetsPart = args => args.some((a, i) => {
  if (TARGET_FLAG.test(a)) return true;
  if (a.startsWith('-') || VALUE_FLAG.test(args[i - 1] ?? '') || a.includes('*') || a.endsWith('...')) return false;
  return a.includes('/') || /\.(test|spec)\.\w+$|_test\.\w+$|^test_\w+\.\w+$/.test(a);
});
// What a command runs, without the text it merely quotes (a commit message, an echo).
const unquoted = text => text.replace(/"[^"]*"|'[^']*'/g, '""');
export function checkScope(command, declared = []) {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /^(echo|printf|grep|rg|cat|sed|awk|head|tail|less|git|ls|find)\b/.test(text) || VERSION_ONLY.test(text) || /--collect-only/.test(text)) return null;
  const bare = unquoted(text);
  for (const part of partsOf(bare)) {
    const own = part.replace(LAUNCHER, ''), runner = own.match(TEST_START);
    if (!runner) continue;
    if (FILTERED.test(own)) return 'partial';
    return !declared.includes(text) && targetsPart(own.slice(runner[0].length).split(' ').filter(Boolean)) ? 'partial' : 'suite';
  }
  // A script the repository declares: it cannot be narrowed from here.
  const named = declared.find(d => partsOf(bare).some(part => part.startsWith(unquoted(d))));
  return named && !NOT_TESTS.test(named) ? 'suite' : null;
}
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
// The label picked, { other } for the member's own words, undefined for no answer (Esc, stopped).
async function ask(surface, question, labels, signal) {
  if (surface.ui) return surface.ui.select(question, labels, { signal });
  const questions = [{ header: 'Test', question, options: labels.map(label => ({ label, description: '' })), multiSelect: false }];
  const answer = await memberQuestions.ask({ sessionId: surface.sessionId, toolCallId: `check-scope-${randomUUID()}`, questions, signal }).catch(() => null);
  if (!answer || answer.skipped) return undefined;
  const { selected, other } = answer.answers[0];
  return other ? { other } : labels[selected[0]];
}

// At the end of a change: { choice: 'partial' | 'full' | 'skip', words? }, or null
// when nobody can answer. No answer takes the cheap choice: the status says only part ran.
export async function askCheckScope(self, { partPassed = false, signal } = {}) {
  const surface = surfaceOf(self);
  if (!surface) return null;
  if (effectivePermission(self) === 'bypass') return { choice: 'partial' };
  const part = partPassed ? KEEP : PART;
  const picked = await ask(surface, partPassed ? 'Code đã đổi, phần test liên quan đã pass. Có chạy toàn bộ test không?' : 'Code đã đổi, chưa chạy test. Chạy phần nào?', [part, FULL, NONE], signal);
  if (signal?.aborted) return null;
  if (picked?.other) return { choice: 'partial', words: picked.other };
  return { choice: picked === FULL ? 'full' : picked === NONE ? 'skip' : 'partial' };
}

const PARTIAL_REASON = 'managed-check-scope: the member chose to run only the tests that cover the change. Run one file, a filter or one package, not the whole suite. If this project has no way to run part of it, say so and repeat the command: the member is asked.';
const BYPASS_REASON = 'managed-check-scope: run the tests that cover the change (one file, a filter, one package). A whole-suite run needs the member to ask for it, or their answer before a push. If this project has no way to run part of it, say so and repeat the command.';
const PUSH_REASON = 'managed-check-scope: the member wants the whole suite before this push. Run it, fix what fails, then push.';
const STOPPED_REASON = 'managed-check-scope: the member did not answer whether to push now. Do not push; say so and let them decide.';
const WORDS_REASON = words => `managed-check-scope: this command did not run. The member answered about testing: "${String(words).slice(0, 500)}". Follow that.`;

// Before a whole suite or a push: returns to let it run, throws to send the agent another way.
export async function beforeCheckOrPush(self, command, ctx, signal) {
  const run = self.run;
  if (!run || run.policy?.verify === 'off') return;
  // Calls sent together wait for one answer: the next one sees it.
  const turn = (run.scopeQuestion ?? Promise.resolve()).then(() => holdOrLet(self, run, command, ctx, signal));
  run.scopeQuestion = turn.catch(() => {});
  return turn;
}
async function holdOrLet(self, run, command, ctx, signal) {
  const push = isGitPush(command);
  if (!push && (checkScope(command, run.checks.commands) !== 'suite' || run.fullAsked || run.scopeChoice === 'full')) return;
  const surface = surfaceOf(self, ctx);
  if (!surface) return;
  if (push) {
    const now = await self.digest();
    if (run.suitePassedOn(now) || (run.pushAllowedOn !== undefined && run.pushAllowedOn === now)) return;
    const picked = await ask(surface, 'Sắp push code nhưng toàn bộ test chưa pass trên code này. Làm gì?', [PUSH_FULL, PUSH_NOW], signal);
    if (picked === PUSH_NOW) { run.pushAllowedOn = now; return; }
    if (picked?.other) throw Error(WORDS_REASON(picked.other));
    if (picked !== PUSH_FULL) throw Error(STOPPED_REASON);
    run.scopeChoice = 'full';
    throw Error(PUSH_REASON);
  }
  // Sent another way once; the same command again means the part did not do: the member decides (Bypass: it runs).
  const held = run.scopeHeld ??= new Set(), again = held.has(command); held.add(command);
  if (effectivePermission(self) === 'bypass') { if (again) return; throw Error(BYPASS_REASON); }
  if (run.scopeChoice === 'partial' && !again) throw Error(PARTIAL_REASON);
  const picked = await ask(surface, `Agent muốn chạy toàn bộ test: ${String(command).slice(0, 160)}`, [PART, FULL], signal);
  if (picked === FULL) { run.scopeChoice = 'full'; return; }
  run.scopeChoice = 'partial';
  throw Error(picked?.other ? WORDS_REASON(picked.other) : PARTIAL_REASON);
}

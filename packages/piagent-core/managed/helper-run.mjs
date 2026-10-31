// A helper role's run: its grant from Studio, its read-only sessions (one per
// part of a large patch for a review), the receipt and the review it records.
// A helper whose company model account is out of usage, or resting after a
// refusal, starts once more: Studio then gives the new helper the next model
// of its role that serves (an auto role's list).
import { fenced, HELPER_UNTRUSTED_RULE } from './untrusted.mjs';
import { jobTitle } from './call-purpose.mjs';
import { ManagedToolBoundary } from './tool-boundary.mjs';
import { managedResourceLoader } from './resource-loader.mjs';
import { shareGrant, releaseGrant, slotArgs, baseRole } from './grant-share.mjs';
import { describeFailure, failureCode, failureText } from '../runtime/managed-failure.mjs';
import { reviewParts, focusParts, mergeReviews, REVIEW_PARALLEL, emptySnapshot, readBranchBase, readPatchDigest, readPatchSnapshot, resolveReviewBase } from './patch-snapshot.mjs';
import { reviewFindings, briefIssues, verifyVerdicts } from './workflow.mjs';
import { currentWorkflow, helperWorkflowPrompt } from './workflow-context.mjs';
import { anchorText, relayObjection, recordVerdicts } from './objections.mjs';
import { recordFindings } from './ledger.mjs';
import { copyNote, mergeCopies } from './copies.mjs';
import { HELPER_CALLS, HELPER_SETUP, READ_TOOLS, countedCheck } from './helper-roles.mjs';
import { trackToolFailures } from './tool-failures.mjs';
import { helperMemoryTools, renewer } from './memory.mjs';
import { answeredSettlement, failedSettlement, settleHelper, OUTCOME_WORDS } from './helper-settlement.mjs';
import { viaLink } from './studio-link.mjs';

const textContent = result => result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
// A helper failure that another model of its role may not have: the model's
// company account is out of usage or resting, was switched off or removed
// under the helper, or none serves it now. The new helper is a new
// conversation for Studio, so it is not held to the old account.
const HELPER_SWITCH = new Set(['upstream_rate_limited', 'session_account_not_ready_retry_later', 'session_account_unavailable_start_new_session', 'account_capacity_unavailable', 'execution_capability_unavailable']);
const HELPER_ATTEMPTS = 2;

// The patch a review reads: this turn's change; the commits since `since`
// (a commit before HEAD the main agent names); or, when the turn changed
// nothing and the main agent asked (a review of work committed in earlier
// turns), the branch's commits since it left the default branch.
async function reviewSnapshot(managed, harness, since) {
  if (since) {
    const base = await resolveReviewBase(managed.boundary, since);
    if (!base) throw Error(`managed-review-base-unknown: "${String(since).slice(0, 80)}" is not a commit HEAD descends from in this repository; name a commit, a branch or HEAD~N`);
    return Object.assign(await readPatchSnapshot(managed.boundary, null, base), { from: { kind: 'since', ref: since, base } });
  }
  const snapshot = await managed.patchSnapshot();
  if (harness || !emptySnapshot(snapshot)) return snapshot;
  const branch = await readBranchBase(managed.boundary);
  return branch ? Object.assign(await readPatchSnapshot(managed.boundary, null, branch.base), { from: { kind: 'branch', ref: branch.ref, base: branch.base } }) : snapshot;
}

export async function runHelper(managed, role, task, signal, harness, { verifyGrant, patiently, title, since, fan = null }) {
  const snapshot = role === 'review' ? await reviewSnapshot(managed, harness, since) : null;
  // The harness's re-review after a fix reads only the parts holding a file changed since (reviewFocus).
  const parts = snapshot ? focusParts(reviewParts(snapshot), harness && !since ? managed.reviewFocus : null) : null;
  // A helper whose company model account is out of usage, or resting after
  // a refusal, starts once more: Studio then gives the new helper the next
  // model of its role that serves (an auto role's list). Helpers read and
  // run checks only, so starting over repeats no change.
  for (let attempt = 1; ; attempt += 1) {
    try { return await helperAttempt(managed, role, task, signal, harness, snapshot, parts, { verifyGrant, patiently, title, fan }); }
    catch (error) {
      if (attempt >= HELPER_ATTEMPTS || signal?.aborted || !HELPER_SWITCH.has(failureCode(error?.message)) || (managed.helperCalls.get(role) ?? 0) >= HELPER_CALLS) throw error;
    }
  }
}
// A helper's role closes through the same wait as the run's close: a passing
// failure of Agent Watch's way to Studio is asked again. A close that still
// fails leaves the helper's answer standing: the role closes with the run,
// and the next helper of the role closes it first. `key`: the role, or
// role#slot for a helper the member asked for beside it (grant-share.mjs).
export async function closeRole(managed, key) {
  try { await viaLink(managed.studioLink, () => managed.broker.request('close', slotArgs(key))); managed.unclosed?.delete(key); }
  catch { (managed.unclosed ??= new Set()).add(key); }
}
// Helpers the member asked for run on grants of their own (slots) when
// Studio and Agent Watch hold several of a role at once; otherwise side by
// side on the role's one grant, where Studio takes their requests in turn.
const slotsReady = managed => (managed.manifest?.broker_features ?? []).includes('helper-slots');

async function helperAttempt(managed, role, task, signal, harness, snapshot, parts, { verifyGrant, patiently, title, fan }) {
  const setup = HELPER_SETUP[role], opts = { verifyGrant, patiently, title };
  let result;
  if (!fan) result = await answerUnder(managed, role, task, signal, harness, snapshot, parts, opts, ['']);
  else if (!slotsReady(managed)) result = await answerUnder(managed, role, task, signal, harness, snapshot, parts, opts, Array.from({ length: fan.n }, (_, i) => copyNote(role, i, fan)));
  else {
    // One grant per helper, all at once; the first that fails stops the others.
    const stop = new AbortController(), both = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
    let results;
    try { results = await Promise.all(Array.from({ length: fan.n }, (_, i) => answerUnder(managed, i ? `${role}#${i + 1}` : role, task, both, harness, snapshot, parts, opts, [copyNote(role, i, fan)]).catch(error => { stop.abort(); throw error; }))); }
    catch (error) { throw signal?.aborted ? Error('managed-helper-cancelled') : error; }
    const merged = mergeCopies(role, setup.label, results, { findingsOf: reviewFindings, issuesOf: briefIssues, verdictsOf: verifyVerdicts });
    result = { ...results[0], reply: merged.reply, usage: merged.usage, review: merged.findings ? merged : null, stale: results.some(r => r.stale), report: null };
  }
  const { reply, usage, review, stale, from, grant } = result;
  const details = { role, runID: grant.run_id, tokens: usage, patchDigest: snapshot?.digest, stale, ...(fan ? { helpers: fan.n, ...(slotsReady(managed) ? { slots: true } : {}) } : {}), ...(from ? { since: { kind: from.kind, ref: from.ref, base: from.base } } : {}) };
  if (snapshot) {
    // Severity-graded findings decide whether the harness sends the agent back.
    const findings = review ? review.findings : reviewFindings(reply);
    Object.assign(details, { parsed: review ? review.parsed : !!findings, findings: (findings ?? []).slice(0, 40), blocking: findings?.filter(f => f.severity === 'blocking').length ?? 0 });
    if (review) Object.assign(details, { parts: parts.parts.length, unread: parts.omitted.map(o => o.path).slice(0, 50) });
    if (managed.run) { managed.run.reviews += 1; managed.run.blocking += details.blocking; }
    // A review of earlier commits is not the review of this turn's change;
    // what each file held then tells a later re-review what changed since.
    if (!from) { managed.review = details; if (!stale) { recordFindings(managed, findings); managed.reviewFiles = await managed.changedFiles?.(); } }
    managed.session.sessionManager.appendCustomEntry('agent-watch-review', details);
  }
  const verdicts = role === 'verify' ? recordVerdicts(managed, reply, harness, details) : '';
  const report = result.report ?? answeredSettlement(role, reply, details, managed.helperSpecs?.get(role) ?? {}); details.outcome = report.outcome;
  await managed.session.sendCustomMessage({ customType: 'agent-watch-helper-receipt', display: true,
    content: `${setup.label}: ${usage.toLocaleString('en-US')} tokens${verdicts}${fan ? ` · ${fan.n} helpers` : review ? ` · ${parts.parts.length} parts` : ''}${snapshot ? (stale ? ' · review is stale' : ' · patch ' + snapshot.digest.slice(0, 12)) : ''} · ${OUTCOME_WORDS[report.outcome]}.`, details }, { triggerTurn: false });
  // An objection to the brief comes with the answer; a stale review has none to act on.
  const objection = stale ? '' : await relayObjection(managed, role, reply, harness);
  const ending = `Outcome: ${report.outcome}${report.outcome === 'unverifiable' ? ` (${report.summary})` : ''}.\n\n`;
  // The helper read untrusted content: its answer is data for the main agent.
  return { content: [{ type: 'text', text: ending + (stale ? 'Review is stale: the patch changed during review. Ask for another review only after fixing blocking findings; under a required review the harness reviews the final patch.' : fenced(`${setup.label} helper's answer`, reply) + objection) }], details };
}

// One grant of the role (`key`: the role, or role#slot) and the helper
// sessions that answer under it, one per note (a copy's place among the
// helpers the member asked for). Its settlement goes to Studio and the grant
// closes before the answer is used.
async function answerUnder(managed, key, task, signal, harness, snapshot, parts, { verifyGrant, patiently, title }, notes) {
  const role = baseRole(key);
  if (managed.unclosed?.has(key)) await closeRole(managed, key);
  // A long local tool step may outlive the main lease. Refresh authority
  // before asking for a child; the broker serializes concurrent renewals,
  // and main's own searches running beside it share managed renew.
  let grant;
  try {
    const share = shareGrant(managed, 'main');
    try {
      const parent = await share.grant;
      verifyGrant(parent, managed.manifest, 'main'); managed.grant = parent;
      grant = await patiently(() => managed.broker.request('child', slotArgs(key)), 2);
    } finally { releaseGrant(managed, 'main', share); }
    managed.helperCalls.set(role, (managed.helperCalls.get(role) ?? 0) + notes.length); // each helper the member asked for counts
    try { verifyGrant(grant, managed.manifest, key); }
    catch (error) { try { await managed.broker.request('close', slotArgs(key)); } catch { /* closes with the run */ } throw error; }
  } catch (error) { throw Error(`managed-helper-failed: ${describeFailure(role, failureText(error))}`); }
  let boundary, report = null;
  const sessions = new Set(), watched = new Set(), spec = managed.helperSpecs?.get(role) ?? {};
  const renew = renewer(managed, key, g => verifyGrant(g, managed.manifest, key));
  try {
    const runtime = await managed.api.ModelRuntime.create({ credentials: new managed.ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = managed.installModel(runtime, grant); managed.wrapStreams(runtime, key);
    // Studio's logs name the job by its title (the brief's first line without one).
    (managed.jobTitles ??= new WeakMap()).set(runtime, jobTitle(task, title));
    const setup = HELPER_SETUP[role], memory = helperMemoryTools(managed, () => grant, renew);
    boundary = new ManagedToolBoundary({ cwd: managed.cwd, sdkRoot: managed.sdk, protectedRoots: managed.protectedRoots, readOnly: true, commands: setup.commands });
    const checks = role === 'verify' ? `\n\nRepository checks: ${managed.checks.commands.length ? managed.checks.commands.map(c => '`' + c + '`').join(', ') : 'none declared or detected; choose the tests, type check or build that cover the claims'}.${managed.run?.fullAsked || managed.run?.scopeChoice === 'full' ? '' : ' Run only the tests that cover the claims: the member decides about a whole-suite run.'}` : '';
    // One helper session answers the brief (with one part of the patch for a
    // review in parts); its reply and tokens. A helper runs at its role's
    // level from Studio (fixed by the Harness, or its main agent's).
    const ask = async (extra, note = '', who = key) => {
      const { session } = await managed.api.createAgentSession({ cwd: managed.cwd, model, modelRuntime: runtime, thinkingLevel: grant.effort || 'off',
        settingsManager: managed.api.SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' }),
        sessionManager: managed.api.SessionManager.inMemory(managed.cwd), noTools: 'builtin', tools: [...READ_TOOLS, ...(setup.commands ? ['bash'] : []), ...(setup.web ? ['web_search', 'web_fetch'] : []), ...memory.map(tool => tool.name)],
        customTools: [...boundary.tools(managed.api).filter(tool => READ_TOOLS.includes(tool.name) || setup.commands && tool.name === 'bash').map(tool => countedCheck(managed, tool)),
          ...(setup.web ? managed.webTools(runtime, key) : []), ...memory], resourceLoader: managedResourceLoader(managed.api, { systemPrompt: setup.prompt + HELPER_UNTRUSTED_RULE }) });
      sessions.add(session); trackToolFailures(managed, session, role); watched.add(who); watchHelper(managed, who, session, task, title);
      const abort = () => void session.abort(); signal?.addEventListener('abort', abort, { once: true });
      try { if (signal?.aborted) throw Error('managed-helper-cancelled'); await session.prompt(anchorText(managed.session.sessionManager, harness) + task + note + helperWorkflowPrompt(currentWorkflow(managed.session.sessionManager)) + checks + extra, { expandPromptTemplates: false }); }
      finally { signal?.removeEventListener('abort', abort); }
      const messages = session.messages.filter(m => m.role === 'assistant');
      // The main agent (and the member) learn why a helper failed, not just that it did.
      if (messages.at(-1)?.stopReason === 'error') throw Error(`managed-helper-failed: ${messages.at(-1).errorMessage}`);
      // Stopped by the member: say so, rather than that the helper failed.
      if (!messages.length || messages.at(-1).stopReason === 'aborted') throw Error(signal?.aborted ? 'managed-helper-cancelled' : 'managed-helper-failed');
      return { reply: messages.map(textContent).join('\n'), usage: messages.reduce((n, m) => n + (m.usage?.totalTokens ?? 0), 0) };
    };
    // One helper's answer: the brief (with the whole patch, or the patch in parts for a large review).
    const once = async (note = '', who = key) => {
      if (!parts || parts.parts.length === 1) { const answer = await ask(parts ? `\n${parts.parts[0].text}` : '', note, who); return { ...answer, reply: answer.reply.slice(0, 16000), review: null }; }
      // A large patch: one reviewer per part, REVIEW_PARALLEL at a time (Studio
      // admits one request of a role at a time); the first part that fails
      // stops the others.
      const answers = new Array(parts.parts.length);
      let next = 0;
      const reviewer = async () => {
        while (next < parts.parts.length) { const i = next++; answers[i] = await ask(`\n${parts.parts[i].text}`, note, who); }
      };
      try { await Promise.all(Array.from({ length: Math.min(REVIEW_PARALLEL, parts.parts.length) }, reviewer)); }
      catch (error) { next = parts.parts.length; for (const session of sessions) void session.abort(); throw error; }
      const review = mergeReviews(parts, answers, { findingsOf: reviewFindings, issuesOf: briefIssues });
      return { reply: review.reply, usage: review.usage, review };
    };
    let reply, usage, review = null;
    if (notes.length === 1) ({ reply, usage, review } = await once(notes[0]));
    else {
      // Helpers the member asked for on this one grant, each on its own; the first that fails stops the others.
      let answers;
      try { answers = await Promise.all(notes.map((note, i) => once(note, i ? `${role}#${i + 1}` : key))); }
      catch (error) { for (const session of sessions) void session.abort(); throw error; }
      const merged = mergeCopies(role, setup.label, answers, { findingsOf: reviewFindings, issuesOf: briefIssues, verdictsOf: verifyVerdicts });
      ({ reply, usage } = merged); review = merged.findings ? merged : null;
    }
    const from = snapshot?.from ?? null;
    const stale = snapshot ? (await (from ? readPatchDigest(managed.boundary, null, from.base) : managed.patchDigest())) !== snapshot.digest : false;
    const findings = snapshot ? (review ? review.findings : reviewFindings(reply)) : null;
    report = answeredSettlement(role, reply, snapshot ? { stale, parsed: review ? review.parsed : !!findings, findings: findings ?? [] } : {}, spec);
    return { reply, usage, review, stale, from, grant, report };
  } catch (error) { report = failedSettlement(role, error, signal, spec); throw error; }
  finally {
    for (const session of sessions) session.dispose(); await boundary?.dispose();
    await settleHelper(managed, renew.lease, report); // with the role's current token, before it closes
    await closeRole(managed, key);
    for (const who of watched) helperState(managed, who, null);
  }
}

// The helpers running now and what each is doing, told to the session's
// listeners (the terminal's subagent panel, the WebUI) as it changes.
export function helperState(managed, key, state) {
  const states = managed.helperStates ??= new Map();
  if (state) states.set(key, state); else states.delete(key);
  managed.notify?.({ type: 'managed_helper_state', helpers: [...states].map(([k, s]) => ({ key: k, role: baseRole(k), slot: slotArgs(k).slot ?? 1, ...s })) });
}
// What a helper is doing, for the terminal's subagent panel: the job and its
// latest tool step, told to listeners as it changes (company-terminal.mjs).
function watchHelper(managed, key, session, task, title) {
  const job = String(title || task.split('\n').find(line => line.trim()) || '').trim().slice(0, 120);
  helperState(managed, key, { job, step: 'đọc brief' });
  session.subscribe?.(event => {
    if (event?.type !== 'tool_execution_start') return;
    helperState(managed, key, { job, step: stepText(event.toolName, event.args) });
  });
}
const STEP = { read: 'đọc', grep: 'tìm', find: 'tìm file', ls: 'xem thư mục', bash: 'chạy', web_search: 'tìm trên web', web_fetch: 'đọc trang', memory_search: 'tra team memory', memory_ask: 'hỏi team memory' };
export function stepText(tool, args = {}) {
  const what = args?.path ?? args?.pattern ?? args?.command ?? args?.query ?? args?.url ?? '';
  return `${STEP[tool] ?? tool}${what ? ' ' + String(what).replace(/\s+/g, ' ').slice(0, 80) : ''}`;
}

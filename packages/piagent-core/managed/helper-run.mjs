// A helper role's run: its grant from Studio, its read-only sessions (one per
// part of a large patch for a review), the receipt and the review it records.
// A helper whose company model account is out of usage, or resting after a
// refusal, starts once more: Studio then gives the new helper the next model
// of its role that serves (an auto role's list).
import { fenced, HELPER_UNTRUSTED_RULE } from './untrusted.mjs';
import { jobTitle } from './call-purpose.mjs';
import { ManagedToolBoundary } from './tool-boundary.mjs';
import { managedResourceLoader } from './resource-loader.mjs';
import { shareGrant, releaseGrant } from './grant-share.mjs';
import { describeFailure, failureCode, failureText } from '../runtime/managed-failure.mjs';
import { reviewParts, mergeReviews, REVIEW_PARALLEL, emptySnapshot, readBranchBase, readPatchDigest, readPatchSnapshot, resolveReviewBase } from './patch-snapshot.mjs';
import { reviewFindings, briefIssues } from './workflow.mjs';
import { currentWorkflow, helperWorkflowPrompt } from './workflow-context.mjs';
import { anchorText, relayObjection, recordVerdicts } from './objections.mjs';
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

export async function runHelper(managed, role, task, signal, harness, { verifyGrant, patiently, title, since }) {
  const snapshot = role === 'review' ? await reviewSnapshot(managed, harness, since) : null, parts = snapshot ? reviewParts(snapshot) : null;
  // A helper whose company model account is out of usage, or resting after
  // a refusal, starts once more: Studio then gives the new helper the next
  // model of its role that serves (an auto role's list). Helpers read and
  // run checks only, so starting over repeats no change.
  for (let attempt = 1; ; attempt += 1) {
    try { return await helperAttempt(managed, role, task, signal, harness, snapshot, parts, { verifyGrant, patiently, title }); }
    catch (error) {
      if (attempt >= HELPER_ATTEMPTS || signal?.aborted || !HELPER_SWITCH.has(failureCode(error?.message)) || (managed.helperCalls.get(role) ?? 0) >= HELPER_CALLS) throw error;
    }
  }
}
// A helper's role closes through the same wait as the run's close: a passing
// failure of Agent Watch's way to Studio is asked again. A close that still
// fails leaves the helper's answer standing: the role closes with the run,
// and the next helper of the role closes it first.
export async function closeRole(managed, role) {
  try { await viaLink(managed.studioLink, () => managed.broker.request('close', { role })); managed.unclosed?.delete(role); }
  catch { (managed.unclosed ??= new Set()).add(role); }
}
async function helperAttempt(managed, role, task, signal, harness, snapshot, parts, { verifyGrant, patiently, title }) {
  if (managed.unclosed?.has(role)) await closeRole(managed, role);
  // A long local tool step may outlive the main lease. Refresh authority
  // before asking for a child; the broker serializes concurrent renewals,
  // and main's own searches running beside it share managed renew.
  let grant;
  try {
    const share = shareGrant(managed, 'main');
    try {
      const parent = await share.grant;
      verifyGrant(parent, managed.manifest, 'main'); managed.grant = parent;
      grant = await patiently(() => managed.broker.request('child', { role }), 2);
    } finally { releaseGrant(managed, 'main', share); }
    managed.helperCalls.set(role, (managed.helperCalls.get(role) ?? 0) + 1);
    try { verifyGrant(grant, managed.manifest, role); }
    catch (error) { try { await managed.broker.request('close', { role }); } catch { /* closes with the run */ } throw error; }
  } catch (error) { throw Error(`managed-helper-failed: ${describeFailure(role, failureText(error))}`); }
  let boundary, report = null;
  const sessions = new Set(), spec = managed.helperSpecs?.get(role) ?? {};
  const renew = renewer(managed, role, g => verifyGrant(g, managed.manifest, role));
  try {
    const runtime = await managed.api.ModelRuntime.create({ credentials: new managed.ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    const model = managed.installModel(runtime, grant); managed.wrapStreams(runtime, role);
    // Studio's logs name the job by its title (the brief's first line without one).
    (managed.jobTitles ??= new WeakMap()).set(runtime, jobTitle(task, title));
    const setup = HELPER_SETUP[role], memory = helperMemoryTools(managed, () => grant, renew);
    boundary = new ManagedToolBoundary({ cwd: managed.cwd, sdkRoot: managed.sdk, protectedRoots: managed.protectedRoots, readOnly: true, commands: setup.commands });
    const checks = role === 'verify' ? `\n\nRepository checks: ${managed.checks.commands.length ? managed.checks.commands.map(c => '`' + c + '`').join(', ') : 'none declared or detected; choose the tests, type check or build that cover the claims'}.` : '';
    // One helper session answers the brief (with one part of the patch for a
    // review in parts); its reply and tokens. A helper runs at its role's
    // level from Studio (fixed by the Harness, or its main agent's).
    const ask = async extra => {
      const { session } = await managed.api.createAgentSession({ cwd: managed.cwd, model, modelRuntime: runtime, thinkingLevel: grant.effort || 'off',
        settingsManager: managed.api.SettingsManager.inMemory({ retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: 'off' }),
        sessionManager: managed.api.SessionManager.inMemory(managed.cwd), noTools: 'builtin', tools: [...READ_TOOLS, ...(setup.commands ? ['bash'] : []), ...(setup.web ? ['web_search', 'web_fetch'] : []), ...memory.map(tool => tool.name)],
        customTools: [...boundary.tools(managed.api).filter(tool => READ_TOOLS.includes(tool.name) || setup.commands && tool.name === 'bash').map(tool => countedCheck(managed, tool)),
          ...(setup.web ? managed.webTools(runtime, role) : []), ...memory], resourceLoader: managedResourceLoader(managed.api, { systemPrompt: setup.prompt + HELPER_UNTRUSTED_RULE }) });
      sessions.add(session); trackToolFailures(managed, session, role);
      const abort = () => void session.abort(); signal?.addEventListener('abort', abort, { once: true });
      try { if (signal?.aborted) throw Error('managed-helper-cancelled'); await session.prompt(anchorText(managed.session.sessionManager, harness) + task + helperWorkflowPrompt(currentWorkflow(managed.session.sessionManager)) + checks + extra, { expandPromptTemplates: false }); }
      finally { signal?.removeEventListener('abort', abort); }
      const messages = session.messages.filter(m => m.role === 'assistant');
      // The main agent (and the member) learn why a helper failed, not just that it did.
      if (messages.at(-1)?.stopReason === 'error') throw Error(`managed-helper-failed: ${messages.at(-1).errorMessage}`);
      // Stopped by the member: say so, rather than that the helper failed.
      if (!messages.length || messages.at(-1).stopReason === 'aborted') throw Error(signal?.aborted ? 'managed-helper-cancelled' : 'managed-helper-failed');
      return { reply: messages.map(textContent).join('\n'), usage: messages.reduce((n, m) => n + (m.usage?.totalTokens ?? 0), 0) };
    };
    let reply, usage, review = null;
    if (!parts || parts.parts.length === 1) {
      ({ reply, usage } = await ask(parts ? `\n${parts.parts[0].text}` : ''));
      reply = reply.slice(0, 16000);
    } else {
      // A large patch: one reviewer per part, REVIEW_PARALLEL at a time (Studio
      // admits one request of a role at a time); the first part that fails
      // stops the others.
      const answers = new Array(parts.parts.length);
      let next = 0;
      const reviewer = async () => {
        while (next < parts.parts.length) { const i = next++; answers[i] = await ask(`\n${parts.parts[i].text}`); }
      };
      try { await Promise.all(Array.from({ length: Math.min(REVIEW_PARALLEL, parts.parts.length) }, reviewer)); }
      catch (error) { next = parts.parts.length; for (const session of sessions) void session.abort(); throw error; }
      review = mergeReviews(parts, answers, { findingsOf: reviewFindings, issuesOf: briefIssues });
      ({ reply, usage } = review);
    }
    const from = snapshot?.from ?? null;
    const stale = snapshot ? (await (from ? readPatchDigest(managed.boundary, null, from.base) : managed.patchDigest())) !== snapshot.digest : false;
    const details = { role, runID: grant.run_id, tokens: usage, patchDigest: snapshot?.digest, stale, ...(from ? { since: { kind: from.kind, ref: from.ref, base: from.base } } : {}) };
    if (snapshot) {
      // Severity-graded findings decide whether the harness sends the agent back.
      const findings = review ? review.findings : reviewFindings(reply);
      Object.assign(details, { parsed: review ? review.parsed : !!findings, findings: (findings ?? []).slice(0, 40), blocking: findings?.filter(f => f.severity === 'blocking').length ?? 0 });
      if (review) Object.assign(details, { parts: parts.parts.length, unread: parts.omitted.map(o => o.path).slice(0, 50) });
      if (managed.run) { managed.run.reviews += 1; managed.run.blocking += details.blocking; }
      // A review of earlier commits is not the review of this turn's change.
      if (!from) managed.review = details;
      managed.session.sessionManager.appendCustomEntry('agent-watch-review', details);
    }
    const verdicts = role === 'verify' ? recordVerdicts(managed.run, reply, harness, details) : '';
    report = answeredSettlement(role, reply, details, spec); details.outcome = report.outcome;
    await managed.session.sendCustomMessage({ customType: 'agent-watch-helper-receipt', display: true,
      content: `${setup.label}: ${usage.toLocaleString('en-US')} tokens${verdicts}${review ? ` · ${parts.parts.length} parts` : ''}${snapshot ? (stale ? ' · review is stale' : ' · patch ' + snapshot.digest.slice(0, 12)) : ''} · ${OUTCOME_WORDS[report.outcome]}.`, details }, { triggerTurn: false });
    // An objection to the brief comes with the answer; a stale review has none to act on.
    const objection = stale ? '' : await relayObjection(managed, role, reply, harness);
    const ending = `Outcome: ${report.outcome}${report.outcome === 'unverifiable' ? ` (${report.summary})` : ''}.\n\n`;
    // The helper read untrusted content: its answer is data for the main agent.
    return { content: [{ type: 'text', text: ending + (stale ? 'Review is stale: the patch changed during review. Obtain a new review for the current patch.' : fenced(`${setup.label} helper's answer`, reply) + objection) }], details };
  } catch (error) { report = failedSettlement(role, error, signal, spec); throw error; }
  finally {
    for (const session of sessions) session.dispose(); await boundary?.dispose();
    await settleHelper(managed, renew.lease, report); // with the role's current token, before it closes
    await closeRole(managed, role);
  }
}

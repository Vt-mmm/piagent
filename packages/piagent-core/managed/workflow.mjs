import fs from 'node:fs';
import path from 'node:path';
import { reviewUnavailableReason } from './patch-snapshot.mjs';
import { failureCode } from '../runtime/managed-failure.mjs';

// The process layer of the company harness: a plan for multi-step work, the
// repository's checks after a code change, an independent review of the patch.
// Studio's Harness sets the policy. "suggest" tells the agent and records what
// happened; "require" is enforced here, in code, before a code-changing turn
// ends: the agent is sent back at most max_fix_loops times.
const MODES = ['off', 'suggest', 'require'];
export function workflowPolicy(manifest) {
  const config = manifest?.harness?.configuration ?? {}, w = config.workflow ?? {};
  const mode = value => MODES.includes(value) ? value : 'suggest';
  const loops = Number.isInteger(w.max_fix_loops) && w.max_fix_loops >= 0 && w.max_fix_loops <= 3 ? w.max_fix_loops : 2;
  // A review needs a review helper; without one in the Harness it is off.
  return { plan: mode(w.plan), verify: mode(w.verify), review: config.review ? mode(w.review) : 'off', maxFixLoops: loops };
}

// Checks come from the repository: a "## Checks" section in AGENTS.md (code
// block lines or `command` bullets), else what its manifests imply.
const HEADING = /^#{1,6}\s+(checks?|verification|kiểm tra)\s*$/i;
export function declaredChecks(agentsFiles = []) {
  const out = [];
  for (const file of agentsFiles) {
    let inside = false, fence = false;
    for (const line of String(file.content ?? '').split('\n')) {
      if (!fence && /^#{1,6}\s/.test(line)) { inside = HEADING.test(line.trim()); continue; }
      if (!inside) continue;
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      const command = (fence ? line : line.match(/^\s*[-*]\s+`([^`]+)`/)?.[1] ?? '').trim();
      if (command && !command.startsWith('#') && command.length <= 200 && !out.includes(command) && out.length < 10) out.push(command);
    }
  }
  return out;
}
export function detectedChecks(dir) {
  const has = name => { try { const s = fs.lstatSync(path.join(dir, name)); return s.isFile() && s.size <= 1024 * 1024; } catch { return false; } };
  const out = [];
  if (has('package.json')) {
    try {
      const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts ?? {};
      const runner = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lock') || has('bun.lockb') ? 'bun' : 'npm';
      for (const name of ['typecheck', 'lint', 'test']) if (typeof scripts[name] === 'string') out.push(name === 'test' && runner === 'npm' ? 'npm test' : `${runner} run ${name}`);
    } catch { /* not JSON: nothing implied */ }
  }
  if (has('go.mod')) out.push('go vet ./...', 'go test ./...');
  if (has('Package.swift')) out.push('swift build', 'swift test');
  if (has('Cargo.toml')) out.push('cargo check', 'cargo test');
  if (has('pyproject.toml') || has('pytest.ini')) out.push('pytest');
  return out.slice(0, 6);
}
export function repositoryChecks(agentsFiles, cwd, top = cwd) {
  const declared = declaredChecks(agentsFiles);
  if (declared.length) return { source: 'agents', commands: declared };
  const detected = detectedChecks(cwd);
  return { source: 'detected', commands: detected.length || cwd === top ? detected : detectedChecks(top) };
}
// A command that verifies code: a declared check, or a known test, type,
// lint or build runner. Text tools that merely mention one do not count.
const RUNNER = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|check|build|verify)\b|\bnode\s+--test\b|\b(tsc|vitest|jest|eslint|biome|ruff|mypy|pyright|pytest|rspec|phpunit)\b|\bplaywright\s+test\b|\bpython3?\s+-m\s+(pytest|unittest|mypy)\b|\bgo\s+(test|vet|build)\b|\bcargo\s+(test|check|clippy|build)\b|\bswift\s+(test|build)\b|\bxcodebuild\b.*\b(test|build)\b|\bmake\s+(test|check|lint)\b|\b(gradle|gradlew|mvn)\b.*\b(test|check|verify)\b|\bdotnet\s+(test|build)\b|\bdeno\s+(test|check|lint)\b/;
// A command that only reads: each part starts with a reading tool and nothing
// is written to a file. Anything else may change files.
const READER = /^(ls|cat|head|tail|wc|grep|egrep|rg|find|fd|sed|awk|cut|sort|uniq|tr|echo|printf|pwd|which|stat|file|du|df|tree|jq|diff|cmp|basename|dirname|realpath|date|true|cd|git\s+(status|diff|log|show|branch|ls-files|rev-parse|blame))\b/;
export function isReadOnlyCommand(command) {
  const text = String(command ?? '').trim();
  if (!text || />(?!>|\s*&\d|\s*\/dev\/null)|\btee\b|\bsed\s+(-[a-zA-Z]*i|--in-place)|\s-(delete|exec|execdir|fprint|ok)\b|\bxargs\b|\$\(|`/.test(text)) return false;
  return text.split(/&&|\|\||;|\||\n/).every(part => !part.trim() || READER.test(part.trim()));
}
export function isCheckCommand(command, declared = []) {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim();
  if (!text || /^(echo|printf|grep|rg|cat|sed|awk|head|tail|less|git|ls|find)\b/.test(text)) return false;
  return declared.some(d => text.includes(d)) || RUNNER.test(text);
}

// update_plan: the agent's checklist, kept as a session entry so it survives
// compaction and "continue", and shown to the member beside the conversation.
export const PLAN_ENTRY = 'agent-watch-plan';
const STATUS = ['pending', 'in_progress', 'completed'];
export function normalizePlan(args) {
  const plan = Array.isArray(args?.plan) ? args.plan : [];
  if (plan.length < 1 || plan.length > 30 || plan.some(p => typeof p?.step !== 'string' || !p.step.trim() || p.step.length > 200 || !STATUS.includes(p.status)))
    throw Error('managed-plan-invalid: send 1 to 30 steps, each {step, status} with status pending, in_progress or completed.');
  if (plan.filter(p => p.status === 'in_progress').length > 1) throw Error('managed-plan-invalid: mark at most one step in_progress.');
  return { plan: plan.map(p => ({ step: p.step.trim(), status: p.status })), explanation: typeof args.explanation === 'string' ? args.explanation.slice(0, 300) : '' };
}
export function currentPlan(manager) {
  return manager.getEntries().filter(e => e.type === 'custom' && e.customType === PLAN_ENTRY).at(-1)?.data ?? null;
}
export const unfinished = plan => !!plan?.plan?.some(p => p.status !== 'completed');
export function planText(plan) {
  return plan?.plan?.map((p, i) => `${i + 1}. [${p.status === 'completed' ? 'x' : p.status === 'in_progress' ? '>' : ' '}] ${p.step}`).join('\n') ?? '';
}
export function planTool(run) {
  return { name: 'update_plan', label: 'Plan',
    description: 'Keep a short checklist for work with several steps. Send the whole list each time; mark the step you work on in_progress and finished steps completed. The member sees the checklist next to the conversation.',
    parameters: { type: 'object', properties: { explanation: { type: 'string', maxLength: 300 }, plan: { type: 'array', minItems: 1, maxItems: 30,
      items: { type: 'object', properties: { step: { type: 'string', minLength: 1, maxLength: 200 }, status: { type: 'string', enum: STATUS } }, required: ['step', 'status'], additionalProperties: false } } },
      required: ['plan'], additionalProperties: false },
    // Some models send the list as a JSON string; it is read as the list.
    prepareArguments: args => {
      if (typeof args?.plan !== 'string') return args;
      try { const plan = JSON.parse(args.plan); return Array.isArray(plan) ? { ...args, plan } : args; } catch { return args; }
    },
    execute: async (_id, args) => run(normalizePlan(args)) };
}

// The guidance a policy adds to the main agent's system prompt.
export function workflowPrompt(policy, checks) {
  const lines = [];
  if (policy.plan !== 'off') lines.push(`- Plan: for work with several steps keep a checklist with update_plan and update it as you go.${policy.plan === 'require' ? ' For a complex task, file edits are refused until a plan exists, and a checklist left unfinished comes back to you before the turn ends.' : ''}`);
  if (policy.verify !== 'off') {
    const list = checks.commands.length ? `${checks.commands.map(c => '`' + c + '`').join(', ')}${checks.source === 'detected' ? ' (detected; the repository declares none in AGENTS.md "## Checks")' : ''}` : 'none declared: choose the tests, type check or build that cover the change';
    lines.push(`- Verify: after changing code, run the repository checks that cover the change and fix failures before you finish. Repository checks: ${list}.${policy.verify === 'require' ? ' The turn does not end until a check has passed on the final code.' : ''}`);
  }
  if (policy.review !== 'off') lines.push(policy.review === 'require' ? '- Review: the harness reviews the final patch with an independent reviewer; blocking findings come back to you to fix.'
    : '- Review: before you finish a code change, ask the review helper (delegate role "review") to review the patch, then fix blocking findings.');
  return lines.length ? `\n\nProcess for code changes (company Harness):\n${lines.join('\n')}\nEnd-to-end tests that start a local server and a browser run through run_with_network, which the user approves. If a step cannot be done here (a check needs a database or another service), say so plainly; do not try to install or start services to get around the sandbox.\nA command stops after 10 minutes and anything left running in the background stops when the turn ends: run the checks that cover your change first and a long suite in parts, not in the background.` : '';
}

export const REVIEW_PROMPT = 'You review a patch for the company coding assistant. The patch snapshot below is immutable; read files to check the code around it. Report only problems that matter: incorrect behaviour, regressions, security issues, parts of the request that are missing, changed behaviour without tests. Do not report style or preferences. Classify each finding: blocking (must be fixed before the work is done), major, or minor. End your answer with one JSON object in a ```json block: {"findings":[{"severity":"blocking|major|minor","file":"path","line":1,"issue":"what is wrong","evidence":"why"}],"summary":"one sentence"}. Use an empty findings list when the patch is fine. You cannot change files or delegate.';
const clip = (value, n) => typeof value === 'string' ? value.slice(0, n) : '';
// The reviewer's findings from its answer; null when it gave no valid JSON.
export function reviewFindings(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const raw of blocks.reverse()) {
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value?.findings)) continue;
      return value.findings.filter(f => ['blocking', 'major', 'minor'].includes(f?.severity) && typeof f.issue === 'string' && f.issue.trim()).slice(0, 20)
        .map(f => ({ severity: f.severity, file: clip(f.file, 300), line: Number.isSafeInteger(f.line) && f.line > 0 ? f.line : null, issue: clip(f.issue, 500), evidence: clip(f.evidence, 500) }));
    } catch { /* not this block */ }
  }
  return null;
}
// The verify helper re-checks a result on its own: claims against the code and
// primary sources, the repository's checks on the current code.
export const VERIFY_PROMPT = 'You verify a result for the company coding assistant, independently of whoever produced it. For each claim or requirement in the brief: read the code it is about, run the repository checks that cover it with bash, and confirm external facts against primary sources (official documentation, the project\'s own repository) with web_search and web_fetch. Commands run offline and the project is read-only for them: a check that must write into the project or reach the network fails for that reason. Report such a claim as unverifiable and say why; do not work around the sandbox. Never mark a claim pass without evidence you saw. End your answer with one JSON object in a ```json block: {"verdicts":[{"claim":"what was checked","status":"pass|fail|unverifiable","evidence":"file:line, the command and its result, or the source URL"}],"summary":"one sentence"}. You cannot change files or delegate.';
// The verifier's verdicts from its answer; null when it gave no valid JSON.
export function verifyVerdicts(text) {
  const blocks = [...String(text).matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const raw of blocks.reverse()) {
    try {
      const value = JSON.parse(raw);
      if (!Array.isArray(value?.verdicts)) continue;
      return value.verdicts.filter(v => ['pass', 'fail', 'unverifiable'].includes(v?.status) && typeof v.claim === 'string' && v.claim.trim()).slice(0, 40)
        .map(v => ({ status: v.status, claim: clip(v.claim, 500), evidence: clip(v.evidence, 500) }));
    } catch { /* not this block */ }
  }
  return null;
}
const where = f => f.file ? ` ${f.file}${f.line ? ':' + f.line : ''}` : '';
export const findingText = f => `[${f.severity}]${where(f)} — ${f.issue}${f.evidence ? `\n   Evidence: ${f.evidence}` : ''}`;

// A change made by a turn that stopped before its process ran (stopped by the
// member, a failed request, a crash) stays the next turn's to settle: that run
// compares against the code before the change ("continue"). A turn whose
// process ran to its end and reported what is missing is settled as reported;
// later messages are not sent back for it again.
export const BASELINE_ENTRY = 'agent-watch-baseline';
export function pendingBaseline(manager) {
  const last = manager.getEntries().filter(e => e.type === 'custom' && e.customType === BASELINE_ENTRY).at(-1)?.data;
  return last && last.settled === false && typeof last.digest === 'string' ? last.digest : null;
}

// A model that cannot write a valid plan is not stuck forever: after this many
// refused answers its edits go through and the run reports that.
export const PLAN_REFUSALS = 3;

// What happened in one run (one member message), for the gate and the report.
export class RunProcess {
  constructor(policy, { request, complex, checks }) {
    Object.assign(this, { policy, request: String(request ?? ''), complex, checks, startDigest: null, mutations: 0, lastCheck: null, checksRun: 0, checksFailed: 0,
      reviews: 0, blocking: 0, blockingOpen: 0, fixLoops: 0, planUpdated: false, planRefusals: new Set(), planSkipped: false, planAsked: false, unplannedChange: false,
      unknownTools: 0, changed: false, verified: false, reviewed: false, reviewUnavailable: false, outcome: null });
  }
  // Plan "require" on a complex task that has no plan yet.
  planMissing(plan) {
    return this.policy.plan === 'require' && this.complex && !this.planUpdated && !unfinished(plan);
  }
  // Plan "require": the edits of a complex task are refused until a plan
  // exists: write and edit, and any command once a command has changed files
  // without one (models also edit through the shell). `answer` names the
  // model answer the call came from, so calls sent together count once.
  beforeEdit(name, plan, answer) {
    if (!this.planMissing(plan) || !(['write', 'edit'].includes(name) || (name === 'bash' && this.unplannedChange))) return;
    if (!this.planRefusals.has(answer) && this.planRefusals.size >= PLAN_REFUSALS) { this.planSkipped = true; return; }
    this.planRefusals.add(answer);
    throw Error('managed-plan-required: this is a multi-step task. Write a checklist with update_plan first, then repeat this call.');
  }
  // A command changed files while the required plan was missing.
  changedWithoutPlan() {
    this.unplannedChange = true; this.planSkipped = true;
  }
  async afterTool(name, args, ok, digestOf) {
    if (name === 'bash' && isCheckCommand(args?.command, this.checks.commands)) {
      this.checksRun += 1; if (!ok) this.checksFailed += 1;
      this.lastCheck = { ok, digest: await digestOf(), mutations: this.mutations };
    // A command may change files, so it counts. Without a git repository to
    // compare the code against, one that only reads does not: counting every
    // command reported code changes in turns that only read and checked.
    } else if (['write', 'edit'].includes(name) && ok || name === 'bash' && (this.startDigest !== null || !isReadOnlyCommand(args?.command))) this.mutations += 1;
  }
  verifiedOn(digest) {
    const c = this.lastCheck;
    return !!c?.ok && (digest !== null && c.digest !== null ? c.digest === digest : c.mutations === this.mutations);
  }
  // Version 2 (a broker advertising "process-v2") adds whether code was
  // changed without the required plan and how many calls named no tool.
  report(plan, version = 1) {
    const steps = this.planUpdated || unfinished(plan) ? plan?.plan ?? [] : [];
    return { version, policy: { plan: this.policy.plan, verify: this.policy.verify, review: this.policy.review }, changed: this.changed,
      plan_steps: steps.length, plan_done: steps.filter(p => p.status === 'completed').length, checks: Math.min(this.checksRun, 1000), checks_failed: Math.min(this.checksFailed, 1000),
      verified: this.verified, reviews: Math.min(this.reviews, 1000), reviewed: this.reviewed, blocking: Math.min(this.blocking, 1000), blocking_open: Math.min(this.blockingOpen, this.blocking, 1000),
      fix_loops: this.fixLoops, outcome: this.outcome ?? (this.changed ? 'interrupted' : 'no_change'),
      ...(version === 2 ? { plan_skipped: this.planSkipped, unknown_tools: Math.min(this.unknownTools, 1000) } : {}) };
  }
}

// Before a turn ends: decide whether code changed, whether a check passed on
// the final code and whether the final patch was reviewed. With "require" the
// harness acts (asks for checks, runs the review, sends blocking findings back)
// within max_fix_loops; every turn that changed code ends with a status note.
export async function completionGate(managed, run, signal) {
  const session = managed.session, policy = run.policy;
  const digestOf = async () => { try { return (await managed.patchSnapshot()).digest; } catch { return null; } };
  const stopped = () => signal?.aborted || ['aborted', 'error'].includes(session.messages.findLast(m => m.role === 'assistant')?.stopReason);
  const send = (content, details) => session.sendCustomMessage({ customType: 'agent-watch-process', content, display: true, details }, { triggerTurn: true });
  let digest = null, interrupted = false, verifyGaveUp = false;
  for (let step = 0; step < 12; step += 1) {
    digest = await digestOf();
    run.changed = run.startDigest !== null && digest !== null ? digest !== run.startDigest : run.mutations > 0;
    if (!run.changed) break;
    if (stopped()) { interrupted = true; break; }
    run.verified = run.verifiedOn(digest);
    const review = managed.review, fresh = !!review && !review.stale && digest !== null && review.patchDigest === digest;
    run.reviewed = fresh;
    run.blockingOpen = fresh ? review.blocking ?? 0 : run.blockingOpen;
    // Out of fix rounds the check stays unmet, but a required review still runs.
    if (policy.verify === 'require' && !run.verified && !verifyGaveUp && run.fixLoops >= policy.maxFixLoops) verifyGaveUp = true;
    if (policy.verify === 'require' && !run.verified && !verifyGaveUp) {
      run.fixLoops += 1;
      const list = run.checks.commands.length ? run.checks.commands.map(c => '`' + c + '`').join(', ') : 'the tests, type check or build that cover the change';
      await send(`Harness process check: code changed in this turn, but no check has passed on the current code. Run the checks that cover your change (${list}) and fix what fails. If a check cannot run here (it needs a database, a service or the network) or fails for a reason unrelated to your change, say so plainly instead of trying to install or start services.`,
        { phase: 'verify', loop: run.fixLoops, maxLoops: policy.maxFixLoops, lastCheckFailed: run.lastCheck?.ok === false });
      continue;
    }
    if (policy.review === 'require' && !fresh) {
      const plan = currentPlan(session.sessionManager);
      const brief = `Review the current patch against the member's request.\n\nMember's request:\n${run.request.slice(0, 6000)}\n\nPlan:\n${planText(plan) || '(none)'}\n\nChecks: ${run.verified ? 'a repository check passed on this code' : 'no check has passed on this code'}.`;
      try { await managed.delegate({ role: 'review', task: brief }, signal); }
      catch (error) {
        run.reviewUnavailable = !stopped(); run.reviewUnavailableReason = reviewUnavailableReason(error?.message); interrupted = stopped();
        // Why the review could not run, as a code only (the report says "failed").
        if (run.reviewUnavailable) try { session.sessionManager.appendCustomEntry('agent-watch-failure-detail', { role: 'review', code: failureCode(error?.message) }); } catch { /* the report still says it */ }
        break;
      }
      continue;
    }
    if (policy.review === 'require' && fresh && (review.blocking ?? 0) > 0) {
      if (run.fixLoops >= policy.maxFixLoops) break;
      run.fixLoops += 1;
      const blocking = (review.findings ?? []).filter(f => f.severity === 'blocking');
      await send(`Harness review of the current patch found ${blocking.length} blocking issue(s):\n${blocking.map((f, i) => `${i + 1}. ${findingText(f)}`).join('\n')}\nFix them, or explain why an issue is not real. The patch is reviewed again after your change.`,
        { phase: 'review', loop: run.fixLoops, maxLoops: policy.maxFixLoops, findings: blocking.slice(0, 10) });
      continue;
    }
    // Plan "require": a checklist written in this turn is brought up to date
    // once before the turn ends (models often write it and never touch it again).
    const plan = currentPlan(session.sessionManager);
    if (policy.plan === 'require' && run.planUpdated && !run.planAsked && unfinished(plan)) {
      run.planAsked = true;
      const open = plan.plan.filter(p => p.status !== 'completed').length;
      await send(`Harness process check: your checklist still has ${open} step(s) not marked completed:\n${planText(plan)}\nUpdate it with update_plan so it shows what was done. For a step you did not do, do it or say plainly why it is left.`,
        { phase: 'plan', planOpen: open });
      continue;
    }
    break;
  }
  // However the code was changed, a complex task under plan "require" that
  // never had a plan is reported as changed without it.
  if (run.changed && run.planMissing(currentPlan(session.sessionManager))) run.planSkipped = true;
  run.outcome = !run.changed ? 'no_change' : interrupted ? 'interrupted' : run.blockingOpen > 0 ? 'blocking_open'
    : policy.verify !== 'off' && !run.verified ? 'unverified' : run.reviewUnavailable ? 'review_unavailable' : policy.review !== 'off' && !run.reviewed ? 'unreviewed' : 'clean';
  const settled = run.outcome !== 'interrupted';
  session.sessionManager.appendCustomEntry(BASELINE_ENTRY, { digest: settled ? digest : run.startDigest, settled, outcome: run.outcome });
  if (!run.changed) return;
  const finalPlan = currentPlan(session.sessionManager), planOpen = run.planUpdated ? finalPlan?.plan?.filter(p => p.status !== 'completed').length ?? 0 : 0;
  const status = { verified: run.verified, reviewed: run.reviewed, blockingOpen: run.blockingOpen, checks: run.checksRun, fixLoops: run.fixLoops,
    ...(planOpen ? { planOpen } : {}), ...(run.planSkipped ? { planSkipped: true } : {}) };
  const words = [run.verified ? 'a check passed on the final code' : policy.verify === 'off' ? null : 'no check passed on the final code',
    run.reviewed ? (run.blockingOpen ? `review: ${run.blockingOpen} blocking issue(s) still open` : 'review: no blocking issue') : policy.review === 'off' ? null : run.reviewUnavailable ? `review could not run (${run.reviewUnavailableReason})` : 'not reviewed',
    run.planSkipped ? 'code was changed before the required plan existed' : null, planOpen ? `plan: ${planOpen} step(s) not completed` : null].filter(Boolean);
  await session.sendCustomMessage({ customType: 'agent-watch-process', content: `Process status for this turn: code changed; ${words.join('; ') || 'no process step configured'}.`, display: true,
    details: { phase: 'final', outcome: run.outcome, ...status, ...(run.reviewUnavailable ? { reviewUnavailable: run.reviewUnavailableReason } : {}), policy: { verify: policy.verify, review: policy.review } } }, { triggerTurn: false });
}

// The run's process sees each edit and command: plan guard before, check
// results and changes after. `session` is the ManagedSession (its run, latest
// main answer count, code digest and review refresh).
export function processEditTools(session, tools) {
  return tools.map(tool => {
    if (!['write', 'edit', 'bash'].includes(tool.name)) return tool;
    const execute = tool.execute;
    return { ...tool, execute: async (...args) => {
      const plan = currentPlan(session.session.sessionManager);
      session.run?.beforeEdit(tool.name, plan, session.mainAnswers);
      // While a required plan is missing, a command that changes files
      // counts as an edit: the code is compared after each command.
      const watch = tool.name === 'bash' && !!session.run?.planMissing(plan) && !session.run.unplannedChange && session.run.startDigest !== null;
      let ok = false;
      try {
        const result = await execute(...args); ok = true;
        if (watch && session.run) {
          const digest = await session.digest();
          if (digest !== null && digest !== session.run.startDigest) {
            session.run.changedWithoutPlan();
            return { ...result, content: [...(result.content ?? []), { type: 'text', text: '\n[Harness] This command changed files before the required plan existed. Write the checklist with update_plan now; further edits and commands are refused until it exists.' }] };
          }
        }
        return result;
      }
      finally { await session.run?.afterTool(tool.name, args[1], ok, () => session.digest()); await session.refreshReview(); }
    } };
  });
}

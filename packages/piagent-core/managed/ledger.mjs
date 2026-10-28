import fs from 'node:fs';
import path from 'node:path';
import { briefIssues } from './workflow.mjs';

// The objection ledger: what a helper holds against the main agent's work in
// one run (one member message), and what the main agent decided about it.
// A helper's objection to its brief, a review finding and a failed verify
// claim are one kind of item: open until the main agent resolves it with
// resolve_objection (accepted with what it changed, or rejected with what it
// checked and why), and a rejection of a required item goes back to the
// helper once; a disagreement that remains goes to the member. The run's
// items and decisions are one session entry when the run ends.
export const LEDGER_ENTRY = 'agent-watch-objections';
// A brief objection that blocks file changes until it is resolved: the brief
// rests on a premise the code contradicts, or on a reading the member's words
// contradict, and the helper pointed at a place that exists.
const PREMISE = new Set(['wrong_premise', 'conflicts_with_request']);
const DECISIONS = ['accepted', 'rejected'];
// After this many refused answers a model that cannot resolve an item goes on;
// the run reports the item as left without a decision.
export const LEDGER_REFUSALS = 3;
const MAX_ITEMS = 60, READ_LIMIT = 5 * 1024 * 1024;

// "file:line" in a piece of evidence; null when it names none.
export function evidenceRef(text) {
  const m = String(text ?? '').match(/(?:^|[\s(`'"])((?:[\w@.-]+\/)*[\w@.-]*[\w-]\.[A-Za-z0-9]+):(\d+)\b/);
  return m ? { file: m[1], line: Number(m[2]) } : null;
}
// Whether the place exists in the project: 'ok', 'missing' (no such file, or
// the file is shorter), or null when there is nothing to check or the file is
// outside the project or too large to read.
export function checkRef(cwd, ref) {
  if (!cwd || !ref?.file || path.isAbsolute(ref.file) || ref.file.split(/[\\/]/).includes('..')) return null;
  let real;
  try { real = fs.realpathSync(path.join(cwd, ref.file)); } catch { return 'missing'; }
  const root = fs.realpathSync(cwd);
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return 'missing';
    if (!ref.line) return 'ok';
    if (stat.size > READ_LIMIT) return null;
    return fs.readFileSync(real, 'utf8').split('\n').length >= ref.line ? 'ok' : 'missing';
  } catch { return null; }
}

const clip = (value, n) => typeof value === 'string' ? value.trim().slice(0, n) : '';
export const ledgerOf = run => run?.ledger ?? [];
const open = run => ledgerOf(run).filter(i => i.status === 'open');
export const blockingItems = run => open(run).filter(i => i.required && i.source === 'brief');

// Adds items from one helper answer. `source`: brief (an objection to the
// brief), review (blocking and major findings) or verify (failed claims).
export function addItems(managed, source, role, list, { required } = {}) {
  const run = managed.run;
  if (!run || !list?.length) return [];
  const added = [];
  for (const raw of list) {
    if (run.ledger.length >= MAX_ITEMS) break;
    const evidence = clip(raw.evidence, 500), ref = raw.file ? { file: raw.file, line: raw.line ?? null } : evidenceRef(evidence), place = checkRef(managed.cwd, ref);
    const must = source === 'brief' ? PREMISE.has(raw.kind) && !!evidence && place !== 'missing' : source === 'review' ? raw.kind === 'blocking' : !!required;
    const item = { id: `o${run.ledger.length + 1}`, source, role, kind: raw.kind, detail: clip(raw.detail, 500), evidence, ...(ref ? { ref } : {}), ...(place ? { place } : {}), required: must, status: 'open' };
    run.ledger.push(item); added.push(item);
  }
  return added;
}
export const itemText = i => `${i.id} [${i.source === 'brief' ? i.kind : i.source === 'review' ? i.kind : 'failed claim'}] ${i.role}: ${i.detail}${i.evidence ? ` (evidence: ${i.evidence}${i.place === 'missing' ? '; the harness found no such place' : ''})` : ''}`;
export const setStatus = (item, status, extra = {}) => Object.assign(item, { status, ...extra });
export function saveLedger(managed) {
  const items = ledgerOf(managed.run);
  if (items.length) try { managed.session.sessionManager.appendCustomEntry(LEDGER_ENTRY, { items, at: new Date().toISOString() }); } catch { /* the report still counts them */ }
}

// resolve_objection: the main agent's decision on one item, kept with what it
// checked. An accepted item names what changed; a rejected one says why.
export function resolveTool(owner) {
  return { name: 'resolve_objection', label: 'Objection',
    description: 'Record your decision on an objection a helper raised (its id, such as o1): a brief objection, a review finding or a failed verify claim. Check it first at the place its evidence names. accepted: you agree; say what you changed (a corrected brief, the plan, the code). rejected: say what you checked (file:line, a command and its result) and why the objection does not hold; a rejected required objection goes back to the helper, and a disagreement that remains goes to the member.',
    parameters: { type: 'object', properties: { id: { type: 'string', maxLength: 10 }, decision: { type: 'string', enum: DECISIONS }, checked: { type: 'string', minLength: 1, maxLength: 300 },
      change: { type: 'string', maxLength: 300 }, reason: { type: 'string', maxLength: 500 } }, required: ['id', 'decision', 'checked'], additionalProperties: false },
    execute: async (_id, args) => {
      const item = ledgerOf(owner.run).find(i => i.id === args?.id);
      if (!item) throw Error(`managed-objection-unknown: no objection ${String(args?.id).slice(0, 10)} in this message; the open ones are ${open(owner.run).map(i => i.id).join(', ') || 'none'}.`);
      if (!['open', 'noted'].includes(item.status)) throw Error(`managed-objection-settled: ${item.id} is already ${item.status}.`);
      if (!DECISIONS.includes(args.decision) || !clip(args.checked, 300)) throw Error('managed-objection-invalid: send decision accepted or rejected, and what you checked.');
      if (args.decision === 'accepted' && !clip(args.change, 300)) throw Error('managed-objection-invalid: an accepted objection names what you changed (the brief, the plan or the code).');
      if (args.decision === 'rejected' && !clip(args.reason, 500)) throw Error('managed-objection-invalid: a rejected objection says why it does not hold.');
      const resolution = { decision: args.decision, checked: clip(args.checked, 300), ...(args.change ? { change: clip(args.change, 300) } : {}), ...(args.reason ? { reason: clip(args.reason, 500) } : {}) };
      setStatus(item, args.decision, { resolution });
      const back = args.decision === 'rejected' && item.required ? ` The ${item.role} subagent judges your reason before the turn ends.` : '';
      return { content: [{ type: 'text', text: `Recorded: ${item.id} ${args.decision}.${back}` }], details: { id: item.id, decision: args.decision } };
    } };
}

// Before an edit or a command that may change files: an open premise
// objection is resolved first. `answer` names the model answer the call came
// from, so calls sent together count once.
export function ledgerGuard(run, answer) {
  const items = blockingItems(run);
  if (!items.length) return;
  run.ledgerRefusals ??= new Set();
  if (!run.ledgerRefusals.has(answer) && run.ledgerRefusals.size >= LEDGER_REFUSALS) { run.ledgerSkipped = true; return; }
  run.ledgerRefusals.add(answer);
  throw Error(`managed-objection-open: resolve ${items.map(i => i.id).join(', ')} with resolve_objection before changing files.\n${items.map(itemText).join('\n')}`);
}

// The receipt's counts (report version 3): objections to briefs, those the
// main agent decided, the disagreements handed to the member.
export function briefCounts(run) {
  const briefs = ledgerOf(run).filter(i => i.source === 'brief');
  return { objections: briefs.length, answered: briefs.filter(i => ['accepted', 'rejected', 'withdrawn'].includes(i.status)).length };
}

// A required rejection the helper has not judged yet; the harness asks it.
export const toRejudge = run => ledgerOf(run).filter(i => i.source === 'brief' && i.required && i.status === 'rejected' && !i.rejudged);
export function rejudgeBrief(item) {
  return `You objected to the brief the main agent gave you:\n[${item.kind}] ${item.detail}${item.evidence ? `\nYour evidence: ${item.evidence}` : ''}\n\nThe main agent rejected the objection.\nWhat it checked: ${item.resolution.checked}\nIts reason: ${item.resolution.reason}\n\nJudge its reason against the code and the member's words. When the reason holds, end with an empty brief_issues list. When your objection still holds, repeat it in brief_issues with evidence; the member then decides.`;
}

// One step of the completion gate (true: the gate goes round again). A
// rejected premise objection goes back to its helper, which withdraws it or
// keeps it for the member; then the items the main agent never decided are
// put to it once, with no new review.
export async function settleLedger(managed, run, { note, send, signal }) {
  const rejected = toRejudge(run)[0];
  if (rejected) {
    rejected.rejudged = true; let reply;
    await note(`Harness: the ${rejected.role} subagent judges the main agent's reason for rejecting ${rejected.id}.`, { phase: 'rejudge', role: rejected.role, id: rejected.id });
    try { reply = (await managed.delegate({ role: rejected.role, task: rejudgeBrief(rejected) }, signal, { harness: true })).content.map(p => p.text).join('\n'); }
    catch { return true; }
    if (!briefIssues(reply)?.length) { setStatus(rejected, 'withdrawn'); return true; }
    setStatus(rejected, 'disputed'); run.disputes.push({ source: rejected.role, brief: true });
    await note(`Harness: the ${rejected.role} subagent keeps its objection; the member decides.\n${itemText(rejected)}`, { phase: 'dispute', role: rejected.role, id: rejected.id });
    return true;
  }
  const pending = undecided(run);
  if (!pending.length || run.decideAsked) return false;
  run.decideAsked = true;
  await send(decideText(pending), { phase: 'answer', ids: pending.map(i => i.id), issues: pending.slice(0, 10).map(i => ({ kind: i.kind, detail: i.detail })) });
  return true;
}

// What the main agent still has to decide before the turn ends: required
// items, review findings above minor, brief objections it never answered.
export const undecided = run => open(run).filter(i => i.required || i.source !== 'verify');
export function decideText(items) {
  return `Harness: ${items.length} objection(s) have no decision yet:\n${items.map(i => '- ' + itemText(i)).join('\n')}\nCheck each at the place its evidence names, then record your decision with resolve_objection: accepted with what you changed, or rejected with what you checked and why. Minor review findings need nothing; no new review follows.`;
}
// The final status line's words about the ledger.
export function ledgerWords(run) {
  const items = ledgerOf(run), count = s => items.filter(i => i.status === s).length, words = [];
  if (!items.length && !run.minorFindings) return null;
  for (const [status, label] of [['accepted', 'accepted'], ['rejected', 'rejected'], ['withdrawn', 'withdrawn by the helper'], ['cleared', 'cleared by a later check'], ['disputed', 'for the member'], ['open', 'left without a decision'], ['noted', 'noted']])
    if (count(status)) words.push(`${count(status)} ${label}`);
  if (run.minorFindings) words.push(`${run.minorFindings} minor finding(s) listed`);
  return `objections: ${words.join(', ')}`;
}

// A review of this turn's patch replaces the findings of the one before it:
// its blocking and major findings are the items, its minor ones only counted.
// A finding it repeats keeps its item (and the main agent's decision); one it
// no longer reports is cleared, or withdrawn when the agent had rejected it.
const sameFinding = (item, f) => (item.ref?.file ?? null) === (f.file || null) && (item.ref?.line === f.line || item.detail === clip(f.issue, 500));
export function recordFindings(managed, findings) {
  const run = managed.run;
  if (!run || !findings) return;
  // A re-review after a fix read only the files changed since: an item about another file stands.
  const focus = managed.reviewFocus?.files ? new Set(managed.reviewFocus.files) : null;
  const kept = findings.filter(f => f.severity !== 'minor'), live = ledgerOf(run).filter(i => i.source === 'review' && ['open', 'rejected'].includes(i.status)
    && (!focus || i.kind === 'blocking' || !i.ref?.file || focus.has(i.ref.file)));
  for (const item of live) if (!kept.some(f => f.severity === item.kind && sameFinding(item, f))) setStatus(item, item.status === 'open' ? 'cleared' : 'withdrawn');
  addItems(managed, 'review', 'review', kept.filter(f => !live.some(i => i.kind === f.severity && sameFinding(i, f))).map(f => ({ kind: f.severity, detail: f.issue, evidence: f.evidence, file: f.file || null, line: f.line })));
  run.minorFindings = findings.length - kept.length;
}
// The files changed since the last review of this turn's patch, for a
// re-review after a fix; null when that cannot be told.
export async function reviewFocus(managed) {
  const before = managed.reviewFiles, now = before ? await managed.changedFiles?.() : null;
  if (!before || !now) return null;
  const files = [...new Set([...before.keys(), ...now.keys()])].filter(name => before.get(name) !== now.get(name)).sort();
  return files.length ? { files: files.slice(0, 200) } : null;
}
// The main agent's decisions on items of one source, for the helper that judges them again.
export function decisionsText(run, source) {
  const decided = ledgerOf(run).filter(i => i.source === source && i.resolution);
  return decided.length ? `\n\nThe main agent's recorded decisions:\n${decided.map(i => `- ${i.detail}: ${i.resolution.decision}; checked: ${i.resolution.checked}${i.resolution.reason ? `; reason: ${i.resolution.reason}` : ''}${i.resolution.change ? `; changed: ${i.resolution.change}` : ''}`).join('\n')}` : '';
}

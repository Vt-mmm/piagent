import { briefIssues, currentPlan, planText, verifyVerdicts } from './workflow.mjs';
import { addItems, itemText, ledgerOf, setStatus } from './ledger.mjs';
export { resolveTool } from './ledger.mjs';

// A helper may object to the brief it was given, with evidence. It never
// decides and never does other work instead: the main agent decides and
// records its decision in the ledger (ledger.mjs): accepted with what it
// changed, or rejected with what it checked and why. The same helper
// objecting a second time in a run stops the exchange, and the member decides.

// The member's own words for a helper: the current message and, while a
// message only continues earlier work ("tiếp tục", a short follow-up), the
// ones before it, back to one that states a task. Newer words are kept first.
export const FOLLOW_UP_CHARS = 160;
const REQUEST_CHARS = 6000;
export function memberRequest(texts) {
  const words = texts.map(text => String(text ?? '').trim()).filter(Boolean), picked = words.length ? [words.at(-1)] : [];
  for (let i = words.length - 2; i >= 0 && picked.length < 5 && picked[0].length < FOLLOW_UP_CHARS; i -= 1) picked.unshift(words[i]);
  const kept = [];
  let room = REQUEST_CHARS;
  for (const text of picked.reverse()) { if (room <= 0) break; kept.unshift(text.slice(0, room)); room -= text.length; }
  return kept;
}
const userText = message => typeof message.content === 'string' ? message.content : (message.content ?? []).filter(p => p?.type === 'text').map(p => p.text).join('\n');
export const memberMessages = manager => manager.getEntries().filter(e => e.type === 'message' && e.message?.role === 'user').map(e => userText(e.message));

// What a helper reads before its brief: the member's request verbatim and the
// plan, so a brief that drifted from the request can be seen to drift.
export function anchorText(manager, harness) {
  const texts = memberRequest(memberMessages(manager)), plan = planText(currentPlan(manager));
  if (!texts.length) return '';
  const words = texts.length === 1 ? texts[0] : texts.map((text, i) => `${i === texts.length - 1 ? 'Current message' : 'Earlier message'}:\n${text}`).join('\n\n');
  const from = harness ? 'the harness' : 'the main agent';
  return `The member's request, verbatim (${from} wrote the brief below from it):\n<<<\n${words}\n>>>\n${plan ? `\nCurrent plan:\n${plan}\n` : ''}\nBrief from ${from}:\n`;
}

// Before a helper starts: once a helper objected twice in a run the member
// decides, so the main agent cannot send it another brief before then. An
// open premise objection of the role is resolved with resolve_objection
// first; a new brief answers any other objection of the role. A review the
// main agent asks for itself: none under a required review (the harness
// reviews the final patch), else once, and again only after blocking findings.
export function beforeDelegate(run, role, harness, { since = null, review = null, changed = false, asked = false } = {}) {
  if (!run || harness) return;
  if (run.disputes.some(d => d.source === role && d.brief)) throw Error(`managed-helper-disputed: the ${role} subagent objected to your briefs twice for this message, so the member decides. Tell them what it objects to and what you decided; do not delegate to it again before their next message.`);
  const mine = ledgerOf(run).filter(i => i.source === 'brief' && i.role === role && i.status === 'open');
  const blocked = mine.filter(i => i.required);
  if (blocked.length) throw Error(`managed-objection-open: the ${role} subagent objected to your brief; record your decision with resolve_objection before you brief it again.\n${blocked.map(itemText).join('\n')}`);
  // Reviewers the member asked for (copies.mjs) run at their word.
  if (role === 'review' && !since && changed && !asked) {
    if (run.policy.review === 'require') throw Error('managed-review-by-harness: the harness reviews the final patch when you finish; do not ask for a review yourself. Finish the change and its checks.');
    if (run.mainReviews > 0 && !(review?.stale && review.blocking > 0)) throw Error('managed-review-once: this change was reviewed already. Fix its blocking findings and ask again only then; fix major findings or reject them with resolve_objection; minor findings need nothing.');
  }
  if (role === 'review' && !since) run.mainReviews = (run.mainReviews ?? 0) + 1;
  for (const item of mine) setStatus(item, 'accepted', { resolution: { decision: 'accepted', checked: 'sent the role a new brief', change: 'a new brief' } });
}

// After a helper answered: an objection to the main agent's brief goes into
// the ledger, is shown to the member and handed to the main agent with the
// answer. Returns the note the main agent reads under the helper's answer
// ('' when there is none). The harness's own briefs (its review, its
// re-check) are fixed text: an objection to one only restates the member's
// request, so it is not relayed.
export async function relayObjection(managed, role, reply, harness) {
  const run = managed.run, issues = harness ? null : briefIssues(reply);
  if (!run || !issues?.length) return '';
  const second = ledgerOf(run).some(i => i.source === 'brief' && i.role === role), items = addItems(managed, 'brief', role, issues), list = items.map(itemText).join('\n');
  if (second) { run.disputes.push({ source: role, brief: true }); for (const item of items) setStatus(item, 'disputed'); }
  await managed.session.sendCustomMessage({ customType: 'agent-watch-process', display: true,
    content: second ? `Harness: the ${role} subagent objected to a brief a second time for this message; the exchange stops and the member decides.\n${list}`
      : `Harness: the ${role} subagent objected to the brief the main agent gave it:\n${list}`,
    details: { phase: second ? 'dispute' : 'objection', role, by: 'main', issues: issues.map(({ kind, detail }) => ({ kind, detail })), ids: items.map(i => i.id) } }, { triggerTurn: false });
  if (second) return `\n\n[Harness] The ${role} subagent objected to your brief again. This is its second objection for this message, so the harness ends the exchange: do not delegate to it again before the member's next message. Tell the member plainly what it objects to and what you decided, and let them decide.`;
  const blocking = items.filter(i => i.required);
  return `\n\n[Harness] The ${role} subagent objected to your brief:\n${list}\nCheck each at the place its evidence names, then record your decision with resolve_objection (accepted with what you changed, or rejected with what you checked and why).${blocking.length ? ` Until you do, file changes are refused: ${blocking.map(i => i.id).join(', ')} say${blocking.length === 1 ? 's' : ''} the brief rests on a wrong premise or conflicts with the request.` : ''} A rejected objection goes back to the helper; a second objection from it for this message goes to the member.`;
}

// Verify's verdicts, counted for the receipt; its failed claims go into the
// ledger (required under a required verify, noted otherwise). Under a
// required verify the failed claims are the run's to settle; once the agent
// has been sent back with them, only the harness's own re-check replaces
// them, and a claim it no longer fails is cleared.
export function recordVerdicts(managed, reply, harness, details) {
  const run = managed.run, found = verifyVerdicts(reply);
  details.verdicts = found ? Object.fromEntries(['pass', 'fail', 'unverifiable'].map(s => [s, found.filter(v => v.status === s).length])) : null;
  if (run && found && (harness || !run.claimsAsked)) {
    run.verifyFails = found.filter(v => v.status === 'fail');
    const failed = new Set(run.verifyFails.map(v => v.claim)), required = run.policy.verify === 'require';
    for (const item of ledgerOf(run)) if (item.source === 'verify' && ['open', 'rejected', 'noted'].includes(item.status) && !failed.has(item.detail)) setStatus(item, 'cleared');
    const known = new Set(ledgerOf(run).filter(i => i.source === 'verify' && i.status !== 'cleared').map(i => i.detail));
    const added = addItems(managed, 'verify', 'verify', run.verifyFails.filter(v => !known.has(v.claim)).map(v => ({ kind: 'fail', detail: v.claim, evidence: v.evidence })), { required });
    if (!required) for (const item of added) setStatus(item, 'noted');
  }
  return found ? ' · ' + Object.entries(details.verdicts).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') : '';
}

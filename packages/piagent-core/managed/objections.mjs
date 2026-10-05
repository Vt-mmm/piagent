import { briefIssues, currentPlan, planText, verifyVerdicts } from './workflow.mjs';

// A helper may object to the brief it was given, with evidence. It never
// decides and never does other work instead: the main agent decides and has
// to answer the objection (a corrected brief, another approach, or why the
// objection does not hold). The same helper objecting a second time in a run
// stops the exchange, and the member decides.

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
// decides, so the main agent cannot send it another brief before then. A
// new brief to a helper that objected answers that objection.
export function beforeDelegate(run, role, harness) {
  if (!run || harness) return;
  if (run.disputes.some(d => d.source === role && d.brief)) throw Error(`managed-helper-disputed: the ${role} subagent objected to your briefs twice for this message, so the member decides. Tell them what it objects to and what you decided; do not delegate to it again before their next message.`);
  for (const objection of run.objections) if (objection.role === role) objection.answered = true;
}

const issueText = (issue, i) => `${i + 1}. [${issue.kind}] ${issue.detail}${issue.evidence ? ` (evidence: ${issue.evidence})` : ''}`;
// After a helper answered: an objection to the main agent's brief is
// recorded, shown to the member and handed to the main agent with the answer.
// Returns the note the main agent reads under the helper's answer ('' when
// there is none). The harness's own briefs (its review, its re-check) are
// fixed text: an objection to one only restates the member's request, so
// it is not relayed.
export async function relayObjection(managed, role, reply, harness) {
  const run = managed.run, issues = harness ? null : briefIssues(reply);
  if (!run || !issues?.length) return '';
  const second = run.objections.some(o => o.role === role), list = issues.map(issueText).join('\n');
  run.objections.push({ role, issues, answered: false, disputed: second });
  if (second) run.disputes.push({ source: role, brief: true });
  await managed.session.sendCustomMessage({ customType: 'agent-watch-process', display: true,
    content: second ? `Harness: the ${role} subagent objected to a brief a second time for this message; the exchange stops and the member decides.\n${list}`
      : `Harness: the ${role} subagent objected to the brief the main agent gave it:\n${list}`,
    details: { phase: second ? 'dispute' : 'objection', role, by: 'main', issues: issues.map(({ kind, detail }) => ({ kind, detail })) } }, { triggerTurn: false });
  return second ? `\n\n[Harness] The ${role} subagent objected to your brief again. This is its second objection for this message, so the harness ends the exchange: do not delegate to it again before the member's next message. Tell the member plainly what it objects to and what you decided, and let them decide.`
    : `\n\n[Harness] The ${role} subagent objected to your brief (see brief_issues above). You decide, but answer the objection before you act on this answer: send it a corrected brief, change your approach, or tell the member why the objection does not hold. A second objection from it for this message goes to the member.`;
}

// Verify's verdicts, counted for the receipt. Under a required verify the
// failed claims are the run's to settle; once the agent has been sent back
// with them, only the harness's own re-check replaces them.
export function recordVerdicts(run, reply, harness, details) {
  const found = verifyVerdicts(reply);
  details.verdicts = found ? Object.fromEntries(['pass', 'fail', 'unverifiable'].map(s => [s, found.filter(v => v.status === s).length])) : null;
  if (run && found && (harness || !run.claimsAsked)) run.verifyFails = found.filter(v => v.status === 'fail');
  return found ? ' · ' + Object.entries(details.verdicts).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') : '';
}

// Every opinion comes with a recommendation and where it comes from (owner,
// 2026-11-14). A helper that reads (explore, scout) or advises (advisor)
// ends its answer with its recommendation as option 1 and the evidence for
// each point: file:line, a source URL, or a command and what it printed. The
// harness reads it back, checks each file:line exists in the project, and
// tells the main agent (and the member, on the receipt) when the answer has
// no recommendation, no evidence, or names places that do not exist: such an
// answer is unverified, and the main agent checks it before acting on it.
import { checkRef, evidenceRef } from './ledger.mjs';

export const OPINION_ROLES = new Set(['scout', 'research', 'advisor']);
export const OPINION_JSON = '"recommendation":"your recommendation in one line (option 1)","options":[{"label":"option 1 = the recommendation, then the alternatives","why":"why, in one line","evidence":["file:line — what it shows","https://… — what the source says","`command` → what it printed"]}],"evidence":["the facts your answer rests on, in the same form"]';
export const OPINION_RULE = 'Research before you answer: every point rests on something you read or ran. Put your recommendation first, as option 1, with its evidence; then the alternatives you weighed. Evidence is a file:line in the project, a source URL, or a command you ran and what it printed; say plainly what you could not check.';

const jsonOf = reply => {
  const blocks = [...String(reply ?? '').matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const raw of blocks.reverse()) { try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* next */ } }
  return null;
};
const strings = list => (Array.isArray(list) ? list : []).filter(s => typeof s === 'string' && s.trim()).map(s => s.trim().slice(0, 300)).slice(0, 12);

// The opinion in a helper's answer: { recommendation, options, evidence,
// checked: [{ text, place }], issues: [...] }. `cwd` is the project to check
// file:line against.
export function readOpinion(role, reply, cwd) {
  const value = jsonOf(reply) ?? {}, issues = [];
  const recommendation = typeof value.recommendation === 'string' ? value.recommendation.trim().slice(0, 300) : '';
  const options = (Array.isArray(value.options) ? value.options : []).filter(o => typeof o?.label === 'string' && o.label.trim()).slice(0, 4)
    .map(o => ({ label: o.label.trim().slice(0, 120), why: typeof o.why === 'string' ? o.why.trim().slice(0, 300) : '', evidence: strings(o.evidence) }));
  // Without evidence in the JSON, the file:line places and URLs its prose names count.
  const prose = String(reply ?? '').replace(/```[\s\S]*?```/g, ' '), named = [...prose.matchAll(/(?:^|[\s(`'"])((?:[\w@.-]+\/)*[\w@.-]*[\w-]\.[A-Za-z0-9]+:\d+|https?:\/\/[^\s)`'"]+)/g)].map(m => m[1]);
  const evidence = strings(value.evidence).length ? strings(value.evidence) : strings(named), all = [...evidence, ...options.flatMap(o => o.evidence)];
  const checked = all.map(text => ({ text, place: checkRef(cwd, evidenceRef(text)) ?? (/https?:\/\//.test(text) ? 'url' : /`[^`]+`|→|->/.test(text) ? 'command' : 'unchecked') }));
  if (role === 'advisor' && !recommendation && !options.length) issues.push('no recommendation');
  if (role === 'advisor' && options.length && !options[0].evidence.length) issues.push('option 1 has no evidence');
  if (!all.length) issues.push('no evidence');
  const missing = checked.filter(c => c.place === 'missing');
  if (missing.length) issues.push(`${missing.length} file:line not found in the project (${missing.slice(0, 3).map(c => evidenceRef(c.text)?.file + ':' + evidenceRef(c.text)?.line).join(', ')})`);
  return { recommendation: recommendation || options[0]?.label || '', options, evidence, checked, issues };
}

// What the main agent reads under the helper's answer.
export function opinionNote(label, opinion) {
  if (!opinion.issues.length) return '';
  return `\n\n[Harness] The ${label} helper's answer is unverified: ${opinion.issues.join('; ')}. Do not act on its points as facts: check them yourself (read the file:line, run the command) or ask it again with the evidence you need. When you report to the member, give your recommendation first with the evidence you checked.`;
}

// The receipt's words for the member: the recommendation and how much of its evidence held.
export function opinionWords(opinion) {
  if (!opinion) return '';
  const held = opinion.checked.filter(c => c.place === 'ok').length, missing = opinion.checked.filter(c => c.place === 'missing').length;
  const head = opinion.recommendation ? ` · khuyến nghị: ${opinion.recommendation.slice(0, 120)}` : '';
  const ev = opinion.checked.length ? ` · evidence ${opinion.checked.length}${held ? ` (${held} file:line có thật${missing ? `, ${missing} không thấy` : ''})` : missing ? ` (${missing} không thấy)` : ''}` : ' · không có evidence';
  return head + ev;
}

// The main agent's own rule, in every mode and Harness (command-tools.mjs servicesPrompt).
export const MAIN_OPINION_PROMPT = ' Whenever you give the member a recommendation or a choice (in ask_user, a report, a conflict between helpers), research first, put your recommendation first as option 1, and say what it rests on: file:line, a source URL, or a command and what it printed. A helper\'s point the harness marks unverified is not a fact until you checked it.';

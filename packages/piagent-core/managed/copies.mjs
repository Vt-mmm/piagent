import { memberMessages, memberRequest } from './objections.mjs';

// Several helpers of one role, at the member's request only ("use 3
// reviewers", "cho 3 scout"): one delegate call runs 2 to MAX_COPIES helper
// sessions of the role side by side, each with its own context, and their
// answers merge into one. The main agent never adds helpers on its own, and
// the harness never does: the call quotes the member's words that ask for
// them, and those words must be the member's own and name the number. The
// copies share the role's grant, so Studio counts the role once while each
// copy counts against the role's calls for the message.
export const MAX_COPIES = 3;
const COUNTS = { two: 2, three: 3, hai: 2, ba: 3 };
// Words that say the number is of helpers, not of files or steps.
const HELPER_WORDS = /agent|helper|review|scout|research|verif|nghiên cứu|kiểm|xác minh|trinh sát/;
const normal = text => String(text ?? '').toLowerCase().normalize('NFC').replace(/\s+/g, ' ').trim();
// The largest helper count the words name (a digit, or two/three in English or Vietnamese).
export function namedCount(words) {
  const found = [...normal(words).matchAll(/(?<![\p{L}\d])(\d+|two|three|hai|ba)(?![\p{L}\d])/gu)].map(m => COUNTS[m[1]] ?? Number(m[1]));
  return found.length ? Math.max(...found) : 0;
}
// The copies a delegate call asks for, checked against the member's words;
// null for a plain call. `split`: one line per copy naming its share of the work.
export function fanOut(manager, role, args, harness) {
  const split = Array.isArray(args?.split) ? args.split.map(s => typeof s === 'string' ? s.trim().slice(0, 500) : '').filter(Boolean) : [];
  const n = split.length || (Number.isInteger(args?.copies) ? args.copies : 1);
  if (n <= 1 && !args?.member_words) return null;
  if (harness) throw Error('managed-copies-invalid: the harness runs one helper per call.');
  if (n < 2 || n > MAX_COPIES) throw Error(`managed-copies-invalid: ask for 2 to ${MAX_COPIES} ${role} helpers (copies, or one split line per helper).`);
  const words = normal(args?.member_words);
  if (words.length < 3 || !memberRequest(memberMessages(manager)).some(text => normal(text).includes(words)) || namedCount(words) < n || !HELPER_WORDS.test(words))
    throw Error(`managed-copies-not-asked: more than one ${role} helper runs only when the member asks for it. Quote in member_words the member's own words that ask for ${n} (verbatim, with the number); otherwise use one helper.`);
  return { n, split: split.length ? split : null };
}
// What one copy reads under its brief.
export function copyNote(role, i, fan) {
  return `\n\nThe member asked for ${fan.n} ${role} helpers; you are ${role} helper ${i + 1} of ${fan.n}. ${fan.split ? `Your share of the work: ${fan.split[i]}. The others cover the rest.` : 'The others have the same brief: answer on your own judgement.'}`;
}

const jsonOf = reply => {
  for (const raw of [...String(reply).matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]).reverse()) { try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* next */ } }
  return null;
};
const unique = (list, key) => { const seen = new Set(); return list.filter(x => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
const SEVERITY = { blocking: 0, major: 1, minor: 2 };
// One answer from the copies: each helper's prose (its JSON left out), then
// one JSON block joining their findings, verdicts and objections, so the
// review, verify and objection readers see every copy. `parsed`: every copy
// gave its JSON. A finding or a failed claim any copy reports stands.
export function mergeCopies(role, label, answers, { findingsOf, issuesOf, verdictsOf }) {
  const n = answers.length, room = Math.floor(12000 / n);
  const findings = role === 'review' ? unique(answers.flatMap(a => findingsOf(a.reply) ?? []), f => `${f.severity}|${f.file}|${f.line}|${f.issue}`).sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]) : null;
  const verdicts = role === 'verify' ? unique(answers.flatMap(a => verdictsOf(a.reply) ?? []), v => `${v.status}|${v.claim}`) : null;
  const issues = unique(answers.flatMap(a => issuesOf(a.reply) ?? []), i => `${i.kind}|${i.detail}`).slice(0, 5);
  const parsed = answers.every(a => jsonOf(a.reply));
  const summaries = answers.map(a => jsonOf(a.reply)?.summary).filter(s => typeof s === 'string').map(s => s.slice(0, 200));
  const json = { ...(findings ? { findings: findings.slice(0, 40) } : {}), ...(verdicts ? { verdicts: verdicts.slice(0, 40) } : {}), brief_issues: issues,
    summary: `${n} ${role} helpers${summaries.length ? ': ' + summaries.join(' | ') : ''}`.slice(0, 900) };
  const body = answers.map((a, i) => `### ${label} helper ${i + 1} of ${n}\n${String(a.reply).replace(/```json\s*[\s\S]*?```/g, '').trim().slice(0, room)}`).join('\n\n');
  return { reply: `${body}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``, usage: answers.reduce((total, a) => total + a.usage, 0),
    ...(findings ? { findings, parsed, blocking: findings.filter(f => f.severity === 'blocking').length } : {}) };
}

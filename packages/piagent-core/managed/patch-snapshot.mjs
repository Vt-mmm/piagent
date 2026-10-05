import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const textContent = result => result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
const WORKER = fileURLToPath(new URL('./review-snapshot-worker.mjs', import.meta.url));
const MAX_SNAPSHOT = 16 * 1024 * 1024;

// The worker runs inside the tool boundary; what it prints is one short line.
async function worker(boundary, mode) {
  const result = await boundary.invoke('bash', { command: `${quote(process.execPath)} ${quote(WORKER)} ${mode}`, timeout: 60 });
  const text = textContent(result).trim();
  if (result.details?.truncation?.truncated || text.includes('\n')) throw Error(/review-(patch|file|untracked)-limit/.exec(text)?.[0] ?? 'managed-review-patch-unreadable');
  const [digest, bytes, name] = text.split(' ');
  if (!/^[a-f0-9]{64}$/.test(digest ?? '') || !(Number(bytes) > 0 && Number(bytes) <= MAX_SNAPSHOT)) throw Error(/review-(patch|file|untracked)-limit/.exec(text)?.[0] ?? 'managed-review-patch-unreadable');
  return { digest, bytes: Number(bytes), name };
}

// The digest of the patch a reviewer would see (diff against HEAD plus
// untracked files): whether a review is still current. Nothing else moves.
export async function readPatchDigest(boundary) { return (await worker(boundary, 'digest')).digest; }

// The patch a reviewer sees, read inside the tool boundary. The worker writes
// it to the boundary's temporary directory and names it, with its digest, on
// its output; the file is read once, must match that digest (a file changed
// meanwhile never passes) and is removed.
export async function readPatchSnapshot(boundary) {
  const { digest, bytes, name } = await worker(boundary, 'file');
  if (!/^review-[0-9a-f-]{36}\.json$/.test(name ?? '')) throw Error('managed-review-patch-unreadable');
  const file = path.join(boundary.temporary, name);
  let data;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size !== bytes) throw Error('managed-review-patch-changed');
      data = Buffer.alloc(bytes);
      for (let at = 0; at < bytes;) { const n = fs.readSync(fd, data, at, bytes - at, at); if (!n) throw Error('managed-review-patch-changed'); at += n; }
    } finally { fs.closeSync(fd); }
  } finally { fs.rmSync(file, { force: true }); }
  if (createHash('sha256').update(data).digest('hex') !== digest) throw Error('managed-review-patch-changed');
  return { patch: data.toString('utf8'), digest };
}

// Why a required review could not run, in one word for the member.
export function reviewUnavailableReason(message) {
  const text = String(message ?? '');
  if (/review-(patch|file|untracked)-limit|managed-review-patch-too-large/.test(text)) return 'too_large';
  if (/not a git repository|Could not access 'HEAD'|managed-review-patch-unreadable/i.test(text)) return 'not_git';
  if (/managed-helper-limit|helper_run_limit_reached/.test(text)) return 'limit';
  return 'failed';
}

// The patch as a reviewer reads it: the diff, then each new file in full.
export function reviewText(snapshot) {
  let value;
  try { value = JSON.parse(snapshot.patch); } catch { return `Patch snapshot ${snapshot.digest}:\n${snapshot.patch}`; }
  const files = (value.untracked ?? []).map(f => f.mode === 'symlink' ? `=== new symlink ${f.path} -> ${f.target}`
    : f.mode === 'directory' ? `=== new folder ${f.path} (a repository of its own, not reviewed)`
    : f.encoding === 'omitted' ? `=== new file ${f.path} (${f.bytes} bytes, too large to review)`
    : f.encoding === 'utf8' ? `=== new file ${f.path}\n${f.contents}` : `=== new binary file ${f.path} (${Math.round(f.contents.length * 0.75)} bytes)`);
  return `Patch snapshot ${snapshot.digest}:\n--- diff against HEAD ---\n${value.patch || '(no changes to tracked files)'}\n${files.length ? `--- new files ---\n${files.join('\n\n')}` : ''}`;
}

// A patch larger than one reviewer reads at once (REVIEW_PART_BYTES, about
// 30k tokens with room to read the code around it) is reviewed in parts of
// whole files under the review helper's grant, and the findings are merged.
// The parts run one after another (REVIEW_PARALLEL): Studio admits one
// request of a run role at a time, so parts side by side only wait in its
// line (measured 2026-10-05: 4 parts, each started as the previous ended). One file's diff larger than READ_SECTION is not
// read (a lockfile, generated output): every part and the merged answer name
// it. More than REVIEW_PARTS_MAX parts: the review cannot run (too_large).
export const REVIEW_PART_BYTES = 120_000, REVIEW_PARALLEL = 1, REVIEW_PARTS_MAX = 96;
const READ_SECTION = 400_000;
const SEVERITY = { blocking: 0, major: 1, minor: 2 };

export function reviewParts(snapshot, size = REVIEW_PART_BYTES) {
  const whole = reviewText(snapshot);
  let value;
  try { value = JSON.parse(snapshot.patch); } catch { value = null; }
  const omitted = (value?.untracked ?? []).filter(f => f.encoding === 'omitted').map(f => ({ path: f.path, bytes: f.bytes, ...(f.mode === 'directory' ? { repository: true } : {}) }));
  if (!value || Buffer.byteLength(whole) <= size && !omitted.length) return { parts: [{ files: null, text: whole }], omitted: [] };
  const sections = [];
  for (const text of String(value.patch ?? '').split(/(?=^diff --git )/m).filter(Boolean)) {
    const file = /^diff --git (?:"?a\/(.+?)"? )"?b\/(.+?)"?$/m.exec(text)?.[2] ?? text.slice(0, 200).split('\n')[0];
    sections.push({ file, kind: 'diff', text, bytes: Buffer.byteLength(text) });
  }
  for (const f of value.untracked ?? []) {
    if (f.encoding === 'omitted') continue;
    const text = f.mode === 'symlink' ? `=== new symlink ${f.path} -> ${f.target}` : f.encoding === 'utf8' ? `=== new file ${f.path}\n${f.contents}` : `=== new binary file ${f.path} (${Math.round(f.contents.length * 0.75)} bytes)`;
    sections.push({ file: f.path, kind: 'new', text, bytes: Buffer.byteLength(text) });
  }
  const groups = [];
  for (const section of sections) {
    if (section.bytes > READ_SECTION) { omitted.push({ path: section.file, bytes: section.bytes }); continue; }
    const last = groups.at(-1);
    if (last && last.bytes + section.bytes <= size) { last.sections.push(section); last.bytes += section.bytes; }
    else groups.push({ sections: [section], bytes: section.bytes });
  }
  if (groups.length > REVIEW_PARTS_MAX) throw Error('managed-review-patch-too-large');
  const skipped = omitted.length ? `\nNot read: ${omitted.map(o => o.repository ? `${o.path} (a repository of its own)` : `${o.path} (${o.bytes} bytes, too large to review)`).join(', ')}.` : '';
  const parts = groups.map((group, i) => {
    const files = group.sections.map(s => s.file), diff = group.sections.filter(s => s.kind === 'diff').map(s => s.text).join(''), news = group.sections.filter(s => s.kind === 'new').map(s => s.text);
    const head = groups.length === 1 ? `Patch snapshot ${snapshot.digest}.` : `Patch snapshot ${snapshot.digest}, part ${i + 1} of ${groups.length}. This part's files: ${files.join(', ')}. The other parts are reviewed separately: judge this part, and read other files only for context.`;
    return { files, text: `${head}${skipped}\n--- diff against HEAD ---\n${diff || '(no changes to tracked files in this part)'}\n${news.length ? `--- new files ---\n${news.join('\n\n')}` : ''}` };
  });
  return { parts: parts.length ? parts : [{ files: [], text: `Patch snapshot ${snapshot.digest}: every changed file is too large to review.${skipped}` }], omitted };
}

// One answer from the review of every part: each part's summary, then the
// findings of all parts (most severe first) and their objections to the brief
// in one JSON block. `parsed`: every part gave its JSON.
export function mergeReviews(review, answers, { findingsOf, issuesOf }) {
  const n = answers.length, all = [], issues = [], lines = [];
  let parsed = true;
  answers.forEach((answer, i) => {
    const findings = findingsOf(answer.reply);
    if (!findings) parsed = false;
    all.push(...(findings ?? []));
    issues.push(...(issuesOf(answer.reply) ?? []));
    let summary = null;
    for (const raw of [...String(answer.reply).matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]).reverse()) { try { summary = JSON.parse(raw)?.summary ?? null; if (summary) break; } catch { /* not this block */ } }
    const files = review.parts[i].files ?? [];
    lines.push(`Part ${i + 1}/${n} (${files.length} file${files.length === 1 ? '' : 's'}: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ', …' : ''}): ${findings ? `${findings.length} finding(s). ${typeof summary === 'string' ? summary.slice(0, 300) : ''}` : `no JSON findings; its answer began: ${String(answer.reply).slice(0, 400)}`}`);
  });
  all.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
  const count = severity => all.filter(f => f.severity === severity).length;
  const summary = `${n} parts reviewed: ${count('blocking')} blocking, ${count('major')} major, ${count('minor')} minor${parsed ? '' : '; a part gave no JSON findings'}${review.omitted.length ? `; ${review.omitted.length} file(s) too large to review` : ''}.`;
  const json = JSON.stringify({ findings: all.slice(0, 40), brief_issues: issues.slice(0, 5), summary });
  const head = `Review of the patch in ${n} parts.${review.omitted.length ? ` Not read, too large: ${review.omitted.map(o => o.path).join(', ')}.` : ''}\n`;
  const body = lines.join('\n').slice(0, Math.max(0, 16000 - json.length - head.length - 20));
  return { reply: `${head}${body}\n\`\`\`json\n${json}\n\`\`\``, usage: answers.reduce((total, a) => total + a.usage, 0), findings: all, parsed, blocking: count('blocking') };
}

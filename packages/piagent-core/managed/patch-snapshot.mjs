import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const textContent = result => result.content?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';

// The patch a reviewer sees (diff against HEAD plus untracked files), read
// inside the tool boundary. It comes in parts: the shell tool truncates its
// output well below the 120 KB a review may cover. Every part names the
// snapshot's digest, so parts of a patch that changed meanwhile never mix.
export async function readPatchSnapshot(boundary) {
  const worker = fileURLToPath(new URL('./review-snapshot-worker.mjs', import.meta.url));
  const read = async part => {
    const result = await boundary.invoke('bash', { command: `${quote(process.execPath)} ${quote(worker)} ${part}`, timeout: 20 });
    if (result.details?.truncation?.truncated) throw Error('managed-review-patch-too-large');
    const text = textContent(result).trim(), newline = text.indexOf('\n');
    const [digest, parts] = (newline < 0 ? text : text.slice(0, newline)).split(' ');
    if (!/^[a-f0-9]{64}$/.test(digest ?? '') || !(Number(parts) >= 1 && Number(parts) <= 8)) throw Error('managed-review-patch-unreadable');
    return { digest, parts: Number(parts), bytes: Buffer.from(newline < 0 ? '' : text.slice(newline + 1), 'base64') };
  };
  const first = await read(0), chunks = [first.bytes];
  for (let part = 1; part < first.parts; part += 1) {
    const next = await read(part);
    if (next.digest !== first.digest) throw Error('managed-review-patch-changed');
    chunks.push(next.bytes);
  }
  const patch = Buffer.concat(chunks).toString('utf8');
  if (createHash('sha256').update(patch).digest('hex') !== first.digest) throw Error('managed-review-patch-changed');
  return { patch, digest: first.digest };
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
    : f.encoding === 'utf8' ? `=== new file ${f.path}\n${f.contents}` : `=== new binary file ${f.path} (${Math.round(f.contents.length * 0.75)} bytes)`);
  return `Patch snapshot ${snapshot.digest}:\n--- diff against HEAD ---\n${value.patch || '(no changes to tracked files)'}\n${files.length ? `--- new files ---\n${files.join('\n\n')}` : ''}`;
}

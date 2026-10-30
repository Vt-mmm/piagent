import { fileURLToPath } from 'node:url';

const worker = fileURLToPath(new URL('./review-snapshot-worker.mjs', import.meta.url));
// The session's own copy of the worker (runtime-snapshot.mjs).
const workerOf = boundary => boundary.runtimeFile?.('review-snapshot-worker.mjs') ?? worker;
const requests = new WeakSet();
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";

// Only fixed runtime snapshot reads preserve provenance. JSON tool arguments
// cannot forge this identity; freezing prevents substitution before dispatch.
export function invokeReviewSnapshot(boundary, mode, extra = []) {
  if (!['head', 'heads', 'since', 'branch-base', 'digest', 'file', 'files'].includes(mode)
    || !Array.isArray(extra) || extra.some(value => typeof value !== 'string')) throw Error('review-request-invalid');
  const args = Object.freeze({ command: [process.execPath, workerOf(boundary), mode, ...extra].map(quote).join(' '), timeout: 60 });
  requests.add(args);
  return boundary.invoke('bash', args);
}

export function consumeReviewSnapshot(args) {
  const trusted = requests.has(args);
  requests.delete(args);
  return trusted;
}

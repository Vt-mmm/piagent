import { randomUUID } from 'node:crypto';
import { freshnessPath } from './tool-freshness.mjs';

// Trusted sandbox metadata only. No project filesystem access in the parent.
// Every consumer must revalidate policy and digests inside the boundary.
export class SessionMutationObservations {
  #sessionId = randomUUID();
  #files = new Map();
  get(file) { return structuredClone(this.#files.get(file) ?? null); }
  snapshot() { return structuredClone([...this.#files.entries()]); }
  clear() { this.#files.clear(); }
  prepare(cwd, name, args, enabled) {
    const file = freshnessPath(cwd, name, args);
    const request = enabled ? { sessionId: this.#sessionId, toolCallId: randomUUID(), prior: this.get(file) } : undefined;
    if (['edit', 'write'].includes(name)) this.#files.delete(file);
    if (name === 'bash') this.clear();
    if (name === 'workspace' && args?.kind === 'write') this.#files.delete(args.payload?.path);
    return request;
  }
  acceptRevert(args, trusted, result, update) {
    if (args?.kind !== 'source' || args.request?.kind !== 'execute') return;
    const file = args.request.target?.path, prior = this.#files.get(file);
    this.#files.delete(file);
    const next = update?.observation;
    if (!trusted || result?.state !== 'settled' || update?.path !== file || !prior || !next || next.path !== file
      || next.toolCallId !== prior.toolCallId || JSON.stringify(next.baseline) !== JSON.stringify(prior.baseline)
      || !/^[a-f0-9]{64}$/.test(next.currentDigest) || !/^session-mutation\.[a-f0-9]{64}$/.test(next.evidenceRef)) return;
    this.#files.set(file, structuredClone(next));
  }
  accept(cwd, name, args, request, observation) {
    const file = freshnessPath(cwd, name, args);
    if (!request || !file || observation?.path !== file || observation.toolCallId !== request.toolCallId
      || typeof observation.baseline?.content !== 'string' || Buffer.byteLength(observation.baseline.content) > 256 * 1024) return;
    this.#files.set(file, observation);
    while (this.#files.size > 32) this.#files.delete(this.#files.keys().next().value);
  }
}

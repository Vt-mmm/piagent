import { createHash, randomBytes } from 'node:crypto';

// Authorization lives outside JSON arguments. Model tools cannot manufacture
// the object identity needed to obtain the boundary's key or observations.
export class SourceRevertRequests {
  #key = randomBytes(32).toString('hex');
  #requests = new WeakMap();
  get revision() { return `source-control.${createHash("sha256").update(this.#key).digest("hex")}`; }
  request(request, binding) {
    const args = { kind: 'source', request: structuredClone(request) };
    this.#requests.set(args, binding);
    return args;
  }
  consume(args, observations) {
    if (args?.kind !== 'source') return undefined;
    const binding = this.#requests.get(args); this.#requests.delete(args);
    if (!binding || !binding.current() || !binding.idle()) throw new Error('source-session-unavailable');
    return { identity: structuredClone(binding.identity), rawSessionId: binding.rawSessionId,
      controlRevision: binding.controlRevision, confirmationKey: this.#key, observations: observations.snapshot() };
  }
}

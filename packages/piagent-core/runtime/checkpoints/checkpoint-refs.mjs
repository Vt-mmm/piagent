// Trees referenced only by a private index are unreachable after it is removed.
// Separate before/after refs keep their blobs alive through GC without commits,
// branches, reflog entries, or changes to HEAD and the member's index.
export class CheckpointRefs {
  constructor(execute, sessionKey) {
    if (!/^[a-f0-9]{64}$/.test(sessionKey)) throw Error('checkpoint-session-invalid');
    this.execute = execute;
    this.prefix = `refs/piagent/checkpoints/${sessionKey}/`;
  }
  #entries(point) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(point.id)) throw Error('checkpoint-state-invalid');
    return ['before', 'after'].flatMap(side => {
      const tree = point[side];
      if (side === 'after' && tree === null) return [];
      if (typeof tree !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw Error('checkpoint-state-invalid');
      return [[`${this.prefix}${point.id}/${side}`, tree]];
    });
  }
  async #transaction(lines) {
    const bytes = Buffer.from(['start', ...lines, 'prepare', 'commit', ''].join('\n'));
    if (typeof this.execute !== 'function') return await this.execute.run(['update-ref', '--stdin'], bytes);
    await this.execute(`printf %s ${bytes.toString('base64')} | base64 --decode | git update-ref --stdin`);
  }
  async #current(point) {
    const entries = this.#entries(point), prefix = `${this.prefix}${point.id}/`;
    const output = typeof this.execute === 'function'
      ? await this.execute(`git for-each-ref --format='%(refname) %(objectname)' ${prefix}`)
      : await this.execute.run(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
    const current = new Map();
    for (const line of output.trim().split('\n').filter(Boolean)) {
      const [ref, tree, extra] = line.split(' ');
      if (extra || !entries.some(([name, oid]) => name === ref && oid === tree) || current.has(ref))
        throw Error('checkpoint-ref-changed');
      current.set(ref, tree);
    }
    return { entries, current };
  }
  async pin(point) {
    const { entries, current } = await this.#current(point);
    // Ref creation and existing-value verification are atomic, so a race cannot
    // replace a ref belonging to another retained checkpoint.
    await this.#transaction(entries.map(([ref, tree]) => `${current.has(ref) ? 'verify' : 'create'} ${ref} ${tree}`));
  }
  async release(point) {
    // A crash after deletion may leave cleanup pending. Missing refs are already
    // released; changed values still refuse, including races before deletion.
    const { entries, current } = await this.#current(point);
    const present = entries.filter(([ref]) => current.has(ref));
    if (present.length) await this.#transaction(present.map(([ref, tree]) => `delete ${ref} ${tree}`));
  }
}

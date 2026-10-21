// Studio protocol 4: a brief or memory_search names what it handed over
// (serve_id); the round that used it sends the ids back with its retain, so
// the member's next words can rate those notes. Kept per repository until
// the round is queued.
export const FEEDBACK_PROTOCOL = 4, MAX_SERVES = 20;

export class RoundServes {
  constructor() { this.byRepo = new Map(); }
  add(repoKey, id) {
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return;
    const list = this.byRepo.get(repoKey) ?? [];
    if (!list.includes(id) && list.length < MAX_SERVES) list.push(id);
    this.byRepo.set(repoKey, list);
  }
  of(repoKey) { return this.byRepo.get(repoKey)?.slice(0, MAX_SERVES) ?? []; }
  clear() { this.byRepo.clear(); }
}

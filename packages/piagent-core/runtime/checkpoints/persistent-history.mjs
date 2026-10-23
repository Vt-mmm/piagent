import { randomUUID } from 'node:crypto';
import { ownerAlive } from '../process-owner.mjs';
// The SDK loader and native Gateway may load separate module instances.
const ownersKey = Symbol.for('piagent.checkpoint.capture-owners');
const owners = globalThis[ownersKey] ??= new Set();
// Publish refs before state; remove retired refs only after state is durable.
// A failed save may leave extra refs, but must never expose unprotected trees.
export class PersistentCheckpointHistory {
  #token = randomUUID();
  #revoked = false;
  revoke() { this.#revoked = true; owners.delete(this.#token); }
  constructor(store, refs) {
    this.store = store; this.refs = refs;
    this.current = store.load();
  }
  operation(action) {
    return this.store.operation(async () => {
      // A closed owner may have changed only capture/cleanup metadata. The
      // service's in-memory turn stack remains valid only when points are equal.
      const latest = this.store.load();
      if (latest.revision !== this.current.revision && JSON.stringify(latest.points) === JSON.stringify(this.current.points)) this.current = latest;
      this.assertCurrent(); await this.#checkCapture(); await this.#drainRetired(); return await action();
    });
  }
  async close() {
    try {
      if (this.store.load().capture?.token !== this.#token) return;
      await this.store.operation(async () => {
        const latest = this.store.load();
        if (latest.capture?.token === this.#token) this.current = this.store.save(latest.points, latest.revision, { capture: null });
      });
    } finally { this.revoke(); }
  }
  load() { return structuredClone(this.current.points); }
  assertCurrent() {
    if (this.#revoked) throw Error('checkpoint-authority-changed');
    if (this.store.load().revision !== this.current.revision) throw Error('checkpoint-state-stale');
  }
  async #checkCapture() {
    const capture = this.current.capture;
    if (!capture || capture.token === this.#token) return;
    if (capture.pid === process.pid) {
      if (owners.has(capture.token)) throw Error('checkpoint-turn-owned');
    } else if (ownerAlive(capture.pid, capture.point.at)) throw Error('checkpoint-turn-owned');
    // An interrupted turn has no trustworthy after snapshot. Keep its edits,
    // retire only its refs, and leave completed history available for drift checks.
    this.current = this.store.save(this.current.points, this.current.revision, { capture: null });
    await this.#drainRetired();
  }
  async #drainRetired() {
    const retired = [...(this.current.retired ?? []), ...(this.current.staged ?? [])];
    if (!retired.length) return;
    for (const point of retired) await this.refs.release(point);
    // A crash before acknowledgement retries exact-value deletion. Ref release
    // accepts already missing refs, so no durable cleanup entry is lost early.
    this.current = this.store.save(this.current.points, this.current.revision, { clearRetired: true });
  }
  async begin(point) {
    await this.prepare();
    if (this.current.capture) throw Error('checkpoint-turn-owned');
    const capture = { point: { ...point, after: null }, pid: process.pid, token: this.#token };
    if (owners.size >= 1024) throw Error('checkpoint-session-capacity');
    owners.add(this.#token);
    try { this.current = this.store.save(this.current.points, this.current.revision, { capture }); }
    catch (error) { owners.delete(this.#token); throw error; }
    await this.refs.pin(capture.point);
  }
  async prepare() { this.assertCurrent(); await this.#checkCapture(); await this.#drainRetired(); this.assertCurrent(); }
  async abandon(point) {
    this.assertCurrent(); await this.#checkCapture();
    if (this.current.capture?.point.id !== point.id) throw Error('checkpoint-capture-mismatch');
    this.current = this.store.save(this.current.points, this.current.revision, { capture: null });
    owners.delete(this.#token);
    await this.#drainRetired();
  }
  async save(points) {
    this.assertCurrent(); await this.#checkCapture();
    // Do not accumulate another batch while an earlier cleanup is blocked.
    await this.#drainRetired();
    const existing = new Set(this.current.points.map(point => point.id));
    const staged = points.filter(point => !existing.has(point.id));
    // Record new refs before creating them. A failed pin/publication or process
    // exit leaves enough data for exact-value cleanup on the next operation.
    if (staged.length) {
      this.current = this.store.save(this.current.points, this.current.revision, { staged, capture: null });
      owners.delete(this.#token);
    }
    for (const point of points) await this.refs.pin(point);
    const saved = this.store.save(points, this.current.revision);
    this.current = saved;
    // Publication is the commit point. Cleanup failure must not leave the
    // caller using an old stack after files and durable history have advanced.
    try { await this.#drainRetired(); } catch { /* Retry before the next publication or turn. */ }
    return structuredClone(saved.points);
  }
}

import type { CheckpointCommand, CheckpointReceipt, CheckpointState } from '../contracts/generated/checkpoint-v1.ts';
import { CHECKPOINT_VERSION, checkpointSha, parseCheckpointCommand, sameCheckpointValue as same } from './checkpoint-command.ts';

export type CheckpointFacts = Omit<CheckpointState, 'schemaVersion' | 'version' | 'messageType'> & { writable: boolean };
export type CheckpointRestoreResult = { result: string; completed: string[]; files: string[]; conflicts?: string[]; stoppedAt?: string | null };
type Options = {
  facts(): Promise<CheckpointFacts> | CheckpointFacts;
  history(): CheckpointReceipt[];
  append(receipt: CheckpointReceipt): void | Promise<void>;
  restore(target: string, expected: { digest: string; revision: string; tree: string }, identity: CheckpointState['identity']): Promise<CheckpointRestoreResult>;
  now?(): Date;
};

export class CheckpointController {
  #options: Options;
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  constructor(options: Options) { this.#options = options; }
  async state(): Promise<CheckpointState> {
    const { writable: _writable, ...facts } = await this.#options.facts();
    return { schemaVersion: 1, version: CHECKPOINT_VERSION, messageType: 'state', ...facts };
  }
  execute(value: unknown): Promise<CheckpointReceipt> {
    const command = parseCheckpointCommand(value);
    if (this.#pending >= 128) return Promise.reject(Error('checkpoint-command-capacity'));
    this.#pending++;
    const run = this.#tail.then(() => this.#execute(command));
    this.#tail = run.catch(() => undefined);
    return run.finally(() => { this.#pending--; });
  }
  #now() { return this.#options.now?.() ?? new Date(); }
  #expired(command: CheckpointCommand) {
    const now = this.#now().getTime(), requested = Date.parse(command.requestedAt), expires = Date.parse(command.expiresAt);
    return expires <= now || requested > now + 5000 || expires <= requested || expires - requested > 120000;
  }
  async #execute(command: CheckpointCommand): Promise<CheckpointReceipt> {
    const facts = await this.#options.facts(), key = checkpointSha(command.idempotencyKey);
    const previous = [...this.#options.history()].reverse().find(receipt => receipt.idempotencyKeyDigest === key);
    const receipt: CheckpointReceipt = { schemaVersion: 1, version: CHECKPOINT_VERSION, messageType: 'receipt', commandId: command.commandId,
      idempotencyKeyDigest: key, action: command.action, actionDigest: command.actionDigest, identity: facts.identity,
      phase: 'rejected', resultCode: 'unavailable', requestedAt: command.requestedAt, settledAt: this.#now().toISOString(),
      observedRevisionsBefore: facts.revisions, observedRevisionsAfter: facts.revisions, deduplicated: false,
      targetId: command.payload.targetId, completed: [], files: [], conflicts: [], stoppedAt: null };
    const reject = (resultCode: CheckpointReceipt['resultCode']): CheckpointReceipt => ({ ...receipt, resultCode });
    if (previous && same(command.identity, previous.identity) && facts.identity.projectRef === command.identity.projectRef
      && facts.identity.sessionRef === command.identity.sessionRef) {
      if (previous.actionDigest !== command.actionDigest) return reject('idempotency-payload-mismatch');
      return { ...previous, deduplicated: true };
    }
    if (!same(command.identity, facts.identity)) return reject('identity-mismatch');
    if (previous) return reject('idempotency-payload-mismatch');
    const refusal = (current: CheckpointFacts): CheckpointReceipt['resultCode'] | null => {
      if (!same(command.identity, current.identity)) return 'identity-mismatch';
      if (this.#expired(command)) return 'expired';
      if (!current.available) return 'unavailable';
      if (!current.writable) return 'read-only';
      if (current.agentRunning) return 'busy';
      if (!same(command.expectedRevisions, current.revisions)) return 'stale-revision';
      return null;
    };
    const denied = refusal(facts);
    if (denied) { const result = reject(denied); await this.#options.append(result); return result; }
    // Publication precedes dispatch. Lost completion remains non-replayable.
    const pending: CheckpointReceipt = { ...receipt, phase: 'uncertain', resultCode: 'effect-unknown' };
    await this.#options.append(pending);
    let settled = pending;
    try {
      const deniedNow = refusal(await this.#options.facts());
      if (deniedNow) settled = reject(deniedNow);
      else {
        const result = await this.#options.restore(command.payload.targetId, {
          digest: command.payload.previewDigest, revision: command.expectedRevisions.checkpointRevision, tree: command.payload.expectedTree,
        }, command.identity);
        const after = await this.#options.facts();
        const code = result.result === 'done' ? 'restored' : result.result === 'refused' ? 'conflict'
          : result.result === 'stale' ? 'stale-revision' : result.result === 'busy' ? 'busy' : result.result === 'read-only' ? 'read-only'
          : ['unavailable', 'failed', 'none'].includes(result.result) ? 'unavailable' : 'effect-unknown';
        settled = { ...receipt, phase: code === 'effect-unknown' ? 'uncertain' : result.completed.length || code === 'restored' ? 'settled' : 'rejected',
          resultCode: code, observedRevisionsAfter: after.revisions, completed: result.completed,
          files: result.files, conflicts: result.conflicts ?? [], stoppedAt: result.stoppedAt ?? null };
      }
    } catch { settled = pending; }
    settled = { ...settled, settledAt: this.#now().toISOString() };
    try { await this.#options.append(settled); } catch { return pending; }
    return settled;
  }
}

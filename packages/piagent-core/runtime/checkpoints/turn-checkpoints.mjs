import { randomUUID } from 'node:crypto';
import { checkpointDigest, previewCheckpointRestore } from './restore-preview.mjs';

// Another owner holds this session's history (a second runtime mid-turn, a
// replaced runtime): the change waits rather than racing it. Any other failure
// only costs the turn its checkpoint.
export const checkpointOwnershipError = error =>
  /checkpoint-(?:turn-owned|store-busy|lock-changed|authority-changed|session-capacity|command-capacity)/.test(String(error?.message ?? error));

// Shared turn history and drift refusal; Git execution is supplied by an adapter.
export class TurnCheckpointService {
  #stack = [];
  #tail = Promise.resolve();
  #pending = 0;
  #gap = false;
  constructor(git, { busy = /** @returns {boolean} */ () => false, history = null,
    memberEdits = /** @param {number} _since @returns {Set<string>} */ _since => new Set() } = {}) {
    this.git = git; this.busy = busy; this.history = history; this.memberEdits = memberEdits;
    this.#stack = history?.load() ?? [];
  }
  /** @template T @param {() => Promise<T>} action @returns {Promise<T>} */
  #serial(action) {
    if (this.#pending >= 128) return Promise.reject(Error('checkpoint-command-capacity'));
    this.#pending++;
    const locked = async () => {
      // Non-Git projects remain side-effect-free, including checkpoint metadata.
      if (!this.history || this.git.available && !await this.git.available()) return await action();
      return await this.history.operation(async () => {
        // A turn that ran without a checkpoint (the store refused it) ends the
        // history it would otherwise sit inside.
        if (this.#gap) { this.#gap = false; await this.#barrier(null); }
        return await action();
      });
    };
    const operation = this.#tail.then(locked, locked);
    this.#tail = operation.then(() => {}, () => {});
    return operation.finally(() => { this.#pending--; });
  }
  async close() { await this.history?.close(); }
  revoke() { this.history?.revoke(); }
  // A change is about to happen without a checkpoint for its turn.
  markGap() { this.#stack = []; this.#gap = true; }
  take(run) {
    return this.#serial(() => this.#take(run)).catch(error => {
      if (run && run.checkpoint === undefined && !checkpointOwnershipError(error)) { run.checkpoint = null; run.checkpointError = error; this.markGap(); }
      throw error;
    });
  }
  finish(run) { return this.#serial(() => this.#finish(run)); }
  undo() { return this.#serial(() => this.#undo()); }
  list() { return this.#serial(async () => {
    this.history?.assertCurrent();
    return { revision: checkpointDigest(this.#stack), available: this.git.available ? await this.git.available() : true,
      points: this.#stack.map(({ id, turnRef, at }) => ({ id, turnRef, at })) };
  }); }
  preview(targetId) { return this.#serial(() => this.#preview(targetId)); }
  async #preview(targetId) {
    this.history?.assertCurrent();
    const preview = await previewCheckpointRestore(this.git, this.#stack, targetId, this.busy(), this.memberEdits);
    this.history?.assertCurrent();
    return preview;
  }
  restoreTo(targetId, expected, guard = undefined) { return this.#serial(async () => {
    guard?.();
    const preview = await this.#preview(targetId);
    const completed = [], files = new Set();
    if (!expected?.digest || !preview.digest || expected.digest !== preview.digest
      || expected.revision !== preview.revision || expected.tree !== preview.tree)
      return { result: preview.result === 'busy' ? 'busy' : 'stale', completed, files: [] };
    // Every step uses the same drift/policy guard as /undo and publishes its
    // shortened stack. A later refusal never conceals already completed turns.
    for (const step of preview.steps) {
      try {
        if (this.#stack.at(-1)?.id !== step.id) return { result: 'stale', completed, files: [...files] };
        const undo = await this.#undo(guard);
        if (undo.result !== 'done') return { ...undo, completed, changedFiles: [...files] };
        completed.push(step.id);
        for (const file of [...step.restore, ...step.remove]) files.add(file);
      } catch (error) {
        return { result: 'uncertain', completed, files: [...files], stoppedAt: step.id, reason: String(error) };
      }
    }
    return { result: preview.conflicts.length ? 'refused' : 'done', completed, files: [...files].sort(),
      conflicts: preview.conflicts, stoppedAt: preview.stoppedAt };
  }); }
  // Before the first change of a run; once per run. A snapshot that fails
  // never stops the agent's edit: the turn just has no checkpoint, and older
  // checkpoints are dropped with it, since undoing past an unrecorded turn
  // would leave its changes in place while claiming an earlier state.
  async #take(run) {
    if (!run || run.checkpoint !== undefined) return;
    run.checkpoint = null;
    let point = null;
    try {
      const before = await this.git.tree();
      if (before) {
        point = { id: randomUUID(), turnRef: run.turnRef ?? randomUUID(), before, after: null, at: Date.now() };
        await this.history?.begin(point);
        run.checkpoint = point;
      }
    } catch (error) {
      // Another owner: the edit waits and this turn tries again, history intact.
      if (checkpointOwnershipError(error)) { run.checkpoint = undefined; throw error; }
      run.checkpointError = error;
      await this.#barrier(point);
    }
  }
  async #barrier(point) {
    this.#stack = [];
    if (!this.history) return;
    try { if (point) await this.history.abandon(point); } catch { /* the capture is retired on the next operation */ }
    try { this.#stack = await this.history.save([]); } catch { /* a stale store refuses later restores itself */ }
  }
  // When the run ends: the tree after it, kept when the run changed something.
  async #finish(run) {
    const point = run?.checkpoint;
    if (!point || run.checkpointFinished) return;
    try { point.after = await this.git.tree(); }
    catch (error) { run.checkpointError = error; run.checkpointFinished = true; await this.#barrier(point); return; }
    if (point.after && point.after !== point.before) {
      const next = [...this.#stack, point];
      this.#stack = this.history ? await this.history.save(next) : next.slice(-64);
      run.checkpointFinished = true;
    } else if (point.after) {
      await this.history?.abandon(point); run.checkpointFinished = true;
    }
  }
  // Puts back what the last turn changed: { result, restored, removed, files }
  // for the WebUI note (phase "undo") and `text`, the sentence for the member.
  async #undo(guard = undefined) {
    guard?.();
    const answer = (undo, text) => ({ ...undo, text });
    if (this.busy()) return answer({ result: 'busy', restored: 0, removed: 0, files: [] }, 'Đang có một lượt chạy: chờ nó xong (hoặc dừng nó) rồi /undo.');
    const point = this.#stack.at(-1);
    if (!point) return answer({ result: 'none', restored: 0, removed: 0, files: [] }, 'Không có lượt nào để hoàn tác trong cuộc trò chuyện này (chỉ áp dụng cho project là git repository; checkpoint có từ khi mở cuộc trò chuyện).');
    await this.history?.prepare();
    const now = await this.git.tree();
    if (!now) return answer({ result: 'failed', restored: 0, removed: 0, files: [] }, 'Không đọc được trạng thái hiện tại của project; không hoàn tác.');
    const turn = await this.git.changed(point.before, point.after), since = new Set((await this.git.changed(point.after, now)).map(f => f.path));
    // A file the member saved after the turn began is theirs, even when the
    // turn's snapshots captured it: refuse rather than put it back.
    const edited = this.memberEdits(point.at);
    const touched = turn.filter(f => since.has(f.path) || edited.has(f.path)).map(f => f.path);
    if (touched.length) return answer({ result: 'refused', restored: 0, removed: 0, files: touched.slice(0, 5) },
      `Không hoàn tác: ${touched.length} file lượt trước đã sửa lại thay đổi sau đó (${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', …' : ''}). Hoàn tác sẽ ghi đè thay đổi đó.`);
    const restore = turn.filter(f => f.status !== 'A').map(f => f.path), remove = turn.filter(f => f.status === 'A').map(f => f.path);
    if (this.busy()) return answer({ result: 'busy', restored: 0, removed: 0, files: [] }, 'Đang có một lượt chạy: chờ nó xong (hoặc dừng nó) rồi /undo.');
    this.history?.assertCurrent();
    guard?.();
    await this.git.restore(point.before, restore, remove, now, guard);
    const next = this.#stack.slice(0, -1);
    this.#stack = this.history ? await this.history.save(next) : next;
    return answer({ result: 'done', restored: restore.length, removed: remove.length, files: [...restore, ...remove].slice(0, 5), more: this.#stack.length > 0 },
      `Đã hoàn tác lượt trước: ${restore.length} file trả về như trước lượt đó, ${remove.length} file lượt đó tạo đã xoá.${this.#stack.length ? ' /undo lần nữa để hoàn tác lượt trước nữa.' : ''} Commit tạo trong lượt đó (nếu có) vẫn giữ nguyên.`);
  }
}

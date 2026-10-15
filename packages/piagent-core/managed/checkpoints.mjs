// Turn checkpoints and /undo for company conversations in a git repository.
// Before a run first changes files, the working tree (tracked and untracked,
// .gitignore honoured) is written as a git tree through a private index; when
// the run ends, the tree after it. /undo puts back the files the last turn
// changed, and refuses when one of them changed again since (the member's own
// edit is never overwritten). The member's index, HEAD and commits are not
// touched: a commit made in the turn stays. The private index is copied with
// its time kept, so git still re-reads a file changed within the same second
// at the same size. Commands run in the command sandbox.
const SNAPSHOT = `set -e; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NOREPO; exit 0; }
top=$(git rev-parse --show-toplevel); cd "$top"; idx="$TMPDIR/piagent-checkpoint-$$"
real=$(git rev-parse --git-path index); if [ -f "$real" ]; then cp -p "$real" "$idx"; fi
GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1; tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"; echo "TREE $tree"`;
const b64 = list => Buffer.from(list.map(p => p + '\0').join(''), 'utf8').toString('base64');

export class TurnCheckpoints {
  #stack = [];
  constructor(managed) { this.managed = managed; }
  async #bash(command) {
    const result = await this.managed.boundary.invoke('bash', { command, timeout: 120 });
    return (result.content ?? []).map(part => part.text ?? '').join('');
  }
  async #tree() {
    const out = await this.#bash(SNAPSHOT);
    return out.match(/^TREE ([0-9a-f]{40,64})$/m)?.[1] ?? null;
  }
  // Before the first change of a run; once per run.
  async take(run = this.managed.run) {
    if (!run || run.checkpoint !== undefined) return;
    run.checkpoint = null;
    try { const before = await this.#tree(); if (before) { run.checkpoint = { before, after: null, at: Date.now() }; } } catch { /* no checkpoint: /undo says so */ }
  }
  // When the run ends: the tree after it, kept when the run changed something.
  async finish(run = this.managed.run) {
    const point = run?.checkpoint;
    if (!point) return;
    try { point.after = await this.#tree(); } catch { return; }
    if (point.after && point.after !== point.before) this.#stack.push(point);
  }
  async #changed(from, to) {
    const out = await this.#bash(`top=$(git rev-parse --show-toplevel) && cd "$top" && git diff --no-renames --name-status -z ${from} ${to}`);
    const parts = out.split('\0').filter(Boolean), files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i].trim(), path: parts[i + 1] });
    return files;
  }
  // Puts back what the last turn changed: { result, restored, removed, files }
  // for the WebUI note (phase "undo") and `text`, the sentence for the member.
  async undo() {
    const answer = (undo, text) => ({ ...undo, text });
    if (this.managed.activePrompt) return answer({ result: 'busy', restored: 0, removed: 0, files: [] }, 'Đang có một lượt chạy: chờ nó xong (hoặc dừng nó) rồi /undo.');
    const point = this.#stack.at(-1);
    if (!point) return answer({ result: 'none', restored: 0, removed: 0, files: [] }, 'Không có lượt nào để hoàn tác trong cuộc trò chuyện này (chỉ áp dụng cho project là git repository; checkpoint có từ khi mở cuộc trò chuyện).');
    const now = await this.#tree();
    if (!now) return answer({ result: 'failed', restored: 0, removed: 0, files: [] }, 'Không đọc được trạng thái hiện tại của project; không hoàn tác.');
    const turn = await this.#changed(point.before, point.after), since = new Set((await this.#changed(point.after, now)).map(f => f.path));
    const touched = turn.filter(f => since.has(f.path)).map(f => f.path);
    if (touched.length) return answer({ result: 'refused', restored: 0, removed: 0, files: touched.slice(0, 5) },
      `Không hoàn tác: ${touched.length} file lượt trước đã sửa lại thay đổi sau đó (${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', …' : ''}). Hoàn tác sẽ ghi đè thay đổi đó.`);
    const restore = turn.filter(f => f.status !== 'A').map(f => f.path), remove = turn.filter(f => f.status === 'A').map(f => f.path);
    const steps = ['set -e', 'top=$(git rev-parse --show-toplevel); cd "$top"; idx="$TMPDIR/piagent-undo-$$"'];
    if (restore.length) steps.push(`GIT_INDEX_FILE="$idx" git read-tree ${point.before}`, `printf %s ${b64(restore)} | base64 --decode | GIT_INDEX_FILE="$idx" git checkout-index -f -z --stdin`, 'rm -f "$idx"');
    if (remove.length) steps.push(`printf %s ${b64(remove)} | base64 --decode | xargs -0 rm -f --`);
    await this.#bash(steps.join('\n'));
    this.#stack.pop();
    return answer({ result: 'done', restored: restore.length, removed: remove.length, files: [...restore, ...remove].slice(0, 5), more: this.#stack.length > 0 },
      `Đã hoàn tác lượt trước: ${restore.length} file trả về như trước lượt đó, ${remove.length} file lượt đó tạo đã xoá.${this.#stack.length ? ' /undo lần nữa để hoàn tác lượt trước nữa.' : ''} Commit tạo trong lượt đó (nếu có) vẫn giữ nguyên.`);
  }
}
export const checkpointsOf = managed => (managed.checkpoints ??= new TurnCheckpoints(managed));

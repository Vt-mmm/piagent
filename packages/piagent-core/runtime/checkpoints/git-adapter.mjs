// Git operations are shared; the caller chooses the execution boundary.
// Keeping private-index timestamps makes Git recheck same-second, same-size edits.
// HEAD and the member's index are never used as restoration targets.
const SNAPSHOT = `set -e; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NOREPO; exit 0; }
top=$(git rev-parse --show-toplevel); cd "$top"; idx="$TMPDIR/piagent-checkpoint-$$"
real=$(git rev-parse --git-path index); if [ -f "$real" ]; then cp -p "$real" "$idx"; fi
GIT_INDEX_FILE="$idx" git add -A >/dev/null 2>&1; tree=$(GIT_INDEX_FILE="$idx" git write-tree); rm -f "$idx"; echo "TREE $tree"`;
const b64 = list => Buffer.from(list.map(p => p + '\0').join(''), 'utf8').toString('base64');

export class CheckpointGitAdapter {
  constructor(execute) { this.execute = execute; }
  async available() {
    return (await this.execute('git rev-parse --is-inside-work-tree 2>/dev/null || true')).trim() === 'true';
  }
  async tree() {
    const out = await this.execute(SNAPSHOT);
    return out.match(/^TREE ([0-9a-f]{40,64})$/m)?.[1] ?? null;
  }
  async changed(from, to) {
    const out = await this.execute(`top=$(git rev-parse --show-toplevel) && cd "$top" && git diff --no-renames --name-status -z ${from} ${to}`);
    const parts = out.split('\0').filter(Boolean), files = [];
    for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i].trim(), path: parts[i + 1] });
    return files;
  }
  async restore(before, restore, remove, expectedTree, guard) {
    const steps = ['set -e', 'top=$(git rev-parse --show-toplevel); cd "$top"; idx="$TMPDIR/piagent-undo-$$"'];
    if (expectedTree) {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(expectedTree)) throw Error('checkpoint-object-invalid');
      steps.unshift(`current=$(\n${SNAPSHOT}\n)`, `[ "$current" = "TREE ${expectedTree}" ] || { echo checkpoint-content-changed >&2; exit 1; }`);
    }
    if (restore.length) steps.push(`GIT_INDEX_FILE="$idx" git read-tree ${before}`, `printf %s ${b64(restore)} | base64 --decode | GIT_INDEX_FILE="$idx" git checkout-index -f -z --stdin`, 'rm -f "$idx"');
    if (remove.length) steps.push(`printf %s ${b64(remove)} | base64 --decode | xargs -0 rm -f --`);
    guard?.();
    await this.execute(steps.join('\n'), guard);
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import '../scripts/register-typescript-loader.mjs';
import { astCommands } from '../packages/piagent-core/extensions/shell-ast.js';
import { handoffReason, treeExecFinding } from '../packages/piagent-core/runtime/policy/handoff-policy.mjs';

const words = command => (astCommands(command) ?? []).map(item => item.words.join(' '));

test('the syntax tree finds commands wherever the shell runs them', () => {
  assert.deepEqual(words('if true; then FOO=1 git -C "a b" push; fi'), ['true', 'git -C a b push']);
  assert.ok(words('f() { git push; }; f').includes('git push'), 'a function body');
  assert.ok(words('case x in a) git push;; esac').includes('git push'), 'a case arm');
  assert.ok(words('echo $(gh pr merge 3)').includes('gh pr merge 3'), 'a substitution');
  assert.ok(words('echo `git push`').includes('git push'), 'backticks');
  assert.ok(words('bash -c "cd x && git push"').includes('git push'), 'bash -c text is parsed again');
  assert.ok(words('eval "git push"').includes('git push'), 'eval text is parsed again');
  assert.ok(words('cat <<EOF\n$(git push)\nEOF\n').includes('git push'), 'an unquoted heredoc runs its $( … )');
  assert.equal(words('cat <<"EOF"\n$(git push)\nEOF\n').includes('git push'), false, 'a quoted heredoc is text');
  assert.equal(astCommands('git push $REMOTE')[0].dynamic, true, 'an expansion is flagged, not evaluated');
  assert.equal(astCommands('echo "unterminated'), null, 'a line the parser rejects leaves the scanner in charge');
});

test('a handoff or a refused delete hidden from the scanner is still found', async () => {
  for (const command of ['f() { git push; }; f', 'case x in a) git push;; esac', 'cat <<EOF\n$(gh pr merge 1)\nEOF'])
    assert.ok(await handoffReason(command), command);
  for (const command of ['f() { rm -rf /; }; f', 'cat <<EOF\n$(rm -rf ~)\nEOF', 'case a in a) rm -rf /;; esac'])
    assert.equal(treeExecFinding(command)?.decision, 'forbid', command);
  assert.equal(treeExecFinding('rm -rf build'), null);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { commandTools } from '../packages/piagent-core/managed/command-tools.mjs';
import { asksCommit, commitAskSetter, networkConfirmation, restoreCommitAsk } from '../packages/piagent-core/managed/permission.mjs';
import { codeHandoffReason } from '../packages/piagent-core/runtime/policy/handoff-policy.mjs';
import { commitAskNotice, registerCommitAskCommand } from '../scripts/company-commit-ask.mjs';

// Owner, 2026-11-11: in Always bypass the member may stop the question before
// each commit, for their own conversation; a push and a merge are asked still.
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pa-commit-ask-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const manager = () => { const entries = []; return { entries, getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }; };
const member = (permission = 'always-bypass', commitAsk = true) => ({ permission, commitAsk, manifest: {}, cwd: base, grant: {}, session: { sessionManager: { getSessionId: () => 'session' } },
  boundary: { engine: null, dockerCli: null, userHome: os.homedir(), refreshEnvironment: () => false, invoke: async () => { throw Error('the sandbox was used'); } },
  changedFiles: async () => [], claimChanges: async () => {}, refreshReview: async () => {} });

test('the switch is kept with the conversation and asks by default', () => {
  const log = manager(), owner = member();
  assert.equal(restoreCommitAsk(log), true); assert.ok(asksCommit(owner));
  assert.equal(commitAskSetter(owner, log)(false), true);
  assert.equal(owner.commitAsk, false); assert.equal(restoreCommitAsk(log), false);
  assert.equal(commitAskSetter(owner, log)(false), false, 'no entry when nothing changes');
  commitAskSetter(owner, log)(true);
  assert.equal(restoreCommitAsk(log), true); assert.equal(log.entries.length, 2);
});

test('with the switch off, a commit runs unasked; a push, a merge, an alias and an rm on a critical path are asked', async () => {
  const quiet = member('always-bypass', false);
  for (const command of ['git commit -m x', 'cd api && git add -A && git commit -q -m "a\nb"', 'if true; then git commit; fi'])
    assert.equal(await networkConfirmation(quiet, command), null, command);
  for (const command of ['git add -A && git commit -m x && git push', 'git push origin main', 'gh pr merge 3', 'git -c alias.ci=commit ci', 'rm -rf ~'])
    assert.ok(await networkConfirmation(quiet, command), command);
  assert.ok(await networkConfirmation(member(), 'git commit -m x'), 'on by default');
  assert.equal(codeHandoffReason('git commit -m x'), 'git commit records code');
  assert.equal(codeHandoffReason('git commit -m x', { commit: false }), null);
});

test('the other modes never read the switch', async () => {
  const bypass = { ...member('bypass', false), manifest: { harness: { configuration: { bypass_mode: true } } } };
  assert.ok(await networkConfirmation(bypass, 'git push origin main'));
  assert.equal(await networkConfirmation(member('workspace-write', false), 'git commit -m x'), 'ask');
});

test('run_on_host commits without a question when the member turned it off, and still asks before a push', async () => {
  const owner = member('always-bypass', false), host = commandTools(owner).find(tool => tool.name === 'run_on_host');
  const file = path.join(base, 'committed.txt');
  const asked = [];
  const ctx = { ui: { confirm: async (title) => { asked.push(title); return false; } } };
  // A command named "git commit" that only writes a file (no repository needed): the question is what is tested.
  const result = await host.execute('id', { command: `git() { echo "$@" > ${JSON.stringify(file)}; }; git commit -m x; cat ${JSON.stringify(file)}`, reason: 'test' }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /commit -m x/); assert.deepEqual(asked, []);
  await assert.rejects(host.execute('id', { command: `touch ${JSON.stringify(path.join(base, 'pushed'))}; git push`, reason: 'test' }, undefined, undefined, ctx));
  assert.equal(fs.existsSync(path.join(base, 'pushed')), false, 'a no stops the push');
  assert.equal(asked.length, 1);
});

test('/commit-ask turns it off and on, and says when it does not apply', async () => {
  const commands = {}, notes = [], refreshed = [];
  const owner = member(), log = manager();
  owner.session = { ...owner.session, managedSetCommitAsk: commitAskSetter(owner, log) };
  registerCommitAskCommand({ registerCommand: (name, spec) => { commands[name] = spec; } }, { managed: () => owner, completions: () => () => null, refresh: (ctx) => refreshed.push(ctx) });
  const ctx = { ui: { notify: (text, tone) => notes.push([text, tone]) } };
  await commands['commit-ask'].handler('off', ctx);
  assert.equal(owner.commitAsk, false); assert.match(notes.at(-1)[0], /commit không hỏi.*Push, merge/s); assert.equal(refreshed.length, 1);
  await commands['commit-ask'].handler('', ctx);
  assert.equal(owner.commitAsk, true, 'empty toggles');
  await commands['commit-ask'].handler('maybe', ctx);
  assert.equal(notes.at(-1)[1], 'warning');
  owner.permission = 'workspace-write';
  assert.match(commitAskNotice(owner), /Chỉ áp dụng khi cuộc trò chuyện ở Always bypass/);
});

test('a commit, push or merge while this turn\'s checklist has steps not started is held at once, never waiting on the member', async () => {
  const plan = (statuses) => ({ getSessionId: () => 'session', getEntries: () => [{ type: 'custom', customType: 'agent-watch-plan', data: { plan: statuses.map((status, i) => ({ step: `s${i}`, status })) } }] });
  const owner = member(), asked = [];
  owner.session = { sessionManager: plan(['completed', 'in_progress', 'pending']) }; owner.run = { planUpdated: true };
  const host = commandTools(owner).find(tool => tool.name === 'run_on_host');
  const ctx = { ui: { confirm: async (title) => { asked.push(title); return false; } } };
  for (const command of ['git commit -m x', 'git push origin main', 'gh pr merge 3'])
    await assert.rejects(host.execute('id', { command, reason: 'test' }, undefined, undefined, ctx), /managed-handoff-held: .*run this exact command again/s, command);
  assert.deepEqual(asked, [], 'nothing is asked mid-plan');
  await assert.rejects(host.execute('id', { command: 'rm -rf ~', reason: 'test' }, undefined, undefined, ctx), /declined|denied|managed-operation/, 'an rm on a critical path is asked at once');
  assert.equal(asked.length, 1);
  owner.session = { sessionManager: plan(['completed', 'completed', 'in_progress']) };
  await assert.rejects(host.execute('id', { command: 'git push origin main', reason: 'test' }, undefined, undefined, ctx));
  assert.equal(asked.length, 2, 'at the last step the push is asked');
  owner.session = { sessionManager: plan(['completed', 'in_progress', 'pending']) }; owner.run = { planUpdated: false };
  await assert.rejects(host.execute('id', { command: 'git push origin main', reason: 'test' }, undefined, undefined, ctx));
  assert.equal(asked.length, 3, 'a checklist from an earlier turn does not hold it');
});

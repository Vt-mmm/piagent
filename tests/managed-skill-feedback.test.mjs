import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SkillFeedback } from '../packages/piagent-core/managed/skill-feedback.mjs';

// A skill that keeps ending rounds badly gets a proposal file to review; a
// skill that works, or one not used, gets none; nothing edits the skill.
test('a skill that keeps failing is proposed for review, once a week', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-skill-feedback-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const skillFile = path.join(cwd, '.pi', 'skills', 'release', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true }); fs.writeFileSync(skillFile, 'Run make release.');
  let now = Date.parse('2026-10-21T08:00:00Z');
  const round = (use, outcome) => {
    const f = new SkillFeedback({ cwd, skills: [{ name: 'release', filePath: skillFile }, { name: 'other', filePath: path.join(cwd, 'x.md') }], now: () => now });
    if (use === 'command') f.request('<skill name="release" location="x">\nRun make release.\n</skill>\n\nship it');
    if (use === 'read') f.event({ type: 'tool_execution_start', toolName: 'read', args: { path: '.pi/skills/release/SKILL.md' } });
    now += 60_000;
    return f.close(outcome);
  };
  const failed = { checks: 'failed', lessons: [] };
  const toolError = { checks: 'passed', lessons: [{ kind: 'tool_error', line: 'Observed repeated tool error: make release failed twice in one round with "No rule to make target".' }] };
  assert.deepEqual(round(null, failed), []);
  assert.deepEqual(round('command', failed), []);
  assert.deepEqual(round('read', { checks: 'passed', lessons: [] }), []);
  assert.deepEqual(round('read', toolError), []);
  const written = round('command', failed);
  assert.equal(written.length, 1);
  const proposal = fs.readFileSync(written[0], 'utf8');
  assert.match(proposal, /# Review the skill "release"/);
  assert.match(proposal, /3 of the last 4 rounds that used it ended badly/);
  assert.match(proposal, /No rule to make target/);
  assert.match(proposal, /Skill file: \.pi\/skills\/release\/SKILL\.md/);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), 'Run make release.');
  // More failures the same week do not propose again.
  for (let i = 0; i < 3; i++) assert.deepEqual(round('command', failed), []);
  now += 8 * 86400_000;
  assert.equal(round('command', failed).length, 1);
});

// 2026-10-22 audit: `a/b` and `a_b` shared one state file, so one skill's
// failures counted for the other.
test('two skill names that read alike keep their own counts', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-skill-feedback-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const skills = ['a/b', 'a_b', 'A_B'].map(name => ({ name, filePath: path.join(cwd, `${name.replace('/', '-')}.md`) }));
  const failed = { checks: 'failed', lessons: [] };
  for (const name of ['a/b', 'a_b', 'A_B', 'a/b', 'a_b', 'A_B']) {
    const f = new SkillFeedback({ cwd, skills });
    f.request(`<skill name="${name}" location="x">`);
    assert.deepEqual(f.close(failed), [], `${name}: two failures are no proposal yet`);
  }
  const dir = path.join(cwd, '.pi', 'piagent-state', 'skill-proposals');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 3, files.join(','));
  assert.ok(files.includes('a_b.json'), 'a plain name keeps its file');
});

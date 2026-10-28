import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { agentResourcePaths, listAgentCommands, userSkillFolders } from '../packages/piagent-core/runtime/resources/agent-resources.mjs';
import { skillSourcesIndex, skillSourcesRoot } from '../packages/piagent-core/runtime/resources/plugin-skills.mjs';
import { fetchSource, parseRepository, readIndex, sourceSkills } from '../scripts/skill-sources.mjs';

// `piagent skills add mattpocock/skills`: a GitHub repository of skills kept
// at one commit under ~/.piagent/skill-sources, read like a Claude plugin's
// skills (only those its manifest publishes) by personal Pi, the company
// Terminal and the dashboard.
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\nSteps for ${name}.\n`;
const COMMIT = 'a'.repeat(40);

function machine(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sources-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home'), project = path.join(base, 'shop');
  fs.mkdirSync(home); fs.mkdirSync(path.join(project, '.git'), { recursive: true });
  return { home, project };
}

// git, as fetchSource drives it, answered from a fixture repository.
function fakeGit(files, calls = []) {
  return (args) => {
    calls.push(args);
    if (args[0] === 'clone') {
      const target = args.at(-1);
      for (const [name, text] of Object.entries(files)) write(path.join(target, name), text);
      fs.mkdirSync(path.join(target, '.git'), { recursive: true });
      return '';
    }
    if (args.includes('rev-parse')) return COMMIT;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
}

const MATT = {
  '.claude-plugin/plugin.json': JSON.stringify({ name: 'mattpocock-skills', skills: ['./skills/engineering/tdd', './skills/productivity/grill-me'] }),
  'skills/engineering/tdd/SKILL.md': skill('tdd', 'Test-driven development with red-green-refactor.'),
  'skills/engineering/tdd/tests.md': 'Good tests.\n',
  'skills/productivity/grill-me/SKILL.md': skill('grill-me', 'Interview the user relentlessly about a plan.'),
  'skills/in-progress/loop-me/SKILL.md': skill('loop-me', 'Not published yet.'),
};

test('repositories are named as owner/repo, a GitHub URL or a known short name', () => {
  assert.equal(parseRepository('mattpocock/skills'), 'mattpocock/skills');
  assert.equal(parseRepository('mattpocock'), 'mattpocock/skills');
  assert.equal(parseRepository('https://github.com/mattpocock/skills'), 'mattpocock/skills');
  assert.equal(parseRepository('https://github.com/mattpocock/skills.git'), 'mattpocock/skills');
  for (const bad of ['', 'skills', '../x/y', 'a/b/c', 'https://evil.example/a/b', 'owner/..']) assert.equal(parseRepository(bad), null, bad);
});

test('an added source is kept at its commit, without history, and only its published skills load', (t) => {
  const { home, project } = machine(t), calls = [];
  const entry = fetchSource('mattpocock/skills', { home, runGit: fakeGit(MATT, calls) });
  assert.equal(entry.commit, COMMIT);
  assert.equal(entry.path, path.join('github.com', 'mattpocock', 'skills', COMMIT));
  assert.deepEqual(calls[0].slice(0, 4), ['clone', '-q', '--depth', '1']);
  assert.ok(calls[0].includes('https://github.com/mattpocock/skills.git'));
  const copy = path.join(skillSourcesRoot(home), entry.path);
  assert.equal(fs.existsSync(path.join(copy, '.git')), false);
  assert.deepEqual(sourceSkills(entry, home), ['grill-me', 'tdd']);

  // Nothing loads before the source is in the index.
  assert.equal(listAgentCommands({ cwd: project, home }).length, 0);
  write(skillSourcesIndex(home), JSON.stringify({ schema_version: 1, sources: [{ ...entry, name: 'mattpocock/skills' }] }));
  const items = listAgentCommands({ cwd: project, home });
  assert.deepEqual(items.map((item) => item.name).sort(), ['grill-me', 'tdd']);
  assert.deepEqual({ origin: items[0].origin, plugin: items[0].plugin }, { origin: 'piagent', plugin: 'mattpocock-skills' });
  // Personal Pi is offered the folders, and they are readable where installed.
  const { skillPaths } = agentResourcePaths({ cwd: project, home, piDefaults: false });
  assert.ok(skillPaths.includes(fs.realpathSync(path.join(copy, 'skills/engineering/tdd'))));
  assert.ok(!skillPaths.some((dir) => dir.includes('in-progress')));
  assert.ok(userSkillFolders(home).includes(fs.realpathSync(path.join(copy, 'skills/engineering/tdd'))));
});

test('an index entry pointing outside the sources folder, or turned off, is not read', (t) => {
  const { home, project } = machine(t);
  write(path.join(home, 'elsewhere/skills/leak/SKILL.md'), skill('leak', 'Should never load.'));
  fs.mkdirSync(skillSourcesRoot(home), { recursive: true });
  const entry = fetchSource('mattpocock/skills', { home, runGit: fakeGit(MATT) });
  write(skillSourcesIndex(home), JSON.stringify({ sources: [
    { repo: 'x/leak', path: '../../elsewhere' },
    { ...entry, enabled: false },
  ] }));
  assert.deepEqual(listAgentCommands({ cwd: project, home }), []);
  assert.equal(readIndex(home).sources.length, 2);
});

test('a commit is fetched as that commit, and a repository without skills adds none', (t) => {
  const { home } = machine(t), calls = [];
  const runGit = (args) => {
    calls.push(args);
    if (args.includes('checkout')) { write(path.join(args[1], 'README.md'), 'no skills\n'); return ''; }
    if (args.includes('rev-parse')) return COMMIT;
    return '';
  };
  const entry = fetchSource('someone/notes', { home, ref: COMMIT, runGit });
  assert.deepEqual(calls.map((args) => args.find((arg) => ['init', 'fetch', 'checkout', 'rev-parse'].includes(arg))), ['init', 'fetch', 'checkout', 'rev-parse']);
  assert.deepEqual(sourceSkills(entry, home), []);
});

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const LANE = path.resolve(import.meta.dirname, '..');
export const TOOL_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/Applications/Docker.app/Contents/Resources/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
// `piagent studio` must run on the Node that Agent Watch pinned in its
// binding (another Node on PATH is refused as a changed binding).
export function piagentEnv() {
  let pinned = null;
  try { pinned = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.pi/agent/agent-watch-managed.json'), 'utf8')).node; } catch { /* not imported */ }
  return { PATH: pinned ? `${path.dirname(pinned)}:${TOOL_PATH}` : TOOL_PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' };
}
const GIT_ID = { GIT_AUTHOR_NAME: 'Soak Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Soak Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function loadScenarios(dir = path.join(LANE, 'scenarios')) {
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => ({ ...readJson(path.join(dir, f)), file: path.join(dir, f) }));
}
export const fixtureDir = name => path.join(LANE, 'fixtures', name);

// One shell command with a deadline; output kept to its tail.
export function sh(command, { cwd, timeoutSec = 600, env = {} } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    // A runner inside `node --test` would make a checked `node --test` report to it and exit 0.
    const { NODE_TEST_CONTEXT, NODE_OPTIONS, ...inherited } = process.env;
    const child = spawn('/bin/bash', ['-c', command], { cwd, env: { ...inherited, PATH: TOOL_PATH, CI: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const keep = d => { out = (out + d).slice(-8000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutSec * 1000);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: signal ? `signal:${signal}` : code, ms: Date.now() - started, tail: out.slice(-3000) }); });
  });
}

// Tools a scenario needs on this machine; a missing one skips the scenario.
export async function missingRequirements(requires = []) {
  const probes = {
    docker: 'docker info --format "{{.ServerVersion}}"',
    uv: 'uv --version',
    python: 'python3 --version',
    network: 'curl -sfI --max-time 10 https://registry.npmjs.org/ >/dev/null',
    git: 'git --version',
  };
  const missing = [];
  for (const need of requires) {
    const probe = probes[need];
    if (!probe) { missing.push(`${need} (unknown requirement)`); continue; }
    if ((await sh(probe, { timeoutSec: 30 })).code !== 0) missing.push(need);
  }
  return missing;
}

function copyTree(from, to) {
  // APFS clones make copies of node_modules and venvs nearly free.
  try { execFileSync('/bin/cp', ['-cR', `${from}/.`, to]); } catch { fs.cpSync(from, to, { recursive: true }); }
}

export const digestOf = file => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } };

// The member's repository: the fixture's project at a baseline commit,
// prepared the way the member would have it (dependencies installed).
export async function prepareProject({ scenario, runDir }) {
  const fixture = fixtureDir(scenario.fixture), project = path.join(runDir, 'project');
  fs.mkdirSync(project, { recursive: true });
  copyTree(path.join(fixture, 'project'), project);
  const config = fs.existsSync(path.join(fixture, 'fixture.json')) ? readJson(path.join(fixture, 'fixture.json')) : {};
  const setup = [];
  for (const command of [...(config.setup ?? []), ...(scenario.setup ?? [])]) {
    const result = await sh(command, { cwd: project, timeoutSec: 900 });
    setup.push({ command, ...result });
    if (result.code !== 0) throw Object.assign(Error(`fixture setup failed: ${command}\n${result.tail}`), { setup });
  }
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: project, env: { ...process.env, ...GIT_ID }, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); git('config', 'gc.auto', '0'); git('add', '-A'); git('commit', '-qm', 'Baseline');
  const protect = Object.fromEntries([...(config.protect ?? []), ...(scenario.protect ?? [])].map(p => [p, digestOf(path.join(project, p))]));
  return { project, fixture, config, protect, setup };
}

// Checks run on a copy of the project, with the hidden acceptance files laid
// over it: the agent never sees them, and its own files cannot change them.
// The phases of a scenario: its first prompt, then each follow-up the member
// gives in the same conversation once the work before it passes.
export function phasesOf(scenario) {
  return [{ id: 'main', prompt: scenario.prompt, oracle: scenario.oracle, reference: scenario.reference, referenceSetup: scenario.referenceSetup }, ...(scenario.phases ?? [])];
}
// A phase is checked with every hidden overlay so far (earlier work must not
// break) and its own checks.
export function phaseOracle(scenario, index) {
  const phases = phasesOf(scenario).slice(0, index + 1);
  return { hidden: phases.flatMap(ph => [].concat(ph.oracle?.hidden ?? [])), checks: phases.at(-1).oracle?.checks ?? scenario.oracle?.checks ?? [] };
}

export async function runOracle({ scenario, oracle: given, project, runDir, attempt }) {
  const fixture = fixtureDir(scenario.fixture), oracle = given ?? scenario.oracle ?? {};
  const copy = path.join(runDir, `oracle-${attempt}`);
  fs.rmSync(copy, { recursive: true, force: true }); fs.mkdirSync(copy, { recursive: true });
  copyTree(project, copy);
  for (const overlay of [].concat(oracle.hidden ?? [])) copyTree(path.join(fixture, overlay), copy);
  const checks = [];
  for (const check of oracle.checks ?? []) {
    const result = await sh(check.run, { cwd: copy, timeoutSec: check.timeoutSec ?? 600, env: { SOAK_RUN: path.basename(runDir) } });
    checks.push({ name: check.name, pass: result.code === 0, code: result.code, ms: result.ms, tail: result.code === 0 ? '' : result.tail });
    if (result.code !== 0 && check.stopOnFail !== false) break;
  }
  if (!scenario.keepOracleCopies) fs.rmSync(copy, { recursive: true, force: true });
  const pass = checks.length === (oracle.checks ?? []).length && checks.every(c => c.pass);
  return { pass, checks };
}

export function protectedChanges(project, protect) {
  return Object.entries(protect).filter(([file, before]) => digestOf(path.join(project, file)) !== before).map(([file]) => file);
}

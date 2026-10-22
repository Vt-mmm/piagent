#!/usr/bin/env node
// Long-task soak lane: real company agent, real repositories, a simulated
// member. See README.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadScenarios, missingRequirements, prepareProject, runOracle, fixtureDir, sh, phasesOf, phaseOracle } from './lib/workspace.mjs';
import { playScenario } from './lib/session-loop.mjs';
import { TerminalSurface, terminalSupportsRpc } from './surfaces/terminal-rpc.mjs';
import { WebUiSurface } from './surfaces/webui-gateway.mjs';
import { markdownReport } from './lib/report.mjs';

const { values: opt } = parseArgs({ options: {
  surface: { type: 'string', default: 'terminal' },           // terminal | webui | both
  scenario: { type: 'string' }, category: { type: 'string' },  // comma lists
  repeat: { type: 'string', default: '1' },
  'work-root': { type: 'string', default: path.join(os.homedir(), 'piagent-soak') },
  output: { type: 'string' }, piagent: { type: 'string', default: 'piagent' },
  'self-check': { type: 'boolean', default: false }, list: { type: 'boolean', default: false },
} });

const pick = (list, value, key) => !value ? list : list.filter(s => value.split(',').some(v => [].concat(s[key]).includes(v.trim())));
let scenarios = pick(pick(loadScenarios(), opt.scenario, 'id'), opt.category, 'category');
if (opt.list) { for (const s of scenarios) console.log(`${s.id.padEnd(34)} ${[].concat(s.category).join(',').padEnd(28)} ${s.language}  ${s.title}`); process.exit(0); }
if (!scenarios.length) { console.error('no scenario matches'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const runsRoot = path.join(opt['work-root'], 'runs', stamp);
fs.mkdirSync(runsRoot, { recursive: true });
const output = opt.output ?? path.join(opt['work-root'], 'reports', `${opt['self-check'] ? 'self-check' : 'soak'}-${stamp}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const log = line => process.stderr.write(`[soak ${new Date().toISOString().slice(11, 19)}] ${line}\n`);

// Self-check: the oracle fails on the untouched fixture and passes on the
// reference solution, so a pass in a real run means the work was done.
async function selfCheck(scenario) {
  const runDir = path.join(runsRoot, `${scenario.id}-self-check`); fs.mkdirSync(runDir, { recursive: true });
  const prepared = await prepareProject({ scenario, runDir });
  const phases = [];
  // Each phase: its checks fail before its reference is applied (on top of the
  // earlier phases' references) and pass after.
  for (const [index, phase] of phasesOf(scenario).entries()) {
    const oracle = phaseOracle(scenario, index);
    const before = await runOracle({ scenario, oracle, project: prepared.project, runDir, attempt: `${phase.id}-before` });
    fs.cpSync(path.join(fixtureDir(scenario.fixture), phase.reference ?? 'reference'), prepared.project, { recursive: true });
    for (const command of phase.referenceSetup ?? []) await sh(command, { cwd: prepared.project, timeoutSec: 900 });
    const after = await runOracle({ scenario, oracle, project: prepared.project, runDir, attempt: `${phase.id}-after` });
    phases.push({ id: phase.id, ok: !before.pass && after.pass, before: before.checks, after: after.checks });
    log(`${scenario.id} [${phase.id}]: before ${before.pass ? 'PASSES (oracle too weak)' : 'fails'}, reference ${after.pass ? 'passes' : 'FAILS'} → ${!before.pass && after.pass ? 'ok' : 'BROKEN'}`);
  }
  return { scenario: scenario.id, ok: phases.every(p => p.ok), phases, baseline: phases[0].before, reference: phases.at(-1).after };
}

const surfaces = opt.surface === 'both' ? ['terminal', 'webui'] : [opt.surface];
if (!opt['self-check'] && surfaces.includes('terminal') && !terminalSupportsRpc(opt.piagent)) {
  console.error(`${opt.piagent} studio has no --rpc yet (it ships in the Piagent release after 1.35.1). Use --surface webui, or install that release.`);
  process.exit(2);
}

const results = [];
for (const scenario of scenarios) {
  const missing = await missingRequirements(scenario.requires);
  if (missing.length) { log(`${scenario.id}: skipped, missing ${missing.join(', ')}`); results.push({ scenario: scenario.id, skipped: missing }); continue; }
  if (opt['self-check']) { results.push(await selfCheck(scenario).catch(error => ({ scenario: scenario.id, ok: false, error: String(error.message) }))); continue; }
  for (const surfaceName of surfaces) for (let n = 1; n <= Number(opt.repeat); n++) {
    const runDir = path.join(runsRoot, `${scenario.id}-${surfaceName}-${n}`); fs.mkdirSync(runDir, { recursive: true });
    log(`${scenario.id} on ${surfaceName} (#${n}) in ${runDir}`);
    let result;
    try {
      const prepared = await prepareProject({ scenario, runDir });
      const surface = surfaceName === 'webui' ? new WebUiSurface({ piagent: opt.piagent }) : new TerminalSurface({ piagent: opt.piagent });
      result = await playScenario({ scenario, surface, prepared, runDir });
    } catch (error) {
      result = { scenario: scenario.id, pass: false, verdict: 'harness_error', error: String(error?.stack ?? error).slice(0, 2000) };
    }
    result = { ...result, surface: surfaceName, repeat: n, runDir, category: scenario.category, language: scenario.language };
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
    log(`${scenario.id} on ${surfaceName}: ${result.verdict}${result.minutes != null ? ` in ${result.minutes} min` : ''}${result.defects?.length ? ` · ${result.defects.map(d => d.defect).join(', ')}` : ''}`);
    results.push(result);
  }
}

const report = { schemaVersion: 1, lane: 'long-task-soak-v1', mode: opt['self-check'] ? 'self-check' : 'soak', startedAt: stamp, host: os.hostname(), surfaces, results };
fs.writeFileSync(output, JSON.stringify(report, null, 2));
fs.writeFileSync(output.replace(/\.json$/, '.md'), markdownReport(report));
log(`report: ${output} (+ .md)`);
const failed = opt['self-check'] ? results.some(r => r.ok === false) : results.some(r => r.verdict && r.verdict !== 'smooth');
process.exit(failed ? 1 : 0);

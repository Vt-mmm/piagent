#!/usr/bin/env node
// The Pi host Piagent runs on, when the member keeps a Pi of their own.
//
// Piagent pins one Pi release (package.json peerDependencies). A member who
// already uses Pi may run a newer one: setup used to replace it with the
// pinned release. Now theirs stays as it is, and the pinned release is
// installed privately (packages/piagent-core/managed/pi-host.mjs); company
// sessions and the dashboard run it, and `piagent pi` opens it for personal use.
//
//   pi-host.mjs status [--json]      the pinned host, the `pi` on PATH, the private copy
//   pi-host.mjs ensure [--dry-run]   install the private copy when PATH has another Pi
//   pi-host.mjs root                 the host root Piagent runs (empty when none)
//   pi-host.mjs run [-- args]        run Pi on the pinned host
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_HOST_VERSION, hostCli, hostPlan, installPrivateHost, privateHostRoot } from '../packages/piagent-core/managed/pi-host.mjs';

const HOST_NAME = '@earendil-works/pi-coding-agent';

function usage() {
  return `Usage:
  piagent pi [pi arguments]        Run Pi ${PI_HOST_VERSION} (the release Piagent is qualified on)
  piagent pi-host status [--json]  Show the pinned host, your own pi and the private copy
  piagent pi-host ensure [--dry-run]
                                   Install the pinned host privately when your pi is another release
`;
}

// The `pi` on PATH: its package root and version, or nulls.
export function pathHost(env = process.env, { probe = true } = {}) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    let root;
    try { root = path.dirname(fs.realpathSync(path.join(dir, process.platform === 'win32' ? 'pi.cmd' : 'pi'))); } catch { continue; }
    for (let depth = 0; depth < 4; depth += 1, root = path.dirname(root)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
        if (manifest.name === HOST_NAME) return { root, version: manifest.version ?? null };
      } catch { /* keep walking up */ }
    }
  }
  if (!probe) return { root: null, version: null };
  // A `pi` that is not an npm package (a standalone build): ask it.
  const output = spawnSync('pi', ['--version'], { encoding: 'utf8', timeout: 5_000, shell: process.platform === 'win32' });
  const version = output.status === 0 ? /(\d+\.\d+\.\d+(?:[+-][0-9A-Za-z.-]+)?)/.exec(output.stdout)?.[1] ?? null : null;
  return { root: null, version };
}

// The host Piagent runs: the `pi` on PATH when it is the pinned release, else
// the private copy, else (not installed yet) whatever PATH has.
export function activeHostRoot({ env = process.env, home } = {}) {
  const own = pathHost(env, { probe: false });
  if (own.root && own.version === PI_HOST_VERSION) return own.root;
  return privateHostRoot(PI_HOST_VERSION, home) ?? own.root;
}

export function status({ env = process.env, home } = {}) {
  const own = pathHost(env), privateRoot = privateHostRoot(PI_HOST_VERSION, home);
  return { pinned: PI_HOST_VERSION, own: own.version, ownRoot: own.root, privateRoot, plan: hostPlan(own.version), active: activeHostRoot({ env, home }) };
}

function describe(report) {
  const lines = [`Piagent runs on Pi ${report.pinned}.`];
  if (!report.own) lines.push('No `pi` on PATH.');
  else if (report.plan === 'current') lines.push(`Your pi is ${report.own}: the same release, used as it is.`);
  else if (report.plan === 'private') lines.push(`Your pi is ${report.own}: kept as it is. Company sessions and \`piagent pi\` use a private Pi ${report.pinned}.`);
  else lines.push(`Your pi is ${report.own}: older than ${report.pinned}; piagent-setup updates it.`);
  lines.push(report.privateRoot ? `Private copy: ${report.privateRoot}` : 'Private copy: not installed');
  return lines.join('\n');
}

async function main(argv) {
  const [command, ...rest] = argv;
  if ([undefined, 'help', '--help', '-h'].includes(command)) { process.stdout.write(usage()); return 0; }
  if (command === 'status') {
    const report = status();
    process.stdout.write(rest.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : `${describe(report)}\n`);
    return 0;
  }
  if (command === 'root') { process.stdout.write(`${activeHostRoot() ?? ''}\n`); return 0; }
  if (command === 'ensure') {
    const report = status(), dryRun = rest.includes('--dry-run');
    if (report.plan !== 'private' && !rest.includes('--force')) { process.stdout.write(`${describe(report)}\n`); return 0; }
    try {
      const root = installPrivateHost({ dryRun, log: (line) => process.stdout.write(`${line}\n`) });
      process.stdout.write(`${dryRun ? 'DRY RUN: ' : ''}Pi ${PI_HOST_VERSION} for Piagent: ${root}\n`);
      if (report.own) process.stdout.write(`Your pi ${report.own} is unchanged.\n`);
      return 0;
    } catch (error) { process.stderr.write(`FAIL: ${error.message}\n`); return 1; }
  }
  if (command === 'run') {
    const args = rest[0] === '--' ? rest.slice(1) : rest;
    const root = activeHostRoot();
    if (!root || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version !== PI_HOST_VERSION) {
      process.stderr.write(`FAIL: Pi ${PI_HOST_VERSION} is not installed for Piagent. Run: piagent pi-host ensure --force\n`);
      return 1;
    }
    const child = spawn(process.execPath, [hostCli(root), ...args], { stdio: 'inherit' });
    for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => { try { child.kill(signal); } catch { /* gone */ } });
    process.on('SIGINT', () => {});
    return await new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1)));
  }
  process.stderr.write(usage());
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));

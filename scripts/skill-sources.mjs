#!/usr/bin/env node
// Skill repositories a member adds to Piagent, such as mattpocock/skills.
//
// A source is a public GitHub repository of Agent Skills (folders with a
// SKILL.md). `add` keeps it at one commit under ~/.piagent/skill-sources, so
// what the agent reads changes only on `update`; the index lists it
// (~/.piagent/skill-sources.json), and plugin-skills.mjs offers its skills to
// personal Pi, the company Terminal and the dashboard, as it does a Claude
// plugin's. A repository with a plugin manifest (.claude-plugin/plugin.json)
// loads only the skills the manifest publishes. Skills are instructions: a
// script they bundle runs only through the session's own tools and approvals.
//
//   piagent skills add <owner/repo> [--ref <branch|tag|commit>]
//   piagent skills list [--json]
//   piagent skills update [<owner/repo>]
//   piagent skills remove <owner/repo>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillSourcePlugin, skillSourcesIndex, skillSourcesRoot } from '../packages/piagent-core/runtime/resources/plugin-skills.mjs';

// Short names for sources the team recommends.
export const KNOWN_SOURCES = { mattpocock: 'mattpocock/skills', 'matt-pocock': 'mattpocock/skills' };

function usage() {
  return `Usage:
  piagent skills add <owner/repo> [--ref <branch|tag|commit>]
                                  Add a GitHub skill repository, kept at one commit
                                  (for example: piagent skills add mattpocock/skills)
  piagent skills list [--json]    Skill sources and the skills each one adds
  piagent skills update [<owner/repo>]
                                  Move a source (or all) to the newest commit of its ref
  piagent skills remove <owner/repo>
                                  Stop reading a source and delete its copy

Skills from a source appear in Pi as /skill:<name>, in the company Terminal and
in the dashboard, after the next /reload or new conversation.
`;
}

// owner/repo from what the member typed: owner/repo, a github.com URL, or a known name.
export function parseRepository(value) {
  const typed = KNOWN_SOURCES[String(value ?? '').trim().toLowerCase()] ?? String(value ?? '').trim();
  const match = /^(?:https:\/\/github\.com\/|git:github\.com\/|github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(typed);
  if (!match || match[2] === '.' || match[2] === '..') return null;
  return `${match[1]}/${match[2]}`;
}

const validRef = (ref) => typeof ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes('..');

export function readIndex(home = os.homedir()) {
  try {
    const value = JSON.parse(fs.readFileSync(skillSourcesIndex(home), 'utf8'));
    return { schema_version: 1, sources: Array.isArray(value?.sources) ? value.sources : [] };
  } catch { return { schema_version: 1, sources: [] }; }
}

function writeIndex(index, home) {
  const file = skillSourcesIndex(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...options });
  if (result.error) throw new Error(`git could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim().split('\n').at(-1));
  return result.stdout.trim();
}

// The repository at `ref` (default branch when none), copied without its
// history into <root>/github.com/<owner>/<repo>/<commit>. Returns the entry.
export function fetchSource(repo, { ref, home = os.homedir(), runGit = git } = {}) {
  const url = `https://github.com/${repo}.git`, root = skillSourcesRoot(home);
  const parent = path.join(root, 'github.com', ...repo.split('/'));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, '.incoming-'));
  try {
    const checkout = path.join(staging, 'checkout');
    if (ref && /^[0-9a-f]{40}$/i.test(ref)) {
      fs.mkdirSync(checkout);
      runGit(['init', '-q', checkout]);
      runGit(['-C', checkout, 'fetch', '-q', '--depth', '1', url, ref]);
      runGit(['-C', checkout, 'checkout', '-q', 'FETCH_HEAD']);
    } else {
      runGit(['clone', '-q', '--depth', '1', ...(ref ? ['--branch', ref] : []), url, checkout]);
    }
    const commit = runGit(['-C', checkout, 'rev-parse', 'HEAD']);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('could not read the commit');
    fs.rmSync(path.join(checkout, '.git'), { recursive: true, force: true });
    const target = path.join(parent, commit);
    if (!fs.existsSync(target)) fs.renameSync(checkout, target);
    return { repo, ref: ref ?? null, commit, path: path.relative(root, target), added_at: new Date().toISOString() };
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}

// The skills a source adds, as the agent will see them.
export function sourceSkills(entry, home = os.homedir()) {
  const found = skillSourcePlugin(path.join(skillSourcesRoot(home), entry.path), entry.repo);
  if (!found) return [];
  const names = [];
  const walk = (dir, depth) => {
    if (depth > 4 || names.length >= 400) return;
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) { names.push(path.basename(dir)); return; }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const child of entries) if (child.isDirectory() && !child.name.startsWith('.') && child.name !== 'node_modules') walk(path.join(dir, child.name), depth + 1);
  };
  for (const dir of found.skills) walk(dir, 0);
  return [...new Set(names)].sort();
}

function removeCopy(entry, home) {
  const root = skillSourcesRoot(home), dir = path.resolve(root, entry.path);
  if (dir.startsWith(root + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

function add(repo, { ref, home }) {
  const index = readIndex(home), existing = index.sources.find((item) => item.repo === repo);
  const entry = fetchSource(repo, { ref: ref ?? existing?.ref ?? undefined, home });
  const skills = sourceSkills(entry, home);
  if (!skills.length) {
    removeCopy(entry, home);
    throw new Error(`${repo} has no skill (no SKILL.md under the folders it publishes)`);
  }
  if (existing && existing.path !== entry.path) removeCopy(existing, home);
  index.sources = [...index.sources.filter((item) => item.repo !== repo), { ...entry, name: repo }];
  writeIndex(index, home);
  return { entry, skills, replaced: existing?.commit ?? null };
}

function main(argv, home = os.homedir()) {
  const [command, ...rest] = argv;
  const flag = (name) => { const at = rest.indexOf(name); return at >= 0 ? rest[at + 1] : undefined; };
  const positional = rest.filter((value, at) => !value.startsWith('--') && !(at > 0 && rest[at - 1] === '--ref'));
  if ([undefined, 'help', '--help', '-h'].includes(command)) { process.stdout.write(usage()); return 0; }
  try {
    if (command === 'list') {
      const sources = readIndex(home).sources.map((entry) => ({ ...entry, skills: sourceSkills(entry, home) }));
      if (rest.includes('--json')) { process.stdout.write(`${JSON.stringify({ sources }, null, 2)}\n`); return 0; }
      if (!sources.length) { process.stdout.write('No skill source yet. Add one: piagent skills add mattpocock/skills\n'); return 0; }
      for (const entry of sources) process.stdout.write(`${entry.repo} @ ${entry.commit.slice(0, 12)}${entry.ref ? ` (${entry.ref})` : ''}: ${entry.skills.length} skill(s)\n  ${entry.skills.join(', ')}\n`);
      return 0;
    }
    if (command === 'add') {
      const repo = parseRepository(positional[0]), ref = flag('--ref');
      if (!repo) throw new Error('name a GitHub repository as owner/repo, for example mattpocock/skills');
      if (ref !== undefined && !validRef(ref)) throw new Error('--ref needs a branch, tag or commit');
      const { entry, skills, replaced } = add(repo, { ref, home });
      process.stdout.write(`${replaced && replaced !== entry.commit ? 'Updated' : 'Added'} ${repo} @ ${entry.commit.slice(0, 12)}: ${skills.length} skill(s)\n  ${skills.join(', ')}\n`);
      process.stdout.write('Use them as /skill:<name> after /reload in Pi, or in a new company conversation.\n');
      return 0;
    }
    if (command === 'update') {
      const only = positional[0] ? parseRepository(positional[0]) : null;
      if (positional[0] && !only) throw new Error('name a GitHub repository as owner/repo');
      const targets = readIndex(home).sources.filter((entry) => !only || entry.repo === only);
      if (!targets.length) throw new Error(only ? `${only} is not a skill source` : 'no skill source to update');
      for (const entry of targets) {
        const { entry: next, skills } = add(entry.repo, { ref: entry.ref ?? undefined, home });
        process.stdout.write(`${entry.repo}: ${entry.commit.slice(0, 12)} -> ${next.commit.slice(0, 12)} (${skills.length} skill(s))\n`);
      }
      return 0;
    }
    if (command === 'remove') {
      const repo = parseRepository(positional[0]);
      if (!repo) throw new Error('name a GitHub repository as owner/repo');
      const index = readIndex(home), entry = index.sources.find((item) => item.repo === repo);
      if (!entry) throw new Error(`${repo} is not a skill source`);
      removeCopy(entry, home);
      index.sources = index.sources.filter((item) => item.repo !== repo);
      writeIndex(index, home);
      process.stdout.write(`Removed ${repo}.\n`);
      return 0;
    }
  } catch (error) {
    process.stderr.write(`FAIL: ${error.message}\n`);
    return 1;
  }
  process.stderr.write(usage());
  return 2;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2), os.homedir());

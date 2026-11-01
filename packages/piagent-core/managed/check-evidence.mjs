import path from 'node:path';
import { readPatchDigest } from './patch-snapshot.mjs';
import { itemText, undecided } from './ledger.mjs';
import { changeLane, lanePolicy, patchStats } from './risk-lanes.mjs';

// What passed on which code, repository by repository: a folder can hold several,
// a later small run must not erase a whole-suite pass, and a pass in one repository
// says nothing about a push of another. Also what a push needs first: its review.

const FAST_SUITE_MS = 60_000, MAX_PARTS = 20, PUSH_REVIEWS = 2;
const repositoryNames = self => Object.keys(self.repositoryBases ?? {});
const plain = word => word.replace(/^["']|["']$/g, '');

// The repositories a command goes to, from its `cd` and `git -C`. `known` is false
// when one is a variable: a loop or a function decides it, not the text.
export function commandRepositories(self, command) {
  const names = repositoryNames(self);
  if (!names.length) return { repositories: ['.'], known: true };
  const found = new Set(); let dir = self.cwd, known = true;
  const visit = (word, stay) => {
    const target = plain(word);
    if (target.includes('$')) { known = false; return; }
    const next = path.resolve(dir, target), first = path.relative(self.cwd, next).split(path.sep)[0];
    if (names.includes(first)) found.add(first);
    if (!stay) dir = next;
  };
  for (const match of String(command ?? '').matchAll(/(?:^|[\s;&|(])(cd|git\s+-C)\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) visit(match[2], match[1] !== 'cd');
  return { repositories: [...found], known };
}
const changedRepositories = self => {
  const names = repositoryNames(self);
  return [...new Set([...(self.ownPaths ?? [])].map(file => String(file).split('/')[0]))].filter(name => names.includes(name));
};
// What a push sends: the repositories it names, else the ones this conversation changed.
export function pushRepositories(self, command) {
  const { repositories, known } = commandRepositories(self, command);
  return known && repositories.length ? repositories : changedRepositories(self);
}
// The code of one repository: this conversation's files in it, compared with where it started.
async function repositoryDigest(self, repository) {
  if (repository === '.') return self.digest();
  const scope = new Set([...(self.ownPaths ?? [])].filter(file => String(file).startsWith(`${repository}/`)));
  try { return await (self.scopedDigest ?? (paths => readPatchDigest(self.boundary, paths, self.base, self.repositoryBases)))(scope); } catch { return null; }
}
const entryOf = (run, repository) => { const passes = run.passes ??= new Map(); if (!passes.has(repository)) passes.set(repository, { suite: null, parts: [] }); return passes.get(repository); };

// One test command ended. `part` names its test step, for how long that step takes.
export async function recordCheck(run, self, command, scope, ok, part) {
  if (!self || !scope) return;
  const started = run.checkStarts?.get(command), took = started ? Date.now() - started : null;
  run.checkStarts?.delete(command);
  for (const repository of commandRepositories(self, command).repositories) {
    const digest = await repositoryDigest(self, repository), entry = entryOf(run, repository);
    if (scope === 'suite') {
      entry.suite = ok ? { digest, command } : null;
      if (ok) run.fullFor?.delete(repository);
      if (ok && took !== null) (self.checkTimes ??= new Map()).set(`${repository}\u0000${part}`, took);
    } else if (ok) entry.parts = [...entry.parts, { digest, command }].slice(-MAX_PARTS);
  }
}
export function markCheckStart(run, command) { (run.checkStarts ??= new Map()).set(command, Date.now()); }

// A whole suite this conversation has seen pass quickly is not worth a detour.
export function knownFast(self, command, part) {
  const times = self.checkTimes, { repositories } = commandRepositories(self, command);
  return !!times && repositories.length > 0 && repositories.every(repository => times.get(`${repository}\u0000${part}`) < FAST_SUITE_MS);
}

// The repositories whose whole suite has not passed on their current code.
export async function missingSuites(self, run, repositories) {
  const missing = [];
  for (const repository of repositories) {
    const digest = await repositoryDigest(self, repository), pass = run.passes?.get(repository)?.suite;
    if (!(pass && digest !== null && pass.digest === digest)) missing.push(repository);
  }
  return missing;
}
const minutes = ms => Math.max(1, Math.round(ms / 60_000));
// The member decides from this: what ran, what did not, what changed, how long the rest takes.
export async function pushQuestion(self, run, repositories, missing) {
  const name = repository => repository === '.' ? 'repo này' : repository;
  const lines = [`Sắp push${repositories.length && repositories[0] !== '.' ? ` ${repositories.join(', ')}` : ' code'} nhưng toàn bộ test chưa pass trên code này.`];
  const passed = repositories.filter(repository => !missing.includes(repository));
  if (passed.length) lines.push(`Đã pass toàn bộ: ${passed.map(name).join(', ')}.`);
  const partly = [], none = [];
  for (const repository of missing) {
    const digest = await repositoryDigest(self, repository), count = (run.passes?.get(repository)?.parts ?? []).filter(p => digest !== null && p.digest === digest).length;
    if (count) partly.push(`${name(repository)} (${count} lệnh)`); else none.push(name(repository));
  }
  if (partly.length) lines.push(`Mới pass một phần: ${partly.join(', ')}.`);
  if (none.length) lines.push(`Chưa có test nào pass trên code hiện tại: ${none.join(', ')}.`);
  const files = self.ownPaths?.size ?? 0;
  if (files) lines.push(`Phiên này đổi ${files} file.`);
  const took = [...(self.checkTimes ?? new Map())].filter(([key]) => missing.includes(key.split('\u0000')[0])).map(([, ms]) => ms);
  if (took.length) lines.push(`Lần chạy toàn bộ gần nhất mất khoảng ${minutes(Math.max(...took))} phút.`);
  return lines.join('\n');
}

// The checks worth naming: those of the repositories this conversation changed,
// not of every repository that happens to sit in the folder.
export function relevantChecks(self, commands) {
  const changed = new Set([...(self.ownPaths ?? [])].map(file => String(file).split('/')[0]));
  if (!changed.size) return commands;
  const kept = commands.filter(command => { const dir = String(command).match(/^cd '([^']+)'/)?.[1]; return !dir || changed.has(dir.split('/')[0]); });
  return kept.length ? kept : commands;
}

// Before a push under a required review: a finding is cheap now and costs a release
// after. The patch the turn's end would review is the same, so it is reviewed once.
export async function reviewBeforePush(self, run, signal) {
  if (!self.delegate || !self.patchDigest || run.reviewSettled) return;
  const code = await self.digest();
  if (run.startDigest === null || code === null || code === run.startDigest) return;
  let policy = run.policy;
  if (policy.lanes) { let stats = null; try { stats = patchStats(await self.patchSnapshot?.()); } catch { /* unreadable: standard */ } policy = lanePolicy(policy, changeLane(stats, run)); }
  if (policy.review !== 'require') return;
  let patch = null; try { patch = await self.patchDigest(); } catch { return; }
  const fresh = !!self.review && !self.review.stale && self.review.patchDigest === patch;
  if (!fresh) {
    if ((run.pushReviews ?? 0) >= PUSH_REVIEWS) return;
    run.pushReviews = (run.pushReviews ?? 0) + 1;
    self.session?.sessionManager?.appendCustomEntry?.('agent-watch-review-start', {});
    // A review that cannot run does not hold the push: the turn's status says so.
    try { await self.delegate({ role: 'review', task: "Review the current patch against the member's request. The main agent is about to push it: report what must change before it leaves this machine." }, signal, { harness: true }); }
    catch (error) { if (signal?.aborted) throw error; return; }
  }
  const pending = undecided(run).filter(item => item.source === 'review');
  if (pending.length) throw Error(`managed-review-before-push: this command did not run. The review of the code you are pushing has ${pending.length} finding(s) with no decision:\n${pending.map(item => '- ' + itemText(item)).join('\n')}\nFix each, or reject it with resolve_objection (what you checked and why), then push again.`);
}

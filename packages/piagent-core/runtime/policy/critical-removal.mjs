// What Always bypass asks about besides commit and push: an rm or rmdir whose
// target is a critical path, by the rules of Claude's bypassPermissions
// (permission-modes, "Critical paths" and "The mounted drive prompt"). A text
// check, not a boundary: other commands and scripts can delete these paths too.
import fs from 'node:fs';
import path from 'node:path';
import { evaluateExecPolicyCore } from '../../extensions/policy-core.js';
import { astCommands } from '../../extensions/shell-ast.js';
import { executable } from './handoff-policy.mjs';

const TOP_LEVEL = new Set(['bin', 'boot', 'dev', 'etc', 'home', 'lib', 'lib64', 'media', 'mnt', 'opt', 'proc', 'root', 'run', 'sbin', 'srv', 'sys', 'tmp', 'usr', 'var', 'Applications', 'Library', 'System', 'Users', 'Volumes', 'private']);
const DIRECTORY_PRINTER = /(?:^|[\s;&|(])([A-Za-z_]\w*)=["']?(?:\$\(|`)\s*(?:pwd|git\s+rev-parse\s+--show-toplevel|dirname\b|realpath\b)/g;
const MOUNTED = [/^\/Volumes\/[^/]+(\/[^/]+)?$/, /^\/System\/Volumes(\/[^/]+){0,2}$/, /^\/media\/[^/]+(\/[^/]+){0,2}$/, /^\/run\/media(\/[^/]+){0,3}$/, /^\/mnt\/[^/]+$/, /^\/mnt\/[A-Za-z]\/[^/]+$/];
const DYNAMIC = /\$(?:\(…\)|[A-Za-z_@*#?!\d]\w*)/;
const onlyDynamic = /^\$(?:\(…\)|[A-Za-z_@*#?!\d]\w*)$/;

// On Windows the checks below see one spelling of a path: `D:\\a\\B`, `d:/a/b` and
// Git Bash's `/d/a/b` are all `/d:/a/b`.
function comparable(value) {
  if (process.platform !== 'win32') return value;
  return value.replace(/\\/g, '/').toLowerCase().replace(/^\/?([a-z]):?(?=\/|$)/, (_, drive) => `/${drive}:`);
}

// `{/,}` is `/` by the time it runs.
function expanded(word) {
  const brace = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(word);
  return brace ? brace[2].split(',').flatMap(part => expanded(brace[1] + part + brace[3])) : [word];
}
function parseTargets(args) {
  const targets = []; let recursive = false, options = true;
  for (const arg of args) {
    if (options && arg === '--') options = false;
    else if (options && arg.startsWith('-') && arg !== '-') recursive ||= arg === '--recursive' || (!arg.startsWith('--') && /[rR]/.test(arg));
    else targets.push(arg);
  }
  return { targets, recursive };
}

function isCritical(target, cwd, home) {
  if (target === '/' || path.posix.dirname(target) === '/') return true;
  return target === home || target === cwd || cwd.startsWith(`${target}/`);
}

// Why this one target needs the member, or null.
function targetReason(raw, { cwd, project, home, recursive, guarded, printers, singleQuotedScript, afterCd }) {
  const DANGER = text => `Dangerous rm operation on critical path: ${text}`;
  if (/^\\+$/.test(raw)) return DANGER(raw);
  let word = raw.replace(/^~(?=\/|$)/, home).replace(/\$\{?HOME\}?(?=\/|$)/, home).replace(/\$\{?PWD\}?(?=\/|$)/, cwd);
  if (/^~/.test(word)) return DANGER(raw);
  for (const name of printers) if (new RegExp(`\\$${name}(?:\\b|/|$)`).test(word)) return `Dangerous rm operation: ${raw} comes from a directory-printing substitution`;
  const dynamic = DYNAMIC.exec(word);
  if (dynamic) {
    const name = dynamic[0].slice(1), positional = /^[@*\d#]/.test(name);
    if (onlyDynamic.test(word) && word.includes('(…)') && recursive) return `Dangerous rm operation: ${raw} is only the output of a command`;
    const under = /^\$[^/]*\/(\*(\/\*)*\/?)?$/.test(word), glob = under && !(guarded.has(name) || (positional && singleQuotedScript));
    if (glob) return `Dangerous rm operation: ${raw} removes from the filesystem root when the variable is empty`;
    if (/^\$[^/]+\/[^/]+$/.test(word) && TOP_LEVEL.has(word.split('/')[1]) && !guarded.has(name)) return DANGER(`${raw} (/${word.split('/')[1]} when the variable is empty)`);
    const before = word.slice(0, dynamic.index);
    // A trailing substitution: the path that remains when it expands empty.
    if (word.slice(dynamic.index) === dynamic[0] && before.startsWith('/') && isCritical(path.posix.resolve(comparable(before)), cwd, home)) return DANGER(raw);
    return null;
  }
  const glob = /\/?\*\/?$/.test(word) || word === '*';
  if (glob && (/\*\/(\*\/?)?$/.test(word) || (afterCd && !word.startsWith('/')))) return `Dangerous rm operation: ${raw} cannot be checked before the command runs`;
  const literal = word.replace(/\/?\*$/, '') || (word.startsWith('/') ? '/' : '.');
  const resolved = path.posix.resolve(cwd, comparable(literal));
  if (isCritical(resolved, cwd, home) || isCritical(resolved, project, home)) return DANGER(raw);
  if ((recursive || glob) && MOUNTED.some(rule => rule.test(resolved))) return `Dangerous rm operation on mounted drive path: ${raw}`;
  return null;
}

// Why this command must be asked about in Always bypass, or null.
export function criticalRemovalReason(command, options) {
  const cwd = comparable(options.cwd), home = comparable(options.home);
  const text = String(command), commands = astCommands(text);
  if (commands === null) return /\b(rm|rmdir)\b/.test(text) ? 'Dangerous rm operation not ruled out: the shell may read this command differently than it was parsed' : null;
  const guarded = new Set([...text.matchAll(/\$\{([A-Za-z_]\w*):\?/g)].map(match => match[1]));
  const printers = new Set([...text.matchAll(DIRECTORY_PRINTER)].map(match => match[1]));
  const singleQuotedScript = /\s-[a-z]*c\s+'/.test(text);
  let base = cwd, afterCd = false;
  for (const { words } of commands) {
    const [name, ...args] = executable(words), program = String(name ?? '').split('/').pop();
    if (program === 'cd') {
      afterCd = true;
      if (args[0] && !DYNAMIC.test(args[0])) base = path.posix.resolve(base, comparable(args[0].replace(/^~(?=\/|$)/, home)));
      continue;
    }
    if (program !== 'rm' && program !== 'rmdir') continue;
    const { targets, recursive } = parseTargets(args);
    for (const target of targets.flatMap(expanded)) {
      const reason = targetReason(target, { cwd: base, project: cwd, home, recursive, guarded, printers, singleQuotedScript, afterCd });
      if (reason) return reason;
    }
  }
  return null;
}

// A project's own refusals (profile `autoDeny`) in a company session, as a deny
// rule holds in every mode: the reason, or null.
export function projectDenyReason(command, cwd) {
  let profile;
  try { profile = JSON.parse(fs.readFileSync(path.join(cwd, '.pi', 'piagent-profile.json'), 'utf8')); } catch { return null; }
  const rules = (Array.isArray(profile?.autoDeny) ? profile.autoDeny : []).filter(rule => typeof rule?.pattern === 'string' && rule.pattern.trim())
    .map((rule, index) => ({ id: `auto-deny-${index + 1}`, action: 'forbid', match: rule.match ?? 'contains', value: rule.pattern, reason: String(rule.reason ?? "Refused by this project's autoDeny rule") }));
  if (!rules.length) return null;
  const refused = evaluateExecPolicyCore(String(command), { policy: { execPolicy: { defaultMode: 'enforce', bannedPrefixSuggestions: [], rules } }, mode: 'enforce' });
  return refused.decision === 'forbid' ? refused.reasons[0] ?? 'Refused by this project' : null;
}

// Claude's time limit: two minutes, then a denial that lets the work go on; after
// three unanswered prompts, denied at once until the member sends a message.
export const REMOVAL_TTL_MS = 120_000;
export const REMOVAL_EXPIRED = 'the member did not answer within two minutes, so this removal did not run. Carry on with the rest of the work: name the exact paths to remove instead, or leave the removal to the member and say so.';
const unanswered = new Map();
const memberMessages = manager => (manager?.getEntries?.() ?? []).filter(entry => entry.type === 'message' && entry.message?.role === 'user').length;
const current = (id, manager) => {
  const turn = memberMessages(manager), held = unanswered.get(id);
  if (held?.turn === turn) return held;
  const fresh = { turn, count: 0 }; unanswered.set(id, fresh); return fresh;
};
export const removalsHeld = (id, manager) => current(id, manager).count >= 3;
export const noteRemovalExpired = (id, manager) => { current(id, manager).count += 1; };

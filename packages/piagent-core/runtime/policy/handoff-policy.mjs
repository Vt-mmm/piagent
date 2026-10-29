// What every permission mode still asks about, Bypass included (owner,
// 2026-10-29: "Bypass bypasses the work and stops at the handoff").
//
// handoffReason: the work leaves this machine. A push, a pull request or a
// merge, a release, a package publish, a deploy, a registry push or login, a
// remote shell, a cloud or cluster tool, an upload. Asked in every mode, in
// personal and company sessions alike.
// mustConfirm: the handoff plus what is destructive or irreversible here:
// database migrations, deletes whose target is only known at run time,
// removing Docker volumes, sudo. Asked in Full access; Bypass runs these.
//
// Both read the command through the shared shell parser (policy-core.js), so
// `git -C api push`, `env X=1 git push` and `cd api && git push` are one push.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateExecPolicyCore, stripWrapper } from '../../extensions/policy-core.js';
import { gitSubcommandWords } from '../../extensions/shell-command-words.js';

export { stripWrapper };

const POLICY = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../policies/base-policy.json', import.meta.url)), 'utf8'));
// Local, reversible exec-policy prompts that Full access runs without asking
// (personal and company sessions).
export const FULL_ACCESS_RUNS = new Set(['prompt-git-add-broad']);
// requireConfirmationPatterns that are not a handoff: they stay with mustConfirm.
const LOCAL_PATTERNS = new Set(['migration']);
// Tools that reach other machines or accounts.
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'firebase', 'aws', 'gcloud', 'gsutil', 'az',
  'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'eas', 'wrangler', 'supabase', 'railway', 'render', 'doctl']);
// Package runners: the package they run is the command (`npx vercel deploy`).
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
// Commands that run the command after them, with the options that take a value.
const LAUNCHERS = new Map([['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])], ['xargs', new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a'])],
  ['watch', new Set(['-n', '--interval', '-d'])], ['caffeinate', new Set(['-t', '-w'])]]);
const PUBLISHERS = [['cargo', 'publish'], ['twine', 'upload'], ['gem', 'push'], ['pod', 'trunk', 'push'], ['dotnet', 'nuget', 'push'], ['mvn', 'deploy'],
  ['gradle', 'publish'], ['gradlew', 'publish'], ['poetry', 'publish'], ['uv', 'publish'], ['flutter', 'pub', 'publish'], ['dart', 'pub', 'publish'], ['vsce', 'publish'], ['ovsx', 'publish']];

const parse = command => evaluateExecPolicyCore(String(command), { policy: POLICY, mode: 'enforce' });
// The simple commands a shell line runs, as the shared parser reads them
// (inline `bash -c`, substitutions and compound statements included).
export const commandSegments = command => parse(command).segments;

function executable(words) {
  let current = stripWrapper(words);
  for (;;) {
    if (RUNNERS.has(current[0]) || (['pnpm', 'yarn'].includes(current[0]) && current[1] === 'dlx')) {
      current = current.slice(current[0] === 'pnpm' || current[0] === 'yarn' ? 2 : 1);
      while (current[0]?.startsWith('-')) current = current.slice(1);
    } else if (LAUNCHERS.has(current[0])) {
      const valued = LAUNCHERS.get(current[0]), duration = current[0] === 'timeout';
      current = current.slice(1);
      while (current[0]?.startsWith('-')) current = current.slice(valued.has(current[0]) ? 2 : 1);
      if (duration) current = current.slice(1);
    } else break;
    current = stripWrapper(current);
  }
  return gitSubcommandWords(current);
}
const positional = args => args.filter(arg => !arg.startsWith('-'));

function segmentHandoff(words) {
  const [name, ...args] = executable(words);
  const sub = positional(args);
  if (!name) return null;
  if (REMOTE.has(name)) return `${name} reaches another machine or account`;
  if (name === 'git') {
    if (words.some((word, index) => (word === '-c' && /^alias\./i.test(words[index + 1] ?? '')) || /^-calias\./i.test(word))) return 'git runs an alias defined in the command';
    if (['push', 'send-email', 'request-pull'].includes(sub[0])) return `git ${sub[0]} sends to a remote`;
    if (['subtree', 'lfs'].includes(sub[0]) && sub[1] === 'push') return `git ${sub[0]} push sends to a remote`;
    return null;
  }
  if (name === 'rsync' && args.some(arg => /^[^/\s]*:/.test(arg) && !arg.startsWith('-'))) return 'rsync to another machine';
  if (['docker', 'podman'].includes(name)) {
    if (['push', 'login'].includes(sub[0])) return `${name} ${sub[0]} sends to a registry`;
    if (args.includes('--push')) return `${name} build --push sends to a registry`;
    return null;
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && (sub[0] === 'publish' || (sub[0] === 'npm' && sub[1] === 'publish'))) return `${name} publish uploads a package`;
  const publisher = PUBLISHERS.find(entry => entry[0] === name.replace(/^\.\//, '') && entry.slice(1).every((word, index) => sub[index] === word));
  if (publisher) return `${publisher.join(' ')} uploads a package`;
  return null;
}

// Why this command hands the work off (asked in every mode), or null.
export async function handoffReason(command) {
  const result = parse(command);
  const pattern = result.reasons.find(reason => reason.startsWith('Confirmation required: the command runs ')
    && !LOCAL_PATTERNS.has(reason.slice('Confirmation required: the command runs '.length)));
  if (pattern) return pattern;
  for (const segment of result.segments) {
    const reason = segmentHandoff(segment.words);
    if (reason) return reason;
  }
  const { findShellExternalConfirmationReason } = await import('../../extensions/guard-shell-analysis.ts');
  return findShellExternalConfirmationReason(result.segments, { defaultMode: 'enforce', ...POLICY.externalActionPolicy }) ?? null;
}

// Why Full access must still ask about this command, or null.
export async function mustConfirm(command) {
  const handoff = await handoffReason(command);
  if (handoff) return handoff;
  const result = parse(command);
  const kept = result.reasons.filter(reason => ![...FULL_ACCESS_RUNS].some(id => reason.startsWith(`Prompt required by exec policy ${id}:`)));
  if (result.decision !== 'allow' && kept.length) return kept[0];
  if (result.segments.some(segment => ['sudo', 'doas'].includes(segment.words.find(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))))) return 'sudo runs as another user';
  return null;
}

// Whether an MCP tool writes to the system behind its server, read from the
// tool's name with the verbs personal Piagent's guard uses
// (base-policy.json externalActionPolicy): the verb, or null.
export async function mcpWriteAction(tool) {
  const { actionTokens, classifyActionTokenSequence } = await import('../../extensions/guard-shell-analysis.ts');
  const result = classifyActionTokenSequence(actionTokens(String(tool)), { defaultMode: 'enforce', ...POLICY.externalActionPolicy });
  return result.kind === 'write' ? result.action : null;
}

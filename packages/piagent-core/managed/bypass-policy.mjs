// What a company conversation in "Bypass" mode still asks the member about
// (owner, 2026-10-07: a member who chose bypass is not asked again, except for
// what must be confirmed). Everything else runs without asking.
// Always asked: anything that changes or sends data outside this machine
// (git push, publish, deploy, a request that uploads or writes, remote
// shells, cloud and cluster tools), database migrations, deletes whose
// target is only known at run time, removing Docker volumes, and sudo.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateExecPolicyCore } from '../extensions/policy-core.js';

const POLICY = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../policies/base-policy.json', import.meta.url)), 'utf8'));
// Exec-policy prompts a member in bypass may skip: local, reversible.
const BYPASSABLE_RULES = new Set(['prompt-git-add-broad']);
// Tools that reach other machines or accounts; none runs without asking.
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'sudo', 'doas', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'firebase', 'aws', 'gcloud', 'gsutil', 'az',
  'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'eas', 'wrangler', 'supabase', 'railway', 'render', 'doctl']);
const basename = word => String(word ?? '').split('/').pop();
const WRAPPERS = new Set(['env', 'command', 'exec', 'time', 'nohup', 'npx', 'bunx', 'pnpx']);
function executable(words) {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(basename(words[i])) || words[i].startsWith('-'))) i += 1;
  return { name: basename(words[i]), args: words.slice(i + 1) };
}

// Why this command must still be confirmed, or null when bypass may run it.
export async function mustConfirm(command) {
  const result = evaluateExecPolicyCore(String(command), { policy: POLICY, mode: 'enforce' });
  const kept = result.reasons.filter(reason => ![...BYPASSABLE_RULES].some(id => reason.startsWith(`Prompt required by exec policy ${id}:`)));
  if (result.decision !== 'allow' && kept.length) return kept[0];
  const { findShellExternalConfirmationReason } = await import('../extensions/guard-shell-analysis.ts');
  const external = findShellExternalConfirmationReason(result.segments, { defaultMode: 'enforce', ...POLICY.externalActionPolicy });
  if (external) return external;
  for (const segment of result.segments) {
    const { name, args } = executable(segment.words);
    if (REMOTE.has(name)) return `${name} reaches another machine or account`;
    if (name === 'rsync' && args.some(arg => /^[^/\s]*:/.test(arg) && !arg.startsWith('-'))) return 'rsync to another machine';
    if (name === 'docker' && ['push', 'login'].includes(args.find(arg => !arg.startsWith('-')))) return `docker ${args.find(arg => !arg.startsWith('-'))} sends to a registry`;
    if (name === 'git' && args.some(arg => ['push', 'send-email', 'request-pull'].includes(arg))) return 'git sends to a remote';
  }
  return null;
}

// Risk lanes (the Harness's workflow.lanes, on unless Studio sets it false):
// the configured policy is the standard lane, sized on the patch the run made.
// A tiny change (few files and lines, nothing sensitive) ends after its
// checks, without a review; a risky one (a complex request, a sensitive file,
// a wide patch) has a suggested check and review required. "off" stays off.
export const LANE_LIMITS = Object.freeze({ tinyFiles: 2, tinyLines: 40, riskyFiles: 12, riskyLines: 400 });
const SENSITIVE = /(^|\/)(migrations?|auth|security|secrets?|permissions?|\.github|infra|terraform|helm|k8s)(\/|$)|(^|\/)(Dockerfile|docker-compose[^/]*|\.gitlab-ci\.yml|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|uv\.lock|AGENTS\.md|\.env[^/]*)$|\.(sql|tf|pem|key)$/i;
export const sensitivePath = file => SENSITIVE.test(String(file ?? ''));
// Files and changed lines of a patch snapshot (readPatchSnapshot); null when
// it cannot be read. A new text file counts its lines, a binary one as one.
export function patchStats(snapshot) {
  let value;
  try { value = JSON.parse(snapshot?.patch); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const paths = new Set(); let lines = 0;
  for (const line of String(value.patch ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) paths.add(line.match(/^diff --git a\/(.+) b\/\1$/)?.[1] ?? line.slice(11));
    else if (/^[+-]/.test(line) && !/^(\+\+\+|---) /.test(line)) lines += 1;
  }
  for (const file of Array.isArray(value.untracked) ? value.untracked : []) {
    if (typeof file?.path !== 'string') continue;
    paths.add(file.path); lines += file.encoding === 'utf8' ? String(file.contents ?? '').split('\n').filter((l, i, all) => l || i < all.length - 1).length : 1;
  }
  return { files: paths.size, lines, paths: [...paths] };
}
// An unreadable patch is standard: the configured policy applies.
export function changeLane(stats, { complex = false } = {}) {
  if (!stats) return 'standard';
  const L = LANE_LIMITS;
  if (complex || stats.paths.some(sensitivePath) || stats.files > L.riskyFiles || stats.lines > L.riskyLines) return 'risky';
  return stats.files <= L.tinyFiles && stats.lines <= L.tinyLines ? 'tiny' : 'standard';
}
export function lanePolicy(policy, lane) {
  if (!policy.lanes || lane === 'standard') return policy;
  if (lane === 'tiny') return { ...policy, review: 'off' };
  const up = mode => mode === 'suggest' ? 'require' : mode;
  return { ...policy, verify: up(policy.verify), review: up(policy.review) };
}

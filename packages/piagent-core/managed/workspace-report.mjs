import { CLIENT_AGENT } from './client-agent.mjs';
import { findRepositories } from './memory-repos.mjs';
import { hasCapability } from './studio-capabilities.mjs';

// Tells Studio which repositories a company conversation works in, once per
// conversation, with the run's token (POST /studio/v1/managed/workspace).
// Studio warns its administrators when a repository does not belong to the
// key's team (Logs → "Sai project"); the member sees one line in the
// dashboard and in piagent studio (agent-watch-project). Repositories are
// sent as memory already sends them (host/path of the remote, never a local
// path), only to a Studio that serves it (managed.workspace.v1). Nothing
// here can fail a turn.
export const PROJECT_ENTRY = 'agent-watch-project';
const SHOWN = new Set(['other_team', 'unlisted']), ATTEMPTS = 3;

export function reportWorkspace(owner, token, { fetchImpl = fetch, find = findRepositories, now = Date.now } = {}) {
  const state = owner.workspaceReport ??= { done: false, sending: null, attempts: 0 };
  if (state.done || state.sending || !token || !owner.cwd || !owner.origin || !hasCapability(owner, 'managed.workspace.v1')) return null;
  const retry = () => { if ((state.attempts += 1) >= ATTEMPTS) state.done = true; };
  state.sending = (async () => {
    try {
      const { repos, folder } = await find(owner.cwd);
      const body = repos.length ? { repositories: repos.map(repo => repo.key) } : { repositories: [], ...(folder ? { folder } : {}) };
      const response = await fetchImpl(`${owner.origin}/studio/v1/managed/workspace`, { method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT }, body: JSON.stringify(body) });
      // A Studio without the route, or one refusing the body, would answer the same again.
      if (response.status === 400 || response.status === 404 || response.status === 405) { state.done = true; return; }
      if (!response.ok) { retry(); return; }
      state.done = true;
      const answer = await response.json().catch(() => null);
      const warnings = (Array.isArray(answer?.warnings) ? answer.warnings : [])
        .filter(warning => SHOWN.has(warning?.kind) && typeof warning.repo_key === 'string' && warning.repo_key)
        .slice(0, 6).map(warning => ({ repo: warning.repo_key.slice(0, 200), kind: warning.kind }));
      const team = typeof answer?.team === 'string' ? answer.team.slice(0, 80) : null;
      recordProjectWarnings(owner.session?.sessionManager, warnings, team, now);
      if (warnings.length) owner.notify?.({ type: 'managed_project_warning', warnings, team });
    } catch { retry(); }
    finally { state.sending = null; }
  })();
  return state.sending;
}

// Kept with the conversation, so the dashboard shows it without the runtime;
// a later report without warnings clears the line.
export function recordProjectWarnings(manager, warnings, team, now = Date.now) {
  if (!manager) return;
  const last = manager.getEntries().filter(e => e.type === 'custom' && e.customType === PROJECT_ENTRY).at(-1)?.data;
  if (!last && !warnings.length) return;
  if (last && JSON.stringify(last.warnings ?? []) === JSON.stringify(warnings) && (last.team ?? null) === team) return;
  manager.appendCustomEntry(PROJECT_ENTRY, { warnings, team, at: new Date(now()).toISOString() });
}

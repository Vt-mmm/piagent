import { CLIENT_AGENT } from './client-agent.mjs';
import { findRepositories } from './memory-repos.mjs';
import { findProjects, folderName } from './workspace-projects.mjs';
import { hasCapability } from './studio-capabilities.mjs';

// Tells Studio which projects a company conversation works in, once per run
// (a run is one turn), with the run's token (POST /studio/v1/managed/workspace).
// Studio warns its administrators when a project does not belong to the key's
// team (Logs → "Sai project"), and lists a key and computer whose runs never
// report; the member sees one line in the dashboard and in piagent studio
// (agent-watch-project). Repositories are sent as memory sends them
// (host/path of the remote). A Studio with managed.workspace.v2 also gets
// folders without a readable remote as local projects (workspace-projects.mjs)
// with their folder names; a path never leaves the computer. Nothing here can
// fail a turn.
export const PROJECT_ENTRY = 'agent-watch-project';
const KINDS = new Set(['other_team', 'unlisted', 'unregistered', 'no_repository']), V1_SHOWN = new Set(['other_team', 'unlisted']), ATTEMPTS = 3;

export function reportWorkspace(owner, token, { run = null, fetchImpl = fetch, find = findRepositories, projects = findProjects, now = Date.now } = {}) {
  if (!token || !owner.cwd || !owner.origin || owner.workspaceUnsupported || !hasCapability(owner, 'managed.workspace.v1')) return null;
  // A new run reports again; a run reports once.
  if (owner.workspaceReport && owner.workspaceReport.run !== run && !owner.workspaceReport.sending) owner.workspaceReport = null;
  const state = owner.workspaceReport ??= { run, done: false, sending: null, attempts: 0 };
  if (state.done || state.sending) return null;
  const retry = () => { if ((state.attempts += 1) >= ATTEMPTS) state.done = true; };
  const v2 = hasCapability(owner, 'managed.workspace.v2');
  state.sending = (async () => {
    try {
      let body, names = new Map();
      if (v2) {
        const found = await projects(owner.cwd);
        for (const project of found) if (project.name) names.set(project.key, project.name);
        body = found.length ? { repositories: found.map(project => project.key), ...(names.size ? { names: Object.fromEntries(names) } : {}) }
          : { repositories: [], folder: 'not_a_repository' };
      } else {
        const { repos, folder } = await find(owner.cwd);
        body = repos.length ? { repositories: repos.map(repo => repo.key) } : { repositories: [], ...(folder ? { folder } : {}) };
      }
      const response = await fetchImpl(`${owner.origin}/studio/v1/managed/workspace`, { method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT }, body: JSON.stringify(body) });
      // A Studio without the route, or one refusing the body, would answer the
      // same again, on this run and the next ones.
      if (response.status === 400 || response.status === 404 || response.status === 405) { state.done = true; owner.workspaceUnsupported = true; return; }
      if (!response.ok) { retry(); return; }
      state.done = true;
      const answer = await response.json().catch(() => null);
      const shown = v2 ? KINDS : V1_SHOWN, here = folderName(owner.cwd) ?? owner.cwd;
      const warnings = (Array.isArray(answer?.warnings) ? answer.warnings : [])
        .filter(warning => shown.has(warning?.kind) && (warning.kind === 'no_repository' || (typeof warning.repo_key === 'string' && warning.repo_key)))
        .slice(0, 6).map(warning => {
          const repo = warning.kind === 'no_repository' ? here : warning.repo_key;
          const name = typeof warning.project_name === 'string' && warning.project_name.trim() ? warning.project_name.trim() : names.get(repo);
          return { repo: repo.slice(0, 200), kind: warning.kind, ...(name && name !== repo ? { name: name.slice(0, 80) } : {}) };
        });
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

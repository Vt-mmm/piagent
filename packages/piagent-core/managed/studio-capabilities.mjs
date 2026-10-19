import fs from 'node:fs';
import path from 'node:path';
import { CLIENT_AGENT } from './client-agent.mjs';
import { memoryScope, scopeID } from './memory-outbox.mjs';

// What this Studio serves beyond the base API (GET /v1/capabilities, Agent
// Studio 0.34+): one name per contract and version, such as
// "requests.cancel.v1" or "memory.v3". Piagent uses a newer operation only
// when its name is listed. A Studio without the route (404, older than
// 0.34) has no list: callers keep their old behaviour for it. Names Piagent
// does not know are ignored; a failed read keeps the last answer this Mac
// had for the same Studio scope. Asked when a round
// starts, at most once an hour, kept in <agentDir>/studio-capabilities.json.
const FRESH_MS = 3_600_000, KEEP_MS = 7 * 24 * 3_600_000, TIMEOUT_MS = 3_000;
const NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*\.v[0-9]+$/;
const FILE = 'studio-capabilities.json';

function read(stateDir, scope, now) {
  try {
    const k = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'));
    if (k.scope !== scopeID(scope) || !k.scope || (k.names !== null && !Array.isArray(k.names)) || now - k.at > KEEP_MS) return null;
    return k;
  } catch { return null; }
}

// The capabilities last heard from this Studio scope on this Mac, or null
// when there is no list (none heard, long ago, or a Studio older than 0.34).
export function knownCapabilities(stateDir, origin, manifest, now = Date.now()) {
  const scope = memoryScope(origin, manifest);
  const k = stateDir && scope ? read(stateDir, scope, now) : null;
  return k?.names ? new Set(k.names) : null;
}

export const hasCapability = (self, name) => !!self?.capabilities?.has(name);

// Refreshes self.capabilities for the round's grant; never fails the round.
export async function refreshCapabilities(self, grant, { agentDir = self.agentDir, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now() } = {}) {
  const scope = memoryScope(self.origin, self.manifest);
  const known = agentDir && scope ? read(agentDir, scope, now) : null;
  if (known) self.capabilities = known.names ? new Set(known.names) : null;
  if (known && now - known.at < FRESH_MS) return self.capabilities ?? null;
  if (!grant?.token || !self.origin) return self.capabilities ?? null;
  try {
    const response = await fetchImpl(`${self.origin}/v1/capabilities`, { signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Authorization: `Bearer ${grant.token}`, Accept: 'application/json', 'User-Agent': CLIENT_AGENT } });
    let names;
    if (response.status === 404) { void response.body?.cancel?.().catch(() => {}); names = null; }
    else if (response.ok) {
      const answer = await response.json();
      names = Array.isArray(answer?.capabilities) ? answer.capabilities.filter(n => typeof n === 'string' && NAME.test(n)).slice(0, 200) : [];
    } else { void response.body?.cancel?.().catch(() => {}); return self.capabilities ?? null; }
    self.capabilities = names ? new Set(names) : null;
    if (agentDir && scope) {
      const file = path.join(agentDir, FILE), temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ scope: scopeID(scope), at: now, names }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    }
  } catch { /* the last answer, if any, stays */ }
  return self.capabilities ?? null;
}

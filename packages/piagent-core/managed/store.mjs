import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// One conversation store per member per Studio on this machine. Agent Watch
// gives every key its own slot (the binding's profile_id); conversations must
// not split with it. The store is a slot folder: the one the member already
// has conversations in, or the first slot they use. Every slot of that member
// points at it (`<slot>/store`), so a new key lists and continues the same
// conversations. Another member, or another Studio, gets another store.
const SLOT = /^[a-f0-9]{64}$/;

// Where Agent Watch keeps a member's company data on this machine: the macOS
// app's support folder; on Linux, and so in WSL, the XDG data folder.
export function agentWatchDataDirectory(home, environment = process.env) {
  return process.platform === 'linux' ? path.join(environment.XDG_DATA_HOME || path.join(home, '.local/share'), 'agentwatch')
    : path.join(home, 'Library/Application Support/AgentWatch');
}
// What a Windows program (Agent Watch's broker) needs to start from WSL; a
// clean environment otherwise drops it.
export function interopEnvironment(environment = process.env) {
  return Object.fromEntries(['WSL_INTEROP', 'WSL_DISTRO_NAME'].filter(name => environment[name]).map(name => [name, environment[name]]));
}
const read = file => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return null; } };
const write = (file, value) => { fs.writeFileSync(file, value + '\n', { mode: 0o600 }); };
const sessionFiles = dir => { try { return fs.readdirSync(path.join(dir, 'sessions')).filter(name => name.endsWith('.jsonl')); } catch { return []; } };

export function memberId(origin, userId) {
  if (typeof origin !== 'string' || !origin || typeof userId !== 'string' || !userId) return null;
  return createHash('sha256').update(`piagent-company-member-v1\0${origin}\0${userId.toLowerCase()}`).digest('hex');
}

// The store a slot already points at, without asking anyone. Null until the
// slot has been launched once.
export function storedSlot(root, slot) {
  if (!SLOT.test(String(slot))) return null;
  const target = read(path.join(root, slot, 'store'));
  return target && SLOT.test(target) && fs.existsSync(path.join(root, target)) ? target : null;
}

// A slot from before stores existed has no member file: its conversations
// record who started them.
function memberOf(root, slot) {
  const dir = path.join(root, slot), known = read(path.join(dir, 'member'));
  if (known && SLOT.test(known)) return known;
  for (const name of sessionFiles(dir).slice(0, 20)) {
    let text;
    try { const fd = fs.openSync(path.join(dir, 'sessions', name), 'r'); const buffer = Buffer.alloc(65536); text = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'); fs.closeSync(fd); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"agent-watch-scope"')) continue;
      try { const scope = JSON.parse(line).data, id = memberId(scope?.origin, scope?.user_id); if (id) { write(path.join(dir, 'member'), id); return id; } } catch { /* a cut line */ }
    }
  }
  return null;
}

// Returns the slot whose folder is this member's store and records it.
export function resolveStore(root, slot, { origin, userId }) {
  if (!SLOT.test(String(slot))) throw Error('managed-launch-binding-changed');
  const member = memberId(origin, userId);
  // Without a member identity (an old Studio) the slot stays its own store.
  if (!member) return slot;
  fs.mkdirSync(path.join(root, slot), { recursive: true, mode: 0o700 });
  const pointed = storedSlot(root, slot);
  if (pointed && memberOf(root, pointed) === member) return pointed;
  let names = [];
  try { names = fs.readdirSync(root).filter(name => SLOT.test(name)); } catch { /* first launch */ }
  // A store is a slot that points at itself or at nothing; the member's store
  // is the one with the most conversations (their history), then the oldest.
  const stores = names.filter(name => { const target = read(path.join(root, name, 'store')); return (!target || target === name) && memberOf(root, name) === member; })
    .map(name => ({ name, sessions: sessionFiles(path.join(root, name)).length, born: fs.statSync(path.join(root, name)).birthtimeMs }))
    .sort((a, b) => b.sessions - a.sessions || a.born - b.born || a.name.localeCompare(b.name));
  const store = stores[0]?.name ?? slot;
  for (const name of new Set([slot, store])) { write(path.join(root, name, 'member'), member); write(path.join(root, name, 'store'), store); }
  return store;
}

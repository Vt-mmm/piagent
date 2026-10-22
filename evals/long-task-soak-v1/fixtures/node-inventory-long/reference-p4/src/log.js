// Append-only JSON-lines log: inventory events plus the stored responses of
// idempotent API writes ({ kind: 'idempotency', ... }).
import fs from 'node:fs';

export function openLog(file) {
  const events = [], responses = new Map();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.kind === 'idempotency') responses.set(entry.key, { fingerprint: entry.fingerprint, status: entry.status, body: entry.body });
      else events.push(entry);
    }
  }
  const append = entry => fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  return {
    events,
    appendEvent: append,
    idempotency: {
      get: key => responses.get(key),
      set: (key, value) => { responses.set(key, value); append({ kind: 'idempotency', key, ...value }); },
    },
  };
}

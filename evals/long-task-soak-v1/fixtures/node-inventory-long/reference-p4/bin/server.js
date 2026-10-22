#!/usr/bin/env node
// Starts the inventory API. PORT (default 3000, 0 = any free port), KHO_TODAY fixes the date,
// KHO_LOG names the append-only event log the state is rebuilt from.
import { Inventory } from '../src/index.js';
import { createServer } from '../src/server.js';
import { openLog } from '../src/log.js';

const clock = process.env.KHO_TODAY ? () => process.env.KHO_TODAY : undefined;
const log = process.env.KHO_LOG ? openLog(process.env.KHO_LOG) : null;
const inventory = log ? Inventory.replay(log.events, { clock, onEvent: log.appendEvent }) : new Inventory({ clock });
const server = createServer({ inventory, idempotency: log ? log.idempotency : new Map() });
server.listen(Number(process.env.PORT ?? 3000), () => console.log(`listening on ${server.address().port}`));

function shutdown() {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

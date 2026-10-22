#!/usr/bin/env node
// Starts the inventory API. PORT (default 3000, 0 = any free port), KHO_TODAY fixes the date.
import { Inventory } from '../src/index.js';
import { createServer } from '../src/server.js';

const clock = process.env.KHO_TODAY ? () => process.env.KHO_TODAY : undefined;
const server = createServer({ inventory: new Inventory({ clock }) });
server.listen(Number(process.env.PORT ?? 3000), () => console.log(`listening on ${server.address().port}`));

function shutdown() {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

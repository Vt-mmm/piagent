import crypto from "node:crypto";
import fs from "node:fs";

const [_workspace, oraclePath, seed, scenarioId] = process.argv.slice(2);
if (!oraclePath || !seed || !scenarioId) throw new Error("variant generator arguments are incomplete");
let counter = 0;
const bytes = () => crypto.createHash("sha256").update(`${seed}:${scenarioId}:${counter += 1}`).digest();
const integer = (minimum, maximum) => minimum + bytes().readUInt32BE(0) % (maximum - minimum + 1);
const token = (prefix) => `${prefix}-${bytes().toString("hex").slice(0, 8)}`;
const oracle = { schemaVersion: 1, graderData: {} };

switch (scenarioId) {
  case "revision-event-reconciliation": {
    const key = token("feature"), start = integer(3, 30);
    oracle.graderData = { key, start, revisions: [token("rev"), token("rev"), token("rev")] };
    break;
  }
  case "fair-dependency-scheduler": oracle.graderData = {
    capacity: integer(3, 6), tenants: [token("tenant"), token("tenant"), token("tenant")]
  }; break;
  case "layered-policy-resolution": oracle.graderData = { protectedPath: `private/${token("vault")}/secret.json`, operation: token("read") }; break;
  case "budgeted-context-graph": oracle.graderData = { term: token("resolver"), budget: integer(8, 14) }; break;
  case "resumable-stream-assembly": oracle.graderData = { first: token("hello"), second: token("world"), message: token("message") }; break;
  case "transactional-config-merge": oracle.graderData = { key: token("feature"), value: token("enabled") }; break;
  default: throw new Error(`unsupported deep logic scenario ${scenarioId}`);
}

fs.writeFileSync(oraclePath, `${JSON.stringify(oracle)}\n`, { mode: 0o600 });

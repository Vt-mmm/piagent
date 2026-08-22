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
  case "resumable-stream-assembly": {
    const astral = ["🙂", "🧠", "🚀"][integer(0, 2)];
    oracle.graderData = {
      first: token("hello"),
      second: token("world"),
      third: token("chunk"),
      message: token("message"),
      other: token("message"),
      start: integer(2, 24),
      astral
    };
    break;
  }
  case "transactional-config-merge": oracle.graderData = { key: token("feature"), value: token("enabled") }; break;
  case "temporal-usage-billing-close": oracle.graderData = {
    tenantA: token("tenant"),
    tenantB: token("tenant"),
    meter: token("meter"),
    plans: [token("plan"), token("plan"), token("plan")],
    firstLimit: integer(4, 12),
    secondLimit: integer(15, 28),
    prices: [integer(110_000, 390_000), integer(410_000, 790_000), integer(810_000, 1_250_000)]
  }; break;
  default: throw new Error(`unsupported deep logic scenario ${scenarioId}`);
}

fs.writeFileSync(oraclePath, `${JSON.stringify(oracle)}\n`, { mode: 0o600 });

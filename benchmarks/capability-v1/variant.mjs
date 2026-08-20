import crypto from "node:crypto";
import fs from "node:fs";

const [, oraclePath, seed, scenarioId] = process.argv.slice(2);
if (!oraclePath || !seed || !scenarioId) throw new Error("variant generator arguments are incomplete");

let counter = 0;
function bytes() {
  counter += 1;
  return crypto.createHash("sha256").update(`${seed}:${scenarioId}:${counter}`).digest();
}
function integer(minimum, maximum) {
  return minimum + (bytes().readUInt32BE(0) % (maximum - minimum + 1));
}
function token(prefix) {
  return `${prefix}-${bytes().toString("hex").slice(0, 8)}`;
}

const oracle = { schemaVersion: 1, graderData: {} };
if (scenarioId === "multi-package-rollout") {
  oracle.graderData = {
    tenantA: token("tenant"),
    tenantB: token("tenant"),
    percentage: integer(15, 85),
    bucketIn: integer(0, 10),
    bucketOut: integer(90, 99)
  };
} else if (scenarioId === "fullstack-search-contract") {
  oracle.graderData = {
    idA: token("item"),
    idB: token("item"),
    marker: token("marker")
  };
} else if (scenarioId === "concurrent-lease-lifecycle") {
  oracle.graderData = {
    key: token("lease"),
    ownerA: token("owner"),
    ownerB: token("owner"),
    now: integer(1_000, 9_000),
    ttlMs: integer(10, 500)
  };
} else if (scenarioId === "resumable-migration-runner") {
  oracle.graderData = {
    ids: [token("prepare"), token("transform"), token("finalize")]
  };
} else if (scenarioId === "durable-session-control-plane") {
  oracle.graderData = {
    idempotencyKey: token("command"),
    objective: `${token("inspect")} production   incident`
  };
} else if (scenarioId === "causal-timeline-recovery") {
  oracle.graderData = {
    messageA: token("message"), messageB: token("message"),
    eventA: token("event"), eventB: token("event"), eventC: token("event"),
    first: token("first"), second: token("second"), maxChars: integer(24, 48)
  };
} else throw new Error(`unsupported capability scenario ${scenarioId}`);

fs.writeFileSync(oraclePath, `${JSON.stringify(oracle)}\n`, { mode: 0o600 });

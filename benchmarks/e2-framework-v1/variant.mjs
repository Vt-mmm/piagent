import crypto from "node:crypto";
import fs from "node:fs";

const [, oraclePath, seed, scenarioId] = process.argv.slice(2);
if (!oraclePath || !seed || !scenarioId) throw new Error("variant generator arguments are incomplete");

let counter = 0;
function digest() {
  counter += 1;
  return crypto.createHash("sha256").update(`${seed}:${scenarioId}:${counter}`).digest();
}
function integer(minimum, maximum) {
  return minimum + (digest().readUInt32BE(0) % (maximum - minimum + 1));
}
function token(prefix) {
  return `${prefix}-${digest().toString("hex").slice(0, 10)}`;
}

const data = scenarioId === "hono-tenant-api" ? {
  tenantA: token("tenant"), tenantB: token("tenant"), userA: token("user"), userB: token("user")
} : scenarioId === "hono-accessible-search" ? {
  idA: token("item"), idB: token("item"), marker: token("marker")
} : scenarioId === "sqlite-resumable-inventory" ? {
  idA: token("sku"), idB: token("sku"), quantityA: integer(1, 20), quantityB: integer(21, 40)
} : scenarioId === "workspace-policy-rollout" ? {
  tenantA: token("tenant"), tenantB: token("tenant"), percentage: integer(15, 85)
} : null;
if (!data) throw new Error(`unsupported E2 scenario ${scenarioId}`);

fs.writeFileSync(oraclePath, `${JSON.stringify({ schemaVersion: 1, graderData: data })}\n`, { mode: 0o600 });

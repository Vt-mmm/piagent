import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { inferAcceptanceObligations } from "../packages/piagent-core/extensions/acceptance-receipt.js";

test("changing a predicate source path cannot add storage semantics", () => {
  const request = "Fix the tenant permission predicate in src/backend/revocation-cache.js. Deny cross-tenant access.";
  const renamed = request.replace("revocation-cache.js", "revocation-policy.js");
  assert.deepEqual(inferAcceptanceObligations(request), inferAcceptanceObligations(renamed));
  const obligations = inferAcceptanceObligations(request);
  assert.ok(obligations.includes("authorization-deny-case"));
  assert.ok(obligations.includes("tenant-boundary"));
  assert.ok(!obligations.includes("tenant-storage-isolation"));
});

test("public revocation predicate preserves its access boundary without a fictitious storage API", () => {
  const text = fs.readFileSync(new URL("../benchmarks/production-v2/prompts/revoked-session-cache.md", import.meta.url), "utf8");
  const result = inferAcceptanceObligations(text);
  assert.ok(!result.includes("tenant-storage-isolation"));
  assert.ok(result.includes("authorization-deny-case"));
  assert.ok(result.includes("tenant-boundary"));
});

test("real storage prose, inline cache names and public collision requirements retain storage checks", () => {
  const publicText = fs.readFileSync(new URL("../benchmarks/production-v2/prompts/tenant-cache-isolation.md", import.meta.url), "utf8");
  for (const text of [publicText, "Fix cross-tenant cache collisions.", "Keep tenant `cache` entries isolated.",
    "Tenant storage must round trip the same tuple.", "Keep tenant entity keys collision-free."]) {
    assert.ok(inferAcceptanceObligations(text).includes("tenant-storage-isolation"), text);
  }
});

test("read-only and invalid-input obligations are unaffected by source path filtering", () => {
  const text = "Inspect src/cache/permission.js. Reject invalid tenant identifiers with TypeError; enforce permission and deny cross-tenant access.";
  const result = inferAcceptanceObligations(text, "read-only");
  for (const required of ["read-only-evidence", "invalid-input-rejection", "authorization-deny-case", "tenant-boundary"]) {
    assert.ok(result.includes(required), required);
  }
  assert.ok(!result.includes("tenant-storage-isolation"));
});

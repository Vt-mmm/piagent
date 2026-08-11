import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const workspace = path.resolve(process.argv[2]);
const oracle = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const scenario = process.env.PIAGENT_BENCHMARK_SCENARIO;
const data = oracle.graderData;
const suiteRoot = path.dirname(new URL(import.meta.url).pathname);
const suite = JSON.parse(fs.readFileSync(path.join(suiteRoot, "suite.json"), "utf8"));
const rubric = JSON.parse(fs.readFileSync(path.join(suiteRoot, "rubric.json"), "utf8"));
const scenarioDefinition = suite.scenarios.find((item) => item.id === scenario);
const definitions = rubric.scenarios[scenario];
if (!scenarioDefinition || !Array.isArray(definitions)) throw new Error(`unsupported E2 scenario ${scenario}`);
const definitionById = new Map(definitions.map((item) => [item.id, item]));
const checks = [];

async function check(id, operation) {
  const definition = definitionById.get(id);
  if (!definition) throw new Error(`undeclared E2 check ${scenario}:${id}`);
  try {
    await operation();
    checks.push({ ...definition, passed: true });
  } catch {
    checks.push({ ...definition, passed: false, detail: "behavioral partition failed" });
  }
}

async function load(relativePath) {
  const url = pathToFileURL(path.join(workspace, relativePath));
  url.searchParams.set("e2", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function typeError(operation) {
  assert.throws(operation, TypeError);
}

function createInventory(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE inventory (id TEXT, name TEXT, quantity); CREATE TABLE audit_log (message TEXT)");
  const insert = db.prepare("INSERT INTO inventory VALUES (?, ?, ?)");
  for (const row of rows) insert.run(row.id, row.name, row.quantity);
  return db;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

if (scenario === "hono-tenant-api") {
  const { createTenantApp } = await load("apps/api/src/tenant-app.js");
  const users = () => [
    { id: ` ${data.userA} `, tenantId: ` ${data.tenantA} `, name: "Active User", active: true, secret: "internal" },
    { id: data.userB, tenantId: data.tenantB, name: "Inactive User", active: false }
  ];
  const request = (app, tenant, user, headers = {}) => app.request(`http://local/tenants/${encodeURIComponent(tenant)}/users/${encodeURIComponent(user)}`, { headers });

  await check("tenant-hono-route", async () => {
    const response = await request(createTenantApp({ users: users() }), data.tenantA, data.userA, { "x-tenant-id": data.tenantA, "x-role": "owner" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/json/);
  });
  await check("tenant-authorization", async () => {
    const app = createTenantApp({ users: users() });
    for (const headers of [
      { "x-tenant-id": data.tenantB, "x-role": "owner" },
      { "x-tenant-id": data.tenantA, "x-role": "viewer" },
      { "x-tenant-id": data.tenantA, "x-role": "OWNER" }
    ]) {
      const response = await request(app, data.tenantA, data.userA, headers);
      assert.equal(response.status, 403);
      assert.doesNotMatch(await response.text(), /Active User|internal/);
    }
    assert.equal((await request(app, data.tenantA, data.userA, { "x-tenant-id": data.tenantA, "x-role": "owner" })).status, 200);
    assert.equal((await request(app, data.tenantA, data.userA, { "x-tenant-id": ` ${data.tenantA} `, "x-role": "admin" })).status, 200);
  });
  await check("tenant-validation", async () => {
    assert.equal((await request(createTenantApp({ users: null }), data.tenantA, data.userA, { "x-tenant-id": data.tenantA, "x-role": "owner" })).status, 400);
    const app = createTenantApp({ users: users() });
    for (const [tenant, user, headers] of [
      [" ", data.userA, { "x-tenant-id": data.tenantA, "x-role": "owner" }],
      [data.tenantA, " ", { "x-tenant-id": data.tenantA, "x-role": "owner" }],
      [data.tenantA, data.userA, { "x-tenant-id": " ", "x-role": "owner" }],
      [data.tenantA, data.userA, { "x-tenant-id": data.tenantA, "x-role": " " }]
    ]) assert.equal((await request(app, tenant, user, headers)).status, 400);
  });
  await check("tenant-response-contract", async () => {
    const app = createTenantApp({ users: users() });
    const response = await request(app, data.tenantA, data.userA, { "x-tenant-id": data.tenantA, "x-role": "owner" });
    assert.deepEqual(await response.json(), { id: data.userA, tenantId: data.tenantA, name: "Active User" });
    assert.equal((await request(app, data.tenantB, data.userB, { "x-tenant-id": data.tenantB, "x-role": "admin" })).status, 404);
    assert.equal((await request(app, data.tenantA, "missing", { "x-tenant-id": data.tenantA, "x-role": "owner" })).status, 404);
  });
  await check("tenant-immutability", async () => {
    const value = users(); const before = structuredClone(value);
    const response = await request(createTenantApp({ users: value }), data.tenantA, data.userA, { "x-tenant-id": data.tenantA, "x-role": "owner" });
    const publicUser = await response.json();
    publicUser.name = "Changed";
    assert.deepEqual(value, before);
    assert.equal(value[0].name, "Active User");
  });
} else if (scenario === "hono-accessible-search") {
  const { createSearchApp, normalizeQuery } = await load("apps/web/src/search-app.js");
  const items = () => [
    { id: data.idA, name: `Cà phê <${data.marker}>`, tags: ["Đồ uống"] },
    { id: data.idB, name: "Tea & cake", tags: [data.marker, { hidden: true }] },
    { id: "last", name: "Other", tags: [] }
  ];
  const get = (app, query) => app.request(`http://local/search?${new URLSearchParams(query)}`);

  await check("search-normalization", () => {
    assert.equal(normalizeQuery("  CÀ\u0300\t PHÊ  "), "ca phe");
    assert.equal(normalizeQuery(" A\u1AB0  B "), "a b");
    assert.equal(normalizeQuery(null), "");
    assert.equal(normalizeQuery(42), "42");
  });
  await check("search-hono-route", async () => {
    const response = await get(createSearchApp({ items: items() }), { q: data.marker.toUpperCase(), limit: "2" });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.ok(html.indexOf(data.idA) < html.indexOf(data.idB));
    const byTag = await (await get(createSearchApp({ items: items() }), { q: "ĐỒ UỐNG" })).text();
    assert.match(byTag, new RegExp(data.idA));
    assert.doesNotMatch(byTag, new RegExp(data.idB));
  });
  await check("search-limit-contract", async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ id: `id-${index}`, name: "Match", tags: [] }));
    const app = createSearchApp({ items: many });
    assert.equal(((await (await get(app, { q: "match" })).text()).match(/<li /g) || []).length, 20);
    assert.equal(((await (await get(app, { q: "match", limit: "1" })).text()).match(/<li /g) || []).length, 1);
    for (const limit of ["0", "-1", "1.5", "101", "NaN", "1e309"]) assert.equal((await get(app, { limit })).status, 400);
  });
  await check("search-accessible-escaping", async () => {
    const dangerous = `id<&>"'`;
    const app = createSearchApp({ items: [{ id: dangerous, name: dangerous, tags: [] }] });
    const html = await (await get(app, { q: "" })).text();
    assert.match(html, /<form aria-label="Search">/);
    assert.match(html, /<ul aria-label="Search results">/);
    assert.match(html, /id&lt;&amp;&gt;&quot;&#39;/);
    assert.doesNotMatch(html, /id<&>/);
    const queryHtml = await (await get(app, { q: dangerous })).text();
    assert.match(queryHtml, /value="id&lt;&amp;&gt;&quot;&#39;"/);
  });
  await check("search-empty-immutable", async () => {
    const value = items(); const before = structuredClone(value);
    const html = await (await get(createSearchApp({ items: value }), { q: "absent" })).text();
    assert.match(html, /<ul aria-label="Search results"><\/ul>/);
    assert.deepEqual(value, before);
  });
} else if (scenario === "sqlite-resumable-inventory") {
  const { migrateInventory } = await load("packages/migration/src/inventory.js");
  const rows = () => [
    { id: ` ${data.idA} `, name: " First ", quantity: data.quantityA },
    { id: data.idB, name: "Second", quantity: `${data.quantityB}` }
  ];

  await check("inventory-schema-migration", () => {
    typeError(() => migrateInventory({}));
    const db = createInventory(rows());
    assert.deepEqual(migrateInventory(db), { version: 2, migrated: 2 });
    assert.deepEqual(db.prepare("SELECT * FROM inventory_v2 ORDER BY rowid").all().map((row) => ({ ...row })), [
      { id: data.idA, label: "First", quantity: data.quantityA },
      { id: data.idB, label: "Second", quantity: data.quantityB }
    ]);
    assert.equal(db.prepare("SELECT value FROM migration_metadata WHERE key='inventory-version'").get().value, 2);
    db.close();
  });
  await check("inventory-validation-atomicity", () => {
    for (const bad of [
      { id: " ", name: "Name", quantity: 1 }, { id: "id", name: " ", quantity: 1 },
      { id: "id", name: "Name", quantity: -1 }, { id: "id", name: "Name", quantity: 1.5 }
    ]) {
      const db = createInventory([rows()[0], bad]);
      typeError(() => migrateInventory(db));
      assert.equal(tableExists(db, "inventory_v2"), false);
      assert.equal(tableExists(db, "migration_metadata"), false);
      db.close();
    }
  });
  await check("inventory-idempotency", () => {
    const db = createInventory(rows());
    assert.equal(migrateInventory(db).migrated, 2);
    assert.deepEqual(migrateInventory(db), { version: 2, migrated: 0 });
    assert.equal(db.prepare("SELECT count(*) AS count FROM inventory_v2").get().count, 2);
    db.close();
  });
  await check("inventory-crash-resume", () => {
    const db = createInventory(rows());
    assert.throws(() => migrateInventory(db, { crashAfter: 1 }), /injected migration crash/);
    assert.equal(tableExists(db, "inventory_v2"), false);
    assert.deepEqual(migrateInventory(db), { version: 2, migrated: 2 });
    typeError(() => migrateInventory(db, { crashAfter: 0 }));
    db.close();
  });
  await check("inventory-preserves-legacy", () => {
    const db = createInventory(rows());
    const before = db.prepare("SELECT * FROM inventory ORDER BY rowid").all();
    migrateInventory(db);
    assert.deepEqual(db.prepare("SELECT * FROM inventory ORDER BY rowid").all(), before);
    assert.equal(tableExists(db, "audit_log"), true);
    const source = fs.readFileSync(path.join(workspace, "packages/migration/src/inventory.js"), "utf8");
    assert.match(source, /\.prepare\s*\(/);
    assert.match(source, /BEGIN/i);
    assert.match(source, /COMMIT/i);
    assert.match(source, /ROLLBACK/i);
    db.close();
  });
} else if (scenario === "workspace-policy-rollout") {
  const policy = await load("packages/policy/src/rollout.js");
  const { evaluateFeature } = await load("packages/feature-api/src/evaluate.js");
  const { renderPolicySummary } = await load("apps/admin/src/summary.js");
  const input = () => ({ enabled: 1, percentage: data.percentage, tenants: [` ${data.tenantA} `, data.tenantA, data.tenantB] });

  await check("policy-normalized-shape", () => {
    const value = input(); const before = structuredClone(value); const normalized = policy.normalizePolicy(value);
    assert.deepEqual(normalized, { enabled: true, percentage: data.percentage, tenants: [data.tenantA, data.tenantB] });
    assert.notEqual(normalized, value);
    assert.deepEqual(value, before);
  });
  await check("policy-validation", () => {
    for (const value of [null, [], "policy"]) typeError(() => policy.normalizePolicy(value));
    for (const percentage of [-1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1]) typeError(() => policy.normalizePolicy({ enabled: true, percentage, tenants: [] }));
    typeError(() => policy.normalizePolicy({ enabled: true, percentage: 1, tenants: "tenant" }));
    typeError(() => policy.normalizePolicy({ enabled: true, percentage: 1, tenants: [1] }));
    typeError(() => policy.normalizePolicy({ enabled: true, percentage: 1, tenants: [" "] }));
  });
  await check("policy-enablement", () => {
    const normalized = policy.normalizePolicy(input());
    assert.equal(policy.isEnabled({ ...normalized, enabled: false }, { tenantId: data.tenantA, bucket: 0 }), false);
    assert.equal(policy.isEnabled(normalized, null), false);
    assert.equal(policy.isEnabled(normalized, { tenantId: data.tenantA, bucket: 99 }), true);
    assert.equal(policy.isEnabled(normalized, { tenantId: "other", bucket: data.percentage - 1 }), true);
    assert.equal(policy.isEnabled(normalized, { tenantId: "other", bucket: data.percentage }), false);
    for (const bucket of [-1, 1.5, 100, Infinity]) typeError(() => policy.isEnabled(normalized, { tenantId: "other", bucket }));
  });
  await check("policy-api-reasons", () => {
    const normalized = policy.normalizePolicy(input());
    assert.deepEqual(evaluateFeature({ ...normalized, enabled: false }, { tenantId: data.tenantA, bucket: 0 }), { allowed: false, reason: "disabled" });
    assert.deepEqual(evaluateFeature(normalized, null), { allowed: false, reason: "not-eligible" });
    assert.deepEqual(evaluateFeature(normalized, { tenantId: data.tenantA, bucket: 99 }), { allowed: true, reason: "tenant-override" });
    assert.deepEqual(evaluateFeature(normalized, { tenantId: "other", bucket: data.percentage - 1 }), { allowed: true, reason: "percentage" });
    assert.deepEqual(evaluateFeature(normalized, { tenantId: "other", bucket: data.percentage }), { allowed: false, reason: "not-eligible" });
    typeError(() => evaluateFeature(normalized, { tenantId: "other", bucket: 1.5 }));
    assert.match(fs.readFileSync(path.join(workspace, "packages/feature-api/src/evaluate.js"), "utf8"), /policy\/src\/rollout\.js/);
  });
  await check("policy-admin-summary", () => {
    assert.equal(renderPolicySummary(input()), `enabled=true; percentage=${data.percentage}; tenants=${data.tenantA},${data.tenantB}`);
    typeError(() => renderPolicySummary({ enabled: true, percentage: 101, tenants: [] }));
    assert.match(fs.readFileSync(path.join(workspace, "apps/admin/src/summary.js"), "utf8"), /policy\/src\/rollout\.js/);
  });
}

function filesUnder(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) entries.push([relative, crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")]);
      else entries.push([relative, `non-regular:${stat.mode}`]);
    }
  };
  visit(root);
  return new Map(entries);
}

const baseline = filesUnder(path.join(suiteRoot, scenarioDefinition.fixture));
const candidate = filesUnder(workspace);
const changedFiles = [...new Set([...baseline.keys(), ...candidate.keys()])].filter((file) => baseline.get(file) !== candidate.get(file)).sort();
const allowed = (file) => scenarioDefinition.allowedChanges.some((pattern) => pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -3) + "/") : file === pattern);
const scopeViolations = changedFiles.filter((file) => !allowed(file));
const earned = checks.filter((item) => item.passed).reduce((total, item) => total + item.weight, 0);
const possible = checks.reduce((total, item) => total + item.weight, 0);
const scopePassed = scopeViolations.length === 0;
const result = {
  passed: checks.length === definitions.length && checks.every((item) => item.passed) && scopePassed,
  criticalPassed: checks.filter((item) => item.critical).every((item) => item.passed) && scopePassed,
  score: possible === 0 ? 0 : Number((earned / possible * 10).toFixed(4)),
  scopePassed,
  changedFiles,
  scopeViolations,
  checks
};
process.stdout.write(`${JSON.stringify(result)}\n`);

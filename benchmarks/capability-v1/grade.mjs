import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
const oracle = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const scenario = process.env.PIAGENT_BENCHMARK_SCENARIO;
const data = oracle.graderData;
const rubric = JSON.parse(fs.readFileSync(new URL("./rubric.json", import.meta.url), "utf8"));
const definitions = rubric.scenarios[scenario];
if (!Array.isArray(definitions) || definitions.length === 0) throw new Error(`unsupported capability scenario ${scenario}`);
const definitionById = new Map(definitions.map((item) => [item.id, item]));
const checks = [];
const PARTITION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

async function check(id, operation) {
  const definition = definitionById.get(id);
  if (!definition) throw new Error(`undeclared capability check ${scenario}:${id}`);
  if (checks.some((item) => item.id === id)) throw new Error(`duplicate capability check ${scenario}:${id}`);
  const failedPartitions = [];
  const partition = async (partitionId, partitionOperation) => {
    if (!PARTITION_ID.test(partitionId)) throw new Error(`invalid diagnostic partition id ${partitionId}`);
    try {
      await partitionOperation();
    } catch {
      failedPartitions.push(partitionId);
    }
  };
  let operationFailed = false;
  try {
    await operation(partition);
  } catch {
    operationFailed = true;
  }
  if (operationFailed) failedPartitions.push("unpartitioned-check-failure");
  const uniqueFailedPartitions = [...new Set(failedPartitions)];
  const passed = uniqueFailedPartitions.length === 0;
  checks.push({
    ...definition,
    passed,
    ...(passed ? {} : {
      failedPartitions: uniqueFailedPartitions,
      detail: `failed partitions: ${uniqueFailedPartitions.join(", ")}`
    })
  });
}

async function load(relativePath) {
  const url = pathToFileURL(path.join(workspace, relativePath));
  url.searchParams.set("capability", `${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function typeError(operation) {
  assert.throws(operation, TypeError);
}

if (scenario === "multi-package-rollout") {
  const policy = await load("packages/policy/src/rollout.js");
  const { featureAccess } = await load("packages/api/src/feature-access.js");
  const { rolloutSummary } = await load("apps/admin/src/rollout-view.js");
  const input = () => ({
    enabled: 1,
    percentage: data.percentage,
    tenants: [` ${data.tenantA} `, data.tenantA, data.tenantB]
  });
  const normalized = () => policy.normalizeRollout(input());

  await check("rollout-normalized-shape", () => {
    assert.deepEqual(normalized(), {
      enabled: true,
      percentage: data.percentage,
      tenants: [data.tenantA, data.tenantB]
    });
  });
  await check("rollout-input-immutable", () => {
    const value = input(); const before = structuredClone(value);
    policy.normalizeRollout(value);
    assert.deepEqual(value, before);
  });
  await check("rollout-new-object", () => {
    const value = input();
    assert.notEqual(policy.normalizeRollout(value), value);
  });
  await check("rollout-invalid-object", () => {
    typeError(() => policy.normalizeRollout(null));
    typeError(() => policy.normalizeRollout([]));
    typeError(() => policy.normalizeRollout("rollout"));
  });
  await check("rollout-invalid-percentage", () => {
    for (const percentage of [-1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1]) {
      typeError(() => policy.normalizeRollout({ enabled: true, percentage, tenants: [] }));
    }
    typeError(() => policy.normalizeRollout({ enabled: true, tenants: [] }));
  });
  await check("rollout-invalid-tenants", () => {
    typeError(() => policy.normalizeRollout({ enabled: true, percentage: 1 }));
    typeError(() => policy.normalizeRollout({ enabled: true, percentage: 1, tenants: "tenant" }));
    typeError(() => policy.normalizeRollout({ enabled: true, percentage: 1, tenants: [1] }));
    typeError(() => policy.normalizeRollout({ enabled: true, percentage: 1, tenants: ["   "] }));
  });
  await check("rollout-tenant-override", () => {
    assert.equal(policy.isFeatureEnabled(normalized(), { tenantId: data.tenantA, bucket: data.bucketOut }), true);
  });
  await check("rollout-percentage-boundaries", () => {
    const rollout = normalized();
    assert.equal(policy.isFeatureEnabled(rollout, { tenantId: "other", bucket: 0 }), data.percentage > 0);
    assert.equal(policy.isFeatureEnabled(rollout, { tenantId: "other", bucket: data.percentage - 1 }), true);
    assert.equal(policy.isFeatureEnabled(rollout, { tenantId: "other", bucket: data.percentage }), false);
    assert.equal(policy.isFeatureEnabled(rollout, { tenantId: "other", bucket: 99 }), data.percentage === 100);
  });
  await check("rollout-disabled-missing-subject", () => {
    assert.equal(policy.isFeatureEnabled({ ...normalized(), enabled: false }, { tenantId: data.tenantA, bucket: 0 }), false);
    assert.equal(policy.isFeatureEnabled(normalized(), null), false);
    assert.equal(policy.isFeatureEnabled(normalized(), undefined), false);
  });
  await check("rollout-invalid-bucket", () => {
    for (const bucket of [-1, 1.5, 100, Infinity]) {
      typeError(() => policy.isFeatureEnabled(normalized(), { tenantId: "other", bucket }));
    }
  });
  await check("feature-access-reasons", () => {
    const rollout = normalized();
    assert.deepEqual(featureAccess({ ...rollout, enabled: false }, { tenantId: data.tenantA, bucket: 0 }), { allowed: false, reason: "disabled" });
    assert.deepEqual(featureAccess(rollout, null), { allowed: false, reason: "not-eligible" });
    assert.deepEqual(featureAccess(rollout, undefined), { allowed: false, reason: "not-eligible" });
    assert.deepEqual(featureAccess(rollout, { tenantId: data.tenantA, bucket: data.bucketOut }), { allowed: true, reason: "tenant-override" });
    assert.deepEqual(featureAccess(rollout, { tenantId: "other", bucket: data.percentage - 1 }), { allowed: true, reason: "percentage" });
    assert.deepEqual(featureAccess(rollout, { tenantId: "other", bucket: data.percentage }), { allowed: false, reason: "not-eligible" });
    for (const bucket of [-1, 1.5, 100, Infinity]) {
      typeError(() => featureAccess(rollout, { tenantId: "other", bucket }));
    }
  });
  await check("rollout-summary", () => {
    assert.equal(rolloutSummary(input()), `enabled=true; percentage=${data.percentage}; tenants=${data.tenantA},${data.tenantB}`);
  });
  await check("rollout-summary-validates", () => {
    typeError(() => rolloutSummary({ enabled: true, percentage: 101, tenants: [] }));
  });
} else if (scenario === "fullstack-search-contract") {
  const { normalizeQuery } = await load("packages/shared/src/search-contract.js");
  const { searchCatalog } = await load("services/catalog/src/search.js");
  const { renderSearchResults } = await load("apps/web/src/search-view.js");
  const items = () => [
    { id: data.idA, name: `Cà phê <${data.marker}>`, tags: ["Đồ uống"] },
    { id: data.idB, name: "Tea & cake", tags: [data.marker] },
    { id: "last", name: "Other", tags: [] }
  ];

  await check("query-normalization", () => {
    assert.equal(normalizeQuery("  CÀ\u0300   PHÊ  "), "ca phe");
    assert.equal(normalizeQuery(" A\u1AB0\t B "), "a b");
  });
  await check("query-nullish", () => {
    assert.equal(normalizeQuery(null), "");
    assert.equal(normalizeQuery(undefined), "");
    assert.equal(normalizeQuery(42), "42");
  });
  await check("catalog-name-tag-order", () => {
    const value = items();
    assert.deepEqual(searchCatalog(value, data.marker.toUpperCase(), { limit: 2 }), [value[0], value[1]]);
    assert.deepEqual(searchCatalog(value, "ĐỒ UỐNG", { limit: 2 }), [value[0]]);
    assert.deepEqual(searchCatalog(value, "", { limit: 10 }), value);
    const stringTag = { id: "string-tag", name: "Other", tags: [data.marker] };
    const nonStringTag = { id: "object-tag", name: "Other", tags: [{ toString: () => data.marker }, 42, null] };
    assert.deepEqual(searchCatalog([nonStringTag, stringTag], data.marker, { limit: 2 }), [stringTag]);
  });
  await check("catalog-input-immutable", () => {
    const value = items(); const before = structuredClone(value);
    searchCatalog(value, data.marker, { limit: 2 });
    assert.deepEqual(value, before);
  });
  await check("catalog-limit-contract", () => {
    const many = Array.from({ length: 21 }, (_, index) => ({ id: String(index), name: `Item ${index}`, tags: [] }));
    assert.equal(searchCatalog(many, "").length, 20);
    assert.equal(searchCatalog(many, "", {}).length, 20);
    assert.deepEqual(searchCatalog(many, "", { limit: 1 }), [many[0]]);
    assert.deepEqual(searchCatalog(many, "", { limit: Number.MAX_SAFE_INTEGER }), many);
  });
  await check("catalog-invalid-input", () => {
    typeError(() => searchCatalog(null, "query"));
    typeError(() => searchCatalog([], "query", null));
    typeError(() => searchCatalog([], "query", []));
    typeError(() => searchCatalog([], "query", "options"));
    for (const limit of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
      typeError(() => searchCatalog([], "query", { limit }));
    }
  });
  await check("catalog-shared-normalizer", () => {
    const source = fs.readFileSync(path.join(workspace, "services/catalog/src/search.js"), "utf8");
    assert.match(source, /import\s*\{[^}]*normalizeQuery[^}]*\}\s*from\s*["'][^"']*packages\/shared\/src\/search-contract\.js["']/);
  });
  await check("search-render-exact-escaping", () => {
    const id = `id<&>\"'${data.idA}`;
    const name = `A<&>\"'${data.marker}`;
    const expectedId = `id&lt;&amp;&gt;&quot;&#39;${data.idA}`;
    const expectedName = `A&lt;&amp;&gt;&quot;&#39;${data.marker}`;
    assert.equal(renderSearchResults([{ id, name }]), `<ul aria-label="Search results"><li data-id="${expectedId}">${expectedName}</li></ul>`);
  });
  await check("search-render-order", () => {
    assert.equal(
      renderSearchResults([{ id: data.idA, name: "First" }, { id: data.idB, name: "Second" }]),
      `<ul aria-label="Search results"><li data-id="${data.idA}">First</li><li data-id="${data.idB}">Second</li></ul>`
    );
  });
  await check("search-render-empty", () => {
    assert.equal(renderSearchResults([]), '<ul aria-label="Search results"></ul>');
  });
  await check("search-render-invalid-input", () => {
    typeError(() => renderSearchResults(null));
    typeError(() => renderSearchResults({}));
  });
} else if (scenario === "concurrent-lease-lifecycle") {
  const { LeaseStore } = await load("packages/lease/src/store.js");
  const { withLease } = await load("packages/lease/src/with-lease.js");

  await check("lease-acquire-input-validation", () => {
    for (const args of [
      ["", data.ownerA, data.now, data.ttlMs], ["   ", data.ownerA, data.now, data.ttlMs],
      [data.key, "", data.now, data.ttlMs], [data.key, "   ", data.now, data.ttlMs],
      ...[-1, Infinity, -Infinity, NaN].map((now) => [data.key, data.ownerA, now, data.ttlMs]),
      ...[0, -1, Infinity, -Infinity, NaN].map((ttlMs) => [data.key, data.ownerA, data.now, ttlMs])
    ]) {
      typeError(() => new LeaseStore().acquire(...args));
    }
    assert.equal(new LeaseStore().acquire(data.key, data.ownerA, 0, Number.MIN_VALUE), true);
  });
  await check("lease-renew-input-validation", () => {
    const store = new LeaseStore();
    for (const args of [
      ["", data.ownerA, data.now, data.ttlMs], ["   ", data.ownerA, data.now, data.ttlMs],
      [data.key, "", data.now, data.ttlMs], [data.key, "   ", data.now, data.ttlMs],
      ...[-1, Infinity, -Infinity, NaN].map((now) => [data.key, data.ownerA, now, data.ttlMs]),
      ...[0, -1, Infinity, -Infinity, NaN].map((ttlMs) => [data.key, data.ownerA, data.now, ttlMs])
    ]) {
      typeError(() => store.renew(...args));
    }
    const boundary = new LeaseStore();
    boundary.acquire(data.key, data.ownerA, 0, Number.MIN_VALUE);
    assert.equal(boundary.renew(data.key, data.ownerA, 0, Number.MIN_VALUE), true);
  });
  await check("lease-release-current-input-validation", () => {
    const store = new LeaseStore();
    typeError(() => store.release("", data.ownerA));
    typeError(() => store.release("   ", data.ownerA));
    typeError(() => store.release(data.key, ""));
    typeError(() => store.release(data.key, "   "));
    typeError(() => store.current(""));
    typeError(() => store.current("   "));
  });
  await check("lease-contention-inclusive-expiry", () => {
    const store = new LeaseStore();
    assert.equal(store.acquire(data.key, data.ownerA, data.now, data.ttlMs), true);
    assert.equal(store.acquire(data.key, data.ownerB, data.now + data.ttlMs - 1, data.ttlMs), false);
    assert.equal(store.acquire(data.key, data.ownerB, data.now + data.ttlMs, data.ttlMs), true);
  });
  await check("lease-same-owner-reacquire", () => {
    const store = new LeaseStore();
    assert.equal(store.acquire(data.key, data.ownerA, data.now, data.ttlMs), true);
    assert.equal(store.acquire(data.key, data.ownerA, data.now + 1, data.ttlMs), true);
    assert.deepEqual(store.current(data.key), { owner: data.ownerA, expiresAt: data.now + 1 + data.ttlMs });
  });
  await check("lease-renew-contract", () => {
    const store = new LeaseStore();
    store.acquire(data.key, data.ownerA, data.now, data.ttlMs);
    assert.equal(store.renew(data.key, data.ownerB, data.now + 1, data.ttlMs), false);
    assert.equal(store.renew(data.key, data.ownerA, data.now + 1, data.ttlMs), true);
    assert.deepEqual(store.current(data.key), { owner: data.ownerA, expiresAt: data.now + 1 + data.ttlMs });
    const expired = new LeaseStore();
    expired.acquire(data.key, data.ownerA, data.now, data.ttlMs);
    assert.equal(expired.renew(data.key, data.ownerA, data.now + data.ttlMs, data.ttlMs), false);
  });
  await check("lease-release-contract", () => {
    const store = new LeaseStore();
    store.acquire(data.key, data.ownerA, data.now, data.ttlMs);
    assert.equal(store.release(data.key, data.ownerB), false);
    assert.equal(store.release(data.key, data.ownerA), true);
    assert.equal(store.release(data.key, data.ownerA), false);
  });
  await check("lease-snapshot-isolation", () => {
    const store = new LeaseStore();
    assert.equal(store.current(data.key), undefined);
    store.acquire(data.key, data.ownerA, data.now, data.ttlMs);
    const snapshot = store.current(data.key);
    snapshot.owner = "mutated";
    assert.equal(store.current(data.key).owner, data.ownerA);
  });
  await check("with-lease-success-callback", async () => {
    const store = new LeaseStore();
    const result = await withLease(store, data.key, data.ownerA, { now: data.now, ttlMs: data.ttlMs }, async (renew) => {
      assert.equal(typeof renew, "function");
      assert.equal(renew(data.now + 1), true);
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(store.current(data.key), undefined);
  });
  await check("with-lease-busy", async () => {
    const store = new LeaseStore();
    store.acquire(data.key, data.ownerB, data.now, data.ttlMs);
    await assert.rejects(withLease(store, data.key, data.ownerA, { now: data.now + 1, ttlMs: data.ttlMs }, async () => true), /busy/i);
  });
  await check("with-lease-failure-cleanup", async () => {
    const store = new LeaseStore();
    await assert.rejects(withLease(store, data.key, data.ownerA, { now: data.now, ttlMs: data.ttlMs }, async () => { throw new Error("operation failed"); }), /operation failed/);
    assert.equal(store.current(data.key), undefined);
  });
  await check("with-lease-owner-change-cleanup", async () => {
    const store = new LeaseStore();
    await withLease(store, data.key, data.ownerA, { now: data.now, ttlMs: data.ttlMs }, async () => {
      assert.equal(store.acquire(data.key, data.ownerB, data.now + data.ttlMs, data.ttlMs), true);
    });
    assert.deepEqual(store.current(data.key), { owner: data.ownerB, expiresAt: data.now + (2 * data.ttlMs) });
  });
} else if (scenario === "resumable-migration-runner") {
  const { migrationPlan } = await load("packages/migration/src/plan.js");
  const { runMigration } = await load("packages/migration/src/runner.js");
  const [prepare, transform, finalize] = data.ids;
  const chain = () => [
    { id: finalize, dependsOn: [transform], apply: async () => {} },
    { id: prepare, dependsOn: [], apply: async () => {} },
    { id: transform, dependsOn: [prepare], apply: async () => {} }
  ];

  await check("migration-step-validation", async (partition) => {
    await partition("steps-not-array", () => typeError(() => migrationPlan(null)));
    await partition("empty-id", () => typeError(() => migrationPlan([{ id: "", dependsOn: [], apply() {} }])));
    await partition("whitespace-only-id", () => typeError(() => migrationPlan([{ id: "   ", dependsOn: [], apply() {} }])));
    await partition("duplicate-id", () => typeError(() => migrationPlan([{ id: "a", dependsOn: [], apply() {} }, { id: "a", dependsOn: [], apply() {} }])));
    await partition("non-callable-apply", () => typeError(() => migrationPlan([{ id: "a", dependsOn: [], apply: true }])));
  });
  await check("migration-dependency-validation", () => {
    typeError(() => migrationPlan([{ id: "a", dependsOn: "b", apply() {} }]));
    typeError(() => migrationPlan([{ id: "a", dependsOn: ["b"], apply() {} }]));
    typeError(() => migrationPlan([{ id: "a", dependsOn: [1], apply() {} }]));
  });
  await check("migration-cycle-validation", () => {
    typeError(() => migrationPlan([{ id: "a", dependsOn: ["a"], apply() {} }]));
    typeError(() => migrationPlan([{ id: "a", dependsOn: ["b"], apply() {} }, { id: "b", dependsOn: ["a"], apply() {} }]));
  });
  await check("migration-stable-chain-order", () => {
    assert.deepEqual(migrationPlan(chain()).map((step) => step.id), [prepare, transform, finalize]);
  });
  await check("migration-stable-ready-order", () => {
    const independent = `independent-${prepare}`;
    const steps = [
      { id: finalize, dependsOn: [prepare], apply() {} },
      { id: independent, dependsOn: [], apply() {} },
      { id: prepare, dependsOn: [], apply() {} }
    ];
    assert.deepEqual(migrationPlan(steps).map((step) => step.id), [independent, prepare, finalize]);
  });
  await check("migration-input-immutable", () => {
    const steps = chain();
    const arrayBefore = [...steps];
    const dependenciesBefore = steps.map((step) => [...step.dependsOn]);
    migrationPlan(steps);
    assert.deepEqual(steps, arrayBefore);
    assert.deepEqual(steps.map((step) => step.dependsOn), dependenciesBefore);
  });
  await check("migration-runner-input-validation", async () => {
    const checkpoint = { read: async () => [], write: async () => {} };
    await assert.rejects(runMigration({ steps: null, checkpoint, apply: async () => {} }), TypeError);
    await assert.rejects(runMigration({ steps: [], checkpoint: null, apply: async () => {} }), TypeError);
    await assert.rejects(runMigration({ steps: [], checkpoint: {}, apply: async () => {} }), TypeError);
    await assert.rejects(runMigration({ steps: [], checkpoint, apply: null }), TypeError);
    await assert.rejects(runMigration({ steps: [{ id: "bad", dependsOn: [], apply: true }], checkpoint, apply: async () => {} }), TypeError);
    await assert.rejects(runMigration({ steps: chain(), checkpoint, apply: async () => {} }), TypeError);
    await assert.rejects(runMigration({
      steps: [
        { id: transform, dependsOn: [prepare], apply() {} },
        { id: prepare, dependsOn: [], apply() {} }
      ],
      checkpoint,
      apply: async () => {}
    }), TypeError);
    const reconstructed = migrationPlan(chain()).map((step) => ({
      id: step.id,
      dependsOn: [...step.dependsOn],
      apply: async () => {}
    }));
    const calls = [];
    await runMigration({ steps: reconstructed, checkpoint, apply: async (step) => calls.push(step.id) });
    assert.deepEqual(calls, [prepare, transform, finalize]);
  });
  await check("migration-checkpoint-validation", async () => {
    const planned = migrationPlan(chain());
    await assert.rejects(runMigration({ steps: planned, checkpoint: { read: async () => "bad", write: async () => {} }, apply: async () => {} }), TypeError);
    await assert.rejects(runMigration({ steps: planned, checkpoint: { read: async () => ["unknown"], write: async () => {} }, apply: async () => {} }), TypeError);
  });
  await check("migration-skip-write-return", async () => {
    const planned = migrationPlan(chain());
    let stored = [prepare]; const writes = []; const calls = [];
    const checkpoint = { read: async () => [...stored], write: async (ids) => { stored = [...ids]; writes.push(ids); } };
    const result = await runMigration({ steps: planned, checkpoint, apply: async (step) => calls.push(step.id) });
    assert.deepEqual(calls, [transform, finalize]);
    assert.deepEqual(writes, [[prepare, transform], [prepare, transform, finalize]]);
    assert.deepEqual(result, { completed: [prepare, transform, finalize] });
    assert.notEqual(result.completed, stored);
    assert.notEqual(writes[0], writes[1]);
  });
  await check("migration-crash-resume", async () => {
    const planned = migrationPlan(chain());
    let stored = []; const calls = []; let failOnce = true;
    const checkpoint = { read: async () => [...stored], write: async (ids) => { stored = [...ids]; } };
    await assert.rejects(runMigration({ steps: planned, checkpoint, apply: async (step) => {
      calls.push(step.id);
      if (step.id === transform && failOnce) { failOnce = false; throw new Error("crash"); }
    } }), /crash/);
    assert.deepEqual(stored, [prepare]);
    await runMigration({ steps: planned, checkpoint, apply: async (step) => calls.push(step.id) });
    assert.deepEqual(calls, [prepare, transform, transform, finalize]);
    assert.deepEqual(stored, [prepare, transform, finalize]);
  });
  await check("migration-return-isolation", async () => {
    const planned = migrationPlan(chain());
    let stored = [];
    const checkpoint = { read: async () => stored, write: async (ids) => { stored = ids; } };
    const result = await runMigration({ steps: planned, checkpoint, apply: async () => {} });
    result.completed.push("mutated");
    assert.deepEqual(stored, [prepare, transform, finalize]);
  });
}

const invoked = new Set(checks.map((item) => item.id));
const missing = definitions.filter((item) => !invoked.has(item.id)).map((item) => item.id);
if (missing.length) throw new Error(`capability grader omitted rubric checks: ${missing.join(", ")}`);
const totalWeight = checks.reduce((sum, item) => sum + item.weight, 0);
const earnedWeight = checks.reduce((sum, item) => sum + (item.passed ? item.weight : 0), 0);
const score = Number((10 * earnedWeight / totalWeight).toFixed(2));
const criticalPassed = checks.filter((item) => item.critical).every((item) => item.passed);
process.stdout.write(`${JSON.stringify({ passed: criticalPassed, score, criticalPassed, earnedWeight, totalWeight, checks })}\n`);

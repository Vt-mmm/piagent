import assert from "node:assert/strict";
import crypto from "node:crypto";
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
} else if (scenario === "durable-session-control-plane") {
  const { routeRuntimeCommand } = await load("packages/session/src/runtime-route.js");
  const { admitRuntimeCommand, runtimeCommandDigest } = await load("packages/session/src/admission.js");
  const { controlSummary } = await load("apps/web/src/control-view.js");
  const objective = data.objective.trim().replace(/\s+/gu, " ");
  const state = () => ({ revision: 7, receipts: {} });
  const command = (kind, payload = {}, overrides = {}) => ({
    idempotencyKey: data.idempotencyKey,
    expectedRevision: 7,
    kind,
    payload,
    confirmed: false,
    ...overrides
  });
  const canonical = (value) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (!value || typeof value !== "object") throw new TypeError("not canonical JSON");
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  };

  await check("runtime-route-validation", async (partition) => {
    await partition("invalid-command-record", () => {
      for (const value of [null, [], "status"]) typeError(() => routeRuntimeCommand(value));
    });
    await partition("unknown-envelope-field", () => typeError(() => routeRuntimeCommand({ ...command("status"), extra: true })));
    await partition("unknown-kind", () => typeError(() => routeRuntimeCommand(command("restart"))));
    await partition("invalid-payload-record", () => {
      for (const payload of [null, [], "payload"]) typeError(() => routeRuntimeCommand(command("status", payload)));
    });
    await partition("non-empty-bounded-payload", () => {
      for (const kind of ["status", "compact", "abort"]) typeError(() => routeRuntimeCommand(command(kind, { extra: true })));
    });
    await partition("invalid-scout-payload", () => {
      typeError(() => routeRuntimeCommand(command("scout", {})));
      typeError(() => routeRuntimeCommand(command("scout", { objective: "   " })));
      typeError(() => routeRuntimeCommand(command("scout", { objective: data.objective, extra: true })));
    });
  });
  await check("runtime-route-exact-contract", () => {
    assert.deepEqual(routeRuntimeCommand(command("status")), { terminalCommand: "/status", confirmationRequired: false, expectedModelCalls: 0, effect: "read" });
    assert.deepEqual(routeRuntimeCommand(command("scout", { objective: data.objective })), { terminalCommand: `/scout ${objective}`, confirmationRequired: true, expectedModelCalls: "bounded", effect: "model" });
    assert.deepEqual(routeRuntimeCommand(command("compact")), { terminalCommand: "/compact", confirmationRequired: true, expectedModelCalls: "bounded", effect: "semantic" });
    assert.deepEqual(routeRuntimeCommand(command("abort")), { terminalCommand: "/abort", confirmationRequired: true, expectedModelCalls: 0, effect: "state" });
  });
  await check("runtime-confirmation-authority", () => {
    assert.equal(admitRuntimeCommand(state(), command("status")).receipt.kind, "status");
    for (const [kind, payload] of [["scout", { objective: data.objective }], ["compact", {}], ["abort", {}]]) {
      typeError(() => admitRuntimeCommand(state(), command(kind, payload)));
      assert.equal(admitRuntimeCommand(state(), command(kind, payload, { confirmed: true })).receipt.kind, kind);
    }
  });
  await check("runtime-revision-validation", () => {
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) typeError(() => admitRuntimeCommand({ revision, receipts: {} }, command("status")));
    typeError(() => admitRuntimeCommand({ revision: 7, receipts: null }, command("status")));
    for (const expectedRevision of [-1, 1.5, 6, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      typeError(() => admitRuntimeCommand(state(), command("status", {}, { expectedRevision })));
    }
    typeError(() => admitRuntimeCommand({ revision: Number.MAX_SAFE_INTEGER, receipts: {} }, command("status", {}, { expectedRevision: Number.MAX_SAFE_INTEGER })));
  });
  await check("runtime-idempotent-replay", () => {
    const first = admitRuntimeCommand(state(), command("scout", { objective: data.objective }, { confirmed: true }));
    const stored = first.state.receipts[data.idempotencyKey];
    const replay = admitRuntimeCommand(first.state, command("scout", { objective: data.objective }, { confirmed: true, expectedRevision: 7 }));
    assert.equal(replay.state, first.state);
    assert.deepEqual(replay.receipt, { ...stored, replayed: true });
    assert.equal(stored.replayed, false);
    assert.notEqual(replay.receipt, stored);
  });
  await check("runtime-idempotency-conflict", () => {
    const first = admitRuntimeCommand(state(), command("status"));
    typeError(() => admitRuntimeCommand(first.state, command("compact", {}, { confirmed: true, expectedRevision: 7 })));
    for (const idempotencyKey of ["", "   ", "__proto__", "prototype", "constructor"]) {
      typeError(() => admitRuntimeCommand(state(), command("status", {}, { idempotencyKey })));
    }
  });
  await check("runtime-digest-canonical", () => {
    const left = { kind: "probe", payload: { z: 1, nested: { beta: true, alpha: [3, null] }, a: "x" } };
    const right = { payload: { a: "x", nested: { alpha: [3, null], beta: true }, z: 1 }, kind: "probe" };
    const expected = crypto.createHash("sha256").update(canonical(left)).digest("hex");
    assert.equal(runtimeCommandDigest(left), expected);
    assert.equal(runtimeCommandDigest(right), expected);
    assert.match(expected, /^[a-f0-9]{64}$/);
    typeError(() => runtimeCommandDigest({ kind: "probe", payload: { value: Infinity } }));
    typeError(() => runtimeCommandDigest({ kind: "probe", payload: { value: undefined } }));
    typeError(() => runtimeCommandDigest({ kind: "probe", payload: {}, extra: true }));
  });
  await check("runtime-receipt-shape", () => {
    const input = command("scout", { objective: data.objective }, { confirmed: true });
    const result = admitRuntimeCommand(state(), input);
    assert.deepEqual(Object.keys(result.receipt).sort(), [
      "commandDigest", "effect", "expectedModelCalls", "idempotencyKey", "kind", "replayed",
      "revisionAfter", "revisionBefore", "terminalCommand"
    ]);
    assert.deepEqual(result.receipt, {
      idempotencyKey: data.idempotencyKey,
      commandDigest: runtimeCommandDigest({ kind: "scout", payload: { objective: data.objective } }),
      kind: "scout", terminalCommand: `/scout ${objective}`, effect: "model", expectedModelCalls: "bounded",
      revisionBefore: 7, revisionAfter: 8, replayed: false
    });
    assert.equal(result.state.revision, 8);
  });
  await check("runtime-state-isolation", () => {
    const originalState = state(); const originalInput = command("scout", { objective: data.objective }, { confirmed: true });
    const beforeState = structuredClone(originalState); const beforeInput = structuredClone(originalInput);
    const result = admitRuntimeCommand(originalState, originalInput);
    assert.deepEqual(originalState, beforeState); assert.deepEqual(originalInput, beforeInput);
    assert.notEqual(result.state, originalState);
    assert.notEqual(result.receipt, result.state.receipts[data.idempotencyKey]);
    result.receipt.effect = "mutated";
    assert.equal(result.state.receipts[data.idempotencyKey].effect, "model");
  });
  await check("runtime-control-summary", () => {
    const receipt = admitRuntimeCommand(state(), command("scout", { objective: data.objective }, { confirmed: true })).receipt;
    assert.equal(controlSummary(receipt), `kind=scout; command=${JSON.stringify(`/scout ${objective}`)}; revision=7->8; effect=model; model=bounded; replayed=false`);
    typeError(() => controlSummary(null));
    typeError(() => controlSummary([]));
  });
} else if (scenario === "causal-timeline-recovery") {
  const { normalizeTimelineSnapshot, projectTimeline } = await load("packages/timeline/src/project.js");
  const { encodeTimelineCheckpoint, decodeTimelineCheckpoint } = await load("packages/timeline/src/checkpoint.js");
  const { renderTimeline } = await load("apps/web/src/timeline-view.js");
  const eventDigest = (event) => crypto.createHash("sha256").update(JSON.stringify({
    id: event.id, cursor: event.cursor, messageId: event.messageId,
    offset: event.offset, text: event.text, complete: event.complete
  })).digest("hex");
  const emptySnapshot = () => ({ cursor: 0, messages: [], seen: {} });
  const event = (id, cursor, messageId, offset, text, complete = false) => ({ id, cursor, messageId, offset, text, complete });
  const eventA = () => event(data.eventA, 1, data.messageA, 0, data.first, false);
  const eventB = () => event(data.eventB, 2, data.messageA, data.first.length, data.second, true);

  await check("timeline-snapshot-validation", async (partition) => {
    const historical = eventA();
    const source = { cursor: 1, messages: [{ id: data.messageA, text: data.first, complete: false }], seen: { [data.eventA]: eventDigest(historical) } };
    const normalized = normalizeTimelineSnapshot(source);
    assert.deepEqual(normalized, source); assert.notEqual(normalized, source); assert.notEqual(normalized.messages, source.messages); assert.notEqual(normalized.messages[0], source.messages[0]); assert.notEqual(normalized.seen, source.seen);
    await partition("invalid-snapshot-record", () => { for (const value of [null, [], "snapshot"]) typeError(() => normalizeTimelineSnapshot(value)); });
    await partition("invalid-snapshot-cursor", () => { for (const cursor of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) typeError(() => normalizeTimelineSnapshot({ cursor, messages: [], seen: {} })); });
    await partition("invalid-snapshot-message", () => {
      typeError(() => normalizeTimelineSnapshot({ cursor: 0, messages: {}, seen: {} }));
      typeError(() => normalizeTimelineSnapshot({ cursor: 0, messages: [{ id: "", text: "", complete: false }], seen: {} }));
      typeError(() => normalizeTimelineSnapshot({ cursor: 0, messages: [{ id: "same", text: "", complete: false }, { id: "same", text: "", complete: true }], seen: {} }));
      typeError(() => normalizeTimelineSnapshot({ cursor: 0, messages: [{ id: "ok", text: 1, complete: false }], seen: {} }));
    });
    await partition("invalid-snapshot-seen", () => {
      typeError(() => normalizeTimelineSnapshot({ cursor: 0, messages: [], seen: null }));
      typeError(() => normalizeTimelineSnapshot({ cursor: 0, messages: [], seen: { [data.eventA]: "ABC" } }));
    });
  });
  await check("timeline-event-validation", () => {
    typeError(() => projectTimeline(emptySnapshot(), null, { maxChars: data.maxChars }));
    for (const options of [null, [], {}, { maxChars: -1 }, { maxChars: 1.5 }, { maxChars: Number.MAX_SAFE_INTEGER + 1 }]) typeError(() => projectTimeline(emptySnapshot(), [], options));
    const valid = eventA();
    const invalid = [
      { ...valid, id: "" }, { ...valid, messageId: "   " }, { ...valid, cursor: 0 }, { ...valid, cursor: 1.5 },
      { ...valid, offset: -1 }, { ...valid, offset: 1.5 }, { ...valid, text: null }, { ...valid, complete: 1 }
    ];
    for (const value of invalid) typeError(() => projectTimeline(emptySnapshot(), [value], { maxChars: data.maxChars }));
  });
  await check("timeline-replay-and-conflicts", () => {
    const first = eventA(); const second = eventB();
    const replay = projectTimeline(emptySnapshot(), [first, second, { ...second }, { ...first }], { maxChars: data.maxChars * 4 });
    assert.deepEqual(replay.appliedIds, [data.eventA, data.eventB]);
    assert.deepEqual(replay.replayedIds, [data.eventA, data.eventB]);
    typeError(() => projectTimeline(emptySnapshot(), [first, { ...first, text: `${first.text}!` }], { maxChars: data.maxChars * 4 }));
    typeError(() => projectTimeline(emptySnapshot(), [first, { ...first, id: data.eventB }], { maxChars: data.maxChars * 4 }));
  });
  await check("timeline-historical-validation", () => {
    const historical = eventA(); const digest = eventDigest(historical);
    const snapshot = { cursor: 1, messages: [{ id: data.messageA, text: data.first, complete: false }], seen: { [data.eventA]: digest } };
    const result = projectTimeline(snapshot, [historical, { ...historical }], { maxChars: data.maxChars * 4 });
    assert.deepEqual(result.replayedIds, [data.eventA]); assert.deepEqual(result.appliedIds, []);
    typeError(() => projectTimeline({ ...snapshot, seen: {} }, [historical], { maxChars: data.maxChars * 4 }));
    typeError(() => projectTimeline(snapshot, [{ ...historical, text: `${data.first}!` }], { maxChars: data.maxChars * 4 }));
  });
  await check("timeline-contiguous-gap", () => {
    const first = eventA(); const second = eventB();
    const sorted = projectTimeline(emptySnapshot(), [second, first], { maxChars: data.maxChars * 4 });
    assert.equal(sorted.cursor, 2); assert.deepEqual(sorted.appliedIds, [data.eventA, data.eventB]); assert.equal(sorted.gap, null); assert.deepEqual(sorted.buffered, []);
    const later = event(data.eventC, 3, data.messageB, 0, "later", false);
    const gap = projectTimeline(emptySnapshot(), [later, first], { maxChars: data.maxChars * 4 });
    assert.equal(gap.cursor, 1); assert.deepEqual(gap.gap, { expected: 2, observed: 3 }); assert.deepEqual(gap.buffered, [later]);
  });
  await check("timeline-offset-completion", () => {
    const projected = projectTimeline(emptySnapshot(), [eventA(), eventB()], { maxChars: data.maxChars * 4 });
    assert.deepEqual(projected.messages, [{ id: data.messageA, text: `${data.first}${data.second}`, complete: true }]);
    typeError(() => projectTimeline(emptySnapshot(), [{ ...eventA(), offset: 1 }], { maxChars: data.maxChars * 4 }));
    const completeSnapshot = { cursor: 1, messages: [{ id: data.messageA, text: data.first, complete: true }], seen: { [data.eventA]: eventDigest(eventA()) } };
    typeError(() => projectTimeline(completeSnapshot, [eventB()], { maxChars: data.maxChars * 4 }));
  });
  await check("timeline-budget-boundary", () => {
    const source = { cursor: 0, messages: [{ id: data.messageA, text: data.first, complete: false }], seen: {} };
    const remaining = data.maxChars - data.first.length;
    assert.ok(remaining >= 0);
    const exact = event(data.eventA, 1, data.messageB, 0, "x".repeat(remaining), false);
    const overflow = event(data.eventB, 2, data.messageB, remaining, "z", true);
    const result = projectTimeline(source, [exact, overflow], { maxChars: data.maxChars });
    assert.equal(result.cursor, 1); assert.deepEqual(result.appliedIds, [data.eventA]); assert.deepEqual(result.buffered, [overflow]);
    assert.deepEqual(result.backpressure, { eventId: data.eventB, cursor: 2, neededChars: data.maxChars + 1, maxChars: data.maxChars });
    assert.deepEqual(result.messages, [source.messages[0], { id: data.messageB, text: "x".repeat(remaining), complete: false }]);
    assert.equal(Object.hasOwn(result.seen, data.eventB), false);
  });
  await check("timeline-input-isolation", () => {
    const snapshot = emptySnapshot(); const events = [eventA(), eventB()];
    const snapshotBefore = structuredClone(snapshot); const eventsBefore = structuredClone(events);
    const result = projectTimeline(snapshot, events, { maxChars: data.maxChars * 4 });
    assert.deepEqual(snapshot, snapshotBefore); assert.deepEqual(events, eventsBefore);
    assert.notEqual(result.messages, snapshot.messages); assert.notEqual(result.seen, snapshot.seen); assert.notEqual(result.buffered, events);
    result.messages[0].text = "mutated"; result.seen[data.eventA] = "0".repeat(64);
    assert.deepEqual(snapshot, snapshotBefore); assert.deepEqual(events, eventsBefore);
  });
  await check("timeline-checkpoint-roundtrip", () => {
    const stateValue = projectTimeline(emptySnapshot(), [eventA(), eventB()], { maxChars: data.maxChars * 4 });
    const core = { cursor: stateValue.cursor, messages: stateValue.messages, seen: stateValue.seen };
    const encoded = encodeTimelineCheckpoint(core); const envelope = JSON.parse(encoded);
    const canonical = (value) => {
      if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    };
    assert.deepEqual(Object.keys(envelope), ["schemaVersion", "payload", "checksum"]);
    assert.equal(envelope.checksum, crypto.createHash("sha256").update(canonical(envelope.payload)).digest("hex"));
    const first = decodeTimelineCheckpoint(encoded); const second = decodeTimelineCheckpoint(encoded);
    assert.deepEqual(first, core); assert.deepEqual(second, core); assert.notEqual(first.messages, second.messages); assert.notEqual(first.seen, second.seen);
    first.messages[0].text = "mutated"; assert.deepEqual(second, core);
  });
  await check("timeline-checkpoint-tamper", () => {
    const encoded = encodeTimelineCheckpoint(emptySnapshot()); const value = JSON.parse(encoded);
    typeError(() => decodeTimelineCheckpoint(null));
    typeError(() => decodeTimelineCheckpoint("{"));
    typeError(() => decodeTimelineCheckpoint(JSON.stringify({ ...value, schemaVersion: 2 })));
    typeError(() => decodeTimelineCheckpoint(JSON.stringify({ ...value, checksum: "0".repeat(64) })));
    typeError(() => decodeTimelineCheckpoint(JSON.stringify({ ...value, payload: { ...value.payload, cursor: 1 } })));
    typeError(() => decodeTimelineCheckpoint(JSON.stringify({ schemaVersion: 1, payload: {}, checksum: value.checksum })));
  });
  await check("timeline-render-exact", () => {
    const id = `${data.messageA}<&>\"'`; const text = `${data.first}<&>\"'`;
    const escapedId = `${data.messageA}&lt;&amp;&gt;&quot;&#39;`; const escapedText = `${data.first}&lt;&amp;&gt;&quot;&#39;`;
    assert.equal(renderTimeline([{ id, text, complete: false }, { id: data.messageB, text: data.second, complete: true }]), `<ol aria-label="Session timeline"><li data-id="${escapedId}" data-state="pending">${escapedText}</li><li data-id="${data.messageB}" data-state="complete">${data.second}</li></ol>`);
  });
  await check("timeline-render-validation", () => {
    typeError(() => renderTimeline(null)); typeError(() => renderTimeline({}));
    assert.equal(renderTimeline([]), '<ol aria-label="Session timeline"></ol>');
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

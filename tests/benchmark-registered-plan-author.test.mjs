import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateHostContractPlan } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { buildRegisteredPlanDrafts } from "../scripts/benchmark-registered-plan-author.mjs";

const ASSET_ROOT = process.env.PIAGENT_REGISTERED_ASSET_ROOT;
const SUITE_DIGEST = "83b03a0ec872d1d6196fb8c4447e628459c11303748109c24da8dbccbbece8cb";
const ZERO = "0".repeat(64);
const sha = value => createHash("sha256").update(value).digest("hex");

function build(configDigest = ZERO, armDigest = ZERO) {
  return buildRegisteredPlanDrafts({ assetRoot: fs.realpathSync.native(ASSET_ROOT),
    suiteRoot: fs.realpathSync.native(path.resolve(import.meta.dirname, "../benchmarks/production-v2")),
    suiteDigest: SUITE_DIGEST, configDigest, armDigest });
}

function materializedIdentities() {
  const byScenario = new Map(), configDigests = new Set();
  for (const name of fs.readdirSync(path.join(ASSET_ROOT, "plans")).sort()) {
    const scenarioId = path.basename(name, ".json"), plan = JSON.parse(
      fs.readFileSync(path.join(ASSET_ROOT, "plans", name), "utf8"));
    const composite = plan.contracts.find(contract => contract.route === "composite");
    if (!composite) continue;
    const identity = composite.planContext.identity;
    assert.ok(plan.contracts.every(contract => contract.route !== "composite"
      || JSON.stringify(contract.planContext.identity) === JSON.stringify(identity)));
    configDigests.add(identity.configDigest);
    byScenario.set(scenarioId, identity);
  }
  assert.equal(configDigests.size, 1);
  return { byScenario, configDigest: [...configDigests][0] };
}

test("public registered-plan author deterministically builds exact 23 code and 4 composite routes", {
  skip: !ASSET_ROOT
}, () => {
  const first = build(), second = build();
  assert.equal(first.authority, "none");
  assert.equal(first.plans.length, 27);
  assert.equal(first.plans.filter(item => item.route === "code").length, 23);
  assert.equal(first.plans.filter(item => item.route === "composite").length, 4);
  assert.equal(sha(JSON.stringify(first)), sha(JSON.stringify(second)));
  for (const item of first.plans) {
    validateHostContractPlan(item.plan);
    assert.equal(item.plan.schemaVersion, 3);
    assert.equal(item.plan.contracts.length, item.criterionCount);
    assert.ok(Buffer.byteLength(JSON.stringify(item.plan)) < 2 * 1024 * 1024);
    assert.ok(item.plan.contracts.every(contract => contract.route === item.route));
    if (item.route === "code") {
      assert.ok(item.caseCount > 0 && item.caseCount <= 256);
      assert.ok(item.plan.contracts.every(contract => contract.checks.flatMap(check => check.cases)
        .every(value => value.invocation?.kind)));
    } else {
      assert.equal(item.caseCount, 0);
      for (const contract of item.plan.contracts) {
        assert.equal(contract.planContext.identity.configDigest, ZERO);
        assert.equal(contract.planContext.identity.armDigest, ZERO);
        const publicContract = JSON.parse(contract.planContext.contractText);
        assert.equal(publicContract.coverage.length, 1);
        assert.equal(publicContract.coverage[0].startByte, 0);
        assert.equal(publicContract.coverage[0].endByte, Buffer.byteLength(publicContract.criterionText));
        assert.deepEqual(publicContract.coverage[0].requiredFactIds,
          publicContract.facts.map(fact => fact.id));
      }
    }
  }
});

test("public family and manual recipes retain their bounded authored case inventory", {
  skip: !ASSET_ROOT
}, () => {
  const expected = new Map([
    ["expiry-boundary", 209], ["config-precedence", 25], ["bounded-retry", 25],
    ["resumable-checkpoint-partial-failure", 18], ["workflow-switch-same-session", 35],
    ["stale-search-response", 13], ["abort-reconnect-supersession", 21],
    ["tenant-role-authorization", 9], ["tenant-cache-isolation", 12],
    ["revoked-session-cache", 21], ["invoice-rounding", 21],
    ["billing-cutoff-clock-skew", 14], ["pagination-boundary", 17],
    ["unicode-search", 10], ["quoted-csv", 19], ["chunked-record-boundary", 10],
    ["schema-migration", 5], ["stable-dedup", 5], ["idempotent-replay-conflict", 13],
    ["cli-double-dash", 10], ["workspace-order", 16],
    ["backend-frontend-contract-sync", 16], ["reconnect-chat-event-order", 16]
  ]);
  const result = build();
  assert.deepEqual(new Map(result.plans.filter(item => item.route === "code")
    .map(item => [item.scenarioId, item.caseCount])), expected);
});

test("materialized plan drafts exactly match the public author output", {
  skip: !ASSET_ROOT
}, () => {
  const identities = materializedIdentities(), template = build(),
    files = fs.readdirSync(path.join(ASSET_ROOT, "plans")).sort();
  assert.deepEqual(files, template.plans.map(item => `${item.scenarioId}.json`).sort());
  for (const expected of template.plans) {
    const identity = identities.byScenario.get(expected.scenarioId), result = build(identities.configDigest,
      identity?.armDigest ?? ZERO), item = result.plans.find(value => value.scenarioId === expected.scenarioId);
    const bytes = fs.readFileSync(path.join(ASSET_ROOT, "plans", `${item.scenarioId}.json`));
    assert.equal(bytes.toString("utf8"), JSON.stringify(item.plan) + "\n");
    assert.ok(bytes.length > 0 && bytes.length < 2 * 1024 * 1024);
  }
});

test("final materialized composite identities are nonzero when explicitly required", {
  skip: !ASSET_ROOT || process.env.PIAGENT_REQUIRE_FINAL_PLAN_IDENTITIES !== "1"
}, () => {
  const identities = materializedIdentities();
  assert.notEqual(identities.configDigest, ZERO);
  assert.equal(identities.byScenario.size, 4);
  for (const [scenarioId, identity] of identities.byScenario) {
    assert.equal(identity.suiteDigest, SUITE_DIGEST, scenarioId);
    assert.notEqual(identity.armDigest, ZERO, scenarioId);
  }
});

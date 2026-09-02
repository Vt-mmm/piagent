import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadBenchmarkSuite, resolveBenchmarkSuiteEntry
} from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { openHostContractConfiguration
} from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { loadRegisteredBenchmarkVerificationPlan
} from "../scripts/benchmark-independent-verification.mjs";

const root = fs.realpathSync.native(path.resolve(import.meta.dirname, ".."));
const assetRootInput = process.env.PIAGENT_REGISTERED_ASSET_ROOT ?? null;
const suiteDigest = "83b03a0ec872d1d6196fb8c4447e628459c11303748109c24da8dbccbbece8cb";
const sha = value => createHash("sha256").update(value).digest("hex");

function inventory(assetRoot) {
  const entries = [], pending = [[assetRoot, ""]];
  while (pending.length) {
    const [directory, prefix] = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name,
        target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push([target, relative]);
      else {
        assert.equal(entry.isFile(), true, relative);
        const bytes = fs.readFileSync(target);
        entries.push(Object.freeze({ path: relative, bytes: bytes.length, sha256: sha(bytes) }));
      }
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  assert.equal(entries.length, 48);
  return Object.freeze({ entries: Object.freeze(entries) });
}

function measurement(assetRoot) {
  const catalog = JSON.parse(fs.readFileSync(path.join(assetRoot, "catalog.json"), "utf8")),
    nodeProfile = JSON.parse(fs.readFileSync(path.join(assetRoot, "measurement", "node-workload-api-v1.json"), "utf8")),
    firstPlan = JSON.parse(fs.readFileSync(path.join(assetRoot, "plans",
      `${catalog.scenarios[0].scenarioId}.json`), "utf8")),
    promptRolesChanged = fs.readdirSync(path.join(assetRoot, "measurement", "prompts"))
      .filter(name => name.endsWith(".md")).map(name => path.basename(name, ".md")).sort(),
    configDigests = new Set();
  for (const scenarioId of ["incident-diagnosis", "protected-env-refusal",
    "repository-prompt-injection", "destructive-history-refusal"]) {
    const plan = JSON.parse(fs.readFileSync(path.join(assetRoot, "plans", `${scenarioId}.json`), "utf8"));
    for (const contract of plan.contracts) configDigests.add(contract.planContext.identity.configDigest);
  }
  assert.equal(configDigests.size, 1);
  return Object.freeze({ assetRoot, inventory: inventory(assetRoot), payload: Object.freeze({
    suiteId: "production-v2-da2", baseSuiteDigest: suiteDigest,
    sharedEnvironmentDigest: [...configDigests][0], nodeProfileDigest: nodeProfile.profile.digest,
    catalogDigest: sha(JSON.stringify(catalog)), promptRolesChanged: Object.freeze(promptRolesChanged),
    scenarioIds: Object.freeze(catalog.scenarios.map(item => item.scenarioId)),
    resources: Object.freeze({ verifiers: Object.freeze([Object.freeze({ id: "docker-runtime",
      sha256: firstPlan.backend.dockerCommand.sha256 })]) })
  }) });
}

test("registered loader binds and provisions all 27 exact public plans provider-free", {
  skip: assetRootInput ? false : "requires the registered public asset root",
  timeout: 120000
}, t => {
  const assetRoot = fs.realpathSync.native(assetRootInput), registeredMeasurement = measurement(assetRoot),
    { suite, suiteRoot } = loadBenchmarkSuite("production-v2", root),
    loaded = loadRegisteredBenchmarkVerificationPlan({ registeredMeasurement, installedRoot: root,
      suiteDigest, scenarios: suite.scenarios, suiteRoot, resolveSuiteEntry: resolveBenchmarkSuiteEntry }),
    temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "registered-plan-loader-"))),
    projectRoot = fs.realpathSync.native(path.join(root, "benchmarks", "production-v2", "project"));
  fs.chmodSync(temporary, 0o700);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  assert.equal(loaded.isCurrent(), true);
  assert.equal(loaded.identity.scenarios.length, 27);
  assert.equal(loaded.measurementConfigurationDigest, registeredMeasurement.payload.sharedEnvironmentDigest);
  let turns = 0;
  for (const scenario of suite.scenarios) {
    const registeredInput = loaded.registeredInput(scenario.id);
    assert.equal(registeredInput.scenarioId, scenario.id);
    turns += registeredInput.turns.length;
    const directory = path.join(temporary, scenario.id), prepared = loaded.prepare({
      scenarioId: scenario.id, surface: "piagent", projectRoot, directory, approved: true
    });
    assert.equal(path.dirname(prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG), directory);
    const configuration = openHostContractConfiguration({
      configPath: prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG,
      projectRoot, installedRoot: root
    });
    try {
      const request = loaded.identity.scenarios.find(item => item.scenarioId === scenario.id).requests[0];
      assert.ok(configuration.forRequest(request.operatorRequestDigest));
      assert.equal(configuration.isCurrent(), true);
    } finally { configuration.close(); }
    assert.equal(prepared.observe([]).status, "partial");
  }
  assert.equal(turns, 54);
  assert.equal(loaded.prepare({ scenarioId: suite.scenarios[0].id, surface: "codex-cli",
    projectRoot, approved: false }), null);
});

test("registered loader rejects one changed approved plan before provisioning authority", {
  skip: assetRootInput ? false : "requires the registered public asset root"
}, t => {
  const source = fs.realpathSync.native(assetRootInput), temporary = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "registered-plan-drift-"))), assetRoot = path.join(temporary, "assets");
  fs.cpSync(source, assetRoot, { recursive: true, errorOnExist: true });
  const canonical = fs.realpathSync.native(assetRoot), registeredMeasurement = measurement(canonical),
    changed = path.join(canonical, "plans", "expiry-boundary.json"), { suite, suiteRoot } = loadBenchmarkSuite("production-v2", root);
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  fs.chmodSync(changed, fs.statSync(changed).mode | 0o200);
  fs.appendFileSync(changed, " ");
  assert.throws(() => loadRegisteredBenchmarkVerificationPlan({ registeredMeasurement,
    installedRoot: root, suiteDigest, scenarios: suite.scenarios, suiteRoot,
    resolveSuiteEntry: resolveBenchmarkSuiteEntry }), /not one approved regular file|changed during approved read/);
});

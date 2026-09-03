import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { applyBenchmarkClaimRestrictions } from "../packages/piagent-core/benchmark/benchmark-claim-restrictions.js";
import { codexExecArgs } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import { classifyCodexAttemptOutcome } from "../packages/piagent-core/benchmark/benchmark-codex-outcome.js";
import { benchmarkPreflight } from "../packages/piagent-core/benchmark/benchmark-preflight.js";
import {
  benchmarkCommandIdentity,
  benchmarkStockCodexIdentity,
  verifyBenchmarkCommandIdentity
} from "../packages/piagent-core/benchmark/benchmark-runtime-identity.js";
import { classifyPreUsageFailure } from "../packages/piagent-core/benchmark/benchmark-transport-evidence.js";
import { parseCodexExecJsonl } from "../packages/piagent-core/benchmark/benchmark-usage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, "tests", "fixtures", "codex-jsonl-v3");

function fixture(name) {
  return fs.readFileSync(path.join(fixtureRoot, `${name}.jsonl`), "utf8");
}

function executable(file, body = "#!/bin/sh\nexit 0\n") {
  fs.writeFileSync(file, body, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
}

function stockInstallation(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-stock-codex-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const codex = path.join(directory, "codex");
  const host = path.join(directory, "codex-code-mode-host");
  executable(codex);
  executable(host, "#!/bin/sh\nexit 3\n");
  return { directory, codex, host };
}

test("production-v3 exposes stock and controlled-custom as separate baseline identities", () => {
  assert.equal(parseBenchmarkArgs([]).codexBaseline, "stock");
  assert.equal(parseBenchmarkArgs(["--codex-baseline", "controlled-custom"]).codexBaseline, "controlled-custom");
  assert.throws(() => parseBenchmarkArgs(["--codex-baseline", "native"]), /stock or controlled-custom/);
  const args = codexExecArgs({ workspace: "/tmp/work", options: {
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", codexMode: "controlled", codexBaseline: "stock"
  } });
  assert.equal(args.includes("code_mode_host"), false, "stock mode must not evade a missing host by disabling it");
  assert.throws(() => codexExecArgs({ workspace: "/tmp/work", options: {
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", codexMode: "controlled", codexBaseline: "stock"
  }, scopedBroker: { nodeCommand: "/tmp/node", brokerScript: "/tmp/broker", brokerConfigPath: "/tmp/config" } }),
  /Stock Codex baseline cannot use the custom scoped broker/);
  const report = { comparison: { tokenClaimAllowed: true, claimEligibility: {} }, verdict: { status: "piagent-more-efficient" } };
  applyBenchmarkClaimRestrictions(report, { surfaces: ["piagent", "codex-cli"], codexMode: "controlled",
    codexBaseline: "controlled-custom" });
  assert.equal(report.customCodexDiagnosticOnly, true);
  assert.equal(report.comparison.tokenClaimAllowed, false);
});

test("stock command identity binds and continuously verifies its required installation closure", t => {
  const value = stockInstallation(t);
  const identity = benchmarkStockCodexIdentity(value.codex);
  assert.equal(identity.packageClosure, null);
  assert.equal(identity.installationClosure.kind, "stock-codex-installation-v1");
  assert.equal(identity.installationClosure.root, fs.realpathSync(value.directory));
  assert.deepEqual(identity.installationClosure.files.map(item => item.relativePath), ["codex", "codex-code-mode-host"]);
  assert.match(identity.installationClosure.contentDigest, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => verifyBenchmarkCommandIdentity(identity, "codex", { fullPackageClosure: true }));
  fs.renameSync(value.host, `${value.host}.missing`);
  assert.throws(() => verifyBenchmarkCommandIdentity(identity, "codex", { fullPackageClosure: true }),
    /required installation file.*codex-code-mode-host|installation closure/i);
});

test("stock preflight rejects a missing installation closure before invoking any command", async t => {
  const value = stockInstallation(t);
  fs.renameSync(value.host, `${value.host}.missing`);
  const generic = benchmarkCommandIdentity(value.codex);
  let commandCalls = 0;
  await assert.rejects(() => benchmarkPreflight({
    runCommand: async () => { commandCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
    packageRoot: value.directory,
    piCommand: "pi",
    piEnvironment: {},
    codexCommand: value.codex,
    codexCommandIdentity: generic,
    gitCommand: "git",
    surfaces: ["piagent", "codex-cli"],
    codexBaseline: "stock",
    codexMode: "controlled",
    codexRuntime: { mode: "controlled", home: value.directory },
    model: "openai-codex/gpt-5.6-luna",
    serviceTier: "default"
  }), /stock Codex installation closure/i);
  assert.equal(commandCalls, 0);
});

test("provider-free stock capability preflight checks version, auth, features, model mapping, and workspace-write", async t => {
  const value = stockInstallation(t);
  const identity = benchmarkStockCodexIdentity(value.codex);
  const calls = [];
  const runtime = await benchmarkPreflight({
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "--version") return { code: 0, stdout: command === "git" ? "git version 2.0" : command === "pi" ? "pi 1" : "codex-cli 0.153.0", stderr: "" };
      if (args[0] === "login") return { code: 0, stdout: "Logged in", stderr: "" };
      if (args[0] === "features") return { code: 0, stdout: "fast_mode stable true\ncode_mode_host stable true\n", stderr: "" };
      if (args[0] === "exec" && args[1] === "--help") return { code: 0, stdout: "-s, --sandbox <SANDBOX_MODE> [possible values: read-only, workspace-write, danger-full-access]\n--json\n--ignore-user-config\n--ignore-rules", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
    packageRoot: value.directory,
    piCommand: "pi",
    piEnvironment: {},
    codexCommand: value.codex,
    codexCommandIdentity: identity,
    gitCommand: "git",
    surfaces: ["piagent", "codex-cli"],
    codexBaseline: "stock",
    codexMode: "controlled",
    codexRuntime: { mode: "controlled", home: value.directory },
    model: "openai-codex/gpt-5.6-luna",
    serviceTier: "fast"
  });
  assert.equal(runtime.codexBaseline, "stock");
  assert.equal(runtime.codexInstallationDigest, identity.installationClosure.contentDigest);
  assert.equal(runtime.codexCapability.workspaceWrite, true);
  assert.equal(runtime.codexCapability.jsonl, true);
  assert.ok(calls.some(([, ...args]) => args[0] === "exec" && args[1] === "--help"));
});

test("Codex success has a terminal message and a redacted authoritative event summary", () => {
  const raw = fixture("success");
  const usage = parseCodexExecJsonl(raw, { eventContract: "production-v3", processExitCode: 0 });
  assert.equal(usage.usageCompleteness, "exact");
  assert.equal(usage.codexEventOutcome.failureClass, null);
  assert.equal(usage.codexEventOutcome.runValidity, "valid");
  assert.equal(usage.codexEventOutcome.terminalAgentMessage, true);
  assert.equal(usage.codexEventSummary.rawPayloadStored, false);
  assert.equal(JSON.stringify(usage.codexEventSummary).includes("Implemented and verified"), false);
  assert.equal(usage.jsonlEvidence.sha256.length, 64);
});

test("exit zero plus top-level error, turn.failed, item error, and failed command are agent failures with exact usage", () => {
  for (const name of ["exit-zero-error-before-terminal", "turn-failed-with-usage", "item-error", "failed-command"]) {
    const usage = parseCodexExecJsonl(fixture(name), { eventContract: "production-v3", processExitCode: 0 });
    assert.equal(usage.usageCompleteness, "exact", name);
    assert.equal(usage.codexEventOutcome.runValidity, "valid", name);
    assert.equal(usage.codexEventOutcome.failureClass, "agent_tool_failure", name);
    assert.equal(usage.codexEventOutcome.countsTowardQuality, true, name);
    assert.equal(usage.codexEventOutcome.countsTowardUsage, true, name);
    assert.ok(usage.fresh > 0, name);
  }
});

test("before-thread, after-terminal, duplicate-terminal, missing-usage, and missing-thread fixtures fail closed", () => {
  const cases = {
    "error-before-thread": "harness_contract_failure",
    "error-after-terminal": "harness_contract_failure",
    "duplicate-terminal": "harness_contract_failure",
    "missing-usage": "unknown_terminal",
    "missing-thread-id": "harness_contract_failure"
  };
  for (const [name, failureClass] of Object.entries(cases)) {
    assert.throws(() => parseCodexExecJsonl(fixture(name), {
      eventContract: "production-v3", processExitCode: 0
    }), error => error?.code === "BENCHMARK_CODEX_EVENT_CONTRACT_INVALID"
      && error?.failureClass === failureClass
      && error?.codexEventSummary?.rawPayloadStored === false, name);
  }
});

test("authoritative Codex outcomes preserve exact failed usage and own lifecycle-invalid classification", () => {
  const failedUsage = parseCodexExecJsonl(fixture("failed-command"), {
    eventContract: "production-v3", processExitCode: 7
  });
  assert.equal(failedUsage.usageCompleteness, "exact");
  assert.equal(failedUsage.codexEventOutcome.failureClass, "agent_tool_failure");
  assert.equal(classifyPreUsageFailure({ code: 7, timedOut: false }, failedUsage, "", {}), undefined);

  let invalid;
  assert.throws(() => parseCodexExecJsonl(fixture("error-after-terminal"), {
    eventContract: "production-v3", processExitCode: 0
  }), error => {
    invalid = error;
    return true;
  });
  assert.equal(invalid.usage.usageCompleteness, "exact");
  assert.deepEqual(classifyPreUsageFailure({ code: 0, timedOut: false }, invalid.usage, "", {}), {
    failure: "codex-event-contract-invalid:event-after-terminal,invalid-top-level-error-position",
    class: "harness-contract",
    usageStatus: "measured-but-unaccepted",
    retryable: false
  });
});

test("missing terminal message and zero-change mutation are quality failures, never transport success", () => {
  const missingMessage = parseCodexExecJsonl(fixture("missing-agent-message"), {
    eventContract: "production-v3", processExitCode: 0
  });
  assert.equal(missingMessage.codexEventOutcome.failureClass, "agent_task_failure");
  const zeroChange = classifyCodexAttemptOutcome({
    eventOutcome: parseCodexExecJsonl(fixture("success"), {
      eventContract: "production-v3", processExitCode: 0
    }).codexEventOutcome,
    scenarioKind: "source-change",
    changedFiles: []
  });
  assert.deepEqual(zeroChange, {
    failureClass: "agent_task_failure",
    reason: "mutation-produced-no-file-change",
    countsTowardQuality: true,
    countsTowardUsage: true
  });
});

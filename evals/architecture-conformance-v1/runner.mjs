#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectArchitecture } from "../../scripts/check-architecture.mjs";

const laneRoot = path.dirname(fileURLToPath(import.meta.url));
const lane = JSON.parse(fs.readFileSync(path.join(laneRoot, "lane.json"), "utf8"));
const argumentsList = process.argv.slice(2);
const outputIndex = argumentsList.indexOf("--output");
const outputArgument = outputIndex >= 0 ? argumentsList[outputIndex + 1] : undefined;
if (outputIndex >= 0 && !outputArgument) throw new Error("--output requires a path");
const outputValueIndex = outputIndex >= 0 ? outputIndex + 1 : -1;
const unknown = argumentsList.filter((_, index) => index !== outputIndex && index !== outputValueIndex);
if (unknown.length > 0) throw new Error(`Unknown option: ${unknown[0]}`);
const requiredGates = {
  architectureCheckPasses: true,
  sourceCoverageComplete: true,
  dependencyBoundariesPass: true,
  lineBudgetsPass: true,
  providerCalls: 0,
  modelTokens: 0
};
if (lane?.schemaVersion !== 1 || lane.id !== "architecture-conformance-v1"
  || lane.providerRequired !== false || lane.modelTokensExpected !== 0
  || lane.checker !== "scripts/check-architecture.mjs"
  || lane.configuration !== "architecture/layers.json"
  || JSON.stringify(lane.releaseGates) !== JSON.stringify(requiredGates)
  || typeof lane.claimBoundary !== "string" || lane.claimBoundary.length === 0) {
  throw new Error("Unsupported architecture conformance lane configuration");
}

let inspection;
let failure = null;
try {
  inspection = inspectArchitecture();
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  inspection = { ok: false, errors: [failure], files: 0, layers: {} };
}
const errors = Array.isArray(inspection.errors) ? inspection.errors : ["invalid-architecture-result"];
const gates = {
  architectureCheckPasses: inspection.ok === true && errors.length === 0,
  sourceCoverageComplete: errors.every((error) => !String(error).includes("source file is not assigned")),
  dependencyBoundariesPass: errors.every((error) => !String(error).includes(" cannot import ")),
  lineBudgetsPass: errors.every((error) => !String(error).includes(" lines exceeds ")),
  providerCalls: 0,
  modelTokens: 0
};
const passed = failure === null
  && Object.entries(gates).every(([name, value]) => name === "providerCalls" || name === "modelTokens" ? value === 0 : value === true);
const report = {
  schemaVersion: 1,
  laneId: lane.id,
  evidenceClass: "provider-free-architecture-conformance",
  passed,
  provider: { required: false, used: false, calls: 0, modelTokens: 0 },
  architecture: {
    filesChecked: Number.isSafeInteger(inspection.files) ? inspection.files : 0,
    layersChecked: Object.keys(inspection.layers ?? {}).length,
    errors: errors.map(String)
  },
  gates,
  claimBoundary: lane.claimBoundary
};

if (outputArgument) {
  const outputPath = path.resolve(outputArgument);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
if (passed) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
}

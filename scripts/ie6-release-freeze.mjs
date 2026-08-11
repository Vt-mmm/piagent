#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateIe6Prerequisites,
  ie6ChunkPlan,
  ie6ReleaseArguments,
  ie6ReleaseProtocolValidationErrors
} from "../packages/piagent-core/benchmark/ie6-release-protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const protocolPath = path.join(root, "evals/ie6-release-protocol.v1.json");

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function digest(bytes, algorithm = "sha256", encoding = "hex") {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}

function parseArgs(values) {
  const result = { check: false, output: "" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--check") {
      if (result.check) fail("duplicate --check");
      result.check = true;
      continue;
    }
    if (value === "--output") {
      if (result.output) fail("duplicate --output");
      const output = values[index + 1];
      if (!output || output.startsWith("--")) fail("--output requires a path");
      result.output = path.resolve(process.cwd(), output);
      index += 1;
      continue;
    }
    fail(`unknown option ${value}`);
  }
  if (!result.check && !result.output) fail("--output is required unless --check is used");
  if (result.check && result.output) fail("--check and --output are mutually exclusive");
  return result;
}

function run(command, args, { timeout = 900_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    env: { ...process.env, PIAGENT_NO_UPDATE_CHECK: "1", PI_OFFLINE: "1" }
  });
  if (result.status !== 0) fail(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "no output").trim()}`);
  return result.stdout;
}

const options = parseArgs(process.argv.slice(2));
const protocolBytes = fs.readFileSync(protocolPath);
const protocol = JSON.parse(protocolBytes);
const errors = ie6ReleaseProtocolValidationErrors(protocol);
if (errors.length) fail(`invalid IE6 protocol: ${errors.join("; ")}`);
for (const artifact of protocol.artifactBindings) {
  const actual = digest(fs.readFileSync(path.join(root, artifact.path)));
  if (actual !== artifact.sha256) fail(`artifact binding mismatch for ${artifact.path}`);
}

const chunks = ie6ChunkPlan(protocol);
const emptyPrerequisites = evaluateIe6Prerequisites(protocol);
if (options.check) {
  process.stdout.write(`${JSON.stringify({
    status: "valid-provider-closed",
    protocol: protocol.id,
    expectedPackageVersion: protocol.candidate.expectedPackageVersion,
    totalSessions: protocol.suite.totalSessions,
    chunks: chunks.length,
    sessionsPerChunk: protocol.suite.maximumSessionsPerChunk,
    providerSessionsStarted: 0,
    providerExecutionAuthorized: false,
    prerequisiteBlockers: emptyPrerequisites.blockers
  }, null, 2)}\n`);
  process.exit(0);
}

const status = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
if (status !== "") fail("working tree must be clean before IE6 freeze");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.version !== protocol.candidate.expectedPackageVersion) fail("package version does not match the IE6 protocol");

run("npm", ["run", "verify"]);
run("npm", ["run", "release:identity"]);
if (execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }) !== "") {
  fail("local gates mutated the frozen working tree");
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-ie6-freeze-"));
let packed;
try {
  const packOutput = run("npm", ["pack", "--json", "--pack-destination", temporary]);
  const pack = JSON.parse(packOutput)[0];
  const tarballPath = path.join(temporary, pack.filename);
  const tarballBytes = fs.readFileSync(tarballPath);
  packed = {
    filename: pack.filename,
    packageVersion: pack.version,
    byteSize: tarballBytes.byteLength,
    fileCount: pack.files.length,
    sha512: digest(tarballBytes, "sha512", "hex")
  };
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

const preflightArgs = ie6ReleaseArguments(protocol, { mode: "preflight" });
const preflight = JSON.parse(run(process.execPath, ["scripts/benchmark-runner.mjs", ...preflightArgs], { timeout: 120_000 }));
if (preflight.status !== "ready" || preflight.providerSessionsStarted !== 0) fail("production preflight was not provider-free and ready");
if (preflight.packageVersion !== packageJson.version || preflight.source?.commit !== head || preflight.source?.dirty !== false) {
  fail("production preflight candidate identity does not match the clean release commit");
}
const localGates = Object.fromEntries(protocol.prerequisites.local.map((gate) => [gate, true]));
const prerequisiteState = evaluateIe6Prerequisites(protocol, {
  local: localGates,
  platforms: { [`${process.platform}-${process.arch}`]: true },
  cohorts: { cohortATasks: 0, cohortBAttempts: 0, cohortCTerminalAttempts: 0 },
  independentHumanParticipants: 0,
  privateFamilyDisjointHoldout: false,
  longHorizonInterruptionResume: false,
  explicitOperatorChunkApproval: false
});

const receipt = {
  schemaVersion: 1,
  id: "ie6-release-freeze-receipt-v1",
  generatedAt: new Date().toISOString(),
  protocol: { id: protocol.id, sha256: digest(protocolBytes) },
  candidate: {
    commit: head,
    packageVersion: packageJson.version,
    contentDigest: preflight.candidateProvenance.contentDigest,
    fileCount: preflight.candidateProvenance.fileCount,
    sourceKind: preflight.source.kind,
    clean: true
  },
  tarball: packed,
  benchmark: {
    suite: preflight.suite.id,
    suiteDigest: preflight.suite.contentDigest,
    configurationDigest: preflight.configuration.contentDigest,
    runtimeDependencyDigest: preflight.configuration.runtimeDependencyDigest,
    environmentPolicyDigest: preflight.configuration.environmentPolicyDigest,
    model: preflight.configuration.model,
    thinking: preflight.configuration.thinking,
    treatment: preflight.configuration.piagentTreatment,
    totalSessions: protocol.suite.totalSessions,
    chunks: chunks.length,
    sessionsPerChunk: protocol.suite.maximumSessionsPerChunk,
    providerSessionsStarted: 0
  },
  localGates,
  authorization: {
    providerExecution: false,
    cohortExecution: false,
    releaseBenchmark: false,
    tag: false,
    push: false,
    publish: false,
    publicDocsPromotion: false
  },
  blockers: prerequisiteState.blockers
};

fs.mkdirSync(path.dirname(options.output), { recursive: true, mode: 0o700 });
const descriptor = fs.openSync(options.output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
try {
  fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
process.stdout.write(`${JSON.stringify({ output: options.output, status: "frozen-provider-closed", commit: head, candidateDigest: receipt.candidate.contentDigest, tarballSha512: packed.sha512, blockers: receipt.blockers }, null, 2)}\n`);

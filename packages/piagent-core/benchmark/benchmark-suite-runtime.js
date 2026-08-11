import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { benchmarkAssuranceEvidenceValidationErrors } from "./benchmark-core.js";
import { validateBenchmarkSuite } from "./benchmark-suite.js";
import { assertBenchmarkModuleGraphBound } from "./benchmark-suite-assets.js";

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function inside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function loadBenchmarkSuite(input, packageRoot) {
  const builtIn = new Map([
    ["core-v1", path.join(packageRoot, "benchmarks", "core-v1", "suite.json")],
    ["capability-v1", path.join(packageRoot, "benchmarks", "capability-v1", "suite.json")],
    ["e2-framework-v1", path.join(packageRoot, "benchmarks", "e2-framework-v1", "suite.json")],
    ["production-v1", path.join(packageRoot, "benchmarks", "production-v1", "suite.json")]
  ]);
  const candidate = builtIn.get(input) ?? path.resolve(input);
  const manifestPath = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()
    ? path.join(candidate, "suite.json")
    : candidate;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")); }
  catch (error) { fail(`Cannot read benchmark suite ${manifestPath}: ${error.message}`); }
  const suite = validateBenchmarkSuite(raw);
  return { suite, manifestPath: fs.realpathSync(manifestPath), suiteRoot: fs.realpathSync(path.dirname(manifestPath)) };
}

export function resolveBenchmarkSuiteEntry(suiteRoot, relativePath, kind) {
  const lexical = path.resolve(suiteRoot, relativePath);
  if (!inside(suiteRoot, lexical)) fail(`Suite ${kind} escapes its root: ${relativePath}`);
  let resolved;
  try { resolved = fs.realpathSync(lexical); }
  catch { fail(`Suite ${kind} does not exist: ${relativePath}`); }
  if (!inside(suiteRoot, resolved)) fail(`Suite ${kind} resolves outside its root: ${relativePath}`);
  const stat = fs.statSync(resolved);
  if (kind === "fixture" ? !stat.isDirectory() : !stat.isFile()) fail(`Suite ${kind} has the wrong file type: ${relativePath}`);
  return resolved;
}

function rejectSymlinks(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail(`Benchmark fixture must not contain symbolic links: ${path.relative(root, target)}`);
      if (stat.isDirectory()) pending.push(target);
    }
  }
}

export function validateBenchmarkSuiteFiles(suite, suiteRoot) {
  rejectSymlinks(suiteRoot);
  for (const scenario of suite.scenarios) {
    const fixture = resolveBenchmarkSuiteEntry(suiteRoot, scenario.fixture, "fixture");
    const prompt = resolveBenchmarkSuiteEntry(suiteRoot, scenario.prompt, "prompt");
    const grader = resolveBenchmarkSuiteEntry(suiteRoot, scenario.grader, "grader");
    const generator = scenario.variantGenerator
      ? resolveBenchmarkSuiteEntry(suiteRoot, scenario.variantGenerator, "variant generator")
      : null;
    assertBenchmarkModuleGraphBound(grader, suiteRoot, `${scenario.id} grader`);
    if (generator) assertBenchmarkModuleGraphBound(generator, suiteRoot, `${scenario.id} variant generator`);
    if (inside(fixture, grader) || inside(fixture, prompt)) fail(`Suite prompt and grader must stay outside the agent fixture: ${scenario.id}`);
    if (generator && inside(fixture, generator)) fail(`Suite variant generator must stay outside the agent fixture: ${scenario.id}`);
  }
}

export function loadBenchmarkAssuranceEvidence(suite, suiteRoot) {
  const relativePath = suite.assurance?.evidenceManifest;
  if (!relativePath) return { verified: false, reason: "not-declared" };
  const target = resolveBenchmarkSuiteEntry(suiteRoot, relativePath, "assurance evidence");
  const buffer = fs.readFileSync(target);
  let value;
  try { value = JSON.parse(buffer.toString("utf8")); }
  catch { fail(`Suite assurance evidence is not valid JSON: ${relativePath}`); }
  const errors = benchmarkAssuranceEvidenceValidationErrors(value);
  if (errors.length > 0) fail(`Suite assurance evidence is invalid: ${errors.join("; ")}`);
  const now = Date.now();
  const accessReceiptCurrent = value.schemaVersion === 2
    && now >= Date.parse(value.accessControl.issuedAt)
    && now < Date.parse(value.accessControl.expiresAt);
  if (value.schemaVersion === 2 && !accessReceiptCurrent) fail("Suite assurance access receipt is not currently valid");
  const matchingFields = [
    "claimTier", "visibility", "familyDisjointSplit", "repositoryDisjointSplit", "holdoutManifestDigest",
    "referenceSolutionDigest", "mutationReportDigest", "calibrationReportDigest", "accessPolicyDigest",
    "disjointnessReportDigest", "humanRubricDigest", "disagreementReportDigest"
  ];
  const mismatches = matchingFields.filter((field) => suite.assurance?.[field] !== value[field]);
  if (mismatches.length > 0) fail(`Suite assurance evidence does not match suite assurance: ${mismatches.join(", ")}`);
  return {
    verified: true,
    manifestPath: relativePath,
    manifestDigest: crypto.createHash("sha256").update(buffer).digest("hex"),
    schemaVersion: value.schemaVersion,
    accessReceiptCurrent,
    claimTier: value.claimTier,
    ...Object.fromEntries(matchingFields.slice(3).map((field) => [field, value[field]])),
    accessControl: value.accessControl,
    disjointness: value.disjointness,
    referenceSolutions: value.referenceSolutions,
    mutationChecks: value.mutationChecks,
    calibration: value.calibration
  };
}

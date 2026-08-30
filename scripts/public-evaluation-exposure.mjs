#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const EXPOSURE_PATH = "evals/private-holdout-v1/public-exposure.v2.json";
const PREVIOUS_PATH = "evals/private-holdout-v1/public-exposure.v1.json";
const TAXONOMY_PATH = "evals/real-task-taxonomy.v1.json";
const PUBLIC_TREES = [
  "adapters", "benchmarks", "evals/architecture-conformance-v1", "evals/golden",
  "evals/harness-next", "evals/long-horizon-v1", "evals/runtime-conformance-v1",
  "evals/scenarios", "tests"
];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const MAX_FILES = 10_000, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function reader(root) {
  let total = 0, count = 0;
  const cache = new Map();
  function checked(relative) {
    let current = root;
    for (const part of relative.split("/")) {
      if (!part || part === "." || part === ".." || part.includes("\\")) throw new Error("Invalid public exposure path");
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Public exposure inputs must not be symlinks");
    }
    return current;
  }
  function bytes(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const target = checked(relative), descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let value;
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Public exposure input is not a bounded regular file");
      value = fs.readFileSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    total += value.length;
    if (value.length > MAX_FILE_BYTES || ++count > MAX_FILES || total > MAX_TOTAL_BYTES) throw new Error("Public exposure inventory exceeds its limits");
    cache.set(relative, value);
    return value;
  }
  function files(relative) {
    const target = checked(relative);
    if (!fs.statSync(target).isDirectory()) throw new Error("Public exposure tree is not a directory");
    const result = [];
    for (const name of fs.readdirSync(target).sort()) {
      const child = `${relative}/${name}`, stat = fs.lstatSync(checked(child));
      if (stat.isDirectory()) result.push(...files(child));
      else if (stat.isFile()) { bytes(child); result.push(child); }
      else throw new Error("Public exposure tree contains a non-regular input");
    }
    return result;
  }
  return { bytes, files, json: (relative) => JSON.parse(bytes(relative).toString("utf8")) };
}

// Inventory public files only. Never load a private suite or execute an oracle.
// The predecessor is retained rather than silently erasing earlier exposure.
export function buildPublicExposure(root = DEFAULT_ROOT) {
  const read = reader(root), allFiles = new Map();
  const visibleTrees = PUBLIC_TREES.map((relative) => {
    const entries = read.files(relative).sort().map((file) => {
      const bytes = read.bytes(file), digest = sha256(bytes);
      allFiles.set(file, bytes);
      return [file, digest];
    });
    return { path: relative, fileCount: entries.length, sha256: sha256(JSON.stringify(entries)) };
  });
  const visibleSuites = [...allFiles.keys()].filter((file) => /^benchmarks\/[^/]+\/suite\.json$/.test(file)).map((file) => {
    const suite = read.json(file);
    if (!/^[a-z0-9-]+$/.test(suite.id ?? "") || file !== `benchmarks/${suite.id}/suite.json`
      || !Array.isArray(suite.scenarios) || suite.scenarios.length === 0) throw new Error("Invalid public suite identity");
    const scenarioIds = suite.scenarios.map((scenario) => scenario.id);
    if (scenarioIds.some((id) => !/^[a-z0-9-]+$/.test(id ?? "")) || new Set(scenarioIds).size !== scenarioIds.length) throw new Error("Invalid public scenario identities");
    return { id: suite.id, path: file, manifestSha256: sha256(read.bytes(file)), scenarioIds };
  });
  const contractLibraries = [...allFiles.keys()].filter((file) => /^adapters\/[^/]+\/contract-families\.json$/.test(file)).map((file) => {
    const library = read.json(file);
    if (library.schemaVersion !== 1 || !Array.isArray(library.families)) throw new Error("Invalid public contract library");
    const families = library.families.map(({ id, version }) => {
      if (!/^[a-z0-9-]+$/.test(id ?? "") || !Number.isSafeInteger(version) || version < 1) throw new Error("Invalid public contract family identity");
      return { id, version };
    });
    if (new Set(families.map(({ id, version }) => `${id}@${version}`)).size !== families.length) throw new Error("Duplicate public contract family identity");
    return { path: file, sha256: sha256(read.bytes(file)), families };
  });
  return {
    schemaVersion: 2,
    id: "author-visible-evaluation-exposure-v2",
    previousExposure: { path: PREVIOUS_PATH, sha256: sha256(read.bytes(PREVIOUS_PATH)) },
    taxonomy: { path: TAXONOMY_PATH, sha256: sha256(read.bytes(TAXONOMY_PATH)) },
    visibleSuites,
    contractLibraries,
    visibleTrees,
    custodianComparisonRules: {
      familyKey: "Compare private task and acceptance-mechanism lineage against every listed suite, contract family, public tree and predecessor exposure; renamed, generated or structurally varied descendants are not disjoint.",
      repositoryKey: "Compare repository history, origin, package graph and fixture lineage, not names alone.",
      minimumPrivateScenarios: 6, minimumPrivateFamilies: 6, minimumPrivateRepositories: 6,
      externalExposure: "The custodian must independently account for author-visible material outside these public roots, including prior local diagnostics and retained campaigns; this inventory is not a complete record of author knowledge.",
      publicOutput: "Export only the closed schema-v2 assurance receipt and independent custody attestation."
    },
    claimBoundary: "Current public-input inventory only, not independent evaluation, approval, generalization or release evidence. Public-tree digests bind [relative path, file SHA-256] pairs globally sorted by the slash-separated path's UTF-16 code units, serialized as compact JSON and hashed as UTF-8; no private artifacts are loaded."
  };
}

export function verifyPublicExposure(root = DEFAULT_ROOT) {
  const read = reader(root), bytes = read.bytes(EXPOSURE_PATH), actual = JSON.parse(bytes.toString("utf8"));
  if (!isDeepStrictEqual(actual, buildPublicExposure(root))) throw new Error("Current public exposure inventory is stale or incomplete; regenerate and obtain a new independent custody receipt");
  return { path: EXPOSURE_PATH, sha256: sha256(bytes), suiteCount: actual.visibleSuites.length,
    scenarioCount: actual.visibleSuites.reduce((sum, suite) => sum + suite.scenarioIds.length, 0),
    contractFamilyVersionCount: actual.contractLibraries.reduce((sum, library) => sum + library.families.length, 0),
    publicTreeCount: actual.visibleTrees.length };
}

// Node resolves module URLs through filesystem aliases. Compare actual files,
// otherwise /var versus /private/var (or a global-bin symlink) can skip the CLI.
const invokedDirectly = process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
    process.stdout.write("Usage: node scripts/public-evaluation-exposure.mjs --check|--write\nRequires the complete public source tree, including development tests. Generation does not grant custody or provider authority.\n");
    process.exit(0);
  }
  try {
    if (process.argv.length !== 3 || !["--check", "--write"].includes(process.argv[2])) throw new Error("Usage: node scripts/public-evaluation-exposure.mjs --check|--write");
    if (process.argv[2] === "--write") {
      const destination = path.join(DEFAULT_ROOT, EXPOSURE_PATH);
      if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink()) throw new Error("Refusing a symlinked public exposure destination");
      fs.writeFileSync(destination, `${JSON.stringify(buildPublicExposure(), null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(verifyPublicExposure())}\n`);
  } catch {
    process.stderr.write("REFUSED: current public exposure inventory is unavailable, stale or incomplete; inspect public inputs and regenerate before independent custody review\n");
    process.exitCode = 1;
  }
}

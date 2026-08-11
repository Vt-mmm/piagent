import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  assertBenchmarkTreeIdentity,
  assertBenchmarkTreeStatIdentity,
  benchmarkTreeIdentity,
  benchmarkTreeStatIdentity
} from "./benchmark-tree-identity.js";

function fail(message) {
  const error = new Error(message);
  error.code = "BENCHMARK_RUNTIME_IDENTITY_INVALID";
  error.exitCode = 1;
  throw error;
}

function executableCandidate(requested, cwd, env) {
  if (requested.includes(path.sep) || (path.sep === "\\" && requested.includes("/"))) {
    return path.resolve(cwd, requested);
  }
  for (const directory of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, requested);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* Try the next PATH entry. */ }
  }
  fail(`Required benchmark command is unavailable: ${requested}`);
}

function commandPackageRoot(resolvedPath) {
  let current = path.dirname(resolvedPath);
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    if (fs.existsSync(manifest) && fs.statSync(manifest).isFile()) {
      try {
        const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
        if (typeof value.name === "string" && typeof value.version === "string") {
          return { root: current, name: value.name, version: value.version };
        }
      } catch (error) {
        fail(`Cannot inspect benchmark command package ${manifest}: ${error.message}`);
      }
    }
    current = path.dirname(current);
  }
  return null;
}

function stableExecutable(file, label) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`Benchmark command is not a regular file: ${label}`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const stable = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every((field) => before[field] === after[field]);
    if (!stable || BigInt(bytes.length) !== after.size) fail(`Benchmark command changed while it was read: ${label}`);
    return { bytes, stat: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function benchmarkCommandIdentity(requested, { cwd = process.cwd(), env = process.env, fullPackageClosure = true } = {}) {
  const selectedPath = executableCandidate(requested, cwd, env);
  let resolvedPath;
  let observed;
  try {
    resolvedPath = fs.realpathSync(selectedPath);
    observed = stableExecutable(resolvedPath, requested);
  } catch (error) {
    fail(`Cannot inspect benchmark command ${requested}: ${error.message}`);
  }
  const { bytes, stat } = observed;
  const packageInfo = commandPackageRoot(resolvedPath);
  return {
    schemaVersion: 1,
    requested,
    selectedPath: path.resolve(selectedPath),
    resolvedPath,
    kind: "regular",
    executable: (stat.mode & 0o111n) !== 0n,
    size: bytes.length,
    contentDigest: crypto.createHash("sha256").update(bytes).digest("hex"),
    packageClosure: packageInfo ? {
      root: packageInfo.root,
      name: packageInfo.name,
      version: packageInfo.version,
      stat: benchmarkTreeStatIdentity(packageInfo.root, { rejectEscapingSymlinks: true }),
      tree: fullPackageClosure ? benchmarkTreeIdentity(packageInfo.root, { rejectEscapingSymlinks: true }) : null
    } : null
  };
}

export function assertBenchmarkCommandIdentity(expected, observed, label, { fullPackageClosure = true } = {}) {
  const valid = (value) => value?.schemaVersion === 1
    && value.kind === "regular"
    && typeof value.resolvedPath === "string"
    && /^[a-f0-9]{64}$/.test(String(value.contentDigest ?? ""))
    && Number.isInteger(value.size)
    && typeof value.executable === "boolean";
  if (!valid(expected) || !valid(observed)) fail(`${label} command identity is missing or unsupported`);
  const fields = ["resolvedPath", "kind", "executable", "size", "contentDigest"];
  const mismatches = fields.filter((field) => expected[field] !== observed[field]);
  if (mismatches.length > 0) fail(`${label} command changed: ${mismatches.join(", ")}`);
  if (JSON.stringify(expected.packageClosure?.root ?? null) !== JSON.stringify(observed.packageClosure?.root ?? null)) {
    fail(`${label} command package root changed`);
  }
  if (expected.packageClosure) {
    if (expected.packageClosure.name !== observed.packageClosure?.name || expected.packageClosure.version !== observed.packageClosure?.version) {
      fail(`${label} command package identity changed`);
    }
    assertBenchmarkTreeStatIdentity(expected.packageClosure.stat, observed.packageClosure?.stat, `${label} command package closure`);
    if (fullPackageClosure) assertBenchmarkTreeIdentity(expected.packageClosure.tree, observed.packageClosure?.tree, `${label} command package closure`);
  }
  return observed;
}

export function verifyBenchmarkCommandIdentity(identity, label, options = {}) {
  const observed = benchmarkCommandIdentity(identity.resolvedPath, { fullPackageClosure: options.fullPackageClosure === true });
  return assertBenchmarkCommandIdentity(identity, observed, label, options);
}

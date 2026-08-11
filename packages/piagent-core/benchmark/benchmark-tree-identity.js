import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const algorithm = "sha256-length-prefixed-tree-v1";
const statAlgorithm = "sha256-length-prefixed-tree-stat-v1";
const taskWorkingTreeDigest = /^wt-content-v2:[a-f0-9]{64}$/;
const canonicalPathCompare = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

// Benchmark code is an architecture-isolated consumer. This predicate mirrors
// the public task-evidence namespace without importing the runtime core.
export function isCurrentTaskWorkingTreeDigest(value) {
  return typeof value === "string" && taskWorkingTreeDigest.test(value);
}

export function taskWorkingTreeSnapshotUsesCurrentAlgorithm(snapshot) {
  return Boolean(snapshot)
    && typeof snapshot === "object"
    && !Array.isArray(snapshot)
    && Object.values(snapshot).every(isCurrentTaskWorkingTreeDigest);
}

export function taskWorkingTreeEvidenceDigest(snapshot) {
  if (!taskWorkingTreeSnapshotUsesCurrentAlgorithm(snapshot)) return undefined;
  const entries = Object.entries(snapshot).sort(([left], [right]) => canonicalPathCompare(left, right));
  const material = `tree\0wt-content-v2\0${JSON.stringify(entries)}`;
  return `wt-content-v2:${crypto.createHash("sha256").update(material).digest("hex")}`;
}

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function field(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function stableFileBytes(file, label) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`Benchmark tree path is not a regular file: ${label}`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const fields = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"];
    if (fields.some((field) => before[field] !== after[field]) || BigInt(bytes.length) !== after.size) {
      fail(`Benchmark tree file changed while it was read: ${label}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function entries(root, rejectSymlinks, rejectEscapingSymlinks) {
  const canonical = fs.realpathSync(root);
  const result = [];
  const symlinkTargets = [];
  const pending = [canonical];
  while (pending.length > 0) {
    const current = pending.pop();
    const names = fs.readdirSync(current).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const target = path.join(current, name);
      const relative = path.relative(canonical, target).split(path.sep).join("/");
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        if (rejectSymlinks) fail(`Benchmark tree rejects symbolic link: ${relative}`);
        const payload = fs.readlinkSync(target);
        if (rejectEscapingSymlinks) {
          if (path.isAbsolute(payload)) fail(`Benchmark tree symlink must be relative: ${relative}`);
          let resolved;
          try { resolved = fs.realpathSync(target); }
          catch (error) { fail(`Benchmark tree symlink is broken: ${relative} (${error.message})`); }
          if (!inside(canonical, resolved)) fail(`Benchmark tree symlink escapes its bound root: ${relative}`);
          symlinkTargets.push(path.relative(canonical, resolved).split(path.sep).join("/"));
        }
        result.push({ path: relative, kind: "symlink", mode: "120000", payload: Buffer.from(payload, "utf8") });
      } else if (stat.isDirectory()) {
        result.push({ path: relative, kind: "directory", mode: "040000", payload: Buffer.alloc(0) });
        pending.push(target);
      } else if (stat.isFile()) {
        result.push({ path: relative, kind: "regular", mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644", payload: stableFileBytes(target, relative) });
      } else {
        fail(`Benchmark tree contains unsupported node type: ${relative}`);
      }
    }
  }
  const sorted = result.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  if (rejectEscapingSymlinks) {
    const represented = new Set(sorted.map((entry) => entry.path));
    for (const target of symlinkTargets) if (target && !represented.has(target)) fail(`Benchmark tree symlink target is not represented: ${target}`);
  }
  return sorted;
}

export function benchmarkTreeIdentity(root, { rejectSymlinks = false, rejectEscapingSymlinks = false } = {}) {
  const treeEntries = entries(root, rejectSymlinks, rejectEscapingSymlinks);
  const hash = crypto.createHash("sha256");
  field(hash, algorithm);
  field(hash, treeEntries.length);
  for (const entry of treeEntries) {
    field(hash, entry.path);
    field(hash, entry.kind);
    field(hash, entry.mode);
    field(hash, entry.payload);
  }
  return {
    schemaVersion: 1,
    algorithm,
    contentDigest: hash.digest("hex"),
    entryCount: treeEntries.length
  };
}

export function assertBenchmarkTreeIdentity(expected, observed, label) {
  const valid = (value) => value?.schemaVersion === 1
    && value.algorithm === algorithm
    && /^[a-f0-9]{64}$/.test(String(value.contentDigest ?? ""))
    && Number.isInteger(value.entryCount)
    && value.entryCount >= 0;
  if (!valid(expected) || !valid(observed)) fail(`${label} tree identity is missing or unsupported`);
  const mismatches = ["algorithm", "contentDigest", "entryCount"].filter((key) => expected[key] !== observed[key]);
  if (mismatches.length > 0) fail(`${label} tree changed: ${mismatches.join(", ")}`);
  return observed;
}

export function benchmarkTreeStatIdentity(root, { rejectEscapingSymlinks = false } = {}) {
  const canonical = fs.realpathSync(root);
  const hash = crypto.createHash("sha256");
  const pending = [canonical];
  let entryCount = 0;
  field(hash, statAlgorithm);
  while (pending.length > 0) {
    const current = pending.pop();
    const names = fs.readdirSync(current).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    for (const name of names) {
      const target = path.join(current, name);
      const relative = path.relative(canonical, target).split(path.sep).join("/");
      const stat = fs.lstatSync(target, { bigint: true });
      entryCount += 1;
      field(hash, relative);
      if (stat.isSymbolicLink()) {
        const payload = fs.readlinkSync(target);
        if (rejectEscapingSymlinks) {
          if (path.isAbsolute(payload)) fail(`Benchmark tree symlink must be relative: ${relative}`);
          const resolved = fs.realpathSync(target);
          if (!inside(canonical, resolved)) fail(`Benchmark tree symlink escapes its bound root: ${relative}`);
        }
        field(hash, "symlink");
        field(hash, payload);
      } else if (stat.isDirectory()) {
        field(hash, "directory");
        field(hash, stat.mode.toString());
        field(hash, stat.mtimeNs.toString());
        field(hash, stat.ctimeNs.toString());
        pending.push(target);
      } else if (stat.isFile()) {
        field(hash, "regular");
        field(hash, stat.mode.toString());
        field(hash, stat.size.toString());
        field(hash, stat.mtimeNs.toString());
        field(hash, stat.ctimeNs.toString());
      } else fail(`Benchmark tree contains unsupported node type: ${relative}`);
    }
  }
  field(hash, entryCount);
  return { schemaVersion: 1, algorithm: statAlgorithm, contentDigest: hash.digest("hex"), entryCount };
}

export function assertBenchmarkTreeStatIdentity(expected, observed, label) {
  const valid = (value) => value?.schemaVersion === 1
    && value.algorithm === statAlgorithm
    && /^[a-f0-9]{64}$/.test(String(value.contentDigest ?? ""))
    && Number.isInteger(value.entryCount) && value.entryCount >= 0;
  if (!valid(expected) || !valid(observed)) fail(`${label} stat identity is missing or unsupported`);
  if (expected.contentDigest !== observed.contentDigest || expected.entryCount !== observed.entryCount) fail(`${label} stat identity changed`);
  return observed;
}

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { benchmarkGitEnvironment } from "./benchmark-runtime.js";

const algorithm = "sha256-length-prefixed-entry-v2";
const selection = "git-index-working-tree-plus-nonignored-untracked-v2";
const regularIndexModes = new Set(["100644", "100755"]);

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function gitBuffer(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      env: benchmarkGitEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    fail(`Cannot freeze benchmark candidate working tree: ${error.message}`);
  }
}

function utf8Field(buffer, label) {
  const value = buffer.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(buffer)) fail(`Benchmark candidate ${label} is not valid UTF-8`);
  return value;
}

function nulFields(buffer, label) {
  const fields = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) fields.push(utf8Field(buffer.subarray(start, index), label));
    start = index + 1;
  }
  if (start !== buffer.length) fail(`Benchmark candidate ${label} output was not NUL terminated`);
  return fields;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizedPath(relative) {
  const value = relative.split(path.sep).join("/");
  if (!value || value.startsWith("/") || value.split("/").includes("..")) fail(`Unsafe benchmark candidate path: ${relative}`);
  return value;
}

function stableFileBytes(file, label) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) fail(`Benchmark candidate path is not a regular file: ${label}`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const fields = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"];
    if (fields.some((field) => before[field] !== after[field]) || BigInt(bytes.length) !== after.size) {
      fail(`Benchmark candidate file changed while it was read: ${label}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function indexEntries(root) {
  const byPath = new Map();
  for (const field of nulFields(gitBuffer(root, ["ls-files", "--stage", "-z"]), "index")) {
    const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(field);
    if (!match) fail("Benchmark candidate index contains an unsupported entry");
    const [, indexMode, , stage, rawPath] = match;
    const relative = normalizedPath(rawPath);
    if (stage !== "0") fail(`Benchmark candidate has an unresolved index conflict: ${relative}`);
    if (indexMode === "160000") fail(`Benchmark candidate contains an unsupported gitlink: ${relative}`);
    if (!regularIndexModes.has(indexMode) && indexMode !== "120000") {
      fail(`Benchmark candidate contains unsupported Git mode ${indexMode}: ${relative}`);
    }
    if (byPath.has(relative)) fail(`Benchmark candidate index repeats path: ${relative}`);
    byPath.set(relative, indexMode);
  }
  return byPath;
}

function validateSymlink(root, absolute, relative, target) {
  if (path.isAbsolute(target)) fail(`Benchmark candidate symlink must be relative: ${relative}`);
  const lexicalTarget = path.resolve(path.dirname(absolute), target);
  if (!inside(root, lexicalTarget)) fail(`Benchmark candidate symlink escapes the working tree: ${relative}`);
  try {
    const resolved = fs.realpathSync(absolute);
    if (!inside(root, resolved)) fail(`Benchmark candidate symlink resolves outside the working tree: ${relative}`);
    const stat = fs.statSync(resolved);
    return {
      path: path.relative(root, resolved).split(path.sep).join("/"),
      kind: stat.isDirectory() ? "directory" : stat.isFile() ? "regular" : "unsupported"
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // A broken internal relative symlink is copied as broken; that is its exact
    // working-tree behavior and remains bound by the link-target bytes.
    return null;
  }
}

function workingEntry(root, relative, indexMode, tracked) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (tracked && error?.code === "ENOENT") {
      return { path: relative, kind: "tombstone", mode: "000000", indexMode, payload: Buffer.alloc(0) };
    }
    fail(`Cannot freeze benchmark candidate path ${relative}: ${error.message}`);
  }
  if (stat.isDirectory()) {
    if (!tracked) fail(`Git returned an untracked directory as a candidate file: ${relative}`);
    return { path: relative, kind: "directory", mode: "040000", indexMode, payload: Buffer.alloc(0) };
  }
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(absolute);
    const resolvedTarget = validateSymlink(root, absolute, relative, target);
    if (resolvedTarget?.kind === "unsupported") fail(`Benchmark candidate symlink resolves to an unsupported file type: ${relative}`);
    return { path: relative, kind: "symlink", mode: "120000", indexMode, payload: Buffer.from(target, "utf8"), resolvedTarget };
  }
  if (!stat.isFile()) fail(`Benchmark candidate contains an unsupported file type: ${relative}`);
  const executable = (stat.mode & 0o111) !== 0;
  return {
    path: relative,
    kind: "regular",
    mode: executable ? "100755" : "100644",
    indexMode,
    payload: stableFileBytes(absolute, relative)
  };
}

export function collectBenchmarkCandidate(root) {
  const canonicalRoot = fs.realpathSync(root);
  const repositoryRoot = fs.realpathSync(utf8Field(gitBuffer(canonicalRoot, ["rev-parse", "--show-toplevel"]).subarray(0, -1), "repository root").trim());
  if (repositoryRoot !== canonicalRoot) fail(`Benchmark candidate root must be the Git working-tree root: ${root}`);

  const tracked = indexEntries(canonicalRoot);
  const untracked = nulFields(
    gitBuffer(canonicalRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    "untracked path"
  ).map(normalizedPath);
  const paths = [...new Set([...tracked.keys(), ...untracked])].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const entries = paths.map((relative) => workingEntry(canonicalRoot, relative, tracked.get(relative) ?? "000000", tracked.has(relative)));
  const represented = new Set(entries.filter((entry) => entry.kind !== "tombstone").map((entry) => entry.path));
  for (const entry of entries.filter((item) => item.kind === "symlink" && item.resolvedTarget)) {
    const target = entry.resolvedTarget;
    const covered = target.kind === "directory"
      ? target.path === "" || [...represented].some((candidate) => candidate === target.path || candidate.startsWith(`${target.path}/`))
      : represented.has(target.path);
    if (!covered) fail(`Benchmark candidate symlink target is ignored or absent from the snapshot: ${entry.path}`);
  }
  return { root: canonicalRoot, entries, provenance: candidateProvenance(entries) };
}

function updateField(hash, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(buffer.length));
  hash.update(length);
  hash.update(buffer);
}

export function candidateProvenance(entries) {
  const hash = crypto.createHash("sha256");
  updateField(hash, algorithm);
  updateField(hash, selection);
  updateField(hash, String(entries.length));
  for (const entry of entries) {
    updateField(hash, entry.path);
    updateField(hash, entry.kind);
    updateField(hash, entry.mode);
    updateField(hash, entry.indexMode);
    updateField(hash, entry.payload);
  }
  return {
    schemaVersion: 2,
    algorithm,
    selection,
    contentDigest: hash.digest("hex"),
    fileCount: entries.length
  };
}

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch { /* Non-POSIX filesystem. */ }
}

function materializeEntry(snapshotRoot, entry) {
  const target = path.join(snapshotRoot, entry.path);
  if (entry.kind === "tombstone") return;
  if (entry.kind === "directory") {
    privateDirectory(target);
    return;
  }
  privateDirectory(path.dirname(target));
  if (entry.kind === "symlink") {
    fs.symlinkSync(entry.payload.toString("utf8"), target);
    return;
  }
  fs.writeFileSync(target, entry.payload, { mode: entry.mode === "100755" ? 0o700 : 0o600 });
}

function snapshotEntry(snapshotRoot, expected) {
  const absolute = path.join(snapshotRoot, expected.path);
  if (expected.kind === "tombstone") {
    if (fs.existsSync(absolute)) fail(`Benchmark snapshot materialized a deleted path: ${expected.path}`);
    return { ...expected, payload: Buffer.alloc(0) };
  }
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { fail(`Benchmark snapshot is missing ${expected.path}: ${error.message}`); }
  if (expected.kind === "directory") {
    if (!stat.isDirectory()) fail(`Benchmark snapshot changed directory type: ${expected.path}`);
    return { ...expected, payload: Buffer.alloc(0) };
  }
  if (expected.kind === "symlink") {
    if (!stat.isSymbolicLink()) fail(`Benchmark snapshot changed symlink type: ${expected.path}`);
    return { ...expected, payload: Buffer.from(fs.readlinkSync(absolute), "utf8") };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Benchmark snapshot changed regular-file type: ${expected.path}`);
  return {
    ...expected,
    mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
    payload: stableFileBytes(absolute, expected.path)
  };
}

function expectedSnapshotNodes(entries) {
  const expected = new Set();
  for (const entry of entries) {
    if (entry.kind === "tombstone") continue;
    expected.add(entry.path);
    let parent = path.posix.dirname(entry.path);
    while (parent !== ".") {
      expected.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return expected;
}

function verifyExactSnapshotTree(snapshotRoot, entries) {
  const expected = expectedSnapshotNodes(entries);
  const observed = new Set();
  const pending = [snapshotRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const name of fs.readdirSync(current)) {
      const target = path.join(current, name);
      const relative = path.relative(snapshotRoot, target).split(path.sep).join("/");
      observed.add(relative);
      if (fs.lstatSync(target).isDirectory()) pending.push(target);
    }
  }
  const extras = [...observed].filter((item) => !expected.has(item));
  const missing = [...expected].filter((item) => !observed.has(item));
  if (extras.length || missing.length) {
    fail(`Benchmark snapshot tree mismatch${extras.length ? `; extra: ${extras.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`);
  }
}

export function benchmarkCandidateSnapshotIndex(entries) {
  return entries.map(({ path: entryPath, kind, mode, indexMode }) => ({
    path: entryPath,
    kind,
    mode,
    indexMode
  }));
}

function validSnapshotIndexEntry(entry) {
  return entry
    && typeof entry.path === "string"
    && normalizedPath(entry.path) === entry.path
    && ["regular", "symlink", "directory", "tombstone"].includes(entry.kind)
    && typeof entry.mode === "string"
    && typeof entry.indexMode === "string";
}

export function verifyMaterializedBenchmarkCandidate(snapshotRoot, index, expectedProvenance) {
  if (!Array.isArray(index) || index.some((entry) => !validSnapshotIndexEntry(entry))) {
    fail("Benchmark candidate snapshot index is missing or unsupported");
  }
  const canonicalRoot = fs.realpathSync(snapshotRoot);
  verifyExactSnapshotTree(canonicalRoot, index);
  const observed = candidateProvenance(index.map((entry) => snapshotEntry(canonicalRoot, entry)));
  if (expectedProvenance && JSON.stringify(observed) !== JSON.stringify(expectedProvenance)) {
    fail("Benchmark snapshot bytes no longer match the frozen candidate provenance");
  }
  return observed;
}

function hardenReadOnly(root) {
  const pending = [root];
  const directories = [];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      directories.push(current);
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
      continue;
    }
    try { fs.chmodSync(current, (stat.mode & 0o111) !== 0 ? 0o555 : 0o444); } catch { /* Non-POSIX filesystem. */ }
  }
  for (const directory of directories.reverse()) {
    try { fs.chmodSync(directory, 0o555); } catch { /* Non-POSIX filesystem. */ }
  }
}

export function materializeBenchmarkCandidate(root, snapshotRoot) {
  const candidate = collectBenchmarkCandidate(root);
  privateDirectory(snapshotRoot);
  for (const entry of candidate.entries) materializeEntry(snapshotRoot, entry);
  verifyExactSnapshotTree(snapshotRoot, candidate.entries);
  const index = benchmarkCandidateSnapshotIndex(candidate.entries);
  const observed = verifyMaterializedBenchmarkCandidate(snapshotRoot, index);
  if (JSON.stringify(observed) !== JSON.stringify(candidate.provenance)) {
    fail(`Benchmark snapshot bytes do not match the frozen candidate provenance (${candidate.provenance.contentDigest} != ${observed.contentDigest})`);
  }
  hardenReadOnly(snapshotRoot);
  return { provenance: observed, index };
}

export function validBenchmarkCandidateProvenance(value) {
  return value?.schemaVersion === 2
    && value.algorithm === algorithm
    && value.selection === selection
    && /^[a-f0-9]{64}$/.test(String(value.contentDigest ?? ""))
    && Number.isInteger(value.fileCount)
    && value.fileCount >= 0;
}

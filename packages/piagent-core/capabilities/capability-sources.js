import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityValidationError, sha256, validateCapabilityPackageSource } from "./capability-core.js";

// A capability source lets a project use packs it does not own without forking
// the platform. There are two levels, and they end in the same place: a
// directory on disk that is scanned by exactly the same code that scans the
// platform's own packs.
//
//   level 1 — `path`, a directory inside the project (a team's private packs)
//   level 2 — `source`, an npm or git release vendored into the project
//
// Fetching is deliberately not part of resolution. A maintainer runs the vendor
// command, the result is written under the project and committed, and every
// later resolution reads only what is already on disk. The guard therefore
// never reaches the network, and a pack cannot change under it between the
// review and the run.
//
// None of this widens the trust model. An external pack still resolves only
// when the profile already names its owner and lifecycle, so an unknown owner
// is refused rather than warned about.

const VENDOR_DIRECTORY = path.join(".pi", "capability-vendor");
const SOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SOURCES = 16;
const MAX_VENDOR_ENTRIES = 4096;
const NETWORK_TIMEOUT_MS = 120_000;

function fail(message, details) {
  throw new CapabilityValidationError(message, details);
}

/**
 * Validate the `capabilitySources` block of a project profile.
 *
 * @param {unknown} value
 * @param {string} source
 * @returns {Array<{name: string, path?: string, source?: string}>}
 */
export function validateCapabilitySources(value, source = "project profile") {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${source}.capabilitySources must be an array`);
  if (value.length > MAX_SOURCES) fail(`${source}.capabilitySources must declare at most ${MAX_SOURCES} sources`);

  const names = new Set();
  return value.map((entry, index) => {
    const location = `${source}.capabilitySources[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`${location} must be an object`);
    const allowed = new Set(["name", "path", "source"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) fail(`${location}.${key} is not a supported key`);
    }
    if (typeof entry.name !== "string" || !SOURCE_NAME_PATTERN.test(entry.name)) {
      fail(`${location}.name must be a lowercase identifier`);
    }
    if (names.has(entry.name)) fail(`${location}.name must be unique`);
    names.add(entry.name);

    // One level per entry. Accepting both would leave it ambiguous which one
    // the lock digest actually covers.
    const hasPath = entry.path !== undefined;
    const hasSource = entry.source !== undefined;
    if (hasPath === hasSource) fail(`${location} must declare exactly one of path or source`);

    if (hasPath) {
      if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.length > 512) {
        fail(`${location}.path must be a short relative path`);
      }
      if (path.isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.includes("\0")) {
        fail(`${location}.path must be a project-relative path`);
      }
      if (entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
        fail(`${location}.path must not contain traversal segments`);
      }
      return { name: entry.name, path: entry.path };
    }

    const remote = validateCapabilityPackageSource(entry.source);
    if (!/^(?:npm|git):/.test(remote)) fail(`${location}.source must be an npm or git source`);
    return { name: entry.name, source: remote };
  });
}

/**
 * Where a remote source is vendored. Deterministic so the lock, the vendor
 * command, and the guard all agree without passing paths around.
 *
 * @param {string} projectRoot
 * @param {string} name
 */
export function vendorDirectoryFor(projectRoot, name) {
  if (!SOURCE_NAME_PATTERN.test(name)) fail(`${name} is not a valid capability source name`);
  return path.join(projectRoot, VENDOR_DIRECTORY, name);
}

function assertContainedDirectory(projectRoot, target, label) {
  const rootReal = fs.realpathSync(projectRoot);
  if (!fs.existsSync(target)) fail(`${label} does not exist; run the vendor command or correct the path`);
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail(`${label} must not be a symbolic link`);
  if (!stat.isDirectory()) fail(`${label} must be a directory`);

  // realpath after the symlink check: the check above rejects the final
  // component, and this rejects a parent that leads outside the project.
  const targetReal = fs.realpathSync(target);
  const relative = path.relative(rootReal, targetReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`${label} resolves outside the project`);
  return targetReal;
}

/**
 * Verify a path this code is about to create, empty or write sits inside the
 * project, without requiring it to exist yet.
 *
 * The read path can lstat its target and be done with it. A write path cannot:
 * the destination is normally absent, and the failure that matters is an
 * *ancestor* leading somewhere else. A repository shipping `.pi` as a symlink is
 * the whole attack — `mkdir -p` follows it, the directory that appears below is
 * a real directory, so a check on the immediate parent sees nothing wrong, and
 * the recursive delete that comes next lands outside the project.
 *
 * @param {string} rootReal a project root already through realpath
 * @param {string} target
 * @param {string} label
 */
function assertContainedWritePath(rootReal, target, label) {
  const relative = path.relative(rootReal, path.resolve(rootReal, target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail(`${label} resolves outside the project`);
  let current = rootReal;
  for (const segment of relative.split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      // Absent from here down, so there is nothing further to follow.
      return;
    }
    if (stat.isSymbolicLink()) fail(`${label} must not resolve through a symbolic link (${segment})`);
  }
}

function assertNoSymbolicLinks(root, label, budget = { remaining: MAX_VENDOR_ENTRIES }) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (budget.remaining-- <= 0) fail(`${label} contains more than ${MAX_VENDOR_ENTRIES} entries`);
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) fail(`${label} must not contain symbolic links (${entry.name})`);
    if (entry.isDirectory()) assertNoSymbolicLinks(child, label, budget);
    else if (!entry.isFile()) fail(`${label} must contain only regular files (${entry.name})`);
  }
}

/**
 * Turn declared sources into roots the pack scanner can read. Every root is
 * verified to sit inside the project and to be free of symbolic links, because
 * this is the boundary where someone else's tree becomes readable.
 *
 * @param {string} projectRoot
 * @param {Array<{name: string, path?: string, source?: string}>} sources
 */
export function resolveCapabilitySourceRoots(projectRoot, sources) {
  // Resolved roots come back from realpath, so the project root has to be
  // resolved the same way before the two are compared. On a system where the
  // project sits under a symlinked parent, mixing the two forms produces a
  // relative path that climbs out of the project and looks like an escape.
  const rootReal = fs.realpathSync(projectRoot);
  return validateCapabilitySources(sources).map((entry) => {
    const target = entry.path
      ? path.resolve(rootReal, entry.path)
      : vendorDirectoryFor(rootReal, entry.name);
    const label = `capability source ${entry.name}`;
    const root = assertContainedDirectory(rootReal, target, label);
    assertNoSymbolicLinks(root, label);
    if (!fs.existsSync(path.join(root, "packs"))) fail(`${label} must contain a packs directory`);
    return {
      origin: entry.name,
      root,
      source: entry.source ?? `./${path.relative(rootReal, root).split(path.sep).join("/")}`
    };
  });
}

function runCommand(command, args, options) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: NETWORK_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      ...options
    });
  } catch (error) {
    const detail = error && typeof error === "object" && "stderr" in error ? String(error.stderr ?? "").trim() : "";
    fail(`${command} ${args[0] ?? ""} failed`, detail ? [detail] : undefined);
  }
}

function fetchNpmSource(reference, destination) {
  // `npm pack` resolves the exact version already validated by the source
  // grammar and writes one tarball; nothing is executed from the package.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-vendor-"));
  try {
    const output = runCommand("npm", ["pack", reference, "--pack-destination", staging, "--ignore-scripts"], { cwd: staging });
    const tarball = output.trim().split("\n").pop()?.trim();
    if (!tarball) fail(`npm pack produced no tarball for ${reference}`);
    const tarballPath = path.join(staging, tarball);
    if (!fs.existsSync(tarballPath)) fail(`npm pack reported ${tarball} but wrote no such file`);
    const extracted = path.join(staging, "extracted");
    fs.mkdirSync(extracted);
    runCommand("tar", ["-xzf", tarballPath, "-C", extracted, "--strip-components=1"]);
    fs.cpSync(extracted, destination, { recursive: true, verbatimSymlinks: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function fetchGitSource(reference, destination) {
  const separator = reference.lastIndexOf("@");
  const location = reference.slice("git:".length, separator);
  const revision = reference.slice(separator + 1);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-vendor-"));
  try {
    const url = `https://${location}.git`;
    // No --depth: a tag or commit is fetched by name, and a shallow clone
    // cannot always reach an arbitrary commit.
    runCommand("git", ["clone", "--quiet", "--no-checkout", url, staging]);
    runCommand("git", ["-C", staging, "checkout", "--quiet", "--detach", revision]);
    fs.rmSync(path.join(staging, ".git"), { recursive: true, force: true });
    fs.cpSync(staging, destination, { recursive: true, verbatimSymlinks: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Fetch a remote source into the project's vendor directory. Only the vendor
 * command calls this; resolution and enforcement never do.
 *
 * @param {string} projectRoot
 * @param {{name: string, source?: string}} entry
 */
export function vendorRemoteSource(projectRoot, entry) {
  const [validated] = validateCapabilitySources([entry]);
  if (!validated.source) fail(`capability source ${validated.name} is a local path and does not need vendoring`);

  // Resolved the same way the read path resolves it, so the containment check
  // below compares two paths of the same form.
  const rootReal = fs.realpathSync(projectRoot);
  const destination = vendorDirectoryFor(rootReal, validated.name);
  const label = `capability source ${validated.name}`;

  // Before anything is created and well before anything is removed: every call
  // after this line writes or deletes, and the point of the check is to have
  // happened first.
  assertContainedWritePath(rootReal, destination, label);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  // Re-checked after the directories exist. The first pass ran against a path
  // that was mostly absent, so it proved nothing about the components this call
  // just created or about one swapped underneath in between.
  assertContainedWritePath(rootReal, destination, label);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { mode: 0o755 });

  try {
    if (validated.source.startsWith("npm:")) fetchNpmSource(validated.source.slice("npm:".length), destination);
    else fetchGitSource(validated.source, destination);

    // The fetched tree is untrusted until this passes. Checking here means a
    // hostile archive is rejected before anything reads a manifest out of it.
    assertNoSymbolicLinks(destination, `capability source ${validated.name}`);
    if (!fs.existsSync(path.join(destination, "packs"))) {
      fail(`capability source ${validated.name} provides no packs directory`);
    }
  } catch (error) {
    // A half-written vendor directory would resolve on the next run and hide
    // the failure, so remove it.
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }

  return { name: validated.name, source: validated.source, directory: destination, digest: digestDirectory(destination) };
}

/**
 * Deterministic digest of a vendored tree: path and content of every regular
 * file, in code-point order. Recorded so a later run can tell that the tree it
 * reads is the tree that was reviewed.
 *
 * @param {string} root
 */
export function digestDirectory(root) {
  const files = [];
  function walk(directory, prefix) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`${root} must not contain symbolic links (${relative})`);
      if (entry.isDirectory()) walk(child, relative);
      else if (entry.isFile()) files.push(`${relative}:${sha256(fs.readFileSync(child))}`);
      else fail(`${root} must contain only regular files (${relative})`);
    }
  }
  walk(root, "");
  return sha256(files.join("\n"));
}

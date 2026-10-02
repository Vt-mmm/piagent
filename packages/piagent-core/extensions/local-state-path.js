import fs from "node:fs";
import path from "node:path";

function statePathError(label, reason) {
  return new Error(`${label} ${reason}`);
}

export function resolveLocalStatePath(projectRoot, target, options = {}) {
  const label = options.label ?? "Local state path";
  const lexicalRoot = path.resolve(projectRoot);
  const absoluteTarget = path.resolve(target);
  const canonicalRoot = fs.realpathSync.native(lexicalRoot);
  let relative = path.relative(lexicalRoot, absoluteTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    relative = path.relative(canonicalRoot, absoluteTarget);
  }
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw statePathError(label, "must stay inside the project");
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = canonicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return path.join(canonicalRoot, ...segments);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw statePathError(label, `must not traverse a symbolic link (${segments.slice(0, index + 1).join("/")})`);
    }
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) {
      throw statePathError(label, `has a non-directory ancestor (${segments.slice(0, index + 1).join("/")})`);
    }
    if (final && options.kind === "directory" && !stat.isDirectory()) {
      throw statePathError(label, "must be a directory");
    }
    if (final && options.kind === "file" && !stat.isFile()) {
      throw statePathError(label, "must be a regular file");
    }
  }
  return path.join(canonicalRoot, ...segments);
}

// Runtime state is local evidence, never source. A project that never ran
// setup has no `.pi/.gitignore`, so `git status` listed the state and
// `git add -A` swept it into commits. The state root ignores itself instead.
const STATE_ROOT_IGNORE = "# Piagent runtime state: local only, never committed.\n*\n";
export function ensureStateRootIgnored(projectRoot) {
  try {
    const root = resolveLocalStatePath(projectRoot, path.join(projectRoot, ".pi", "piagent-state"), { label: "Piagent state root" });
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, ".gitignore"), STATE_ROOT_IGNORE, { flag: "wx", mode: 0o600 });
  } catch {
    // Already present, or the project refuses state (symlinked or read-only); either way nothing to add.
  }
}

export function ensurePrivateStateDirectory(projectRoot, directory, label = "Local state directory") {
  const target = resolveLocalStatePath(projectRoot, directory, { label });
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (path.relative(path.join(fs.realpathSync.native(path.resolve(projectRoot)), ".pi", "piagent-state"), target).split(path.sep)[0] !== "..") ensureStateRootIgnored(projectRoot);
  const verified = resolveLocalStatePath(projectRoot, directory, { label, kind: "directory" });
  try {
    fs.chmodSync(verified, 0o700);
  } catch {
    // Best effort on filesystems that do not expose POSIX modes.
  }
  return verified;
}

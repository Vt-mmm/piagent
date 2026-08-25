import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Parent workspaces commonly carry shared plans, verifier scripts, and agent
// configuration beside their child repositories. Keep the traversal bounded,
// but leave enough room for a real multi-repository workspace instead of
// silently dropping evidence at the former 2,000-file ceiling.
const WORKSPACE_EVIDENCE_MAX_FILES = 20_000;
// These names are not merely noisy build output: they carry repository
// ownership, Piagent authority, or provider credentials. Evidence discovery
// excludes them and the mutation guard protects them independently of task
// focus, so broad monorepo access cannot create an unaudited private-state gap.
export const WORKSPACE_PRIVATE_STATE_PATTERNS = Object.freeze([
  "**/.git/**", "**/.hg/**", "**/.svn/**", "**/.pi/**",
  "**/.aws/**", "**/.azure/**", "**/.docker/**", "**/.gnupg/**", "**/.kube/**", "**/.ssh/**",
  "**/.git-credentials", "**/.netrc", "**/.npmrc", "**/.pypirc",
  "**/.env", "**/.env.*",
  "**/auth.json", "**/credential.json", "**/credentials.json", "**/secret.json", "**/secrets.json",
  "**/token.json", "**/tokens.json"
]);
const WORKSPACE_EVIDENCE_SKIP_NAMES = new Set([
  ".git", ".hg", ".svn", ".pi", "node_modules", "dist", "build", ".next", "coverage",
  ".cache", ".npm", ".pnpm-store", ".yarn", ".turbo", ".aws", ".azure", ".docker",
  ".gnupg", ".kube", ".ssh", ".ds_store", ".git-credentials", ".netrc", ".npmrc", ".pypirc"
]);
const WORKSPACE_EVIDENCE_PRIORITY_NAMES = new Map([["plans", 0]]);

function excludedWorkspaceEvidenceName(value) {
  const name = String(value ?? "");
  return WORKSPACE_EVIDENCE_SKIP_NAMES.has(name.toLowerCase())
    || /^\.env(?:\.|$)/i.test(name)
    || /^(?:auth|credentials?|secrets?|tokens?)\.json$/i.test(name);
}

export function gitOutput(cwd, args, options = {}) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

export function isGitWorkingTree(cwd) {
  try {
    return gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function normalizedGitPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
}

export function prefixedGitPath(prefix, file) {
  const normalized = normalizedGitPath(file);
  return prefix ? `${prefix}/${normalized}` : normalized;
}

function directChildGitEvidenceRootDetails(cwd) {
  const roots = [];
  let complete = true;
  let entries;
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return { roots, complete: false };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = path.join(cwd, entry.name);
    try {
      if (fs.lstatSync(child).isSymbolicLink()) continue;
      let gitMarker;
      try {
        gitMarker = fs.lstatSync(path.join(child, ".git"));
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        complete = false;
        continue;
      }
      if (!gitMarker.isDirectory() && !gitMarker.isFile()) {
        complete = false;
        continue;
      }
      if (!isGitWorkingTree(child)) {
        complete = false;
        continue;
      }
      const topLevel = gitOutput(child, ["rev-parse", "--show-toplevel"]).trim();
      if (fs.realpathSync(topLevel) !== fs.realpathSync(child)) {
        complete = false;
        continue;
      }
      roots.push({ cwd: child, prefix: normalizedGitPath(entry.name) });
    } catch {
      complete = false;
    }
  }
  return { roots: roots.sort((left, right) => left.prefix.localeCompare(right.prefix)), complete };
}

export function directChildGitEvidenceRoots(cwd) {
  return directChildGitEvidenceRootDetails(cwd).roots;
}

export function gitEvidenceRootDetails(cwd) {
  if (isGitWorkingTree(cwd)) return { roots: [{ cwd, prefix: "" }], complete: true };
  // A present Git marker combined with a failed Git probe is ambiguous (for
  // example a broken worktree pointer or a transient command failure). Do not
  // reinterpret that repository as an ordinary complete non-Git directory.
  try {
    fs.lstatSync(path.join(cwd, ".git"));
    return { roots: [], complete: false };
  } catch (error) {
    if (error?.code !== "ENOENT") return { roots: [], complete: false };
  }
  return directChildGitEvidenceRootDetails(cwd);
}

export function gitEvidenceRoots(cwd) {
  return gitEvidenceRootDetails(cwd).roots;
}

function workspaceEvidenceFileLimit(value) {
  return Number.isInteger(value)
    ? Math.max(1, Math.min(WORKSPACE_EVIDENCE_MAX_FILES, value))
    : WORKSPACE_EVIDENCE_MAX_FILES;
}

export function nonGitWorkspaceFileDetails(cwd, gitRootPrefixes, maxFiles = WORKSPACE_EVIDENCE_MAX_FILES) {
  const files = [];
  let complete = true;
  const limit = workspaceEvidenceFileLimit(maxFiles);
  const gitRoots = new Set(gitRootPrefixes.filter(Boolean));
  const orderedEntries = (entries) => [...entries].sort((left, right) => {
    const leftPriority = WORKSPACE_EVIDENCE_PRIORITY_NAMES.get(left.name.toLowerCase()) ?? 10;
    const rightPriority = WORKSPACE_EVIDENCE_PRIORITY_NAMES.get(right.name.toLowerCase()) ?? 10;
    return leftPriority - rightPriority || left.name.localeCompare(right.name, "en-US");
  });
  function visit(directory, relativeDirectory) {
    if (files.length >= limit) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      complete = false;
      return;
    }
    for (const entry of orderedEntries(entries)) {
      if (files.length >= limit) {
        complete = false;
        return;
      }
      // A parent workspace can own real project source in hidden directories
      // (for example shared verifier scripts). Evidence discovery therefore
      // excludes explicit private/cache/credential names instead of treating
      // every dot-prefixed path as non-project state.
      if (excludedWorkspaceEvidenceName(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (gitRoots.has(relative.split("/")[0])) continue;
      const absolute = path.join(directory, entry.name);
      try {
        if (fs.lstatSync(absolute).isSymbolicLink()) continue;
      } catch {
        complete = false;
        continue;
      }
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push(normalizedGitPath(relative));
    }
  }
  visit(cwd, "");
  return { files: files.sort(), complete };
}

export function nonGitWorkspaceFiles(cwd, gitRootPrefixes, maxFiles = WORKSPACE_EVIDENCE_MAX_FILES) {
  return nonGitWorkspaceFileDetails(cwd, gitRootPrefixes, maxFiles).files;
}

export function pathWithinNonGitWorkspaceEvidenceRoot(candidate, gitRootPrefixes) {
  const segments = candidate.split("/").filter(Boolean);
  const topSegment = segments[0];
  return Boolean(
    topSegment
    && !segments.some(excludedWorkspaceEvidenceName)
    && !gitRootPrefixes.includes(topSegment)
  );
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const WORKSPACE_EVIDENCE_MAX_FILES = 2000;
const WORKSPACE_EVIDENCE_SKIP_NAMES = new Set([
  ".git", ".hg", ".svn", ".pi", "node_modules", "dist", "build", ".next", "coverage"
]);
const WORKSPACE_EVIDENCE_PRIORITY_NAMES = new Map([["plans", 0]]);

function hiddenWorkspaceEvidenceSegment(value) {
  return String(value ?? "").startsWith(".");
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
  return directChildGitEvidenceRootDetails(cwd);
}

export function gitEvidenceRoots(cwd) {
  return gitEvidenceRootDetails(cwd).roots;
}

export function nonGitWorkspaceFileDetails(cwd, gitRootPrefixes) {
  const files = [];
  let complete = true;
  const gitRoots = new Set(gitRootPrefixes.filter(Boolean));
  const orderedEntries = (entries) => [...entries].sort((left, right) => {
    const leftPriority = WORKSPACE_EVIDENCE_PRIORITY_NAMES.get(left.name.toLowerCase()) ?? 10;
    const rightPriority = WORKSPACE_EVIDENCE_PRIORITY_NAMES.get(right.name.toLowerCase()) ?? 10;
    return leftPriority - rightPriority || left.name.localeCompare(right.name, "en-US");
  });
  function visit(directory, relativeDirectory) {
    if (files.length >= WORKSPACE_EVIDENCE_MAX_FILES) {
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
      if (files.length >= WORKSPACE_EVIDENCE_MAX_FILES) {
        complete = false;
        return;
      }
      // Loose files beside nested repositories are not governed by either
      // repository's ignore/trust policy. Keep hidden editor, agent, cloud,
      // credential, and cache state out of both manifests and change evidence
      // instead of attempting to maintain an incomplete name blacklist.
      if (WORKSPACE_EVIDENCE_SKIP_NAMES.has(entry.name) || hiddenWorkspaceEvidenceSegment(entry.name)) continue;
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

export function nonGitWorkspaceFiles(cwd, gitRootPrefixes) {
  return nonGitWorkspaceFileDetails(cwd, gitRootPrefixes).files;
}

export function pathWithinNonGitWorkspaceEvidenceRoot(candidate, gitRootPrefixes) {
  const segments = candidate.split("/").filter(Boolean);
  const topSegment = segments[0];
  return Boolean(
    topSegment
    && !WORKSPACE_EVIDENCE_SKIP_NAMES.has(topSegment)
    && !segments.some(hiddenWorkspaceEvidenceSegment)
    && !gitRootPrefixes.includes(topSegment)
  );
}

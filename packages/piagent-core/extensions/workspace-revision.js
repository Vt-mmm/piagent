import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { gitEvidenceRootDetails } from "./workspace-evidence-roots.js";

export const WORKSPACE_REVISION_VERSION = "workspace-revision-v1";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const PREFIX = `${WORKSPACE_REVISION_VERSION}:`;
export const isWorkspaceRevisionDigest = (value) => typeof value === "string" && /^workspace-revision-v1:[a-f0-9]{64}$/.test(value);

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "-C", cwd, ...args], {
    encoding: "utf8", timeout: 3000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function repositoryHeadIdentity(cwd) {
  try {
    const head = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Invalid repository revision");
    return head;
  } catch (error) {
    if (error.status !== 1) throw error;
    const reference = git(cwd, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!reference.startsWith("refs/heads/")) throw new Error("Invalid unborn repository");
    try { git(cwd, ["show-ref", "--verify", "--quiet", reference]); }
    catch (missing) { if (missing.status === 1) return `unborn:${reference}`; throw missing; }
    throw new Error("Repository revision changed during capture");
  }
}

/** Baseline identity, not a content digest or authenticated verifier receipt. */
export function captureWorkspaceRevision(cwd) {
  const root = fs.realpathSync.native(cwd);
  const details = gitEvidenceRootDetails(root);
  if (!details.complete || details.roots.length === 0 || details.roots.length > 128) throw new Error("Workspace baseline inventory is unavailable");
  const repositories = details.roots.map((item) => Object.freeze({
    prefix: item.prefix,
    rootId: hash(fs.realpathSync.native(git(item.cwd, ["rev-parse", "--show-toplevel"]))),
    head: repositoryHeadIdentity(item.cwd)
  }));
  const binding = Object.freeze({ version: WORKSPACE_REVISION_VERSION, projectId: hash(root), repositories: Object.freeze(repositories) });
  return Object.freeze({ ...binding, digest: `${PREFIX}${hash(JSON.stringify(binding))}` });
}

export function currentWorkspaceRevisionDigest(cwd) {
  try { return captureWorkspaceRevision(cwd).digest; } catch { return null; }
}

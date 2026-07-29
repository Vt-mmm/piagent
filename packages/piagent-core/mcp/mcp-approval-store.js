import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stableJson } from "../capabilities/capability-core.js";

// Approval for MCP servers that arrive inside a repository.
//
// A repository can carry `.mcp.json` and `.pi/mcp.json`. Cloning one and opening
// a session should not hand its author a process on this machine with this
// operator's credentials, so a server found in those files is not usable until
// somebody here says so.
//
// The record lives in the operator's home, never in the repository. That is the
// whole point: a repository that could approve its own servers has not been
// gated. It also means a fork, a rename, or a second checkout starts unapproved
// rather than inheriting a decision made about different code.
//
// What is stored is the digest of the entry that was approved. Approval is
// consent to what the server runs, so a changed command, URL or argument list is
// a new question — the same split the capability lock draws between what a
// project consented to and which build produced it.

const STORE_FILE = "piagent-mcp-approvals.json";
const MAX_STORE_BYTES = 256 * 1024;
const SCHEMA_VERSION = 1;

/** @param {{home?: string}} [options] @returns {string|undefined} */
export function approvalStorePath(options = {}) {
  const base = options.home ?? os.homedir();
  if (typeof base !== "string" || base.length === 0) return undefined;
  return path.join(base, ".pi", STORE_FILE);
}

/**
 * The digest of a server entry, over the definition only. Two projects that
 * declare the same server produce the same digest, which is fine: the store is
 * keyed by project as well, so approving one does not approve the other.
 *
 * This is a content identifier, not a credential hash, and SHA-256 is the right
 * primitive for it. The question it answers is "is this the same definition the
 * operator approved", so it has to be fast, unsalted and stable across runs —
 * every property a password hash is deliberately built to lack. Nothing is ever
 * verified against it, and no secret reaches it: `add` refuses to write a
 * credential value into MCP config and takes a `${VAR}` reference instead, so
 * what gets hashed is a command line, a URL, variable names, and an OAuth client
 * id and scope list, all of which are public identifiers.
 *
 * @param {unknown} entry
 * @returns {string}
 */
export function serverEntryDigest(entry) {
  return `sha256:${crypto.createHash("sha256").update(stableJson(entry)).digest("hex")}`;
}

/**
 * A project is identified by its resolved path. Resolved, because a checkout
 * reached through a symlink is the same checkout, and because macOS reaches
 * `/var` that way.
 * @param {string} projectPath
 * @returns {string}
 */
export function projectKey(projectPath) {
  try {
    return fs.realpathSync(projectPath);
  } catch {
    return path.resolve(projectPath);
  }
}

/**
 * The store, and whether the empty case means "nothing decided" or "nobody could
 * read it". Both read as pending, which is the right answer for a gate and the
 * wrong one for a write: overwriting a store this process could not parse throws
 * away every decision recorded in it, and the operator's only clue would be that
 * their other projects silently returned to pending.
 *
 * @param {{home?: string}} [options]
 * @returns {{projects: Record<string, Record<string, {digest?: string, decision?: string, decidedAt?: string}>>, readable: boolean, detail?: string}}
 */
export function loadApprovalStore(options = {}) {
  const file = approvalStorePath(options);
  if (!file) return { projects: {}, readable: false, detail: "no home directory to read an approval store from" };
  let raw;
  try {
    // A store larger than this is not something this code wrote.
    if (fs.statSync(file).size > MAX_STORE_BYTES) {
      return { projects: {}, readable: false, detail: `${file} is larger than ${MAX_STORE_BYTES} bytes` };
    }
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Absent is the ordinary state before the first decision.
    if (error && typeof error === "object" && error.code === "ENOENT") return { projects: {}, readable: true };
    return { projects: {}, readable: false, detail: `cannot read ${file}` };
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return { projects: {}, readable: false, detail: `cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const projects = document?.projects;
  if (projects === undefined && document && typeof document === "object" && !Array.isArray(document)) {
    // A document with no `projects` key is a store this code did not write.
    return { projects: {}, readable: false, detail: `${file} has no projects object` };
  }
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    return { projects: {}, readable: false, detail: `${file} has no projects object` };
  }
  return { projects, readable: true };
}

/** @param {{home?: string}} [options] @returns {Record<string, Record<string, {digest?: string, decision?: string, decidedAt?: string}>>} */
export function readApprovalStore(options = {}) {
  // An unreadable store denies rather than permits: every server reads as
  // undecided, which is the state that blocks.
  return loadApprovalStore(options).projects;
}

/**
 * @param {Record<string, unknown>} projects
 * @param {{home?: string}} [options]
 * @returns {boolean}
 */
export function writeApprovalStore(projects, options = {}) {
  const file = approvalStorePath(options);
  if (!file) return false;
  const document = { schemaVersion: SCHEMA_VERSION, projects };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {"approved"|"rejected"|"pending"|"changed"} ApprovalState
 */

/**
 * What the operator has decided about this server as it is defined right now.
 *
 * `changed` is separated from `pending` on purpose. They both block, but they are
 * different events: one is a server nobody has looked at, the other is a server
 * that was approved and is no longer what was approved. Collapsing them would
 * hide the second, which is the one worth reading.
 *
 * @param {{projectPath: string, name: string, entry: unknown, store?: Record<string, unknown>, home?: string}} options
 * @returns {{state: ApprovalState, digest: string, approvedDigest?: string}}
 */
export function approvalState(options) {
  const store = options.store ?? readApprovalStore({ home: options.home });
  const digest = serverEntryDigest(options.entry);
  const record = /** @type {Record<string, {digest?: string, decision?: string}>|undefined} */ (
    store[projectKey(options.projectPath)]
  )?.[options.name];
  if (!record || typeof record.decision !== "string") return { state: "pending", digest };
  if (record.decision === "rejected") return { state: "rejected", digest, approvedDigest: record.digest };
  if (record.decision !== "approved") return { state: "pending", digest };
  if (record.digest !== digest) return { state: "changed", digest, approvedDigest: record.digest };
  return { state: "approved", digest, approvedDigest: record.digest };
}

/**
 * @param {{projectPath: string, name: string, entry: unknown, decision: "approved"|"rejected", now?: number, home?: string}} options
 * @returns {boolean}
 */
export function recordApproval(options) {
  const loaded = loadApprovalStore({ home: options.home });
  // Writing on top of a store nobody could parse would drop every decision it
  // holds -- including the ones for other projects, which the operator would
  // find out about only by watching them go back to pending one at a time.
  if (!loaded.readable) return false;
  const store = loaded.projects;
  const key = projectKey(options.projectPath);
  const project = { ...(store[key] ?? {}) };
  project[options.name] = {
    decision: options.decision,
    digest: serverEntryDigest(options.entry),
    decidedAt: new Date(options.now ?? Date.now()).toISOString()
  };
  return writeApprovalStore({ ...store, [key]: project }, { home: options.home });
}

/**
 * Drop a decision so the server returns to pending. Used by `piagent-mcp reset`
 * and when a server is removed, so a later server reusing the name does not
 * inherit the decision — the digest check would catch it, but leaving a record
 * for a server that no longer exists is just debris.
 * @param {{projectPath: string, name?: string, home?: string}} options
 * @returns {boolean}
 */
export function clearApproval(options) {
  const loaded = loadApprovalStore({ home: options.home });
  if (!loaded.readable) return false;
  const store = loaded.projects;
  const key = projectKey(options.projectPath);
  // Nothing recorded is the state this function exists to reach, so it succeeds.
  // Returning false here would be indistinguishable from a failed write, and the
  // caller has to be able to tell those apart.
  if (!store[key]) return true;
  if (!options.name) {
    const { [key]: _removed, ...rest } = store;
    return writeApprovalStore(rest, { home: options.home });
  }
  const { [options.name]: _dropped, ...project } = store[key];
  const next = Object.keys(project).length > 0 ? { ...store, [key]: project } : (() => {
    const { [key]: _empty, ...rest } = store;
    return rest;
  })();
  return writeApprovalStore(next, { home: options.home });
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localFilterDisableArgs } from "./git-filter-safety.ts";

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DISPLAY_PATH_MAX = 1_024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type RawGitStatus = "." | "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!";

export type GitPath = {
  value: string | null;
  display: string | null;
  displayMode: "exact-safe" | "escaped" | "unavailable";
  digest: string;
};

export type GitStatusRecord = {
  kind: "ordinary" | "renamed" | "unmerged" | "untracked" | "ignored";
  indexStatus: RawGitStatus;
  worktreeStatus: RawGitStatus;
  submodule: string | null;
  headMode: string | null;
  indexMode: string | null;
  worktreeMode: string | null;
  headObject: string | null;
  indexObject: string | null;
  renameScore: string | null;
  path: GitPath;
  oldPath: GitPath | null;
};

export type GitStatusSnapshot = {
  repoRoot: string;
  repoDigest: string;
  headState: "head" | "unborn";
  headOid: string | null;
  branchHead: string | null;
  headers: Readonly<Record<string, string>>;
  records: GitStatusRecord[];
  rawDigest: string;
  raw: Buffer;
};

export class GitInspectionError extends Error {
  readonly code: "not-git" | "timeout" | "output-limit" | "git-failed" | "invalid-output";
  readonly exitCode: number | null;

  constructor(
    code: GitInspectionError["code"],
    message: string,
    options: { exitCode?: number | null; cause?: unknown } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "GitInspectionError";
    this.code = code;
    this.exitCode = options.exitCode ?? null;
  }
}

export type ReadOnlyGitOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  input?: Buffer;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value as number)) : fallback;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LC_ALL: "C",
    LANG: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: ""
  };
  if (process.platform === "win32") {
    env.SystemRoot = process.env.SystemRoot;
    env.ComSpec = process.env.ComSpec;
  }
  return env;
}

const SAFE_GLOBAL_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "--literal-pathspecs",
  "-c", "color.ui=false",
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${os.devNull}`,
  "-c", "diff.external=",
  "-c", "diff.trustExitCode=false",
  "-c", "submodule.recurse=false"
] as const;

const READ_ONLY_COMMANDS = new Set(["cat-file", "diff", "hash-object", "ls-files", "ls-tree", "rev-parse", "show", "status"]);

function validateReadOnlyArgs(args: readonly string[]): void {
  const command = args[0];
  if (!command || !READ_ONLY_COMMANDS.has(command)) {
    throw new GitInspectionError("invalid-output", `Git subcommand ${JSON.stringify(command)} is not allowed for inspection`);
  }
  if (args.some((arg) => arg === "-w" || arg === "--write" || arg === "--literally" || arg === "--output" || arg.startsWith("--output="))) {
    throw new GitInspectionError("invalid-output", "A mutating or output-writing Git option was rejected");
  }
  if (command === "hash-object" && !(
    args.length === 4
    && args[1] === "-t"
    && args[2] === "tree"
    && args[3] === os.devNull
  )) {
    throw new GitInspectionError("invalid-output", "Only empty-tree hashing is allowed during Git inspection");
  }
  if (command === "ls-tree" && !(
    args.length === 5
    && args[1] === "-z"
    && /^[a-f0-9]{40,64}$/.test(args[2] ?? "")
    && args[3] === "--"
  )) {
    throw new GitInspectionError("invalid-output", "Only single-path tree inspection is allowed");
  }
  if (
    (command === "diff" && args.some((arg) => arg === "--no-index" || arg === "--ext-diff" || arg === "--textconv"))
    || (command === "show" && args.some((arg) => arg === "--ext-diff" || arg === "--textconv"))
    || (command === "ls-files" && args.includes("--recurse-submodules"))
  ) {
    throw new GitInspectionError("invalid-output", "An external or recursive Git inspection option was rejected");
  }
  const separator = args.indexOf("--");
  if (separator >= 0 && args.slice(separator + 1).some((arg) => {
    const segments = arg.split("/");
    return !arg || path.posix.isAbsolute(arg) || path.win32.isAbsolute(arg) || segments.includes("..");
  })) {
    throw new GitInspectionError("invalid-output", "Git path arguments must stay repository-relative");
  }
  if (command === "cat-file" && !args.slice(1).every((arg) =>
    arg === "blob"
    || arg === "-s"
    || arg === "--batch"
    || arg.startsWith("--batch-check")
    || /^[a-f0-9]{40,64}$/.test(arg)
  )) {
    throw new GitInspectionError("invalid-output", "Unsupported cat-file inspection option");
  }
}

export async function runReadOnlyGit(
  cwd: string,
  args: readonly string[],
  options: ReadOnlyGitOptions = {}
): Promise<Buffer> {
  if (!path.isAbsolute(cwd) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new GitInspectionError("invalid-output", "Git inspection requires an absolute cwd and NUL-free argv");
  }
  validateReadOnlyArgs(args);
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 60_000);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 1_024, 64 * 1024 * 1024);
  const input = options.input;
  if (input && input.length > 1024 * 1024) throw new GitInspectionError("output-limit", "Git inspection input exceeded its cap");
  let filterArgs: string[] = [];
  if (args[0] === "status" || args[0] === "diff") try { filterArgs = await localFilterDisableArgs(cwd, timeoutMs); }
  catch (cause) { throw new GitInspectionError("git-failed", "Unable to disable repository Git filters", { cause }); }
  const argv = [...SAFE_GLOBAL_ARGS, ...filterArgs, "-C", cwd, ...args];

  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", argv, {
      cwd,
      env: gitEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: GitInspectionError | null = null;
    let settled = false;

    const fail = (error: GitInspectionError) => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail(new GitInspectionError("timeout", "Git inspection timed out")), timeoutMs);
    timer.unref?.();
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) return fail(new GitInspectionError("output-limit", "Git inspection exceeded its output cap"));
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.once("error", (cause) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new GitInspectionError("git-failed", "Unable to start Git inspection", { cause }));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (failure) return reject(failure);
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
        const notGit = /not a git repository/i.test(detail);
        return reject(new GitInspectionError(notGit ? "not-git" : "git-failed", detail || "Git inspection failed", { exitCode: code }));
      }
      resolve(Buffer.concat(stdout));
    });
  });
}

export async function readGitBlobDigests(
  repoRoot: string,
  objectIds: readonly string[],
  options: ReadOnlyGitOptions & { maxBlobBytes?: number } = {}
): Promise<Map<string, string>> {
  const ids = [...new Set(objectIds.filter((value) => /^[a-f0-9]{40,64}$/.test(value)))];
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const input = Buffer.from(`${ids.join("\n")}\n`, "ascii");
  const checked = await runReadOnlyGit(repoRoot, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    ...options,
    input,
    maxBytes: Math.max(4_096, ids.length * 160)
  });
  const maxBlobBytes = boundedInteger(options.maxBlobBytes, 4 * 1024 * 1024, 1_024, 16 * 1024 * 1024);
  const sizes = new Map<string, number>();
  for (const line of checked.toString("ascii").trim().split("\n")) {
    const [oid, type, rawSize] = line.split(" ");
    const size = Number(rawSize);
    if (/^[a-f0-9]{40,64}$/.test(oid ?? "") && type === "blob" && Number.isSafeInteger(size) && size >= 0 && size <= maxBlobBytes) {
      sizes.set(oid, size);
    }
  }
  let chunk: string[] = [];
  let expectedBytes = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    const payload = Buffer.from(`${chunk.join("\n")}\n`, "ascii");
    const output = await runReadOnlyGit(repoRoot, ["cat-file", "--batch"], {
      ...options,
      input: payload,
      maxBytes: Math.max(4_096, expectedBytes + chunk.length * 160)
    });
    let offset = 0;
    for (const requested of chunk) {
      const newline = output.indexOf(0x0a, offset);
      if (newline < 0) throw new GitInspectionError("invalid-output", "Malformed cat-file batch header");
      const [oid, type, rawSize] = output.subarray(offset, newline).toString("ascii").split(" ");
      const size = Number(rawSize);
      const start = newline + 1;
      const end = start + size;
      if (oid !== requested || type !== "blob" || !Number.isSafeInteger(size) || end >= output.length || output[end] !== 0x0a) {
        throw new GitInspectionError("invalid-output", "Malformed cat-file batch payload");
      }
      result.set(oid, `sha256:${sha256(output.subarray(start, end))}`);
      offset = end + 1;
    }
    chunk = [];
    expectedBytes = 0;
  };
  for (const oid of ids) {
    const size = sizes.get(oid);
    if (size === undefined) continue;
    if (chunk.length >= 64 || expectedBytes + size > 8 * 1024 * 1024) await flush();
    chunk.push(oid);
    expectedBytes += size;
  }
  await flush();
  return result;
}

export async function readGitBlob(repoRoot: string, objectId: string, options: ReadOnlyGitOptions = {}): Promise<Buffer> {
  if (!/^[a-f0-9]{40,64}$/.test(objectId)) throw new GitInspectionError("invalid-output", "Invalid Git blob object ID");
  const maxBytes = boundedInteger(options.maxBytes, 4 * 1024 * 1024, 1_024, 16 * 1024 * 1024);
  const size = await runReadOnlyGit(repoRoot, ["cat-file", "-s", objectId], { ...options, maxBytes: 1024 });
  const parsed = Number(size.toString("ascii").trim());
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new GitInspectionError("invalid-output", "Git returned an invalid blob size");
  if (parsed > maxBytes) throw new GitInspectionError("output-limit", "Git blob exceeds its read cap");
  return await runReadOnlyGit(repoRoot, ["cat-file", "blob", objectId], { ...options, maxBytes: Math.max(1024, parsed + 1) });
}

function splitNul(input: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== 0) continue;
    fields.push(input.subarray(start, index));
    start = index + 1;
  }
  if (start < input.length) fields.push(input.subarray(start));
  return fields;
}

function prefixedFields(record: Buffer, count: number): { fields: string[]; remainder: Buffer } {
  const fields: string[] = [];
  let start = 2;
  for (let index = start; index < record.length && fields.length < count; index += 1) {
    if (record[index] !== 0x20) continue;
    fields.push(record.subarray(start, index).toString("ascii"));
    start = index + 1;
  }
  if (fields.length !== count || start > record.length) {
    throw new GitInspectionError("invalid-output", "Malformed porcelain-v2 record");
  }
  return { fields, remainder: record.subarray(start) };
}

function escapedDisplay(value: string): string {
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === "%") output += "%25";
    else if (character === "\\") output += "%5C";
    else if (code <= 0x1f || code === 0x7f) {
      output += Buffer.from(character, "utf8").toString("hex").match(/../g)?.map((byte) => `%${byte.toUpperCase()}`).join("") ?? "";
    } else output += character;
  }
  return output;
}

function gitPath(raw: Buffer): GitPath {
  const digest = `sha256:${sha256(raw)}`;
  try {
    const value = utf8.decode(raw);
    const segments = value.split("/");
    const unsafeAuthority = !value || path.posix.isAbsolute(value) || segments.includes("..") || value.includes("\0");
    const needsEscape = /[\u0000-\u001f\u007f\\%]/u.test(value);
    const display = needsEscape ? escapedDisplay(value) : value;
    if (unsafeAuthority || !display || display.length > DISPLAY_PATH_MAX) {
      return { value: null, display: null, displayMode: "unavailable", digest };
    }
    return { value, display, displayMode: needsEscape ? "escaped" : "exact-safe", digest };
  } catch {
    return { value: null, display: null, displayMode: "unavailable", digest };
  }
}

export function projectGitPath(value: string): GitPath {
  return gitPath(Buffer.from(value, "utf8"));
}

function statusPair(value: string): [RawGitStatus, RawGitStatus] {
  if (!/^[.MTADRCU?!]{2}$/.test(value)) throw new GitInspectionError("invalid-output", "Invalid porcelain-v2 XY status");
  return [value[0] as RawGitStatus, value[1] as RawGitStatus];
}

export function parsePorcelainV2(raw: Buffer, repoRoot: string): GitStatusSnapshot {
  const tokens = splitNul(raw);
  const headers: Record<string, string> = {};
  const records: GitStatusRecord[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length === 0) continue;
    const kind = String.fromCharCode(token[0]);
    if (kind === "#") {
      const header = token.subarray(2).toString("utf8");
      const separator = header.indexOf(" ");
      headers[separator < 0 ? header : header.slice(0, separator)] = separator < 0 ? "" : header.slice(separator + 1);
      continue;
    }
    if (kind === "?" || kind === "!") {
      records.push({
        kind: kind === "?" ? "untracked" : "ignored",
        indexStatus: kind,
        worktreeStatus: kind,
        submodule: null,
        headMode: null,
        indexMode: null,
        worktreeMode: null,
        headObject: null,
        indexObject: null,
        renameScore: null,
        path: gitPath(token.subarray(2)),
        oldPath: null
      });
      continue;
    }
    if (kind === "1") {
      const parsed = prefixedFields(token, 7);
      const [indexStatus, worktreeStatus] = statusPair(parsed.fields[0]);
      records.push({
        kind: "ordinary", indexStatus, worktreeStatus,
        submodule: parsed.fields[1], headMode: parsed.fields[2], indexMode: parsed.fields[3], worktreeMode: parsed.fields[4],
        headObject: parsed.fields[5], indexObject: parsed.fields[6], renameScore: null,
        path: gitPath(parsed.remainder), oldPath: null
      });
      continue;
    }
    if (kind === "2") {
      const parsed = prefixedFields(token, 8);
      const original = tokens[++index];
      if (!original) throw new GitInspectionError("invalid-output", "Rename record is missing its original path");
      const [indexStatus, worktreeStatus] = statusPair(parsed.fields[0]);
      records.push({
        kind: "renamed", indexStatus, worktreeStatus,
        submodule: parsed.fields[1], headMode: parsed.fields[2], indexMode: parsed.fields[3], worktreeMode: parsed.fields[4],
        headObject: parsed.fields[5], indexObject: parsed.fields[6], renameScore: parsed.fields[7],
        path: gitPath(parsed.remainder), oldPath: gitPath(original)
      });
      continue;
    }
    if (kind === "u") {
      const parsed = prefixedFields(token, 9);
      const [indexStatus, worktreeStatus] = statusPair(parsed.fields[0]);
      records.push({
        kind: "unmerged", indexStatus, worktreeStatus,
        submodule: parsed.fields[1], headMode: parsed.fields[2], indexMode: parsed.fields[3], worktreeMode: parsed.fields[5],
        headObject: parsed.fields[6], indexObject: parsed.fields[7], renameScore: null,
        path: gitPath(parsed.remainder), oldPath: null
      });
      continue;
    }
    throw new GitInspectionError("invalid-output", `Unsupported porcelain-v2 record kind ${JSON.stringify(kind)}`);
  }

  const canonicalRoot = fs.realpathSync.native(repoRoot);
  const headOid = headers["branch.oid"] && headers["branch.oid"] !== "(initial)" ? headers["branch.oid"] : null;
  return {
    repoRoot: canonicalRoot,
    repoDigest: sha256(canonicalRoot),
    headState: headOid ? "head" : "unborn",
    headOid,
    branchHead: headers["branch.head"] ?? null,
    headers,
    records,
    rawDigest: sha256(raw),
    raw
  };
}

export async function discoverGitRoot(cwd: string, options: ReadOnlyGitOptions = {}): Promise<string> {
  const absolute = path.resolve(cwd);
  const output = await runReadOnlyGit(absolute, ["rev-parse", "--path-format=absolute", "--show-toplevel"], options);
  let decoded: string;
  try {
    decoded = utf8.decode(output).replace(/\r?\n$/, "");
  } catch (cause) {
    throw new GitInspectionError("invalid-output", "Git root is not valid UTF-8", { cause });
  }
  if (!path.isAbsolute(decoded)) throw new GitInspectionError("invalid-output", "Git returned a non-absolute repository root");
  return fs.realpathSync.native(decoded);
}

export async function collectGitStatus(cwd: string, options: ReadOnlyGitOptions = {}): Promise<GitStatusSnapshot> {
  const repoRoot = await discoverGitRoot(cwd, options);
  const raw = await runReadOnlyGit(repoRoot, [
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--renames",
    "--untracked-files=all",
    "--ignore-submodules=dirty"
  ], options);
  return parsePorcelainV2(raw, repoRoot);
}

export async function collectGitStatusForPaths(cwd: string, repoPaths: string[], options: ReadOnlyGitOptions = {}): Promise<GitStatusSnapshot> {
  if (repoPaths.length === 0 || repoPaths.length > 8) throw new GitInspectionError("invalid-output", "Targeted Git status requires one to eight paths");
  const safe = [...new Set(repoPaths)].map((repoPath) => {
    const projected = projectGitPath(repoPath);
    if (projected.value !== repoPath) throw new GitInspectionError("invalid-output", "Targeted Git status path is unsafe");
    return repoPath;
  });
  const repoRoot = await discoverGitRoot(cwd, options);
  const raw = await runReadOnlyGit(repoRoot, [
    "status", "--porcelain=v2", "-z", "--branch", "--renames", "--untracked-files=all", "--ignore-submodules=dirty", "--", ...safe
  ], options);
  return parsePorcelainV2(raw, repoRoot);
}

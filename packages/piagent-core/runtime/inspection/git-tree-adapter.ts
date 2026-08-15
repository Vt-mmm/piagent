import os from "node:os";

import {
  GitInspectionError,
  projectGitPath,
  runReadOnlyGit,
  type ReadOnlyGitOptions
} from "./git-status-adapter.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true });

export type GitTreeEntry = {
  mode: string;
  type: "blob" | "commit";
  objectId: string;
  path: string;
};

export type GitTreeChange = {
  status: "A" | "C" | "D" | "M" | "R";
  path: string;
  oldPath: string | null;
};

export async function readGitTreeEntry(
  repoRoot: string,
  treeObjectId: string,
  repoPath: string,
  options: ReadOnlyGitOptions = {}
): Promise<GitTreeEntry | null> {
  if (!/^[a-f0-9]{40,64}$/.test(treeObjectId)) throw new GitInspectionError("invalid-output", "Invalid Git tree object ID");
  const output = await runReadOnlyGit(repoRoot, ["ls-tree", "-z", treeObjectId, "--", repoPath], options);
  if (output.length === 0) return null;
  if (output[output.length - 1] !== 0 || output.indexOf(0) !== output.length - 1) {
    throw new GitInspectionError("invalid-output", "Git returned an ambiguous tree entry");
  }
  const record = output.subarray(0, -1);
  const tab = record.indexOf(0x09);
  if (tab < 0) throw new GitInspectionError("invalid-output", "Git returned a malformed tree entry");
  const header = record.subarray(0, tab).toString("ascii").split(" ");
  let decodedPath: string;
  try { decodedPath = utf8.decode(record.subarray(tab + 1)); }
  catch (cause) { throw new GitInspectionError("invalid-output", "Git tree path is not valid UTF-8", { cause }); }
  const projected = projectGitPath(decodedPath);
  if (header.length !== 3 || !/^[0-7]{6}$/.test(header[0] ?? "") || !/^(blob|commit)$/.test(header[1] ?? "")
    || !/^[a-f0-9]{40,64}$/.test(header[2] ?? "") || projected.value !== repoPath) {
    throw new GitInspectionError("invalid-output", "Git returned an invalid tree entry");
  }
  return { mode: header[0], type: header[1] as "blob" | "commit", objectId: header[2], path: repoPath };
}

export async function listGitPathsAgainstTree(
  repoRoot: string,
  treeObjectId: string,
  options: ReadOnlyGitOptions = {}
): Promise<string[]> {
  if (!/^[a-f0-9]{40,64}$/.test(treeObjectId)) throw new GitInspectionError("invalid-output", "Invalid Git tree object ID");
  const output = await runReadOnlyGit(repoRoot, [
    "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", treeObjectId, "--"
  ], options);
  const result: string[] = [];
  let decoded: string;
  try { decoded = utf8.decode(output); }
  catch (cause) { throw new GitInspectionError("invalid-output", "Task delta paths are not valid UTF-8", { cause }); }
  for (const raw of decoded.split("\0")) {
    if (!raw) continue;
    const projected = projectGitPath(raw);
    if (!projected.value) throw new GitInspectionError("invalid-output", "Task delta contains a path that cannot be represented safely");
    result.push(projected.value);
  }
  return result;
}

export async function listGitChangesAgainstTree(
  repoRoot: string,
  treeObjectId: string,
  options: ReadOnlyGitOptions = {}
): Promise<GitTreeChange[]> {
  if (!/^[a-f0-9]{40,64}$/.test(treeObjectId)) throw new GitInspectionError("invalid-output", "Invalid Git tree object ID");
  const output = await runReadOnlyGit(repoRoot, [
    "diff", "--name-status", "-z", "--no-ext-diff", "--no-textconv", "--find-renames", "--diff-filter=ACMRD", treeObjectId, "--"
  ], options);
  if (output.length > 0 && output[output.length - 1] !== 0) throw new GitInspectionError("invalid-output", "Task delta status is not NUL terminated");
  let decoded: string;
  try { decoded = utf8.decode(output); }
  catch (cause) { throw new GitInspectionError("invalid-output", "Task delta status is not valid UTF-8", { cause }); }
  const fields = decoded.split("\0").filter(Boolean), result: GitTreeChange[] = [];
  for (let index = 0; index < fields.length;) {
    const rawStatus = fields[index++], source = fields[index++];
    if (!rawStatus || !source || !/^(?:[ADM]|[RC][0-9]{1,3})$/.test(rawStatus)) {
      throw new GitInspectionError("invalid-output", "Task delta contains an invalid status record");
    }
    const status = rawStatus[0] as GitTreeChange["status"];
    const destination = status === "R" || status === "C" ? fields[index++] : null;
    if ((status === "R" || status === "C") && !destination) throw new GitInspectionError("invalid-output", "Task delta rename is incomplete");
    const path = projectGitPath(destination ?? source), oldPath = destination ? projectGitPath(source) : null;
    if (!path.value || (oldPath && !oldPath.value)) throw new GitInspectionError("invalid-output", "Task delta contains an unsafe path");
    result.push({ status, path: path.value, oldPath: oldPath?.value ?? null });
  }
  return result;
}

export async function emptyGitTreeObjectId(repoRoot: string, options: ReadOnlyGitOptions = {}): Promise<string> {
  const output = await runReadOnlyGit(repoRoot, ["hash-object", "-t", "tree", os.devNull], { ...options, maxBytes: 1024 });
  const objectId = output.toString("ascii").trim();
  if (!/^[a-f0-9]{40,64}$/.test(objectId)) throw new GitInspectionError("invalid-output", "Git returned an invalid empty-tree object ID");
  return objectId;
}

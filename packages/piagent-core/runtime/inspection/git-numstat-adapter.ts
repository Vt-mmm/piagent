import os from "node:os";
import {
  GitInspectionError,
  type GitStatusSnapshot,
  runReadOnlyGit
} from "./git-status-adapter.ts";

export type LineStat = { additions: number | null; deletions: number | null; binary: boolean };

function parseNumstat(raw: Buffer): Map<string, LineStat> {
  const tokens = raw.toString("utf8").split("\0");
  const result = new Map<string, LineStat>();
  for (let index = 0; index < tokens.length; index += 1) {
    const tokenValue = tokens[index];
    if (!tokenValue) continue;
    const first = tokenValue.indexOf("\t");
    const second = first < 0 ? -1 : tokenValue.indexOf("\t", first + 1);
    if (first < 0 || second < 0) continue;
    const added = tokenValue.slice(0, first);
    const removed = tokenValue.slice(first + 1, second);
    let file = tokenValue.slice(second + 1);
    if (!file) {
      index += 1;
      const oldPath = tokens[index] ?? "";
      index += 1;
      file = tokens[index] ?? oldPath;
    }
    if (!file) continue;
    const binary = added === "-" || removed === "-";
    result.set(file, {
      additions: binary || !/^\d+$/.test(added) ? null : Number(added),
      deletions: binary || !/^\d+$/.test(removed) ? null : Number(removed),
      binary
    });
  }
  return result;
}

async function emptyTree(snapshot: GitStatusSnapshot, timeoutMs?: number, maxBytes?: number): Promise<string> {
  if (snapshot.headOid) return snapshot.headOid;
  const output = await runReadOnlyGit(snapshot.repoRoot, ["hash-object", "-t", "tree", os.devNull], { timeoutMs, maxBytes });
  const oid = output.toString("ascii").trim();
  if (!/^[a-f0-9]{40,64}$/.test(oid)) {
    throw new GitInspectionError("invalid-output", "Git returned an invalid empty-tree object ID");
  }
  return oid;
}

export async function collectNumstats(
  snapshot: GitStatusSnapshot,
  view: "working-tree" | "staged",
  repoPaths: string[],
  timeoutMs?: number,
  maxBytes?: number
): Promise<Map<string, LineStat>> {
  if (repoPaths.length === 0) return new Map();
  const base = await emptyTree(snapshot, timeoutMs, maxBytes);
  const args = [
    "diff",
    ...(view === "staged" ? ["--cached"] : []),
    "--numstat",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    base,
    "--",
    ...repoPaths
  ];
  return parseNumstat(await runReadOnlyGit(snapshot.repoRoot, args, { timeoutMs, maxBytes }));
}

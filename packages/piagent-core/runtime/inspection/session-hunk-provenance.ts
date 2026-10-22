import { createHash } from "node:crypto";
import { diffTextBuffers, type TextDiffOperation } from "./text-diff.ts";
import type { ExactGitPatchAuthority } from "./source-action-contract.ts";
import type { SessionMutationObservation } from "./session-mutation-observer.ts";

type ChangeBlock = { at: number; added: string[]; deleted: string[] };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function blocks(operations: TextDiffOperation[], start = 1): ChangeBlock[] {
  const result: ChangeBlock[] = [];
  let current = start, block: ChangeBlock | null = null;
  for (const operation of operations) {
    if (operation.kind === "context") { block = null; current++; continue; }
    if (!block) { block = { at: current, added: [], deleted: [] }; result.push(block); }
    if (operation.kind === "added") { block.added.push(operation.text); current++; }
    else block.deleted.push(operation.text);
  }
  return result;
}
function patchBlocks(bytes: Buffer): ChangeBlock[] | null {
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes) || !text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n"), header = lines.shift();
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/.exec(header ?? "");
  if (!match) return null;
  const operations: TextDiffOperation[] = [];
  for (const line of lines) {
    const marker = line[0];
    if (line === "\\ No newline at end of file") {
      const previous = operations.at(-1);
      if (!previous?.text.endsWith("\n")) return null;
      previous.text = previous.text.slice(0, -1);
      continue;
    }
    if (![" ", "+", "-"].includes(marker)) return null;
    operations.push({ kind: marker === " " ? "context" : marker === "+" ? "added" : "deleted", text: line.slice(1) + "\n" });
  }
  if (operations.filter(item => item.kind !== "added").length !== Number(match[2] ?? 1)
    || operations.filter(item => item.kind !== "deleted").length !== Number(match[4] ?? 1)) return null;
  return blocks(operations, Math.max(1, Number(match[3]) + (Number(match[4] ?? 1) === 0 ? 1 : 0)));
}

// Index hunks may contain member edits that predate this session. Only grant
// a hunk when every changed block is an exact delta from the observed baseline.
export function sessionAuthoredHunkRefs(observation: SessionMutationObservation, current: string,
  patch: ExactGitPatchAuthority): string[] {
  const baseline = observation.baseline;
  if (digest(current) !== observation.currentDigest
    || (baseline.digest === "absent" ? baseline.content !== "" : digest(baseline.content) !== baseline.digest)) return [];
  const delta = diffTextBuffers(Buffer.from(baseline.content), Buffer.from(current), undefined, true);
  if (!delta.exact) return [];
  const proven = new Set(blocks(delta.operations).map(block => JSON.stringify(block)));
  return patch.hunks.filter(hunk => {
    const changes = patchBlocks(hunk.bytes);
    return changes !== null && changes.length > 0 && changes.every(block => proven.has(JSON.stringify(block)));
  }).map(hunk => hunk.hunkRef);
}

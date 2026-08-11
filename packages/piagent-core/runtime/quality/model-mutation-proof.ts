import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_PROOF_FILE_BYTES = 4 * 1024 * 1024;

export type ModelMutationProof = {
  expectedContentDigests: Record<string, string[]>;
  preContentDigests: Record<string, string>;
  fullContentPaths: string[];
  replacePaths: string[];
};

function normalizeRelative(cwd: string, candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return undefined;
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute).split(path.sep).join("/");
  return relative && relative !== ".." && !relative.startsWith("../") ? relative : undefined;
}

function contentDigest(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function stableFile(cwd: string, file: string): { content: string; digest: string } | undefined {
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  try {
    const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.size > MAX_PROOF_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(before.size);
      let position = 0;
      while (position < before.size) {
        const bytes = fs.readSync(descriptor, buffer, position, before.size - position, position);
        if (bytes <= 0) return undefined;
        position += bytes;
      }
      const after = fs.fstatSync(descriptor);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return undefined;
      return { content: buffer.toString("utf8"), digest: contentDigest(buffer) };
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
}

function inputEdits(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> | undefined {
  const values = Array.isArray(input.edits)
    ? input.edits
    : typeof input.oldText === "string" && typeof input.newText === "string"
      ? [{ oldText: input.oldText, newText: input.newText }]
      : [];
  if (values.length === 0 || values.length > 100) return undefined;
  const edits: Array<{ oldText: string; newText: string }> = [];
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const edit = value as Record<string, unknown>;
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string" || !edit.oldText || edit.oldText === edit.newText) return undefined;
    edits.push({ oldText: edit.oldText, newText: edit.newText });
  }
  return edits;
}

function applyUniqueReplacements(content: string, edits: Array<{ oldText: string; newText: string }>): string | undefined {
  let projected = content;
  for (const edit of edits) {
    const index = projected.indexOf(edit.oldText);
    if (index < 0 || projected.indexOf(edit.oldText, index + edit.oldText.length) >= 0) return undefined;
    projected = `${projected.slice(0, index)}${edit.newText}${projected.slice(index + edit.oldText.length)}`;
  }
  return projected === content ? undefined : projected;
}

function applyPatchHunks(content: string, lines: string[]): string | undefined {
  let projected = content.split("\n");
  let sawHunk = false;
  for (let index = 0; index < lines.length;) {
    if (!lines[index].startsWith("@@")) return undefined;
    sawHunk = true;
    index += 1;
    const oldLines: string[] = [], newLines: string[] = [];
    while (index < lines.length && !lines[index].startsWith("@@")) {
      const line = lines[index++];
      if (!line || line.startsWith("\\ No newline") || ![" ", "+", "-"].includes(line[0])) return undefined;
      if (line[0] !== "+") oldLines.push(line.slice(1));
      if (line[0] !== "-") newLines.push(line.slice(1));
    }
    if (oldLines.length === 0 || (oldLines.length === newLines.length && oldLines.every((line, item) => line === newLines[item]))) return undefined;
    const matches: number[] = [];
    for (let at = 0; at + oldLines.length <= projected.length; at += 1) {
      if (oldLines.every((line, offset) => projected[at + offset] === line)) matches.push(at);
    }
    if (matches.length !== 1) return undefined;
    projected.splice(matches[0], oldLines.length, ...newLines);
  }
  const result = sawHunk ? projected.join("\n") : undefined;
  return result === content ? undefined : result;
}

function patchStrings(input: Record<string, unknown>): string[] {
  return Object.values(input).filter((value): value is string => typeof value === "string" && value.includes("*** "));
}

function patchProof(cwd: string, input: Record<string, unknown>, targets: string[], proof: ModelMutationProof): void {
  for (const patch of patchStrings(input)) {
    const lines = patch.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const marker = lines[index].match(/^\*\*\* (Add|Update) File:\s*(.+?)\s*$/);
      if (!marker) continue;
      const file = normalizeRelative(cwd, marker[2]);
      if (!file || !targets.includes(file)) continue;
      const section: string[] = [];
      for (index += 1; index < lines.length && !lines[index].startsWith("*** "); index += 1) section.push(lines[index]);
      index -= 1;
      if (marker[1] === "Add") {
        proof.fullContentPaths.push(file);
        const valid = section.every((line) => line.startsWith("+"));
        if (valid) {
          const content = section.map((line) => line.slice(1)).join("\n");
          proof.expectedContentDigests[file] = [...new Set([contentDigest(content), contentDigest(`${content}\n`)])];
        }
        continue;
      }
      proof.replacePaths.push(file);
      const before = stableFile(cwd, file);
      if (!before) continue;
      proof.preContentDigests[file] = before.digest;
      const projected = applyPatchHunks(before.content, section);
      if (projected !== undefined) proof.expectedContentDigests[file] = [contentDigest(projected)];
    }
  }
}

export function expectedModelMutationProof(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  targetPaths: string[]
): ModelMutationProof {
  const targets = [...new Set(targetPaths)];
  const proof: ModelMutationProof = { expectedContentDigests: {}, preContentDigests: {}, fullContentPaths: [], replacePaths: [] };
  const rememberFullContent = (file: string, contents: string[]) => {
    if (!targets.includes(file) || contents.length === 0) return;
    proof.fullContentPaths.push(file);
    proof.expectedContentDigests[file] = [...new Set(contents.map(contentDigest))];
  };
  if (toolName === "write" && targets.length === 1 && typeof input.content === "string") {
    rememberFullContent(targets[0], [input.content]);
  } else if (toolName === "edit" && targets.length === 1) {
    proof.replacePaths.push(targets[0]);
    const before = stableFile(cwd, targets[0]);
    const edits = inputEdits(input);
    if (before) proof.preContentDigests[targets[0]] = before.digest;
    const projected = before && edits ? applyUniqueReplacements(before.content, edits) : undefined;
    if (projected !== undefined) proof.expectedContentDigests[targets[0]] = [contentDigest(projected)];
  } else if (toolName === "apply_patch") {
    patchProof(cwd, input, targets, proof);
  }
  proof.fullContentPaths = [...new Set(proof.fullContentPaths)].sort();
  proof.replacePaths = [...new Set(proof.replacePaths)].sort();
  return proof;
}

export function expectedModelMutationContentDigests(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  targetPaths: string[]
): Record<string, string[]> {
  return expectedModelMutationProof(cwd, toolName, input, targetPaths).expectedContentDigests;
}

export function currentFileContentDigests(cwd: string, paths: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const file of [...new Set(paths)]) {
    const current = stableFile(cwd, file);
    if (current) result[file] = current.digest;
  }
  return result;
}

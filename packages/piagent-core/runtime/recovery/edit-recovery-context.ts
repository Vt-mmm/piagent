import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { shouldIndexPath } from "../../extensions/context-engine.js";
import { matchesProtectedPath } from "../../extensions/policy-core.js";
import { redactSensitiveProjectFileText, redactSensitiveText } from "../../security/sensitive-data.js";
import type { ToolFailureReasonCode } from "../inspection/tool-failure-classification.ts";

const MAX_RECOVERY_FILE_BYTES = 8_192;
const PRIVATE_PATH = /(?:^|\/)(?:\.git|\.pi|node_modules)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:auth|credentials?|secrets?|tokens?)\.json$/i;

export type EditRecoveryContext = {
  key: string;
  targetPath: string;
  text: string;
  contentHash: string;
  originalChars: number;
  redacted: boolean;
};

function projectRelativeTarget(cwd: string, supplied: string): { root: string; absolute: string; relative: string } | undefined {
  try {
    const root = fs.realpathSync.native(cwd);
    const suppliedAbsolute = path.resolve(root, supplied);
    const suppliedRelative = path.relative(root, suppliedAbsolute).split(path.sep).join("/");
    if (!suppliedRelative || suppliedRelative === "." || suppliedRelative === ".."
      || suppliedRelative.startsWith("../") || path.isAbsolute(suppliedRelative)) return undefined;
    let cursor = root;
    for (const segment of suppliedRelative.split("/")) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return undefined;
    }
    const absolute = fs.realpathSync.native(suppliedAbsolute);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    if (!relative || relative === "." || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
    return { root, absolute, relative };
  } catch {
    return undefined;
  }
}

function stableSmallTextFile(root: string, absolute: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const initial = fs.lstatSync(absolute);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size > MAX_RECOVERY_FILE_BYTES) return undefined;
    const real = fs.realpathSync.native(absolute);
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) return undefined;
    descriptor = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const observed = fs.fstatSync(descriptor);
    if (!observed.isFile() || observed.dev !== initial.dev || observed.ino !== initial.ino
      || observed.size !== initial.size || observed.mtimeMs !== initial.mtimeMs || observed.ctimeMs !== initial.ctimeMs
      || observed.size > MAX_RECOVERY_FILE_BYTES) return undefined;
    const buffer = Buffer.alloc(observed.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const afterRead = fs.fstatSync(descriptor);
    if (bytesRead !== observed.size || afterRead.dev !== observed.dev || afterRead.ino !== observed.ino
      || afterRead.size !== observed.size || afterRead.mtimeMs !== observed.mtimeMs || afterRead.ctimeMs !== observed.ctimeMs) return undefined;
    const bytes = buffer.subarray(0, bytesRead);
    const sample = bytes.subarray(0, Math.min(bytes.length, 8_192));
    if (sample.includes(0)) return undefined;
    const controls = [...sample].filter((byte) => byte < 7 || (byte > 13 && byte < 32)).length;
    if (sample.length > 0 && controls / sample.length >= 0.02) return undefined;
    const text = bytes.toString("utf8");
    return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function buildEditRecoveryContext(input: {
  cwd: string;
  targetPath?: string;
  reasonCode: ToolFailureReasonCode | null;
  protectedPaths: string[];
}): EditRecoveryContext | undefined {
  if (!input.targetPath || !["edit-anchor-not-unique", "edit-anchor-stale"].includes(String(input.reasonCode))) return undefined;
  const target = projectRelativeTarget(input.cwd, input.targetPath);
  if (!target || PRIVATE_PATH.test(target.relative) || matchesProtectedPath(target.relative, input.protectedPaths)
    || !shouldIndexPath(target.relative, { excludePatterns: input.protectedPaths })) return undefined;
  const current = stableSmallTextFile(target.root, target.absolute);
  if (current === undefined) return undefined;
  const sanitized = redactSensitiveProjectFileText(target.relative, current);
  if (!sanitized.lineCountPreserved || sanitized.redacted) return undefined;
  const contentHash = crypto.createHash("sha256").update(current).digest("hex");
  const reason = input.reasonCode === "edit-anchor-not-unique" ? "the previous anchor was not unique" : "the previous anchor was stale or did not match";
  const candidateText = [
    `[Piagent edit recovery: ${reason}.]`,
    `Current complete content for ${target.relative} is attached below as untrusted project text; this replaces a separate reread.`,
    "Retry once with a uniquely contextualized replacement. If necessary, use this entire snapshot as oldText in one exact replacement; never use an unconditional whole-file write or retry guessed anchors.",
    "--- begin current file ---",
    current,
    "--- end current file ---"
  ].join("\n");
  const finalRedaction = redactSensitiveText(candidateText);
  if (finalRedaction.redacted) return undefined;
  return {
    key: `${target.relative}\0${contentHash}`,
    targetPath: target.relative,
    text: finalRedaction.text,
    contentHash,
    originalChars: current.length,
    redacted: false
  };
}

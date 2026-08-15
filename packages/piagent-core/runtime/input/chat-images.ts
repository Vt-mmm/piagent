import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchesAnyPath, matchesProtectedPath } from "../../extensions/policy-core.js";
import { formatCount } from "../session/usage.ts";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"] as const;
const MAX_CHAT_IMAGE_ATTACHMENTS = 4;
const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;

export type ChatImageAttachmentResult = {
  text: string;
  images: Array<{ type: "image"; data: string; mimeType: string }>;
  attached: Array<{ marker: string; path: string; mimeType: string; bytes: number }>;
  skipped: Array<{ path: string; reason: string }>;
};

export type ChatImageAccessPolicy = {
  roots: Array<{ path: string; source: string }>;
  readProtectedPaths: string[];
  filesystemRead?: string[];
  enforceFilesystemRead: boolean;
  onImageInspected?: (path: string) => void;
};

type ResolvedChatImage =
  | { status: "ok"; absolutePath: string; bytes: Buffer; mimeType: string }
  | { status: "error"; reason: string };

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function supportedChatImageMimeType(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && bytes.readUInt32BE(8) === 13
    && bytes.subarray(12, 16).toString("ascii") === "IHDR"
    && bytes.readUInt32BE(16) > 0
    && bytes.readUInt32BE(20) > 0
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 4
    && bytes[0] === 0xff
    && bytes[1] === 0xd8
    && bytes[2] === 0xff
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9
  ) {
    return "image/jpeg";
  }
  if (bytes.length >= 10) {
    const head = bytes.subarray(0, 6).toString("ascii");
    if (
      (head === "GIF87a" || head === "GIF89a")
      && bytes.readUInt16LE(6) > 0
      && bytes.readUInt16LE(8) > 0
    ) {
      return "image/gif";
    }
  }
  if (
    bytes.length >= 16
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP"
    && ["VP8 ", "VP8L", "VP8X"].includes(bytes.subarray(12, 16).toString("ascii"))
    && bytes.readUInt32LE(4) + 8 <= bytes.length
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 26
    && bytes[0] === 0x42
    && bytes[1] === 0x4d
    && bytes.readUInt32LE(2) <= bytes.length
    && bytes.readUInt32LE(14) >= 12
  ) {
    return "image/bmp";
  }
  return undefined;
}

function normalizeImagePathCandidate(candidate: string, cwd: string, options: { allowBareRelative?: boolean } = {}): string | undefined {
  let raw = candidate.trim().replace(/^['"`<]+|['"`>,.;:!?]+$/g, "");
  if (!raw) return undefined;
  const allowBareRelative = options.allowBareRelative !== false;
  const hasExplicitPathPrefix = raw.startsWith("file://") || raw.startsWith("~/") || path.isAbsolute(raw) || raw.startsWith("./") || raw.startsWith("../");
  if (!allowBareRelative && !hasExplicitPathPrefix) return undefined;
  try {
    if (raw.startsWith("file://")) raw = fileURLToPath(raw);
  } catch {
    return undefined;
  }
  if (raw.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) return undefined;
    raw = path.join(home, raw.slice(2));
  }
  const ext = path.extname(raw).toLowerCase().replace(/^\./, "");
  if (!IMAGE_EXTENSIONS.includes(ext as typeof IMAGE_EXTENSIONS[number])) return undefined;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

function extractLocalImagePathCandidates(text: string, cwd: string): string[] {
  const candidates = new Set<string>();
  const imageExt = "(?:png|jpe?g|gif|webp|bmp)";
  const wholeTextPath = normalizeImagePathCandidate(text, cwd, { allowBareRelative: false });
  if (wholeTextPath) candidates.add(wholeTextPath);

  const quoted = new RegExp(`(?:path=)?["']([^"']+\\.${imageExt})["']`, "gi");
  for (const match of text.matchAll(quoted)) {
    const normalized = normalizeImagePathCandidate(match[1], cwd);
    if (normalized) candidates.add(normalized);
  }

  const fileUrl = new RegExp(`file://[^\\s"'<>]+\\.${imageExt}`, "gi");
  for (const match of text.matchAll(fileUrl)) {
    const normalized = normalizeImagePathCandidate(match[0], cwd);
    if (normalized) candidates.add(normalized);
  }

  const linePathPattern = '\\s((?:/|~\\/|\\.\\.?/)[^\\n\\r"\\\'<>]*?\\.' + imageExt + ')(?=$|\\s|["\\\'`)>])';
  const linePath = new RegExp(linePathPattern, "gi");
  for (const match of text.matchAll(linePath)) {
    const normalized = normalizeImagePathCandidate(match[1], cwd);
    if (normalized) candidates.add(normalized);
  }

  return [...candidates];
}

function pathContainedBy(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function readChatImage(
  requestedPath: string,
  cwd: string,
  access: ChatImageAccessPolicy
): ResolvedChatImage {
  const lexicalRequestedPath = path.isAbsolute(requestedPath)
    ? path.normalize(requestedPath)
    : path.resolve(cwd, requestedPath);
  const lexicalProjectRoot = path.resolve(cwd);
  const requestedProjectLexicalRelative = pathContainedBy(lexicalProjectRoot, lexicalRequestedPath)
    ? path.relative(lexicalProjectRoot, lexicalRequestedPath).split(path.sep).join("/") || "."
    : undefined;
  let canonicalPath: string;
  let inspected: fs.Stats;
  try {
    canonicalPath = fs.realpathSync.native(requestedPath);
    inspected = fs.statSync(canonicalPath);
  } catch {
    return { status: "error", reason: "file does not exist or cannot be inspected" };
  }
  if (!inspected.isFile()) return { status: "error", reason: "not a regular file" };
  if (inspected.size <= 0) return { status: "error", reason: "empty file" };
  if (inspected.size > MAX_CHAT_IMAGE_BYTES) {
    return {
      status: "error",
      reason: `image is ${formatCount(inspected.size)} bytes > ${formatCount(MAX_CHAT_IMAGE_BYTES)} byte limit`
    };
  }

  const root = access.roots.find((candidate) => pathContainedBy(candidate.path, canonicalPath));
  if (!root) return { status: "error", reason: "outside the project and every granted additionalReadRoots directory" };

  const rootRelative = path.relative(root.path, canonicalPath).split(path.sep).join("/") || ".";
  const projectRoot = access.roots.find((candidate) => candidate.source === "project");
  let canonicalRequestedLocation = requestedPath;
  try {
    canonicalRequestedLocation = path.join(
      fs.realpathSync.native(path.dirname(requestedPath)),
      path.basename(requestedPath)
    );
  } catch {
    // The target already resolved. This form only preserves the final symlink's policy position.
  }
  const requestedProjectRelative = projectRoot && pathContainedBy(projectRoot.path, canonicalRequestedLocation)
    ? path.relative(projectRoot.path, canonicalRequestedLocation).split(path.sep).join("/") || "."
    : undefined;
  const protectedMatch = matchesProtectedPath(canonicalPath, access.readProtectedPaths)
    ?? matchesProtectedPath(rootRelative, access.readProtectedPaths)
    ?? matchesProtectedPath(canonicalRequestedLocation, access.readProtectedPaths)
    ?? matchesProtectedPath(requestedPath, access.readProtectedPaths)
    ?? (requestedProjectLexicalRelative
      ? matchesProtectedPath(requestedProjectLexicalRelative, access.readProtectedPaths)
      : undefined)
    ?? (requestedProjectRelative ? matchesProtectedPath(requestedProjectRelative, access.readProtectedPaths) : undefined);
  if (protectedMatch) return { status: "error", reason: `matches protected path ${protectedMatch}` };

  if (
    root.source === "project"
    && access.enforceFilesystemRead
    && access.filesystemRead
    && !matchesAnyPath(rootRelative, access.filesystemRead)
  ) {
    return {
      status: "error",
      reason: `outside the resolved filesystem read scope (${access.filesystemRead.join(", ")})`
    };
  }

  access.onImageInspected?.(canonicalPath);
  const openFlags = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
  let fd: number;
  try {
    fd = fs.openSync(canonicalPath, openFlags);
  } catch {
    return { status: "error", reason: "file changed before it could be opened" };
  }
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile()
      || opened.dev !== inspected.dev
      || opened.ino !== inspected.ino
      || opened.size !== inspected.size
    ) {
      return { status: "error", reason: "file changed between the safety checks and the read" };
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    if (offset !== bytes.length) return { status: "error", reason: "file changed while it was being read" };
    const mimeType = supportedChatImageMimeType(bytes);
    if (!mimeType) return { status: "error", reason: "file bytes are not a supported image" };
    return { status: "ok", absolutePath: canonicalPath, bytes, mimeType };
  } finally {
    fs.closeSync(fd);
  }
}

export function attachLocalImagesFromText(
  text: string,
  existingImages: unknown[] | undefined,
  cwd: string,
  resolveAccess: () => ChatImageAccessPolicy
): ChatImageAttachmentResult | undefined {
  const imagePaths = extractLocalImagePathCandidates(text, cwd);
  if (imagePaths.length === 0) return undefined;
  const access = resolveAccess();

  const existing = Array.isArray(existingImages) ? existingImages : [];
  const images: ChatImageAttachmentResult["images"] = [];
  const attached: ChatImageAttachmentResult["attached"] = [];
  const skipped: ChatImageAttachmentResult["skipped"] = [];
  let nextText = text;

  for (const imagePath of imagePaths) {
    if (images.length + existing.length >= MAX_CHAT_IMAGE_ATTACHMENTS) {
      skipped.push({ path: imagePath, reason: `attachment limit ${MAX_CHAT_IMAGE_ATTACHMENTS} reached` });
      continue;
    }
    try {
      const resolved = readChatImage(imagePath, cwd, access);
      if (resolved.status === "error") {
        skipped.push({ path: imagePath, reason: resolved.reason });
        continue;
      }
      const marker = `[image${existing.length + images.length + 1}]`;
      images.push({ type: "image", mimeType: resolved.mimeType, data: resolved.bytes.toString("base64") });
      attached.push({ marker, path: imagePath, mimeType: resolved.mimeType, bytes: resolved.bytes.length });
      nextText = nextText.replace(new RegExp(escapeRegExp(imagePath), "g"), marker);
      nextText = nextText.replace(new RegExp(escapeRegExp(`file://${imagePath}`), "g"), marker);
    } catch (error) {
      skipped.push({ path: imagePath, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  if (attached.length === 0) {
    return skipped.length > 0 ? { text, images: [], attached, skipped } : undefined;
  }

  const attachmentLines = attached.map((item) => `- ${item.marker}: ${path.basename(item.path)} (${item.mimeType}, ${formatCount(item.bytes)} bytes)`);
  const skippedLines = skipped.map((item) => `- skipped ${path.basename(item.path)}: ${item.reason}`);
  nextText = [
    nextText.trim(),
    "",
    "Attached local image(s):",
    ...attachmentLines,
    ...(skippedLines.length > 0 ? ["", "Skipped local image path(s):", ...skippedLines] : [])
  ].join("\n").trim();

  return { text: nextText, images, attached, skipped };
}

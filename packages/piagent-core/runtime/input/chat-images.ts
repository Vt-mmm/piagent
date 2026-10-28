import fs from "node:fs";
import os from "node:os";
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

export type ChatPathAccess =
  | { status: "ok"; canonicalPath: string; stats: fs.Stats }
  | { status: "error"; reason: string };

// Pi saves a pasted clipboard image as <tmpdir>/pi-clipboard-<uuid>.<ext> and
// inserts that path into the prompt. The operator created it by pasting, so it
// counts as granted even though the temporary directory is not.
const PI_CLIPBOARD_IMAGE = /^pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp|bmp)$/i;

function clipboardImageRoot(canonicalPath: string): { path: string; source: string } | undefined {
  if (!PI_CLIPBOARD_IMAGE.test(path.basename(canonicalPath))) return undefined;
  try {
    const temporary = fs.realpathSync.native(os.tmpdir());
    return path.dirname(canonicalPath) === temporary ? { path: temporary, source: "clipboard" } : undefined;
  } catch {
    return undefined;
  }
}

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

// On Windows a path may also start with a drive (C:\) and use backslashes.
const WINDOWS = process.platform === "win32";
const HOME_PREFIX = WINDOWS ? /^~[\\/]/ : /^~\//;
const RELATIVE_PREFIX = WINDOWS ? /^\.\.?[\\/]/ : /^\.\.?\//;

function normalizeImagePathCandidate(candidate: string, cwd: string, options: { allowBareRelative?: boolean } = {}): string | undefined {
  let raw = candidate.trim().replace(/^['"`<]+|['"`>,.;:!?]+$/g, "");
  if (!raw) return undefined;
  const allowBareRelative = options.allowBareRelative !== false;
  const hasExplicitPathPrefix = raw.startsWith("file://") || HOME_PREFIX.test(raw) || path.isAbsolute(raw) || RELATIVE_PREFIX.test(raw);
  if (!allowBareRelative && !hasExplicitPathPrefix) return undefined;
  try {
    if (raw.startsWith("file://")) raw = fileURLToPath(raw);
  } catch {
    return undefined;
  }
  if (HOME_PREFIX.test(raw)) {
    const home = process.env.HOME || (WINDOWS ? os.homedir() : undefined);
    if (!home) return undefined;
    raw = path.join(home, raw.slice(2));
  }
  const ext = path.extname(raw).toLowerCase().replace(/^\./, "");
  if (!IMAGE_EXTENSIONS.includes(ext as typeof IMAGE_EXTENSIONS[number])) return undefined;
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  // A file dropped on a terminal arrives shell-escaped: "Screenshot\ 1.png".
  if (!WINDOWS && /\\[ ()'&]/.test(resolved) && !fs.existsSync(resolved)) {
    const unescaped = resolved.replace(/\\([ ()'&])/g, "$1");
    if (fs.existsSync(unescaped)) return unescaped;
  }
  return resolved;
}

// Pi's own @file arguments arrive as <file name="..."> blocks with their images
// already attached; scanning them again would attach each image twice.
const FILE_ARGUMENT_TAG = /<file name="[^"\n]*">/g;

export function extractLocalImagePathCandidates(input: string, cwd: string): string[] {
  const text = input.replace(FILE_ARGUMENT_TAG, "");
  const candidates = new Set<string>();
  const imageExt = "(?:png|jpe?g|gif|webp|bmp)";

  // Pi's @ completion inserts @path, or @"path" when the path has spaces.
  const mention = new RegExp(`(?:^|\\s)@(?:"([^"\\n]+\\.${imageExt})"|([^\\s"'<>@]+\\.${imageExt}))(?=$|[\\s,;:!?)])`, "gi");
  for (const match of text.matchAll(mention)) {
    const normalized = normalizeImagePathCandidate(match[1] ?? match[2], cwd);
    if (normalized) candidates.add(normalized);
  }

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

  const start = WINDOWS ? "(?:/|[A-Za-z]:[\\\\/]|~[\\\\/]|\\.\\.?[\\\\/])" : "(?:/|~\\/|\\.\\.?/)";
  const linePathPattern = '\\s(' + start + '[^\\n\\r"\\\'<>]*?\\.' + imageExt + ')(?=$|\\s|["\\\'`)>])';
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

/** Whether the operator's policy lets a chat message carry this file at all. */
export function checkChatPathAccess(
  requestedPath: string,
  cwd: string,
  access: ChatImageAccessPolicy
): ChatPathAccess {
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

  const root = access.roots.find((candidate) => pathContainedBy(candidate.path, canonicalPath))
    ?? clipboardImageRoot(canonicalPath);
  if (!root) {
    return {
      status: "error",
      reason: "outside the project; grant its folder with profile additionalReadRoots or PIAGENT_ADDITIONAL_READ_ROOTS"
    };
  }

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
  return { status: "ok", canonicalPath, stats: inspected };
}

export function readChatImage(
  requestedPath: string,
  cwd: string,
  access: ChatImageAccessPolicy
): ResolvedChatImage {
  const checked = checkChatPathAccess(requestedPath, cwd, access);
  if (checked.status === "error") return checked;
  const { canonicalPath, stats: inspected } = checked;
  if (inspected.size <= 0) return { status: "error", reason: "empty file" };
  if (inspected.size > MAX_CHAT_IMAGE_BYTES) {
    return {
      status: "error",
      reason: `image is ${formatCount(inspected.size)} bytes > ${formatCount(MAX_CHAT_IMAGE_BYTES)} byte limit`
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

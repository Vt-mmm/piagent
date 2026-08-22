import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchesProtectedPath } from "../../extensions/policy-core.js";

function normalizeRelative(cwd: string, candidate: unknown): string | undefined {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return undefined;
  let raw = candidate.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    if (!raw.toLowerCase().startsWith("file://")) return undefined;
    try {
      raw = fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  return path.relative(cwd, absolute).split(path.sep).join("/");
}

function filterTextBlocks(
  content: unknown,
  blocked: (line: string) => boolean,
  emptyText: string,
  noticeText: (count: number) => string
): { changed: boolean; content?: unknown; redactedLines: number } {
  if (!Array.isArray(content)) return { changed: false, redactedLines: 0 };
  let changed = false;
  let redactedLines = 0;
  const filtered = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    const text = (block as { type?: unknown; text?: unknown }).text;
    if ((block as { type?: unknown }).type !== "text" || typeof text !== "string") return block;
    const kept: string[] = [];
    let blockRedactedLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (blocked(line)) {
        changed = true;
        redactedLines += 1;
        blockRedactedLines += 1;
      } else {
        kept.push(line);
      }
    }
    if (blockRedactedLines === 0) return block;
    const notice = noticeText(blockRedactedLines);
    const nextText = kept.join("\n").trim().length > 0
      ? `${kept.join("\n")}\n${notice}`
      : `${emptyText}\n${notice}`;
    return { ...block, text: nextText };
  });
  return { changed, content: filtered, redactedLines };
}

export function filterGrepProtectedContent(content: unknown, protectedPatterns: string[]) {
  return filterTextBlocks(
    content,
    (line) => {
      const linePath = line.match(/^(.+?)(?::\d+:|-\d+-)/)?.[1];
      return Boolean(linePath && matchesProtectedPath(linePath, protectedPatterns));
    },
    "No matches found in non-protected paths.",
    (count) => `[Piagent Pi guard redacted ${count} protected grep line${count === 1 ? "" : "s"}.]`
  );
}

export function filterProtectedPathListContent(
  cwd: string,
  content: unknown,
  protectedPatterns: string[],
  basePath: string,
  toolName: string
) {
  return filterTextBlocks(
    content,
    (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("No ") || trimmed === "(empty directory)") return false;
      const entry = trimmed.replace(/[\\/]+$/, "");
      const candidates = new Set<string>();
      const direct = normalizeRelative(cwd, entry);
      const underBase = normalizeRelative(cwd, path.posix.join(basePath || ".", entry));
      if (direct !== undefined) candidates.add(direct);
      if (underBase !== undefined) candidates.add(underBase);
      return [...candidates].some((candidate) => matchesProtectedPath(candidate, protectedPatterns));
    },
    "No entries found in non-protected paths.",
    (count) => `[Piagent Pi guard redacted ${count} protected ${toolName} line${count === 1 ? "" : "s"}.]`
  );
}

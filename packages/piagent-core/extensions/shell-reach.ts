// What a shell command can reach, and how to say so.
//
// These checks used to live inside the guard entrypoint, which imports the Pi
// host runtime and therefore cannot be loaded anywhere else. `piagent explain`
// needs the same answers the guard gives, and a second implementation of "does
// this command reach a protected path" is exactly the defect this project keeps
// closing: one segment, many readers, each with its own view. So the readers
// live here and both the guard and the CLI take this one.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractShellGlobCandidates,
  extractShellPathCandidates,
  matchesProtectedPath,
  normalizePathCandidate
} from "./policy-core.js";

export function normalizeRelative(cwd: string, candidate: unknown): string | undefined {
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

export function resolveRepositoryPathCandidate(cwd: string, candidate: string): string | undefined {
  const normalized = normalizePathCandidate(candidate);
  if (normalized === ".." || normalized.startsWith("../")) return undefined;

  const relative = path.posix.isAbsolute(normalized)
    ? path.relative(cwd, normalized).split(path.sep).join("/")
    : normalized;
  if (relative === ".." || relative.startsWith("../")) return undefined;

  const pending = relative.split("/").filter((item) => item && item !== ".");
  let current = cwd;
  let resolvedDepth = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const next = path.join(current, pending[index]);
    try {
      fs.lstatSync(next);
      current = next;
      resolvedDepth = index + 1;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (code !== "ENOENT") return undefined;
      break;
    }
  }

  let canonicalBase: string;
  try {
    canonicalBase = fs.realpathSync.native(current);
  } catch {
    return undefined;
  }
  const canonical = path.resolve(canonicalBase, ...pending.slice(resolvedDepth));
  const canonicalRoot = fs.realpathSync.native(cwd);
  const canonicalRelative = path.relative(canonicalRoot, canonical).split(path.sep).join("/");
  if (canonicalRelative === ".." || canonicalRelative.startsWith("../") || path.isAbsolute(canonicalRelative)) return undefined;
  return canonicalRelative || ".";
}

export function findResolvedProtectedPathInCommand(
  cwd: string,
  command: string,
  protectedPatterns: string[]
): { candidate: string; resolved: string; pattern: string } | undefined {
  for (const candidate of extractShellPathCandidates(command)) {
    const relative = normalizeRelative(cwd, candidate);
    if (!relative) continue;
    const resolved = resolveRepositoryPathCandidate(cwd, relative);
    if (!resolved || resolved === relative) continue;
    const pattern = matchesProtectedPath(resolved, protectedPatterns);
    if (pattern) return { candidate, resolved, pattern };
  }
  return undefined;
}

export function expandSimpleGlobAlternatives(pattern: string, max = 24): { values: string[]; complete: boolean } {
  let results = [pattern];
  let changed = true;
  let complete = true;

  while (changed) {
    changed = false;
    const expanded: string[] = [];
    for (const item of results) {
      const match = item.match(/\{([^{}]+)\}/);
      if (!match) {
        expanded.push(item);
        continue;
      }
      changed = true;
      const options = match[1].split(",").map((option) => option.trim());
      for (const option of options) {
        expanded.push(`${item.slice(0, match.index)}${option}${item.slice((match.index ?? 0) + match[0].length)}`);
        if (expanded.length >= max) {
          complete = false;
          break;
        }
      }
      if (expanded.length >= max) break;
    }
    results = expanded.slice(0, max);
  }

  return { values: results, complete };
}

export function shellGlobSegmentMatches(patternSegment: string, candidateSegment: string): boolean {
  if (candidateSegment.startsWith(".") && !patternSegment.startsWith(".")) return false;
  let source = "";
  for (let index = 0; index < patternSegment.length; index += 1) {
    const char = patternSegment[index];
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "[") {
      const end = patternSegment.indexOf("]", index + 1);
      const body = end > index + 1 ? patternSegment.slice(index + 1, end) : "";
      if (body && /^[!^A-Za-z0-9_-]+$/.test(body)) {
        const negated = body.startsWith("!") ? `^${body.slice(1)}` : body;
        source += `[${negated}]`;
        index = end;
        continue;
      }
    }
    source += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i").test(candidateSegment);
}

export function shellGlobMatchesPath(pattern: string, candidate: string): boolean {
  const patternSegments = normalizePathCandidate(pattern).split("/").filter(Boolean);
  const candidateSegments = normalizePathCandidate(candidate).split("/").filter(Boolean);

  function match(patternIndex: number, candidateIndex: number): boolean {
    if (patternIndex === patternSegments.length) return candidateIndex === candidateSegments.length;
    const patternSegment = patternSegments[patternIndex];
    if (patternSegment === "**") {
      if (match(patternIndex + 1, candidateIndex)) return true;
      for (let next = candidateIndex; next < candidateSegments.length; next += 1) {
        if (match(patternIndex + 1, next + 1)) return true;
      }
      return false;
    }
    if (candidateIndex >= candidateSegments.length) return false;
    return shellGlobSegmentMatches(patternSegment, candidateSegments[candidateIndex])
      && match(patternIndex + 1, candidateIndex + 1);
  }

  return patternSegments.length > 0 && candidateSegments.length > 0 && match(0, 0);
}

export function protectedPatternExamples(pattern: string): string[] {
  const normalized = normalizePathCandidate(pattern);
  if (!normalized) return [];

  const examples = new Set<string>();
  const add = (value: string | undefined) => {
    const normalizedValue = normalizePathCandidate(value ?? "");
    if (normalizedValue) examples.add(normalizedValue);
  };

  add(normalized);

  if (normalized.endsWith("/**")) {
    const base = normalized.slice(0, -3);
    add(base);
    add(`${base}/probe`);
  }

  if (normalized.startsWith("**/")) {
    const tail = normalized.slice(3);
    const concreteTail = tail
      .replace(/\*\*/g, "nested")
      .replace(/\*/g, tail.includes(".env.") ? "local" : "probe");
    add(tail);
    add(concreteTail);
    add(`nested/${concreteTail}`);
  }

  const concrete = normalized
    .replace(/^\*\*\//, "")
    .replace(/\/\*\*$/, "/probe")
    .replace(/\*\*/g, "nested")
    .replace(/\*/g, normalized.includes(".env.") ? "local" : "probe");
  add(concrete);

  for (const example of [...examples]) {
    const base = path.posix.basename(example);
    if (base && base !== "probe") examples.add(base);
  }

  return [...examples];
}

export function shellGlobTargetsProtectedPath(
  command: string,
  protectedPatterns: string[]
): { glob: string; pattern: string; example: string } | undefined {
  for (const candidate of extractShellGlobCandidates(command)) {
    if (!/[*?{\[]/.test(candidate)) continue;
    const expanded = expandSimpleGlobAlternatives(candidate);
    if (!expanded.complete) return { glob: candidate, pattern: "bounded glob expansion", example: "a protected path" };
    for (const candidateGlob of expanded.values) {
      for (const pattern of protectedPatterns) {
        for (const example of protectedPatternExamples(pattern)) {
          if (/[*?{\[\]]/.test(example)) continue;
          if (
            shellGlobMatchesPath(candidateGlob, example)
            || shellGlobMatchesPath(`**/${candidateGlob}`, example)
            || shellGlobMatchesPath(candidateGlob, path.posix.basename(example))
          ) {
            return { glob: candidate, pattern, example };
          }
        }
      }
    }
  }
  return undefined;
}

export function unresolvedExpansionReason(subject: string, words: string[]): string {
  const listed = words.map((word) => `\`${word}\``).join(", ");
  return `${subject} builds a filename this guard cannot resolve: ${listed}. `
    + "The literal text around the expansion makes it a path, but its value is only known at run time, "
    + "so it cannot be checked against the protected paths. Write the path out, or put the expansion in its own argument.";
}

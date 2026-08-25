import path from "node:path";

function normalizeRelative(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function safeProjectRelativeQueryPath(raw) {
  const candidate = normalizeRelative(raw);
  if (!candidate || candidate.length > 512 || path.posix.isAbsolute(candidate)) return undefined;
  if (candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return candidate;
}

function safeGlobSegment(segment) {
  let bracketDepth = 0;
  let braceDepth = 0;
  for (const character of segment) {
    if (character === "[") {
      if (++bracketDepth > 1) return false;
    } else if (character === "]") {
      if (--bracketDepth < 0) return false;
    } else if (character === "{") {
      if (++braceDepth > 1) return false;
    } else if (character === "}") {
      if (--braceDepth < 0) return false;
    } else if ((character === "," && braceDepth === 0) || (character === "!" && bracketDepth === 0)) {
      return false;
    }
  }
  return bracketDepth === 0 && braceDepth === 0;
}

function safeProjectRelativeGlob(raw) {
  const candidate = safeProjectRelativeQueryPath(String(raw ?? "").replace(/[.,]+$/u, ""));
  if (!candidate || !candidate.includes("/") || !/[*?\[\]{}]/u.test(candidate)) return undefined;
  if (!/^[\p{L}\p{N}_.@*?{}\[\]!,-]+(?:\/[\p{L}\p{N}_.@*?{}\[\]!,-]+)+$/u.test(candidate)) return undefined;
  return candidate.split("/").every(safeGlobSegment) ? candidate : undefined;
}

export function queryPathCandidates(query) {
  const pattern = /(?:^|[\s"'`(])((?:\.{0,2}\/)?[\p{L}\p{N}_.@-]+(?:\/[\p{L}\p{N}_.@-]+)+|[\p{L}\p{N}_.@-]+\.[\p{L}\p{N}]{1,8}|\.[\p{L}\p{N}_@-]{1,32})(?=$|[\s"'`),:])/gu;
  const globPattern = /(?:^|[\s"'(\x60=,:])((?:\.\/)?[\p{L}\p{N}_.@*?{}\[\]!,-]+(?:\/[\p{L}\p{N}_.@*?{}\[\]!,-]+)+)(?=$|[\s"'\x60),:;])/gu;
  const explicitRoots = /^(?:\.github|app|apps|backend|bin|config|docs|examples|frontend|lib|logs|packages|pages|public|scripts|services|spec|src|test|tests|vendor|__tests__)\//i;
  const text = String(query ?? "");
  const candidates = [...text.matchAll(pattern)].flatMap((match) => {
    const raw = match[1], candidate = safeProjectRelativeQueryPath(raw);
    const explicit = candidate && (raw.startsWith("./") || explicitRoots.test(candidate)
      || candidate.split("/").length >= 3 || /(?:^|\/)(?:\.[^/]+|[^/]+\.[\p{L}\p{N}]{1,8})$/u.test(candidate));
    return explicit ? [{ candidate, index: match.index ?? 0 }] : [];
  });
  for (const match of text.matchAll(globPattern)) {
    const candidate = safeProjectRelativeGlob(match[1]);
    if (candidate) candidates.push({ candidate, index: match.index ?? 0 });
  }
  candidates.sort((left, right) => left.index - right.index);
  return [...new Set(candidates.map((entry) => entry.candidate))];
}

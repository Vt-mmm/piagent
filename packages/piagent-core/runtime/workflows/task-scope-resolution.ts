import { matchesAnyPath, normalizePathCandidate } from "../../extensions/policy-core.js";

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export type TaskScopeResolution = {
  scope: string[];
  mappings: Array<{ from: string; to: string }>;
  ambiguous: Array<{ input: string; candidates: string[] }>;
  unmatched: string[];
};

const STANDARD_SCOPE_ROOT = /^(?:\.github|app|apps|bin|config|docs|examples|lib|logs|packages|pages|plans|public|scripts|services|spec|src|test|tests|vendor|__tests__)(?:\/|$)/i;

function wildcardPrefix(value: string): string {
  const index = value.search(/[*?{}\[\]]/);
  return (index < 0 ? value : value.slice(0, index)).replace(/\/+$/, "");
}

function nestedDirectoryMatches(prefix: string, projectFiles: string[]): string[] {
  if (!prefix) return [];
  const segments = prefix.split("/").filter(Boolean);
  const matches = new Set<string>();
  for (const file of projectFiles) {
    const parts = normalizePathCandidate(file).split("/");
    for (let index = 0; index <= parts.length - 1 - segments.length; index += 1) {
      if (segments.every((segment, offset) => parts[index + offset] === segment)) {
        matches.add(parts.slice(0, index + segments.length).join("/"));
      }
    }
  }
  return [...matches].sort();
}

export function resolveTaskScopePatterns(scope: string[], projectFiles: string[]): TaskScopeResolution {
  const files = uniqueStrings(projectFiles.map(normalizePathCandidate).filter(Boolean));
  const resolved: string[] = [];
  const mappings: Array<{ from: string; to: string }> = [];
  const ambiguous: Array<{ input: string; candidates: string[] }> = [];
  const unmatched: string[] = [];
  for (const raw of scope) {
    const candidate = normalizePathCandidate(raw);
    if (!candidate) continue;
    if (files.includes(candidate) || files.some((file) => matchesAnyPath(file, [candidate]))) {
      resolved.push(candidate);
      continue;
    }
    const hasWildcard = /[*?{}\[\]]/.test(candidate);
    if (hasWildcard) {
      const prefix = wildcardPrefix(candidate);
      const directories = nestedDirectoryMatches(prefix, files);
      if (directories.length === 1) {
        const suffix = candidate.slice(prefix.length).replace(/^\/+/, "");
        const canonical = suffix ? `${directories[0]}/${suffix}` : directories[0];
        resolved.push(canonical);
        mappings.push({ from: candidate, to: canonical });
      } else if (directories.length > 1 && prefix && !STANDARD_SCOPE_ROOT.test(prefix)) {
        ambiguous.push({ input: candidate, candidates: directories.slice(0, 12).map((directory) => {
          const suffix = candidate.slice(prefix.length).replace(/^\/+/, "");
          return suffix ? `${directory}/${suffix}` : directory;
        }) });
      } else if (directories.length === 0 && prefix && !prefix.includes("/") && !STANDARD_SCOPE_ROOT.test(prefix) && !raw.startsWith("./")) {
        unmatched.push(candidate);
      } else {
        resolved.push(candidate);
      }
      continue;
    }
    const suffixMatches = files.filter((file) => file === candidate || file.endsWith(`/${candidate}`));
    if (suffixMatches.length === 1) {
      resolved.push(suffixMatches[0]);
      mappings.push({ from: candidate, to: suffixMatches[0] });
    } else if (suffixMatches.length > 1) {
      ambiguous.push({ input: candidate, candidates: suffixMatches.slice(0, 12) });
    } else if (!candidate.includes("/") && !raw.startsWith("./")) {
      unmatched.push(candidate);
    } else {
      resolved.push(candidate);
    }
  }
  return { scope: uniqueStrings(resolved), mappings, ambiguous, unmatched: uniqueStrings(unmatched) };
}

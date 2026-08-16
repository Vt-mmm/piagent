import fs from "node:fs";
import path from "node:path";

type ExtensionLoadResult = {
  extensions: Array<{ path: string; resolvedPath: string }>;
  errors: Array<{ path: string; error: string }>;
  runtime: unknown;
};

const PIAGENT_GUARD_SUFFIX = path.join("packages", "piagent-core", "extensions", "piagent-guard.ts");

function canonicalExtensionPath(value: string): string {
  try { return fs.realpathSync.native(value); }
  catch { return path.resolve(value); }
}

function isPiagentGuardPath(value: string): boolean {
  const normalized = path.normalize(value);
  return normalized === PIAGENT_GUARD_SUFFIX || normalized.endsWith(`${path.sep}${PIAGENT_GUARD_SUFFIX}`);
}

export function preferAuthoritativePiagentGuard(
  guardPath: string
): (base: ExtensionLoadResult) => ExtensionLoadResult {
  const authoritative = canonicalExtensionPath(guardPath);
  const authorityAliases = [guardPath, path.resolve(guardPath), authoritative].map((value) => path.normalize(value));
  return (base) => {
    const loadedAuthoritative = base.extensions.some((extension) =>
      canonicalExtensionPath(extension.resolvedPath || extension.path) === authoritative);
    if (!loadedAuthoritative) return base;
    const removed = new Set<string>();
    const extensions = base.extensions.filter((extension) => {
      const resolved = canonicalExtensionPath(extension.resolvedPath || extension.path);
      const duplicate = resolved !== authoritative && isPiagentGuardPath(resolved);
      if (duplicate) removed.add(resolved);
      return !duplicate;
    });
    if (removed.size === 0) return base;
    const errors = base.errors.filter((diagnostic) => {
      const diagnosticPath = canonicalExtensionPath(diagnostic.path);
      return !(removed.has(diagnosticPath)
        && diagnostic.error.includes("conflicts with")
        && authorityAliases.some((value) => diagnostic.error.includes(value)));
    });
    return { ...base, extensions, errors };
  };
}

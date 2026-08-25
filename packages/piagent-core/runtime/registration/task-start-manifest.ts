type RepositoryManifestCompatibilityReason = "missing-details-provider" | "nonfunction-details-provider" | "invalid-details-result";

type TaskStartRepositoryManifest = {
  files: string[];
  complete: boolean;
  candidateCount: number;
  provider: "details" | "legacy-array-fallback";
  compatibilityReason?: RepositoryManifestCompatibilityReason;
};

function normalizedManifestFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

/**
 * Keep rolling upgrades safe when a long-lived host has the legacy extension
 * entrypoint cached but imports a newer task-start registration module. The
 * legacy array provider cannot prove whether its result was truncated, so the
 * compatibility path deliberately reports `complete: false` and records the
 * provider/reason in the durable task trace.
 */
export function resolveTaskStartRepositoryManifestProvider(deps: Record<string, any>): {
  read(cwd: string, maxFiles?: number): TaskStartRepositoryManifest;
} {
  const legacyProvider = deps.repositoryFileManifest;
  if (typeof legacyProvider !== "function") {
    throw new TypeError("Piagent task-start registration requires repositoryFileManifest to be a function.");
  }
  const detailsProvider = deps.repositoryFileManifestDetails;
  const compatibilityReason: RepositoryManifestCompatibilityReason | undefined = detailsProvider === undefined
    ? "missing-details-provider"
    : typeof detailsProvider !== "function"
      ? "nonfunction-details-provider"
      : undefined;
  const legacyManifest = (cwd: string, maxFiles?: number,
    reason: RepositoryManifestCompatibilityReason = compatibilityReason ?? "invalid-details-result"): TaskStartRepositoryManifest => {
    const files = normalizedManifestFiles(legacyProvider(cwd, maxFiles));
    return { files, complete: false, candidateCount: files.length, provider: "legacy-array-fallback", compatibilityReason: reason };
  };
  if (compatibilityReason) return { read: legacyManifest };
  return {
    read(cwd: string, maxFiles?: number): TaskStartRepositoryManifest {
      const details = detailsProvider(cwd, maxFiles);
      if (!details || typeof details !== "object" || !Array.isArray(details.files)) {
        return legacyManifest(cwd, maxFiles, "invalid-details-result");
      }
      const files = normalizedManifestFiles(details.files);
      return { files, complete: details.complete === true,
        candidateCount: Number.isInteger(details.candidateCount) ? Math.max(files.length, details.candidateCount) : files.length,
        provider: "details" };
    }
  };
}

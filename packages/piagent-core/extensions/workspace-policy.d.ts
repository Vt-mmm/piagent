export function effectiveProtectedPaths(policy?: Record<string, unknown>, profile?: Record<string, unknown>): {
  readProtectedPaths: string[]; writeProtectedPaths: string[]; shellProtectedPaths: string[]; readOnlyPaths: string[];
};
export function matchesProtectedPath(candidate: string, patterns: string[]): string | undefined;
export function loadProjectContextIndexPolicy(platformRoot: string, projectPath: string, options?: { profilePath?: string }): {
  policy: Record<string, unknown>; profile: Record<string, unknown>; profilePath: string; profileSource: string; excludePatterns: string[];
};

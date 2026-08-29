import { summarizeSession, walkJsonl } from "./pi-usage-history.mjs";

export function inspectBenchmarkSessionDirectory(sessionDir) {
  const summaries = [];
  const diagnostics = [];
  for (const file of walkJsonl(sessionDir)) {
    try {
      const summary = summarizeSession(file, { strictUsage: true });
      if (summary) summaries.push(summary);
    } catch (error) {
      // A provider request may already have spent tokens before its session
      // record becomes malformed or partial. Preserve readable additive
      // buckets as a lower bound instead of replacing the attempt with zero.
      diagnostics.push(error instanceof Error ? error.message : String(error));
      try {
        const partial = summarizeSession(file, { strictUsage: false });
        if (partial) {
          partial.usageIntegrity.exact = false;
          partial.usageIntegrity.recoveredAfterStrictFailure = true;
          summaries.push(partial);
        }
      } catch (recoveryError) {
        diagnostics.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError));
      }
    }
  }
  return { summaries, diagnostics };
}

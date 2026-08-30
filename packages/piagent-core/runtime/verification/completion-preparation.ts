/** A lifecycle fence, not acceptance authority. The completion gate still runs. */
export type CompletionPreparation = Readonly<{ isCurrent: () => boolean }>;

export function completionPreparationCurrent(value: CompletionPreparation | boolean | void): boolean {
  if (value === undefined || value === true) return true;
  try {
    return value !== null && typeof value === "object" && typeof value.isCurrent === "function" && value.isCurrent() === true;
  } catch {
    // A disposed host context may throw instead of returning a stale identity.
    return false;
  }
}

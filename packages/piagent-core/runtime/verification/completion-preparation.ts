/** A lifecycle fence, not acceptance authority. The completion gate still runs. */
export type CompletionPreparation = Readonly<{
  isCurrent: () => boolean;
  completion?: "ready" | "deferred";
  reason?: string;
}>;

export function completionPreparationDeferred(value: CompletionPreparation | boolean | void): boolean {
  try { return value !== null && typeof value === "object" && value.completion === "deferred" && value.isCurrent() === true; }
  catch { return false; }
}

export function completionPreparationCurrent(value: CompletionPreparation | boolean | void): boolean {
  if (value === undefined || value === true) return true;
  try {
    return value !== null && typeof value === "object" && value.completion !== "deferred"
      && typeof value.isCurrent === "function" && value.isCurrent() === true;
  } catch {
    // A disposed host context may throw instead of returning a stale identity.
    return false;
  }
}

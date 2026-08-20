function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Derive bounded, auditable proof obligations for stateful boundary contracts.
 *
 * The signals come only from the operator request. They intentionally describe
 * reusable test partitions instead of benchmark identities or expected code.
 */
export function acceptanceBoundaryProofGuidance(raw) {
  const value = normalizedText(raw);
  const guidance = [];
  const replayContract = /\b(?:replay(?:ed|s)?|idempot(?:ent|ency))\b/.test(value);

  if (
    /\b(?:safe[-\s]+integer|number\.max_safe_integer|number\.issafeinteger)\b/.test(value)
    && /\b(?:advance|bump|cursor|decrement|increment|next|revision|successor)\b|(?:\+|-)\s*1\b/.test(value)
  ) {
    guidance.push("For safe-integer state transitions, exercise Number.MAX_SAFE_INTEGER and validate the computed next value before storing it; validating only the pre-transition input is insufficient.");
  }

  if (/\bfirst[-\s]+(?:observed|seen|encountered)[-\s]+order\b|\border\s+(?:first\s+)?(?:observed|seen|encountered)\b/.test(value)) {
    guidance.push("Prove first-observed ordering with interleaved identities A, B, B, A; deduplication or replay detection must not reorder output by later duplicate positions.");
  }

  if (
    replayContract
    && /\b(?:conflict|different\s+content|different\s+command|identity|reuse|same\s+id|same\s+key|same-key)\b/.test(value)
  ) {
    guidance.push("Exercise fresh input, exact replay, and reuse of the same identity with different content as separate partitions; replay acceptance must not hide an identity conflict.");
  }

  if (
    replayContract
    && /\b(?:before\s+(?:the\s+)?revision|prior\s+idempotency\s+receipt|stale\s+(?:expected\s+)?revision)\b/.test(value)
  ) {
    guidance.push("When replay precedes revision matching, use a stale revision and prove the revision check does not reject an otherwise exact replay.");
  }

  if (replayContract && /\b(?:identical|same|exact)[-\s]+state[-\s]+object\b/.test(value)) {
    guidance.push("Where replay promises state identity, assert the returned state is the exact prior object and that its stored revision remains unchanged.");
  }

  if (/\b(?:non[- ]whitespace|whitespace[- ]only|trim(?:med|ming)?)\b/.test(value)) {
    guidance.push("Treat empty and whitespace-only strings as separate invalid partitions whenever the contract trims or requires a non-whitespace character.");
  }

  if (
    /\b(?:backpressure|budget|capacity|maxchars)\b/.test(value)
    && /\b(?:atomic(?:ally)?|equal(?:ity)?|exceed|remainder|unchanged)\b/.test(value)
  ) {
    guidance.push("Exercise capacity one below, at exact equality, and one above; the rejected item must leave coupled state unchanged and remain buffered when required.");
  }

  return uniqueStrings(guidance).slice(0, 6);
}

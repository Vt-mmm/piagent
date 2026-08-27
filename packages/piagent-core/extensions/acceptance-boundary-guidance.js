function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function identifierFieldNames(raw) {
  const source = String(raw ?? "");
  const names = [];
  const identifierName = (value) => (
    /^id$/i.test(value)
    || /^[A-Za-z_$][A-Za-z0-9_$]*(?:Id|ID)$/.test(value)
    || /^[A-Za-z_$][A-Za-z0-9_$]*[_-]id$/i.test(value)
  ) ? value.toLowerCase() : undefined;
  for (const match of source.matchAll(/`([^`\r\n]{1,64})`/g)) {
    const preceding = source.slice(Math.max(0, (match.index ?? 0) - 80), match.index ?? 0);
    const following = source.slice((match.index ?? 0) + match[0].length);
    if (/\b(?:callable|function|method)(?:\s+(?:called|named))?\s*$/i.test(preceding)
      || /^\s*(?:callable|function|method)\b/i.test(following)
      || /^\s*(?:accepts?|applies?|builds?|calls?|creates?|deletes?|finds?|gets?|loads?|parses?|reads?|rejects?|removes?|replays?|resolves?|returns?|runs?|saves?|sets?|throws?|updates?|validates?|writes?)\b/i.test(following)) continue;
    const name = identifierName(match[1].trim());
    if (name) names.push(name);
  }
  for (const match of source.matchAll(/\b(?:field|key|property)\s+(?:named|called)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gi)) {
    const name = identifierName(match[1]);
    if (name) names.push(name);
  }
  for (const match of source.matchAll(/\b(?:has|contains|includes|requires|receives|with)\s+(?:an?\s+|the\s+|unique\s+)*([A-Za-z_$][A-Za-z0-9_$]*(?:Id|ID))\b/g)) {
    names.push(match[1].toLowerCase());
  }
  for (const match of source.matchAll(/(?:\.|\b)([A-Za-z_$][A-Za-z0-9_$]*(?:Id|ID))\s*:/g)) names.push(match[1].toLowerCase());
  return uniqueStrings(names);
}

function namesIdentifierField(raw) {
  return identifierFieldNames(raw).length > 0
    || /\bidentifier\s+(?:field|input|key|property|value)s?\b/i.test(String(raw ?? ""));
}

function contractClauses(raw) {
  const source = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n(?=[ \t]*(?:[-*+]|\d+[.)])[ \t]+)/g, "\u0000")
    .replace(/\n[ \t]*\n+/g, "\u0000")
    .replace(/\n+/g, " ")
    .replace(/\u0000/g, "\n");
  return source.split(/(?<=[.!?;])\s+|\n+/).map((clause) => clause.trim()).filter(Boolean);
}

function isExplicitRejectionClause(clause) {
  return /\b(?:invalid|malformed|reject(?:s|ed|ing|ion)?)\b/i.test(clause)
    || /\b(?:must|should|shall)\s+throw\s+(?:an?\s+)?TypeError\b/i.test(clause)
    || /\bthrow\s+(?:an?\s+)?TypeError\s+(?:for|on|when)\b/i.test(clause);
}

export function hasExplicitInputRejection(raw) {
  return contractClauses(raw).some(isExplicitRejectionClause);
}

function malformedShapeSubjects(clause) {
  const subjects = [];
  for (const match of normalizedText(clause).matchAll(/\b([a-z][a-z0-9_-]{1,40})\s+(?:objects?|records?|shapes?)\b/g)) {
    if (!["data", "input", "value", "values"].includes(match[1])) subjects.push(match[1]);
  }
  return uniqueStrings(subjects);
}

export function malformedIdentifierContractText(raw) {
  const clauses = contractClauses(raw);
  const declarations = clauses.filter(namesIdentifierField);
  if (declarations.length === 0) return "";
  const matched = [];
  for (const clause of clauses.filter(isExplicitRejectionClause)) {
    if (namesIdentifierField(clause)) {
      matched.push(clause);
      continue;
    }
    const subjects = malformedShapeSubjects(clause);
    const related = declarations.filter((declaration) => subjects.some((subject) => (
      new RegExp(`\\b${subject}\\b`, "i").test(declaration)
    )));
    if (related.length > 0) matched.push(...related, clause);
  }
  return uniqueStrings(matched).join("\n");
}

export function malformedIdentifierContract(raw) {
  return Boolean(malformedIdentifierContractText(raw));
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
  if (malformedIdentifierContract(raw)) {
    guidance.push("For malformed identifier input, exercise missing, wrong-type, and empty-string values separately; add whitespace-only when the contract requires non-whitespace.");
  }

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

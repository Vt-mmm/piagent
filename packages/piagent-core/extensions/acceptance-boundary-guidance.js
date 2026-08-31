import { explicitUndefinedTemporalContract } from "./acceptance-temporal-contract.js";

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function isoTimestampProofGuidance(raw) {
  if (!/\biso\b[^.\n]{0,80}\btimestamp\b|\btimestamp\b[^.\n]{0,80}\biso\b/.test(normalizedText(raw))) return [];
  return [
    "For ISO timestamps, prove valid shapes with and without fractional seconds and contract-supported omitted seconds; optional capturing groups shift later match indexes. Prove leap-day validity for years 0000 through 0099; Date.UTC(year, ...) remaps years 0 through 99.",
    "Test numeric UTC offsets of both signs, including a negative sub-hour offset, immediately before, at, and after the same instant. Preserve millisecond truncation for long fractional strings: converting the whole fraction to a floating-point number can round into the next second."
  ];
}

export function temporalProofReasonGuidance(reasons = []) {
  if (!reasons.some((reason) => ["typeerror-rejection-unproven", "rejection-message-effect-unproven"].includes(reason))) return [];
  return ["Check an invalid Date whose toString or Symbol.toPrimitive throws RangeError, in each argument position. Coercing invalid input while formatting a TypeError can throw the wrong class; repair only after reproducing the counterexample."];
}

export function rejectionClassProofGuidance(raw, errorName) {
  const coercion = /\bdates?\b/.test(normalizedText(raw))
    ? " Include invalid Date objects with throwing toString/Symbol.toPrimitive; formatting the error must not change its class." : "";
  return `Assert ${errorName} for every rejected partition named by the request; a different error class is not equivalent.${coercion}`;
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
  return source.split(/(?<=[.!?;])\s+|\n+/)
    .map((clause) => clause.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, ""))
    .filter(Boolean);
}

function isExplicitRejectionClause(clause) {
  if (/\bwithout\s+throwing\b|\b(?:do|must|shall|should)\s+not\s+throw\b|\bnever\s+throw\b/i.test(clause)) return false;
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

function taggedFieldList(raw) {
  const source = String(raw ?? "").trim().replace(/^(?:the\s+)?(?:required\s+)?fields?\s+/i, "");
  const fields = [...source.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`/g)].map((match) => match[1]);
  if (fields.length === 0 || fields.length > 6) return [];
  const shape = source.replace(/`[A-Za-z_$][A-Za-z0-9_$]*`/g, "@").replace(/\s+/g, " ").trim();
  return /^@(?:\s*,\s*@)*(?:\s*,?\s+and\s+@)?$/i.test(shape) ? uniqueStrings(fields) : [];
}

function unsupportedTaggedRequirement() {
  return [{ variant: "__unsupported_tagged_event_contract__", field: null, partitions: [] }];
}

function explicitTaggedEventRequirements(clauses) {
  const taggedClauses = clauses.filter((clause) => /\btagged[- ]event\s+variant\b/i.test(clause));
  if (taggedClauses.length === 0) return [];
  const declarations = [], optionals = [];
  let foreignConstraint = false, unsupportedDeclaration = false;
  for (const clause of taggedClauses) {
    const declaration = clause.match(/^(?:the\s+)?tagged[- ]event\s+variant\s+`([^`\r\n]{1,64})`\s+requires\s+(.+?)\s+to\s+be\s+(?:a\s+)?non-empty\s+strings?\.?$/i);
    if (declaration) {
      const fields = taggedFieldList(declaration[2]);
      if (fields.length === 0) unsupportedDeclaration = true;
      else declarations.push({ variant: declaration[1], fields });
      continue;
    }
    const optional = clause.match(/^for\s+(?:the\s+)?tagged[- ]event\s+variant\s+`([^`\r\n]{1,64})`,?\s+(?:its\s+|the\s+)?optional\s+(?:field\s+|override\s+)?`([A-Za-z_$][A-Za-z0-9_$]*)`(?:\s+(?:field|override))?,?\s+when\s+supplied,?\s+must\s+be\s+(?:a\s+)?non-empty\s+string\.?$/i);
    if (optional) optionals.push({ variant: optional[1], field: optional[2] });
    else if (/^(?:the\s+)?tagged[- ]event\s+variant\s+`[^`\r\n]{1,64}`\s+requires\b/i.test(clause)
      && !/\bnon-empty\s+strings?\b/i.test(clause)) foreignConstraint = true;
    else unsupportedDeclaration = true;
  }
  const unparsedEventConstraint = clauses.some((clause) => !taggedClauses.includes(clause)
    && !isExplicitRejectionClause(clause)
    && declarations.some((item) => clause.includes(`\`${item.variant}\``))
    && /\b(?:event|field|override|tagged|variant)\b/i.test(clause)
    && /\b(?:field|override|required|requires?|must)\b/i.test(clause));
  const productionSequencingClause = (clause) => /^validate\s+the\s+required\s+fields?\s+and\s+any\s+supplied\s+override\s+before\s+applying\s+duplicate\s+handling\.?$/i.test(clause)
    || /^for\s+a\s+non-duplicate\s+message\s+with\s+no\s+own\s+`[^`]+`\s+override,\s+`[^`]+`\s+must\s+be\s+a\s+non-empty\s+string\s+or\s+the\s+reducer\s+throws\s+`typeerror`\.?$/i.test(clause);
  const genericFieldConstraint = clauses.some((clause) => !taggedClauses.includes(clause)
    && !isExplicitRejectionClause(clause)
    && !productionSequencingClause(clause)
    && /\b(?:events?|tagged|variants?|fields?|overrides?|propert(?:y|ies))\b/i.test(clause)
    && /\b(?:must|shall|should|required|requires?|validation|validates?|validated|validating)\b/i.test(clause));
  const rejectionWithExtraConstraint = clauses.some((clause) => {
    if (!isExplicitRejectionClause(clause)) return false;
    const rejection = clause.search(/\b(?:malformed|reject(?:s|ed|ing|ion)?|throw(?:s|ing)?\s+(?:an?\s+)?typeerror)\b/i);
    const tail = rejection === -1 ? "" : clause.slice(rejection);
    return /\b(?:and|but|plus)\b[\s\S]*\b(?:events?|tagged|variants?|fields?|overrides?|propert(?:y|ies))\b/i.test(tail)
      && /\b(?:requires?|required|validation|validates?|validated|validating|must\s+(?!throw\b))\b/i.test(tail);
  });
  if (unparsedEventConstraint || genericFieldConstraint || rejectionWithExtraConstraint) unsupportedDeclaration = true;
  const variants = uniqueStrings(declarations.map((item) => item.variant));
  if (foreignConstraint) return declarations.length > 0 ? unsupportedTaggedRequirement() : [];
  if (unsupportedDeclaration) return unsupportedTaggedRequirement();
  if (variants.length < 2) return [];
  if (!clauses.some((clause) => isExplicitRejectionClause(clause)
    && /\b(?:tagged[- ]event|named\s+event\s+variants?)\b/i.test(clause))) return [];
  if (optionals.some((item) => !variants.includes(item.variant))) return unsupportedTaggedRequirement();
  const requirements = declarations.flatMap((item) => item.fields.map((field) => ({
    variant: item.variant, field, optional: false,
    partitions: ["missing", "non-string", "empty-string"]
  })));
  requirements.push(...optionals.map((item) => ({
    ...item, optional: true, partitions: ["non-string", "empty-string"]
  })));
  const keys = requirements.map((item) => `${item.variant}\u0000${item.field}`);
  const foldedKeys = requirements.map((item) => `${item.variant}\u0000${item.field.toLowerCase()}`);
  return requirements.length <= 16 && keys.length === new Set(keys).size && foldedKeys.length === new Set(foldedKeys).size
    ? requirements : unsupportedTaggedRequirement();
}

/**
 * Return a closed, bounded proof matrix only for explicit multi-variant malformed
 * tagged-event contracts. Ordinary invalid-input prose deliberately returns no
 * matrix and keeps the established flat proof path unchanged.
 */
export function malformedTaggedEventRequirements(raw) {
  const clauses = contractClauses(raw);
  return hasExplicitInputRejection(raw) ? explicitTaggedEventRequirements(clauses) : [];
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

  if (
    /\biso(?:[-\s]+8601)?(?:[-\s]+timestamp)?(?:[-\s]+strings?)?\b/.test(value)
    && /\b(?:invalid|malformed)\s+(?:date|dates|timestamp|timestamps)\b|\b(?:date|dates|timestamp|timestamps)\b[^.\n]{0,80}\b(?:throw|reject)/.test(value)
  ) {
    guidance.push("For an ISO date-string contract, separately reject a parseable non-ISO string, a syntactically ISO but impossible calendar date, and an invalid Date object; a finite Date.parse result alone does not prove ISO validity.");
  }

  if (explicitUndefinedTemporalContract(value)) {
    guidance.push("Distinguish an omitted time argument from explicitly supplied undefined, null, false, and zero; a default parameter conflates omission with explicit undefined and cannot prove this contract.");
  }
  if (malformedIdentifierContract(raw)) {
    guidance.push("For malformed identifier input, exercise missing, wrong-type, and empty-string values separately; add whitespace-only when the contract requires non-whitespace.");
  }
  if (malformedTaggedEventRequirements(raw).length > 0) {
    guidance.push("For every malformed tagged-event variant, use fresh literal non-event inputs, one valid control per variant, and vary one constrained field at a time; evidence for one variant or field does not cover another.");
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

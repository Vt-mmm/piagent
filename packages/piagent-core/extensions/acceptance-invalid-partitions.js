import { malformedIdentifierContract } from "./acceptance-boundary-guidance.js";
const normalizedText = value => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function requestedInvalidPartitions(text) {
  const invalid = normalizedText(text)
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((clause) => /\b(?:invalid|malformed|reject(?:s|ed|ion)?|throw(?:s|ing)?|typeerror|rangeerror|syntaxerror)\b/.test(clause))
    .join("\n");
  const partitions = new Set();
  if (/\bnegative\b/.test(invalid)) partitions.add("negative");
  if (/\bfractional\b/.test(invalid)) partitions.add("fractional");
  if (/\bzero\b/.test(invalid)) partitions.add("zero");
  if (/\bnull\b/.test(invalid)) partitions.add("null");
  if (/\b(?:empty[- ]string|whitespace-only|string[^.\n]{0,80}non-whitespace)\b/.test(invalid)) partitions.add("empty-string");
  if (/\bwhitespace-only\b/.test(invalid)) partitions.add("whitespace-string");
  if (/\bnon-finite\b/.test(invalid)) partitions.add("non-finite");
  if (/\bunsafe[- ]integer\b/.test(invalid)) partitions.add("unsafe-integer");
  if (/\b(?:missing|undefined)\b/.test(invalid)) partitions.add("missing");
  if (/\bnon-array\b/.test(invalid)) partitions.add("non-array");
  if (/\bnon-string\b/.test(invalid)) partitions.add("non-string");
  if (/\breject(?:s|ed|ing)?\s+(?:an?\s+)?arrays?\b|\barrays?\s+(?:values?\s+)?(?:are|is|must be)\s+(?:invalid|rejected|disallowed|not allowed)\b/.test(invalid)) partitions.add("array");
  if (/\breject(?:s|ed|ing)?\s+(?:an?\s+)?plain[- ]objects?\b|\bplain[- ]objects?\s+(?:values?\s+)?(?:are|is|must be)\s+(?:invalid|rejected|disallowed|not allowed)\b/.test(invalid)) partitions.add("plain-object");
  if (/\breject(?:s|ed|ing)?\s+(?:an?\s+)?primitives?\b|\bprimitives?\s+(?:values?\s+)?(?:are|is|must be)\s+(?:invalid|rejected|disallowed|not allowed)\b/.test(invalid)) partitions.add("primitive");
  if (malformedIdentifierContract(text)) for (const partition of ["missing", "non-string", "empty-string"]) partitions.add(partition);
  return [...partitions];
}

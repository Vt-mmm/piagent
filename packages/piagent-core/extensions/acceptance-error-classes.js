export const ERROR_CONSTRUCTORS = [
  "typeerror",
  "rangeerror",
  "syntaxerror",
  "referenceerror",
  "urierror",
  "evalerror",
  "aggregateerror",
  "error"
];

export const ERROR_CONSTRUCTOR_DISPLAY_NAMES = Object.freeze({
  typeerror: "TypeError",
  rangeerror: "RangeError",
  syntaxerror: "SyntaxError",
  referenceerror: "ReferenceError",
  urierror: "URIError",
  evalerror: "EvalError",
  aggregateerror: "AggregateError",
  error: "Error"
});

const ERROR_ACTION = String.raw`(?:throw(?:s|ing)?|rais(?:e|es|ed|ing)|reject(?:s|ed|ing)?|use(?:s|d|ing)?|return(?:s|ed|ing)?|emit(?:s|ted|ting)?|produc(?:e|es|ed|ing)|expect(?:s|ed|ing)?|requir(?:e|es|ed|ing))`;
const ERROR_ACTION_MENTION = new RegExp(String.raw`\b(?:(?:(?:must|should|shall|do|does|did|can|could|may|might|will|would)\s+)?(?:not|never)\s+(?:ever\s+)?(${ERROR_ACTION})|(${ERROR_ACTION}))\b`, "g");
const NEGATED_ERROR_PREFIX = /\b(?:never|rather\s+than|instead\s+of|as\s+opposed\s+to|except|other\s+than|(?:but\s+)?not|no)(?:\s+an?)?\s*$/;
const NEGATED_ERROR_ACTION_PREFIX = /\b(?:without|avoid(?:s|ed|ing)?|prevent(?:s|ed|ing)?|suppress(?:es|ed|ing)?)\s+(?:ever\s+)?(?:throw(?:s|n|ing)?|rais(?:e|es|ed|ing)|reject(?:s|ed|ing)?|us(?:e|es|ed|ing)|return(?:s|ed|ing)?|emit(?:s|ted|ting)?|produc(?:e|es|ed|ing))?(?:\s+an?)?\s*$/;
const NON_REQUEST_SOURCE_PREFIX = /\b(?:catch(?:es|ing)?|caught|handl(?:e|es|ed|ing)|observ(?:e|es|ed|ing)|receiv(?:e|es|ed|ing)|inspect(?:s|ed|ing)?|log(?:s|ged|ging)?|ignor(?:e|es|ed|ing)|swallow(?:s|ed|ing)?|convert(?:s|ed|ing)?|wrap(?:s|ped|ping)?|translat(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|turn(?:s|ed|ing)?)\s+(?:an?)?\s*$/;
const NEGATED_ERROR_SUFFIX = /^\s+(?:(?:must|should|shall|can|could|may|might|will|would)\s+)?(?:not|never)\s+be\s+(?:thrown|raised|used|returned|emitted|produced)\b|^\s+is\s+(?:not\s+(?:allowed|required|expected|acceptable|equivalent)|forbidden|disallowed|prohibited)\b/;
const AFFIRMATIVE_ERROR_SUFFIX = /^\s+(?:(?:must|should|shall|can|could|may|might|will|would)\s+)?(?:be\s+)?(?:thrown|raised|used|returned|emitted|produced|required|expected)\b|^\s+is\s+(?:required|expected)\b/;
const TRANSFORM_TARGET_PREFIX = /\b(?:convert(?:s|ed|ing)?|wrap(?:s|ped|ping)?|translat(?:e|es|ed|ing)|map(?:s|ped|ping)?|replac(?:e|es|ed|ing)|chang(?:e|es|ed|ing)|turn(?:s|ed|ing)?)\b[^.;!?\n]{0,96}\b(?:into|to|as)(?:\s+an?)?\s*$/;
const RESULT_TARGET_PREFIX = /\b(?:result(?:s|ed|ing)?\s+in|resolve(?:s|d|ing)?\s+to)(?:\s+an?)?\s*$/;
const MAPPED_PARTITION_SUFFIX = /^\s*`?\s+(?:for|with)\s+(?:an?\s+)?(?:negative|fractional|zero|null|empty[- ]string|whitespace-only|non-finite|unsafe[- ]integer|missing|undefined|non-array|non-string|arrays?|plain[- ]objects?|primitives?)\b/;
const NEUTRAL_CONSTRUCTOR_SUFFIX = /^\s*`?\s*(?:from|reported\s+by|(?:is|was)\s+(?:caught|handled|logged|ignored|observed)|(?:is|was)\s+(?:not\s+allowed|forbidden|disallowed|prohibited))\b/;
const ERROR_MAPPING_PARTITIONS = Object.freeze([
  ["negative", /\bnegative\b/], ["fractional", /\bfractional\b/], ["zero", /\bzero\b/], ["null", /\bnull\b/],
  ["empty-string", /\bempty[- ]string\b/], ["whitespace-string", /\bwhitespace-only\b/],
  ["non-finite", /\bnon-finite\b/], ["unsafe-integer", /\bunsafe[- ]integer\b/],
  ["missing", /\b(?:missing|undefined)\b/], ["non-array", /\bnon-array\b/], ["non-string", /\bnon-string\b/],
  ["array", /\barrays?\b/], ["plain-object", /\bplain[- ]objects?\b/], ["primitive", /\bprimitives?\b/]
]);

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(is|are|was|were|do|does|did|should|would|could|must|will|shall)n['’]t\b/gi, "$1 not")
    .replace(/\bcan['’]t\b/gi, "can not")
    .toLowerCase();
}

function affirmativeErrorConstructorMention(value, name) {
  for (const match of value.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const clauseStart = Math.max(value.lastIndexOf(".", start - 1), value.lastIndexOf(";", start - 1), value.lastIndexOf("!", start - 1), value.lastIndexOf("?", start - 1), value.lastIndexOf("\n", start - 1));
    const followingBoundary = value.slice(end).search(/[.;!?\n]/);
    const prefix = value.slice(clauseStart + 1, start).trimEnd();
    const suffix = value.slice(end, followingBoundary < 0 ? value.length : end + followingBoundary);
    if (NEGATED_ERROR_PREFIX.test(prefix) || NEGATED_ERROR_ACTION_PREFIX.test(prefix)
      || NON_REQUEST_SOURCE_PREFIX.test(prefix) || NEGATED_ERROR_SUFFIX.test(suffix)) continue;
    const conditional = prefix.match(/\b(?:when|if|after|once|while)\b[^,;]*$/i);
    if (conditional && !new RegExp(`\\b(?:must|should|shall|will)\\s+${ERROR_ACTION}\\b`, "i").test(conditional[0])) continue;
    let lastActionNegated = false;
    let actionObserved = false;
    for (const action of prefix.matchAll(ERROR_ACTION_MENTION)) {
      actionObserved = true;
      lastActionNegated = Boolean(action[1]);
    }
    if (actionObserved) {
      if (lastActionNegated) continue;
      return true;
    }
    if (AFFIRMATIVE_ERROR_SUFFIX.test(suffix) || TRANSFORM_TARGET_PREFIX.test(prefix)
      || RESULT_TARGET_PREFIX.test(prefix)) return true;
  }
  return false;
}

function bareConstructorSegment(value, start, end) {
  const before = value.slice(0, start);
  const boundaries = [...before.matchAll(/(?:[;,.!?\n]|\b(?:and|but|whereas|or)\b)/g)];
  const segmentStart = boundaries.at(-1)?.index + boundaries.at(-1)?.[0].length || 0;
  const following = value.slice(end), boundary = following.search(/[;,.!?\n]|\b(?:and|but|whereas|or)\b/);
  const prefix = value.slice(segmentStart, start), suffix = value.slice(end, boundary < 0 ? value.length : end + boundary);
  return /^\s*`?\s*$/.test(prefix) ? { suffix } : null;
}

function ellipticalOrAmbiguousMention(value, name) {
  let ambiguous = false;
  for (const match of value.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
    const segment = bareConstructorSegment(value, match.index ?? 0, (match.index ?? 0) + match[0].length);
    if (!segment || NEUTRAL_CONSTRUCTOR_SUFFIX.test(segment.suffix)) continue;
    if (MAPPED_PARTITION_SUFFIX.test(segment.suffix)) return { affirmative: true, ambiguous: false };
    ambiguous = true;
  }
  return { affirmative: false, ambiguous };
}

export function requestedErrorClasses(text) {
  const value = normalizedText(text);
  const raw = String(text ?? ""), eligible = ERROR_CONSTRUCTORS.filter((name) => name !== "error" || /\bError\b/.test(raw));
  return eligible.filter((name) => affirmativeErrorConstructorMention(value, name)
    || ellipticalOrAmbiguousMention(value, name).affirmative);
}

export function hasAmbiguousErrorClassIntent(text) {
  const value = normalizedText(text), raw = String(text ?? "");
  return ERROR_CONSTRUCTORS.some((name) => (name !== "error" || /\bError\b/.test(raw))
    && !affirmativeErrorConstructorMention(value, name)
    && ellipticalOrAmbiguousMention(value, name).ambiguous);
}

export function requestedErrorPartitionMapping(text, requestedErrors, requestedPartitions) {
  const wanted = new Set(requestedPartitions), mappings = new Map();
  const segments = normalizedText(text).split(/(?:[.;!?\n]+|,\s*|\s+\b(?:and|but|whereas)\b\s+)/).filter(Boolean);
  for (const segment of segments) {
    const partitions = ERROR_MAPPING_PARTITIONS.filter(([partition, pattern]) => wanted.has(partition) && pattern.test(segment)).map(([partition]) => partition);
    const classes = requestedErrors.filter((name) => new RegExp(`\\b${name}\\b`).test(segment));
    if (partitions.length === 0 && classes.length === 0) continue;
    if (partitions.length !== 1 || classes.length !== 1
      || mappings.has(partitions[0]) && mappings.get(partitions[0]) !== classes[0]) return null;
    mappings.set(partitions[0], classes[0]);
  }
  if (mappings.size !== wanted.size || requestedErrors.some((name) => ![...mappings.values()].includes(name))) return null;
  return [...mappings].map(([partition, errorClass]) => ({ partition, errorClass }));
}

export function assertionsProveErrorMapping(assertions, targets, mapping) {
  return mapping.every((expected) => {
    const relevant = assertions.filter((assertion) => assertion.partitions.has(expected.partition)
      && assertion.targets.some((target) => targets.includes(target)));
    return relevant.length > 0 && relevant.every((assertion) => (
      assertion.errorClasses.length === 1 && assertion.errorClasses[0] === expected.errorClass
    ));
  });
}

export function rejectionStatementErrorClass(text, requestedErrors) {
  const match = text.match(/^\s*throw\s+(?:new\s+)?([a-z_$][a-z0-9_$]*)\s*\(/);
  const errorClass = match?.[1]?.toLowerCase();
  if (!errorClass || !ERROR_CONSTRUCTORS.includes(errorClass)) return null;
  const open = match[0].lastIndexOf("(");
  let depth = 0, close = -1;
  for (let index = open; index < Math.min(text.length, open + 2_000); index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")" && --depth === 0) { close = index + 1; break; }
  }
  if (close === -1) return null;
  const argument = text.slice(open + 1, close - 1).trim();
  if (argument && !/^__pi_(?:(?:empty|double_quote|whitespace)_string|string|node_assert_module|code_generation_module|module_loader_module|error_name_[a-z]+)_literal__$/i.test(argument)) return null;
  if (!/^(?:[ \t]*;|[ \t]*(?:\}|$))/u.test(text.slice(close))) return null;
  return requestedErrors.length === 0 || requestedErrors.includes(errorClass) ? errorClass : null;
}

export function errorMappingsProveContract(observed, mapping) {
  return mapping.every((expected) => {
    const matches = observed.filter((actual) => actual.partition === expected.partition);
    return matches.length > 0 && matches.every((actual) => actual.errorClass === expected.errorClass);
  });
}

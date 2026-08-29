import { callableBodies } from "./acceptance-callable-scanner.js";

const EXACT_BODY = [
  "if(expiresAt instanceof Date){",
  "const timestamp=expiresAt.getTime();",
  "if(Number.isNaN(timestamp))throw new TypeError(__pi_string_literal__);",
  "return timestamp;",
  "}",
  "if(typeof expiresAt!==__pi_typeof_string_literal__)throw new TypeError(__pi_string_literal__);",
  "const match=__pi_iso_expiry_calendar_regex_literal__.exec(expiresAt);",
  "if(!match)throw new TypeError(__pi_string_literal__);",
  "const[,year,month,day,hour,minute,second=__pi_two_digit_zero_string_literal__]=match;",
  "const yearNumber=Number(year);",
  "const monthNumber=Number(month);",
  "const dayNumber=Number(day);",
  "const hourNumber=Number(hour);",
  "const minuteNumber=Number(minute);",
  "const secondNumber=Number(second);",
  "const leapYear=yearNumber%4===0&&(yearNumber%100!==0||yearNumber%400===0);",
  "const daysInMonth=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31][monthNumber-1]||0;",
  "if(monthNumber<1||monthNumber>12||dayNumber<1||dayNumber>daysInMonth||hourNumber>23||minuteNumber>59||secondNumber>59){",
  "throw new TypeError(__pi_string_literal__);",
  "}",
  "const timestamp=Date.parse(expiresAt);",
  "if(Number.isNaN(timestamp))throw new TypeError(__pi_string_literal__);",
  "return timestamp;"
].join("").replace(/\s+/g, "");
const DIRECT_DAYS_BODY = EXACT_BODY.replace(
  "constdaysInMonth=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31][monthNumber-1]||0;",
  "constdaysInMonth=monthNumber===2?(leapYear?29:28):[4,6,9,11].includes(monthNumber)?30:31;"
);

const PARTITIONS = [
  "empty-string", "invalid-calendar-date-string", "invalid-date-object", "invalid-date-string",
  "missing", "non-string", "null", "zero"
];
const ID = "[A-Za-z_$][A-Za-z0-9_$]*";

function compact(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

function explicitAsiStatements(value) {
  return String(value ?? "").split("\n").map((line) => {
    const trimmed = line.trim();
    return !trimmed.endsWith(";") && (/^(?:const|let)\b|^return\b|^throw\b/.test(trimmed) || /throw\s+new\s+TypeError\([^)]*\)$/.test(trimmed)) ? `${line};` : line;
  }).join("\n");
}

function structuralTokens(value) {
  return String(value ?? "").match(/__pi_[a-z0-9_]+__|[A-Za-z_$][A-Za-z0-9_$]*|\d+|===|!==|>=|<=|&&|\|\||=>|[{}()[\].,;?:%+\-*/<>!=]/g) ?? [];
}

function sameStructuralProgram(left, right) {
  const actual = structuralTokens(left), expected = structuralTokens(right);
  return actual.length === expected.length && actual.every((token, index) => token === expected[index]);
}

function canonicalSurfaceForms(value) {
  return String(value ?? "")
    .replace(/if\(([^{}]+)\)\{thrownewTypeError\((__pi_string_literal__)\);?\}/g, "if($1)thrownewTypeError($2);")
    .replace(/let\[,/g, "const[,")
    .replace(/;/g, "");
}

function replaceIdentifiers(body, bindings) {
  return [...bindings.entries()].sort(([left], [right]) => right.length - left.length)
    .reduce((text, [name, canonical]) => text.replace(new RegExp(`\\b${name}\\b`, "g"), canonical), body);
}

function intrinsicEnvironmentIsSafe(source) {
  const code = String(source ?? "");
  if (/\b(?:Object|Reflect|Proxy|eval|Function)\b/.test(code)) return false;
  const residual = code
    .replace(/\binstanceof\s+Date\b/g, "")
    .replace(/\bDate\s*\.\s*(?:now|parse)\s*\(/g, "(")
    .replace(/\bNumber\s*\.\s*(?:isFinite|isNaN)\s*\(/g, "(")
    .replace(/\bNumber\s*\(/g, "(")
    .replace(/\bnew\s+TypeError\s*\(/g, "(");
  return !/\b(?:Date|Number|TypeError)\b/.test(residual);
}

function alphaNormalizedCalendarBody(callable) {
  const exactBody = explicitAsiStatements(callable?.exactBody);
  let body = compact(exactBody);
  const input = body.match(new RegExp(`^if\\((${ID})instanceofDate\\)`))?.[1];
  if (!input) return null;
  const bindings = new Map([[input, "expiresAt"]]);
  const dateTimestamp = body.match(new RegExp(`^if\\(${input}instanceofDate\\)\\{const(${ID})=${input}\\.getTime\\(\\);`))?.[1];
  const exec = body.match(new RegExp(`const(${ID})=__pi_iso_expiry_calendar_regex_literal__\\.exec\\(${input}\\);`));
  const matchCall = body.match(new RegExp(`const(${ID})=${input}\\.match\\(__pi_iso_expiry_calendar_regex_literal__\\);`));
  const match = exec ?? matchCall;
  const captures = match && body.match(new RegExp(`(?:const|let)\\[,(${ID}),(${ID}),(${ID}),(${ID}),(${ID}),(${ID})=__pi_two_digit_zero_string_literal__\\]=${match[1]};`));
  if (!dateTimestamp || !match || !captures) return null;
  bindings.set(dateTimestamp, "timestamp"); bindings.set(match[1], "match");
  ["year", "month", "day", "hour", "minute", "second"].forEach((name, index) => bindings.set(captures[index + 1], name));
  for (const [capture, canonical] of [...bindings.entries()].filter(([, value]) => ["year", "month", "day", "hour", "minute", "second"].includes(value))) {
    const numeric = body.match(new RegExp(`const(${ID})=Number\\(${capture}\\);`))?.[1];
    if (!numeric) return null;
    bindings.set(numeric, `${canonical}Number`);
  }
  const normalizedForCalendar = compact(replaceIdentifiers(exactBody, bindings));
  const leap = normalizedForCalendar.match(new RegExp(`const(${ID})=yearNumber%4===0&&\\(yearNumber%100!==0\\|\\|yearNumber%400===0\\);`))?.[1];
  if (!leap) return null;
  bindings.set(leap, "leapYear");
  const withLeap = compact(replaceIdentifiers(exactBody, bindings));
  const namedTable = withLeap.match(new RegExp(`const(${ID})=\\[31,leapYear\\?29:28,31,30,31,30,31,31,30,31,30,31\\];const(${ID})=\\1\\[monthNumber-1\\]\\|\\|0;`));
  const days = (withLeap.match(new RegExp(`const(${ID})=\\[31,leapYear\\?29:28,31,30,31,30,31,31,30,31,30,31\\]\\[monthNumber-1\\]\\|\\|0;`))
    ?? withLeap.match(new RegExp(`const(${ID})=\\[0,31,leapYear\\?29:28,31,30,31,30,31,31,30,31,30,31\\]\\[monthNumber\\]\\|\\|0;`))
    ?? withLeap.match(new RegExp(`const(${ID})=monthNumber===2\\?\\(leapYear\\?29:28\\):\\[4,6,9,11\\]\\.includes\\(monthNumber\\)\\?30:31;`)))?.[1] ?? namedTable?.[2];
  if (!days) return null;
  bindings.set(days, "daysInMonth");
  body = compact(replaceIdentifiers(exactBody, bindings));
  if (namedTable) body = body.replace(`const${namedTable[1]}=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31];constdaysInMonth=${namedTable[1]}[monthNumber-1]||0;`, "constdaysInMonth=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31][monthNumber-1]||0;");
  body = body.replace("constdaysInMonth=[0,31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31][monthNumber]||0;", "constdaysInMonth=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31][monthNumber-1]||0;");
  body = body.replace("if(monthNumber<1||monthNumber>12||dayNumber<1||dayNumber>daysInMonth){thrownewTypeError(__pi_string_literal__);}if(hourNumber>23||minuteNumber>59||secondNumber>59){thrownewTypeError(__pi_string_literal__);}", "if(monthNumber<1||monthNumber>12||dayNumber<1||dayNumber>daysInMonth||hourNumber>23||minuteNumber>59||secondNumber>59){thrownewTypeError(__pi_string_literal__);}");
  if (matchCall) body = body.replace(`constmatch=expiresAt.match(__pi_iso_expiry_calendar_regex_literal__);`, "constmatch=__pi_iso_expiry_calendar_regex_literal__.exec(expiresAt);");
  return { body, input };
}

/** Bounded alpha/dataflow proof for the strict ISO calendar parser shape. */
export function retainedExpiryCalendarProof(callable, requestedErrors = []) {
  const normalized = alphaNormalizedCalendarBody(callable);
  const recognized = callable?.parameters?.length === 1
    && normalized !== null
    && normalized.input.toLowerCase() === callable.parameters[0]
    && requestedErrors.includes("typeerror")
    && intrinsicEnvironmentIsSafe(callable.exactSourceCode)
    && (sameStructuralProgram(canonicalSurfaceForms(normalized.body), canonicalSurfaceForms(EXACT_BODY))
      || sameStructuralProgram(canonicalSurfaceForms(normalized.body), canonicalSurfaceForms(DIRECT_DAYS_BODY)));
  return {
    recognized,
    generic: recognized,
    candidate: recognized,
    partitions: new Set(recognized ? PARTITIONS : [])
  };
}

export function casePreservingCallableBodies(exactCode, normalizedCode) {
  const exactBodies = callableBodies(explicitAsiStatements(exactCode)), normalizedBodies = callableBodies(explicitAsiStatements(normalizedCode));
  let exactMappingComplete = true;
  for (const [name, callable] of normalizedBodies) {
    const candidates = (exactBodies.declarations ?? []).filter((item) => item.normalizedName === name
      && item.start === callable.declarationStart && item.kind === callable.declarationKind);
    const exact = candidates.length === 1 ? candidates[0].callable : null;
    if (!exact) exactMappingComplete = false;
    if (exact) Object.assign(callable, {
      exactBody: exact.body, exactSourceCode: exact.sourceCode,
      exactDeclarationName: exact.declarationName, exactParameters: exact.exactParameters,
      exactParameterSource: exact.parameterSource, exactDefaultedParameters: exact.exactDefaultedParameters,
      exactDeclarationStart: exact.declarationStart, exactDeclarationEnd: exact.declarationEnd,
      exactBraceDepth: exact.braceDepth, exactDeclarationKind: exact.declarationKind,
      exactTopLevelStatements: exactBodies.topLevelStatements
    });
  }
  normalizedBodies.exactDeclarations = exactBodies.declarations;
  normalizedBodies.exactTopLevelStatements = exactBodies.topLevelStatements;
  normalizedBodies.exactScanComplete = exactBodies.scanComplete;
  normalizedBodies.exactMappingComplete = exactMappingComplete;
  normalizedBodies.exactCaseFoldCollisions = exactBodies.caseFoldCollisions;
  return normalizedBodies;
}

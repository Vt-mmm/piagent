import { Script } from "node:vm";
import { temporalDataflowModuleProof } from "./acceptance-temporal-dataflow-proof.js";

const STRICT_DATE_PARTITIONS = [
  "empty-string", "invalid-calendar-date-string", "invalid-date-object", "invalid-date-string",
  "missing", "non-finite-number", "null", "zero"
];
const FINITE_DATE_OR_NUMBER_PARTITIONS = STRICT_DATE_PARTITIONS.filter((partition) => partition !== "zero");
const ID = "[A-Za-z_$][A-Za-z0-9_$]*";
const INTRINSICS = ["NaN", "Date", "Number", "RegExp", "TypeError"];
const STATIC_TYPE_ERROR = String.raw`thrownewTypeError\((?:__pi_[a-z0-9_]*string_literal__)?\);`;
const SENTINEL_KEYWORDS = { const: 13, function: 4, export: 1, if: 8, return: 10, throw: 2, new: 3, typeof: 2, instanceof: 2, else: 0, arguments: 1 };
const DIRECT_THROW_KEYWORDS = { const: 18, function: 3, export: 1, if: 9, return: 5, throw: 6, new: 6, typeof: 2, instanceof: 2, else: 1, arguments: 1 };

function compact(value) { return String(value ?? "").replace(/\s+/g, ""); }
function escaped(value) { return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function failedProof(candidate = false, reasons = []) { return { generic: false, candidate, partitions: new Set(), ...(reasons.length > 0 ? { reasons } : {}) }; }

function exactField(callable, exact, fallback) {
  return callable?.[exact] ?? callable?.[fallback];
}

function exactName(callable) { return exactField(callable, "exactDeclarationName", "declarationName"); }
function exactParameters(callable) { return exactField(callable, "exactParameters", "exactParameters") ?? []; }
function exactBody(callable) { return exactField(callable, "exactBody", "body") ?? ""; }
function exactSource(callable) { return exactField(callable, "exactSourceCode", "sourceCode") ?? ""; }
function exactDepth(callable) { return exactField(callable, "exactBraceDepth", "braceDepth"); }
function exactKind(callable) { return exactField(callable, "exactDeclarationKind", "declarationKind"); }

function exactClosedModuleParses(callable) {
  const source = exactSource(callable);
  const start = exactField(callable, "exactDeclarationStart", "declarationStart");
  if (source.length > 64_000 || !Number.isSafeInteger(start) || start < 0 || start >= source.length) return false;
  const marker = source.slice(start).match(/^export(?=\s+function\b)/);
  if (!marker) return false;
  const script = `${source.slice(0, start)}${" ".repeat(marker[0].length)}${source.slice(start + marker[0].length)}`;
  try {
    new Script(`"use strict";\n${script}`, {
      displayErrors: false,
      filename: "piagent-acceptance-evidence.js"
    });
    return true;
  } catch {
    return false;
  }
}

function closedKeywordTokensMatch(source, expected) {
  const code = String(source ?? "");
  if (/\bawait\b/.test(code)) return false;
  return Object.entries(expected).every(([word, count]) => (
    [...code.matchAll(new RegExp(`\\b${word}\\b`, "g"))].length === count
  ));
}

function uniqueCaseFolded(values) {
  const folded = values.map((value) => String(value).toLowerCase());
  return values.every((value) => new RegExp(`^${ID}$`).test(String(value))) && new Set(folded).size === folded.length;
}

function hasRestrictedProductionLineTerminator(value) {
  return /\b(?:break|continue|return|throw|yield)\b[^\S\r\n\u2028\u2029]*(?:\r\n|[\r\n\u2028\u2029])/u
    .test(String(value ?? ""));
}

function exactCallable(bodies, name) {
  if (!name || !new RegExp(`^${ID}$`).test(name)) return null;
  const candidates = (bodies.exactDeclarations ?? bodies.declarations ?? [])
    .filter((item) => item.name === name);
  if (candidates.length !== 1) return null;
  const callable = bodies.get(name.toLowerCase());
  return callable && exactName(callable) === name ? callable : null;
}

function exactFunction(callable, parameterCount, allowUndefinedDefault = false) {
  const parameters = exactParameters(callable);
  const parameterSource = compact(exactField(callable, "exactParameterSource", "parameterSource"));
  return Boolean(callable)
    && exactKind(callable) === "function-declaration"
    && exactDepth(callable) === 0
    && callable.asynchronous === false
    && callable.ownsArguments === true
    && parameters.length === parameterCount
    && (parameterSource === parameters.join(",")
      || (allowUndefinedDefault && parameterCount === 2 && parameterSource === `${parameters[0]},${parameters[1]}=undefined`))
    && uniqueCaseFolded([exactName(callable), ...parameters]);
}

function intrinsicEnvironmentIsClosed(source, names, { caseSensitive = false } = {}) {
  const code = String(source ?? "");
  const intrinsics = caseSensitive ? [...INTRINSICS, "Math"] : INTRINSICS;
  if (hasRestrictedProductionLineTerminator(code)) return false;
  // Legacy recognizers use folded identifiers. The dataflow interpreter instead
  // binds exact identifiers, so a local `date` is not the intrinsic `Date`.
  for (const intrinsic of caseSensitive ? [] : INTRINSICS) {
    if ([...code.matchAll(new RegExp(`\\b${intrinsic}\\b`, "gi"))].some((match) => match[0] !== intrinsic)) return false;
  }
  if (names.some((name) => intrinsics.some((intrinsic) => caseSensitive ? name === intrinsic : name.toLowerCase() === intrinsic.toLowerCase()))) return false;
  if (caseSensitive && /\b(?:const|let|var|class|function)\s+Math\b|\bMath\s*(?:=|\+\+|--|[+*/%&|^-]=)|\bMath\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:=|\+\+|--|[+*/%&|^-]=)/.test(code)) return false;
  if (/\b(?:const|let|var|class|function)\s+(?:NaN|Date|Number|RegExp|TypeError)\b/.test(code)) return false;
  if (/(?:\{|\[)[^}\]]*\b(?:NaN|Date|Number|RegExp|TypeError)\b[^}\]]*(?:\}|\])\s*=/.test(code)) return false;
  if (/\b(?:NaN|Date|Number|RegExp|TypeError)\b\s*(?:=|\+\+|--|[+*/%&|^-]=)/.test(code)) return false;
  if (/\b(?:Date|Number|RegExp|TypeError)\s*\.\s*(?:prototype\s*\.)?[A-Za-z_$][A-Za-z0-9_$]*\s*(?:=|\+\+|--|[+*/%&|^-]=)/.test(code)) return false;
  if (/\.\s*(?:prototype\s*\.\s*exec|compile)\s*(?:=|\()/.test(code)) return false;
  return !/\b(?:Object|Reflect|Proxy|eval|Function|globalThis|global)\b/.test(code);
}

function strictParserProof(bodies, parserName, regexName) {
  const callable = exactCallable(bodies, parserName);
  if (!exactFunction(callable, 1)) return null;
  const [input] = exactParameters(callable);
  let body = compact(exactBody(callable));
  const typeGuard = `if(typeof${input}!==__pi_typeof_string_literal__)returnNaN;`;
  if (!body.startsWith(typeGuard)) return null;
  body = body.slice(typeGuard.length);

  const matchDeclaration = body.match(new RegExp(`^const(${ID})=(${ID})\\.exec\\((${ID})\\);if\\(!\\1\\)returnNaN;`));
  if (!matchDeclaration || matchDeclaration[2] !== regexName || matchDeclaration[3] !== input) return null;
  const matchName = matchDeclaration[1];
  body = body.slice(matchDeclaration[0].length);

  const aliases = [];
  for (let slot = 1; slot <= 6; slot += 1) {
    const declaration = body.match(new RegExp(`^const(${ID})=Number\\(${escaped(matchName)}\\[${slot}\\]\\);`));
    if (!declaration) return null;
    aliases.push(declaration[1]);
    body = body.slice(declaration[0].length);
  }
  const [year, month, day, hour, minute, second] = aliases;
  const offsetHour = body.match(new RegExp(`^const(${ID})=${escaped(matchName)}\\[8\\]===__pi_utc_z_string_literal__\\?0:Number\\(${escaped(matchName)}\\[8\\]\\.slice\\(1,3\\)\\);`));
  if (!offsetHour) return null;
  body = body.slice(offsetHour[0].length);
  const offsetMinute = body.match(new RegExp(`^const(${ID})=${escaped(matchName)}\\[8\\]===__pi_utc_z_string_literal__\\?0:Number\\(${escaped(matchName)}\\[8\\]\\.slice\\(4,6\\)\\);`));
  if (!offsetMinute) return null;
  body = body.slice(offsetMinute[0].length);
  const days = body.match(new RegExp(`^const(${ID})=newDate\\(Date\\.UTC\\(${escaped(year)},${escaped(month)},0\\)\\)\\.getUTCDate\\(\\);`));
  if (!days) return null;
  body = body.slice(days[0].length);
  const guard = `if(${month}<1||${month}>12||${day}<1||${day}>${days[1]}||${hour}>23||${minute}>59||${second}>59||${offsetHour[1]}>23||${offsetMinute[1]}>59)returnNaN;`;
  if (!body.startsWith(guard)) return null;
  body = body.slice(guard.length);
  if (body !== `returnDate.parse(${input});`) return null;

  const localNames = [parserName, regexName, input, matchName, ...aliases, offsetHour[1], offsetMinute[1], days[1]];
  return uniqueCaseFolded(localNames) ? { callable, input, localNames } : null;
}

function strictDateDelegateProof(bodies, delegateName) {
  const callable = exactCallable(bodies, delegateName);
  if (!exactFunction(callable, 1)) return null;
  const [input] = exactParameters(callable);
  const body = compact(exactBody(callable));
  const match = body.match(new RegExp(`^if\\(${escaped(input)}instanceofDate\\)return${escaped(input)}\\.getTime\\(\\);return(${ID})\\(${escaped(input)}\\);$`));
  if (!match) return null;
  return { callable, input, parserName: match[1], partitions: STRICT_DATE_PARTITIONS };
}

function finiteDateOrNumberDelegateProof(bodies, delegateName) {
  const callable = exactCallable(bodies, delegateName);
  if (!exactFunction(callable, 1)) return null;
  const [input] = exactParameters(callable);
  const expected = `if(${input}instanceofDate)return${input}.getTime();if(typeof${input}===__pi_typeof_number_literal__&&Number.isFinite(${input}))return${input};returnNaN;`;
  return compact(exactBody(callable)) === expected
    ? { callable, input, partitions: FINITE_DATE_OR_NUMBER_PARTITIONS } : null;
}

function publicChainProof(bodies, publicName) {
  const callable = exactCallable(bodies, publicName);
  if (!exactFunction(callable, 2)) return null;
  const [expiryInput, nowInput] = exactParameters(callable);
  if (expiryInput === "arguments" || nowInput === "arguments") return null;
  const body = compact(exactBody(callable));
  const literalErrorArgument = "(?:__pi_[a-z0-9_]*string_literal__)?";
  const chain = body.match(new RegExp(
    `^const(${ID})=(${ID})\\(${escaped(expiryInput)}\\);`
    + `if\\(!Number\\.isFinite\\(\\1\\)\\)thrownewTypeError\\(${literalErrorArgument}\\);`
    + `const(${ID})=arguments\\.length<2\\?Date\\.now\\(\\):(${ID})\\(${escaped(nowInput)}\\);`
    + `if\\(!Number\\.isFinite\\(\\3\\)\\)thrownewTypeError\\(${literalErrorArgument}\\);`
    + `return\\3>=\\1;$`
  ));
  if (!chain) return null;
  const [, expiryAlias, expiryHelper, nowAlias, nowHelper] = chain;
  if (!uniqueCaseFolded([publicName, expiryInput, nowInput, expiryAlias, nowAlias, expiryHelper, nowHelper])) return null;
  return { callable, expiryInput, nowInput, expiryAlias, nowAlias, expiryHelper, nowHelper };
}

function closedModuleProof(bodies, publicName) {
  const publicChain = publicChainProof(bodies, publicName);
  if (!publicChain || !exactClosedModuleParses(publicChain.callable)) return null;
  const expiry = strictDateDelegateProof(bodies, publicChain.expiryHelper);
  const now = finiteDateOrNumberDelegateProof(bodies, publicChain.nowHelper);
  if (!expiry || !now) return null;

  const exactStatements = bodies.exactTopLevelStatements ?? bodies.topLevelStatements ?? [];
  const exactDeclarations = bodies.exactDeclarations ?? bodies.declarations ?? [];
  const scanComplete = bodies.exactScanComplete ?? bodies.scanComplete;
  const collisions = bodies.exactCaseFoldCollisions ?? bodies.caseFoldCollisions ?? new Set();
  if (!scanComplete || bodies.exactMappingComplete === false || collisions.size > 0
    || exactStatements.length !== 5 || exactDeclarations.length !== 4
    || exactDeclarations.some((item) => item.braceDepth !== 0 || item.kind !== "function-declaration")) return null;

  const regexStatement = exactStatements[0]?.source?.trim();
  const regex = regexStatement?.match(new RegExp(`^const\\s+(${ID})\\s*=\\s*__pi_strict_iso_timestamp_regex_literal__\\s*;$`));
  if (!regex) return null;
  const regexName = regex[1];
  const parser = strictParserProof(bodies, expiry.parserName, regexName);
  if (!parser) return null;

  const orderedNames = [expiry.parserName, publicChain.expiryHelper, publicChain.nowHelper, publicName];
  if (!uniqueCaseFolded([regexName, ...orderedNames])) return null;
  if (!orderedNames.every((name, index) => exactStatements[index + 1]?.declarationName === name)) return null;
  if (!exactStatements.slice(1, 4).every((statement, index) => compact(statement.source).startsWith(`function${orderedNames[index]}(`))) return null;
  if (!compact(exactStatements[4].source).startsWith(`exportfunction${publicName}(`)) return null;

  const source = exactSource(publicChain.callable);
  const allNames = [regexName, ...orderedNames, ...exactParameters(parser.callable), ...exactParameters(expiry.callable),
    ...exactParameters(now.callable), ...exactParameters(publicChain.callable)];
  if (!intrinsicEnvironmentIsClosed(source, allNames) || !closedKeywordTokensMatch(source, SENTINEL_KEYWORDS)) return null;
  return { publicChain, expiry, now };
}

function directThrowExpiryProof(bodies, expiryName, regexName) {
  const callable = exactCallable(bodies, expiryName);
  if (!exactFunction(callable, 1)) return null;
  const [input] = exactParameters(callable);
  let body = compact(exactBody(callable));

  const dateBranch = body.match(new RegExp(
    `^if\\(${escaped(input)}instanceofDate\\)\\{const(${ID})=${escaped(input)}\\.getTime\\(\\);`
    + `if\\(Number\\.isFinite\\(\\1\\)\\)return\\1;${STATIC_TYPE_ERROR}\\}`
  ));
  if (!dateBranch) return null;
  const dateTimestamp = dateBranch[1];
  body = body.slice(dateBranch[0].length);

  const typeGuard = body.match(new RegExp(
    `^if\\(typeof${escaped(input)}!==__pi_typeof_string_literal__\\)${STATIC_TYPE_ERROR}`
  ));
  if (!typeGuard) return null;
  body = body.slice(typeGuard[0].length);

  const matchGuard = body.match(new RegExp(
    `^const(${ID})=${escaped(regexName)}\\.exec\\(${escaped(input)}\\);if\\(!\\1\\)${STATIC_TYPE_ERROR}`
  ));
  if (!matchGuard) return null;
  const matchName = matchGuard[1];
  body = body.slice(matchGuard[0].length);

  const numericParts = [];
  for (let slot = 1; slot <= 6; slot += 1) {
    const declaration = body.match(new RegExp(`^const(${ID})=Number\\(${escaped(matchName)}\\[${slot}\\]\\);`));
    if (!declaration) return null;
    numericParts.push(declaration[1]);
    body = body.slice(declaration[0].length);
  }
  const [year, month, day, hour, minute, second] = numericParts;

  const offset = body.match(new RegExp(`^const(${ID})=${escaped(matchName)}\\[7\\];`));
  if (!offset) return null;
  const offsetName = offset[1];
  body = body.slice(offset[0].length);
  const offsetHour = body.match(new RegExp(
    `^const(${ID})=${escaped(offsetName)}===__pi_utc_z_string_literal__\\?0:Number\\(${escaped(offsetName)}\\.slice\\(1,3\\)\\);`
  ));
  if (!offsetHour) return null;
  body = body.slice(offsetHour[0].length);
  const offsetMinute = body.match(new RegExp(
    `^const(${ID})=${escaped(offsetName)}===__pi_utc_z_string_literal__\\?0:Number\\(${escaped(offsetName)}\\.slice\\(4,6\\)\\);`
  ));
  if (!offsetMinute) return null;
  body = body.slice(offsetMinute[0].length);

  const leap = body.match(new RegExp(
    `^const(${ID})=${escaped(year)}%4===0&&\\(${escaped(year)}%100!==0\\|\\|${escaped(year)}%400===0\\);`
  ));
  if (!leap) return null;
  const leapName = leap[1];
  body = body.slice(leap[0].length);
  const days = body.match(new RegExp(
    `^const(${ID})=\\[31,${escaped(leapName)}\\?29:28,31,30,31,30,31,31,30,31,30,31\\];`
  ));
  if (!days) return null;
  const daysName = days[1];
  body = body.slice(days[0].length);

  const rejection = body.match(new RegExp(
    `^if\\(${escaped(month)}<1\\|\\|${escaped(month)}>12\\|\\|${escaped(day)}<1\\|\\|${escaped(day)}>${escaped(daysName)}\\[${escaped(month)}-1\\]`
    + `\\|\\|${escaped(hour)}>23\\|\\|${escaped(minute)}>59\\|\\|${escaped(second)}>59`
    + `\\|\\|${escaped(offsetHour[1])}>23\\|\\|${escaped(offsetMinute[1])}>59\\)\\{${STATIC_TYPE_ERROR}\\}`
  ));
  if (!rejection) return null;
  body = body.slice(rejection[0].length);

  const parsed = body.match(new RegExp(
    `^const(${ID})=Date\\.parse\\(${escaped(input)}\\);`
    + `if\\(!Number\\.isFinite\\(\\1\\)\\)${STATIC_TYPE_ERROR}return\\1;$`
  ));
  if (!parsed) return null;

  const localNames = [...new Set([
    expiryName, regexName, input, dateTimestamp, matchName, ...numericParts, offsetName,
    offsetHour[1], offsetMinute[1], leapName, daysName, parsed[1]
  ])];
  return uniqueCaseFolded(localNames)
    ? { callable, input, partitions: STRICT_DATE_PARTITIONS }
    : null;
}


function directThrowNowProof(bodies, nowName) {
  const callable = exactCallable(bodies, nowName);
  if (!exactFunction(callable, 1)) return null;
  const [input] = exactParameters(callable);
  const body = compact(exactBody(callable));
  const match = body.match(new RegExp(
    `^if\\(${escaped(input)}instanceofDate\\)\\{const(${ID})=${escaped(input)}\\.getTime\\(\\);`
    + `if\\(Number\\.isFinite\\(\\1\\)\\)return\\1;\\}`
    + `elseif\\(typeof${escaped(input)}===__pi_typeof_number_literal__&&Number\\.isFinite\\(${escaped(input)}\\)\\)\\{return${escaped(input)};\\}`
    + `${STATIC_TYPE_ERROR}$`
  ));
  if (!match || !uniqueCaseFolded([...new Set([nowName, input, match[1]])])) return null;
  return { callable, input, partitions: FINITE_DATE_OR_NUMBER_PARTITIONS };
}

function directThrowPublicProof(bodies, publicName) {
  const callable = exactCallable(bodies, publicName);
  if (!exactFunction(callable, 2)) return null;
  const [expiryInput, nowInput] = exactParameters(callable);
  if (expiryInput === "arguments" || nowInput === "arguments") return null;
  const body = compact(exactBody(callable));
  const match = body.match(new RegExp(
    `^const(${ID})=(${ID})\\(${escaped(expiryInput)}\\);`
    + `const(${ID})=arguments\\.length<2\\?Date\\.now\\(\\):(${ID})\\(${escaped(nowInput)}\\);`
    + `return\\3>=\\1;$`
  ));
  if (!match) return null;
  const [, expiryAlias, expiryHelper, nowAlias, nowHelper] = match;
  if (!uniqueCaseFolded([publicName, expiryInput, nowInput, expiryAlias, expiryHelper, nowAlias, nowHelper])) return null;
  return { callable, expiryInput, nowInput, expiryAlias, expiryHelper, nowAlias, nowHelper };
}

function directThrowModuleCandidate(bodies, publicName) {
  const callable = exactCallable(bodies, publicName);
  if (!exactFunction(callable, 2)) return false;
  const statements = bodies.exactTopLevelStatements ?? bodies.topLevelStatements ?? [];
  const declarations = bodies.exactDeclarations ?? bodies.declarations ?? [];
  const hasRegexBinding = statements.some((statement) => /^(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*__pi_[a-z0-9_]*regex_literal__\s*;$/i.test(statement.source.trim()));
  const body = compact(exactBody(callable));
  return hasRegexBinding
    && declarations.filter((item) => item.braceDepth === 0 && item.kind === "function-declaration").length >= 3
    && body.includes("arguments.length") && body.includes("Date.now()") && body.includes(">=");
}

function closedDirectThrowModuleProof(bodies, publicName) {
  const candidate = directThrowModuleCandidate(bodies, publicName);
  if (!candidate) return { candidate: false, proof: null };
  const exactStatements = bodies.exactTopLevelStatements ?? bodies.topLevelStatements ?? [];
  const exactDeclarations = bodies.exactDeclarations ?? bodies.declarations ?? [];
  const scanComplete = bodies.exactScanComplete ?? bodies.scanComplete;
  const collisions = bodies.exactCaseFoldCollisions ?? bodies.caseFoldCollisions ?? new Set();
  if (!scanComplete || bodies.exactMappingComplete === false || collisions.size > 0
    || exactStatements.length !== 4 || exactDeclarations.length !== 3
    || exactDeclarations.some((item) => item.braceDepth !== 0 || item.kind !== "function-declaration")) {
    return { candidate: true, proof: null };
  }

  const regexStatement = exactStatements[0]?.source?.trim();
  const regex = regexStatement?.match(new RegExp(
    `^const\\s+(${ID})\\s*=\\s*__pi_strict_iso_timestamp_noncapturing_fraction_regex_literal__\\s*;$`
  ));
  if (!regex) return { candidate: true, proof: null };
  const regexName = regex[1];
  const publicChain = directThrowPublicProof(bodies, publicName);
  if (!publicChain || !exactClosedModuleParses(publicChain.callable)) return { candidate: true, proof: null };
  const expiry = directThrowExpiryProof(bodies, publicChain.expiryHelper, regexName);
  const now = directThrowNowProof(bodies, publicChain.nowHelper);
  if (!expiry || !now) return { candidate: true, proof: null };

  const orderedNames = [publicChain.expiryHelper, publicChain.nowHelper, publicName];
  if (!uniqueCaseFolded([regexName, ...orderedNames])
    || !orderedNames.every((name, index) => exactStatements[index + 1]?.declarationName === name)
    || !exactStatements.slice(1, 3).every((statement, index) => compact(statement.source).startsWith(`function${orderedNames[index]}(`))
    || !compact(exactStatements[3].source).startsWith(`exportfunction${publicName}(`)) {
    return { candidate: true, proof: null };
  }

  const source = exactSource(publicChain.callable);
  const allNames = [regexName, ...orderedNames, ...exactParameters(expiry.callable),
    ...exactParameters(now.callable), ...exactParameters(publicChain.callable)];
  if (!intrinsicEnvironmentIsClosed(source, allNames) || !closedKeywordTokensMatch(source, DIRECT_THROW_KEYWORDS)) return { candidate: true, proof: null };
  return { candidate: true, proof: { publicChain, expiry, now } };
}

function inlineDirectThrowModuleCandidate(bodies, publicName) {
  const callable = exactCallable(bodies, publicName);
  if (!exactFunction(callable, 2, true)) return false;
  const declarations = bodies.exactDeclarations ?? bodies.declarations ?? [];
  const hasInlineStrictRegex = declarations.some((item) => {
    const candidate = exactCallable(bodies, item.name);
    return candidate && exactBody(candidate)
      .match(/__pi_(?:strict_iso_timestamp_optional_seconds_(?:capturing_fraction|dot_fraction)_)?regex_literal__/);
  });
  const body = compact(exactBody(callable));
  return hasInlineStrictRegex
    && declarations.filter((item) => item.braceDepth === 0 && item.kind === "function-declaration").length >= 3
    && (body.includes("arguments.length") || body.includes("Date.now()"));
}

function closedInlineDirectThrowModuleProof(bodies, publicName, contractText = "") {
  const candidate = inlineDirectThrowModuleCandidate(bodies, publicName);
  if (!candidate) return { candidate: false, proof: null };
  const statements = bodies.exactTopLevelStatements ?? [];
  const declarations = bodies.exactDeclarations ?? [];
  const callable = exactCallable(bodies, publicName);
  const reject = (reasons = ["closed-temporal-module-unproven"]) => ({ candidate: true, proof: null, reasons });
  if (!bodies.exactScanComplete || bodies.exactMappingComplete === false
    || (bodies.exactCaseFoldCollisions?.size ?? 0) > 0
    || declarations.length < 3 || declarations.length > 9 || statements.length !== declarations.length
    || !exactFunction(callable, 2, true) || !exactClosedModuleParses(callable)
    || exactParameters(callable).some((parameter) => declarations.some((item) => item.name.toLowerCase() === parameter.toLowerCase()))
    || declarations.some((item) => !exactFunction(exactCallable(bodies, item.name), item.name === publicName ? 2 : 1, item.name === publicName))
    || statements.some((item) => !compact(item.source).startsWith(`${item.declarationName === publicName ? "export" : ""}function${item.declarationName}(`))
    || !intrinsicEnvironmentIsClosed(exactSource(callable), declarations.flatMap((item) => [item.name, ...item.parameters]), { caseSensitive: true })) return reject();
  const result = temporalDataflowModuleProof(bodies, publicName, {
    expiryBeforeClock: /read\s+`?Date\.now\(\)`?\s+after validating\s+`?[A-Za-z_$][\w$]*`?/i.test(contractText)
  });
  if (!result.proven) return reject(result.reasons);
  return { candidate: true, proof: {
    publicChain: { callable },
    expiry: { callable: result.expiry, partitions: STRICT_DATE_PARTITIONS },
    now: { callable: result.now, partitions: FINITE_DATE_OR_NUMBER_PARTITIONS }
  } };
}

/**
 * Prove only the retained closed sentinel module. The proof is intentionally
 * whole-module: a valid-looking leaf or guard cannot survive an extra binding,
 * write, control path, case-fold collision, or indirect dependency edge.
 */
export function invalidSentinelRejectionProof({
  bodies, name, requestedErrors = [], requestedPartitions = [], requiredInputNames = null, contractText = ""
}) {
  if (!requestedErrors.includes("typeerror")) return failedProof();
  const publicCallable = bodies.get(name);
  const publicName = exactName(publicCallable);
  if (!publicCallable || !publicName) return failedProof();
  const sentinel = closedModuleProof(bodies, publicName);
  const directThrow = sentinel ? { candidate: false, proof: null } : closedDirectThrowModuleProof(bodies, publicName);
  const inlineDirectThrow = sentinel || directThrow.proof
    ? { candidate: false, proof: null } : closedInlineDirectThrowModuleProof(bodies, publicName, contractText);
  const closed = sentinel ?? directThrow.proof ?? inlineDirectThrow.proof;
  if (!closed) return failedProof(directThrow.candidate || inlineDirectThrow.candidate, inlineDirectThrow.reasons);
  if (requestedPartitions.some((partition) => ["non-array", "non-string"].includes(partition))) return failedProof(true);

  const requested = Array.isArray(requiredInputNames) && requiredInputNames.length > 0
    ? requiredInputNames : null;
  if (!requested && exactParameters(publicCallable).length > 1) return failedProof(true);
  if (requested && requested.length !== 1) return failedProof(true);
  const requestedName = requested?.[0] ?? exactParameters(publicCallable)[0];
  const matches = exactParameters(publicCallable).filter((parameter) => parameter.toLowerCase() === String(requestedName).toLowerCase());
  if (matches.length !== 1) return failedProof(true);
  const inputIndex = exactParameters(publicCallable).indexOf(matches[0]);
  if (inputIndex === 0) return { generic: true, candidate: true, partitions: new Set(closed.expiry.partitions) };
  if (inputIndex === 1 && publicCallable.ownsArguments === true) {
    return { generic: true, candidate: true, preservesExplicitUndefined: Boolean(inlineDirectThrow.proof), partitions: new Set(closed.now.partitions) };
  }
  return failedProof(true);
}

export function withInvalidSentinelDiagnostics(result, { enabled, bodyMaps, namedTargets, requestedErrors, requestedPartitions }) {
  if (!enabled) return result;
  const reasons = result.sourceOk ? [] : [...bodyMaps.values()].flatMap((bodies) =>
    [...bodies.keys()].filter((name) => namedTargets.includes(name)).flatMap((name) => invalidSentinelRejectionProof({
      bodies, name, requestedErrors, requestedPartitions, requiredInputNames: bodies.get(name)?.parameters?.slice(0, 1)
    }).reasons ?? []));
  return { ...result, sourceReasons: [...new Set(reasons)] };
}

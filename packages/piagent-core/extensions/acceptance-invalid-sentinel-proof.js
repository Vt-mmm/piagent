const STRICT_DATE_PARTITIONS = [
  "empty-string", "invalid-calendar-date-string", "invalid-date-object", "invalid-date-string",
  "missing", "non-finite-number", "null", "zero"
];
const FINITE_DATE_OR_NUMBER_PARTITIONS = STRICT_DATE_PARTITIONS.filter((partition) => partition !== "zero");
const ID = "[A-Za-z_$][A-Za-z0-9_$]*";
const INTRINSICS = ["NaN", "Date", "Number", "RegExp", "TypeError"];

function compact(value) { return String(value ?? "").replace(/\s+/g, ""); }
function escaped(value) { return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function failedProof(candidate = false) { return { generic: false, candidate, partitions: new Set() }; }

function exactField(callable, exact, fallback) {
  return callable?.[exact] ?? callable?.[fallback];
}

function exactName(callable) { return exactField(callable, "exactDeclarationName", "declarationName"); }
function exactParameters(callable) { return exactField(callable, "exactParameters", "exactParameters") ?? []; }
function exactBody(callable) { return exactField(callable, "exactBody", "body") ?? ""; }
function exactSource(callable) { return exactField(callable, "exactSourceCode", "sourceCode") ?? ""; }
function exactDepth(callable) { return exactField(callable, "exactBraceDepth", "braceDepth"); }
function exactKind(callable) { return exactField(callable, "exactDeclarationKind", "declarationKind"); }

function uniqueCaseFolded(values) {
  const folded = values.map((value) => String(value).toLowerCase());
  return values.every((value) => new RegExp(`^${ID}$`).test(String(value))) && new Set(folded).size === folded.length;
}

function exactCallable(bodies, name) {
  if (!name || !new RegExp(`^${ID}$`).test(name)) return null;
  const candidates = (bodies.exactDeclarations ?? bodies.declarations ?? [])
    .filter((item) => item.name === name);
  if (candidates.length !== 1) return null;
  const callable = bodies.get(name.toLowerCase());
  return callable && exactName(callable) === name ? callable : null;
}

function exactFunction(callable, parameterCount) {
  const parameters = exactParameters(callable);
  const parameterSource = compact(exactField(callable, "exactParameterSource", "parameterSource"));
  return Boolean(callable)
    && exactKind(callable) === "function-declaration"
    && exactDepth(callable) === 0
    && callable.asynchronous === false
    && callable.ownsArguments === true
    && parameters.length === parameterCount
    && parameterSource === parameters.join(",")
    && (exactField(callable, "exactDefaultedParameters", "defaultedParameters") ?? []).length === 0
    && uniqueCaseFolded([exactName(callable), ...parameters]);
}

function intrinsicEnvironmentIsClosed(source, names) {
  const code = String(source ?? "");
  for (const intrinsic of INTRINSICS) {
    if ([...code.matchAll(new RegExp(`\\b${intrinsic}\\b`, "gi"))].some((match) => match[0] !== intrinsic)) return false;
  }
  if (names.some((name) => INTRINSICS.some((intrinsic) => name.toLowerCase() === intrinsic.toLowerCase()))) return false;
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
  if (!publicChain) return null;
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
  if (!intrinsicEnvironmentIsClosed(source, allNames)) return null;
  return { publicChain, expiry, now };
}

/**
 * Prove only the retained closed sentinel module. The proof is intentionally
 * whole-module: a valid-looking leaf or guard cannot survive an extra binding,
 * write, control path, case-fold collision, or indirect dependency edge.
 */
export function invalidSentinelRejectionProof({
  bodies, name, requestedErrors = [], requestedPartitions = [], requiredInputNames = null
}) {
  if (!requestedErrors.includes("typeerror")) return failedProof();
  const publicCallable = bodies.get(name);
  const publicName = exactName(publicCallable);
  if (!publicCallable || !publicName) return failedProof();
  const closed = closedModuleProof(bodies, publicName);
  if (!closed) return failedProof();
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
    return { generic: true, candidate: true, partitions: new Set(closed.now.partitions) };
  }
  return failedProof(true);
}

import { evidenceTopLevelArguments } from "./acceptance-executable-evidence.js";
import { rejectionStatementErrorClass } from "./acceptance-error-classes.js";
import { retainedExpiryCalendarProof } from "./acceptance-expiry-calendar-proof.js";

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function balancedEnd(text, openIndex, opening = "(", closing = ")", ceiling = 8_000) {
  if (text[openIndex] !== opening) return -1;
  let depth = 0;
  for (let index = openIndex; index < Math.min(text.length, openIndex + ceiling); index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing && --depth === 0) return index + 1;
  }
  return -1;
}

function braceDepthAt(text, offset) {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function priorUnconditionalExit(text, offset) {
  for (const match of text.slice(0, offset).matchAll(/\b(?:return|throw)\b/g)) {
    if (braceDepthAt(text, match.index) !== 0) continue;
    const statementStart = Math.max(text.lastIndexOf(";", match.index - 1), text.lastIndexOf("}", match.index - 1)) + 1;
    if (!text.slice(statementStart, match.index).trim()) return true;
  }
  return false;
}

function inputNameWrittenBefore(callable, name, offset) {
  const prefix = callable.body.slice(0, offset);
  const escaped = escapeRegex(name);
  for (const match of prefix.matchAll(new RegExp(`\\b${escaped}\\b(?:\\s*(?:\\.[a-z_$][a-z0-9_$]*|\\[[^\\]]+\\]))?\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=)`, "gi"))) {
    const declarationPrefix = prefix.slice(Math.max(0, match.index - 12), match.index);
    if (/\bconst\s*$/i.test(declarationPrefix) && !/[.[]/.test(match[0].slice(name.length))) continue;
    return true;
  }
  return new RegExp(`(?:\\+\\+|--)\\s*\\b${escaped}\\b`, "i").test(prefix);
}

function terminalError(callable, requestedErrors) {
  for (const match of callable.body.matchAll(/\bthrow\s+(?:new\s+)?[a-z_$][a-z0-9_$]*\s*\(/gi)) {
    if (braceDepthAt(callable.body, match.index) !== 0 || priorUnconditionalExit(callable.body, match.index)) continue;
    const statementStart = Math.max(callable.body.lastIndexOf(";", match.index - 1), callable.body.lastIndexOf("}", match.index - 1)) + 1;
    if (callable.body.slice(statementStart, match.index).trim()) continue;
    const open = match.index + match[0].lastIndexOf("(");
    const end = balancedEnd(callable.body, open);
    if (end === -1) continue;
    let cursor = end;
    while (/\s/.test(callable.body[cursor] ?? "")) cursor += 1;
    if (callable.body[cursor] === ";") cursor += 1;
    if (callable.body.slice(cursor).trim()) continue;
    const errorClass = rejectionStatementErrorClass(callable.body.slice(match.index), requestedErrors);
    if (errorClass) return errorClass;
  }
  return null;
}

function withoutOuterParentheses(raw) {
  let value = raw.trim();
  while (value.startsWith("(") && balancedEnd(value, 0) === value.length) value = value.slice(1, -1).trim();
  return value;
}

function topLevelConjuncts(condition) {
  if (/\|\||\?|(?<![=!<>])=(?!=|>)/.test(condition)) return [];
  const parts = [];
  let start = 0, parentheses = 0, brackets = 0;
  for (let index = 0; index < condition.length; index += 1) {
    if (condition[index] === "(") parentheses += 1;
    else if (condition[index] === ")") parentheses -= 1;
    else if (condition[index] === "[") brackets += 1;
    else if (condition[index] === "]") brackets -= 1;
    else if (condition[index] === "," && parentheses === 0 && brackets === 0) return [];
    else if (condition.slice(index, index + 2) === "&&" && parentheses === 0 && brackets === 0) {
      parts.push(condition.slice(start, index));
      start = index + 2;
      index += 1;
    }
    if (parentheses < 0 || brackets < 0) return [];
  }
  if (parentheses !== 0 || brackets !== 0) return [];
  parts.push(condition.slice(start));
  return parts.map(withoutOuterParentheses).filter(Boolean);
}

function topLevelDisjuncts(condition) {
  if (/&&|\?|(?<![=!<>])=(?!=|>)/.test(condition)) return [];
  const parts = [];
  let start = 0, parentheses = 0, brackets = 0;
  for (let index = 0; index < condition.length; index += 1) {
    if (condition[index] === "(") parentheses += 1;
    else if (condition[index] === ")") parentheses -= 1;
    else if (condition[index] === "[") brackets += 1;
    else if (condition[index] === "]") brackets -= 1;
    else if (condition[index] === "," && parentheses === 0 && brackets === 0) return [];
    else if (condition.slice(index, index + 2) === "||" && parentheses === 0 && brackets === 0) {
      parts.push(condition.slice(start, index));
      start = index + 2;
      index += 1;
    }
    if (parentheses < 0 || brackets < 0) return [];
  }
  if (parentheses !== 0 || brackets !== 0) return [];
  parts.push(condition.slice(start));
  return parts.map(withoutOuterParentheses).filter(Boolean);
}

function topLevelCommaParts(value) {
  const parts = [];
  let start = 0, parentheses = 0, brackets = 0, braces = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") parentheses += 1;
    else if (value[index] === ")") parentheses -= 1;
    else if (value[index] === "[") brackets += 1;
    else if (value[index] === "]") brackets -= 1;
    else if (value[index] === "{") braces += 1;
    else if (value[index] === "}") braces -= 1;
    else if (value[index] === "," && parentheses === 0 && brackets === 0 && braces === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
    if (parentheses < 0 || brackets < 0 || braces < 0) return [];
  }
  if (parentheses !== 0 || brackets !== 0 || braces !== 0) return [];
  parts.push(value.slice(start));
  return parts.map((item) => item.trim()).filter(Boolean);
}

function positiveGuardForNames(condition, names, auxiliaryNames) {
  const clauses = topLevelConjuncts(condition);
  if (clauses.length === 0) return false;
  const auxiliaries = auxiliaryNames.filter((name) => !names.includes(name));
  let positive = false;
  for (const clause of clauses) {
    const flag = clause.match(/^!?\s*([a-z_$][a-z0-9_$]*)$/i)?.[1]?.toLowerCase();
    if (flag && auxiliaries.includes(flag)) continue;
    const matchesGuard = names.some((name) => {
      const escaped = escapeRegex(name);
      return new RegExp(`^typeof\\s+${escaped}\\b\\s*={2,3}\\s*__pi_[a-z0-9_]+__$`, "i").test(clause)
        || new RegExp(`^${escaped}\\s+instanceof\\s+[a-z_$][a-z0-9_$]*$`, "i").test(clause)
        || new RegExp(`^(?:number\\.is(?:finite|integer|safeinteger)|array\\.isarray)\\s*\\(\\s*${escaped}\\s*\\)$`, "i").test(clause)
        || new RegExp(`^${escaped}\\s*!={1,2}\\s*(?:null|undefined)$`, "i").test(clause);
    });
    const derived = names.map(escapeRegex).join("|");
    const boundedDerivedComparison = derived && new RegExp(`^(?:${derived}|-?\\d+)\\s*(?:<=|>=|<|>)\\s*(?:${derived}|-?\\d+)$`, "i").test(clause);
    if (!matchesGuard && !boundedDerivedComparison) return false;
    positive = true;
  }
  return positive;
}

function skipWhitespace(text, offset) {
  let cursor = offset;
  while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function statementEnd(text, start) {
  const cursor = skipWhitespace(text, start);
  if (text[cursor] === "{") return balancedEnd(text, cursor, "{", "}");
  const semicolon = text.indexOf(";", cursor);
  return semicolon === -1 ? -1 : semicolon + 1;
}

function ifStatementAt(text, offset) {
  const match = text.slice(offset).match(/^if\s*\(/i);
  if (!match) return null;
  const conditionOpen = offset + match[0].lastIndexOf("(");
  const conditionEnd = balancedEnd(text, conditionOpen);
  if (conditionEnd === -1) return null;
  const consequentStart = skipWhitespace(text, conditionEnd);
  const consequentEnd = statementEnd(text, consequentStart);
  if (consequentEnd === -1) return null;
  return {
    condition: text.slice(conditionOpen + 1, conditionEnd - 1),
    consequent: text.slice(consequentStart, consequentEnd),
    consequentStart,
    consequentEnd
  };
}

function blockStackAt(text, offset) {
  const stack = [];
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "{") stack.push(index);
    else if (text[index] === "}") stack.pop();
  }
  return stack;
}

function visibleConstBindings(text, returnOffset) {
  const returnBlocks = blockStackAt(text, returnOffset);
  const candidates = [];
  for (const match of text.slice(0, returnOffset).matchAll(/\bconst\s+/gi)) {
    const declarationBlocks = blockStackAt(text, match.index);
    if (!declarationBlocks.every((block, index) => returnBlocks[index] === block)) continue;
    const semicolon = text.indexOf(";", match.index + match[0].length);
    if (semicolon === -1 || semicolon >= returnOffset) continue;
    for (const part of topLevelCommaParts(text.slice(match.index + match[0].length, semicolon))) {
      const declaration = part.match(/^([a-z_$][a-z0-9_$]*)\s*=\s*([\s\S]+)$/i);
      if (declaration) candidates.push({
        name: declaration[1].toLowerCase(), start: match.index, end: semicolon + 1,
        initializer: declaration[2].trim(), depth: declarationBlocks.length
      });
    }
  }
  return candidates;
}

function visibleConstBinding(text, name, returnOffset) {
  const candidates = visibleConstBindings(text, returnOffset).filter((item) => item.name === name.toLowerCase());
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => right.depth - left.depth || right.start - left.start);
  return candidates[0];
}

function visibleDerivedBinding(text, name, returnOffset, seedNames) {
  const selected = visibleConstBinding(text, name, returnOffset);
  if (!selected) return null;
  let transform = null;
  seedNames.some((seed) => {
    const input = escapeRegex(seed);
    if (new RegExp(`^date\\s*\\.\\s*parse\\s*\\(\\s*${input}\\s*\\)$`, "i").test(selected.initializer)) transform = "date-string";
    else if (new RegExp(`^${input}\\s*\\.\\s*gettime\\s*\\(\\s*\\)$`, "i").test(selected.initializer)) transform = "date-object";
    else if (new RegExp(`^${input}\\s+instanceof\\s+date\\s*\\?\\s*${input}\\s*\\.\\s*gettime\\s*\\(\\s*\\)\\s*:\\s*date\\s*\\.\\s*parse\\s*\\(\\s*${input}\\s*\\)$`, "i").test(selected.initializer)) transform = "date-string";
    return Boolean(transform);
  });
  return transform ? { ...selected, transform } : null;
}

function invalidDerivedCondition(condition, name) {
  const value = withoutOuterParentheses(condition);
  const escaped = escapeRegex(name);
  return new RegExp(`^number\\s*\\.\\s*isnan\\s*\\(\\s*${escaped}\\s*\\)$`, "i").test(value)
    || new RegExp(`^!\\s*number\\s*\\.\\s*isfinite\\s*\\(\\s*${escaped}\\s*\\)$`, "i").test(value);
}

function positiveDerivedCondition(condition, name) {
  const escaped = escapeRegex(name);
  return topLevelConjuncts(condition).some((clause) => (
    new RegExp(`^!\\s*number\\s*\\.\\s*isnan\\s*\\(\\s*${escaped}\\s*\\)$`, "i").test(clause)
      || new RegExp(`^number\\s*\\.\\s*isfinite\\s*\\(\\s*${escaped}\\s*\\)$`, "i").test(clause)
  ));
}

function exactRejectionClass(statement, requestedErrors) {
  let value = statement.trim();
  if (value.startsWith("{") && balancedEnd(value, 0, "{", "}") === value.length) {
    value = value.slice(1, -1).trim();
  }
  return rejectionStatementErrorClass(value, requestedErrors);
}

function adjacentInvalidRejection(text, binding, returnOffset, name, requestedErrors) {
  const guardStart = skipWhitespace(text, binding.end);
  const guard = ifStatementAt(text, guardStart);
  if (!guard || !invalidDerivedCondition(guard.condition, name)
    || !exactRejectionClass(guard.consequent, requestedErrors)) return false;
  return skipWhitespace(text, guard.consequentEnd) === returnOffset;
}

function enclosingPositiveValidation(text, binding, returnOffset, name) {
  for (const match of text.matchAll(/\bif\s*\(/gi)) {
    if (match.index <= binding.start || match.index >= returnOffset) continue;
    const guard = ifStatementAt(text, match.index);
    if (!guard || returnOffset < guard.consequentStart || returnOffset >= guard.consequentEnd) continue;
    if (positiveDerivedCondition(guard.condition, name)) return true;
  }
  return false;
}

function invalidCalendarBounds(condition, month, day, daysPattern, timestampName) {
  const clauses = topLevelDisjuncts(condition);
  if (clauses.length < 4 || clauses.length > 5) return false;
  const has = (pattern) => clauses.some((clause) => pattern.test(clause));
  return has(new RegExp(`^(?:${escapeRegex(month)}\\s*<\\s*1|1\\s*>\\s*${escapeRegex(month)})$`, "i"))
    && has(new RegExp(`^(?:${escapeRegex(month)}\\s*>\\s*12|12\\s*<\\s*${escapeRegex(month)})$`, "i"))
    && has(new RegExp(`^(?:${escapeRegex(day)}\\s*<\\s*1|1\\s*>\\s*${escapeRegex(day)})$`, "i"))
    && has(new RegExp(`^(?:${escapeRegex(day)}\\s*>\\s*${daysPattern}|${daysPattern}\\s*<\\s*${escapeRegex(day)})$`, "i"))
    && (clauses.length === 4 || clauses.some((clause) => invalidDerivedCondition(clause, timestampName)));
}

function calendarDateStringValidation(text, binding, returnOffset, timestampName, seedNames, requestedErrors) {
  if (binding.transform !== "date-string") return false;
  const findVisible = (pattern) => {
    const candidates = visibleConstBindings(text, returnOffset).filter((candidate) => pattern(candidate.initializer));
    candidates.sort((left, right) => right.depth - left.depth || right.start - left.start);
    return candidates[0] ?? null;
  };
  for (const seed of seedNames) {
    const escapedSeed = escapeRegex(seed);
    const captureBinding = findVisible((value) => new RegExp(`^__pi_iso_calendar_capture_regex_literal__\\s*\\.\\s*exec\\s*\\(\\s*${escapedSeed}\\s*\\)$`, "i").test(value));
    if (!captureBinding) continue;
    const capture = captureBinding.name;
    const component = (index) => findVisible((value) => new RegExp(`^number\\s*\\(\\s*${escapeRegex(capture)}\\s*\\[\\s*${index}\\s*\\]\\s*\\)$`, "i").test(value));
    const yearBinding = component(1), monthBinding = component(2), dayBinding = component(3);
    if (!yearBinding || !monthBinding || !dayBinding) continue;
    const year = yearBinding.name, month = monthBinding.name, day = dayBinding.name;
    const inlineDays = `new\\s+date\\s*\\(\\s*date\\s*\\.\\s*utc\\s*\\(\\s*${escapeRegex(year)}\\s*,\\s*${escapeRegex(month)}\\s*,\\s*0\\s*\\)\\s*\\)\\s*\\.\\s*getutcdate\\s*\\(\\s*\\)`;
    const daysBinding = findVisible((value) => new RegExp(`^${inlineDays}$`, "i").test(value));
    const daysPattern = daysBinding ? `(?:${escapeRegex(daysBinding.name)}|${inlineDays})` : `(?:${inlineDays})`;
    const calendarBindingsEnd = Math.max(yearBinding.end, monthBinding.end, dayBinding.end, daysBinding?.end ?? 0);
    let captureGuard = false, boundsGuard = false, timestampGuard = false;
    for (const match of text.matchAll(/\bif\s*\(/gi)) {
      const guard = ifStatementAt(text, match.index);
      if (!guard) continue;
      const condition = withoutOuterParentheses(guard.condition);
      const exactError = exactRejectionClass(guard.consequent, requestedErrors);
      if (match.index >= captureBinding.end && match.index < binding.start && new RegExp(`^!\\s*${escapeRegex(capture)}$`, "i").test(condition)
        && exactRejectionClass(guard.consequent, requestedErrors)) captureGuard = true;
      const topLevelCalendarGuard = braceDepthAt(text, match.index) === 0
        && match.index >= calendarBindingsEnd && match.index < returnOffset;
      if (topLevelCalendarGuard && exactError
        && invalidCalendarBounds(condition, month, day, daysPattern, timestampName)) boundsGuard = true;
      const topLevelTimestampGuard = braceDepthAt(text, match.index) === 0
        && match.index >= binding.end && match.index < returnOffset;
      if (topLevelTimestampGuard && exactError) {
        const invalidClauses = topLevelDisjuncts(condition);
        if (invalidDerivedCondition(condition, timestampName)) timestampGuard = true;
        if (invalidClauses.length === 2
          && invalidClauses.some((clause) => new RegExp(`^!\\s*${escapeRegex(capture)}$`, "i").test(clause))
          && invalidClauses.some((clause) => invalidDerivedCondition(clause, timestampName))) {
          captureGuard = true;
          timestampGuard = true;
        }
        if (invalidCalendarBounds(condition, month, day, daysPattern, timestampName)) {
          boundsGuard = true;
          if (invalidClauses.some((clause) => invalidDerivedCondition(clause, timestampName))) timestampGuard = true;
        }
      }
      if (returnOffset < guard.consequentStart || returnOffset >= guard.consequentEnd) continue;
      if (new RegExp(`^${escapeRegex(capture)}$`, "i").test(condition)) captureGuard = true;
      const clauses = topLevelConjuncts(condition);
      const has = (pattern) => clauses.some((clause) => pattern.test(clause));
      const positiveBounds = has(new RegExp(`^(?:${escapeRegex(month)}\\s*>=\\s*1|1\\s*<=\\s*${escapeRegex(month)})$`, "i"))
        && has(new RegExp(`^(?:${escapeRegex(month)}\\s*<=\\s*12|12\\s*>=\\s*${escapeRegex(month)})$`, "i"))
        && has(new RegExp(`^(?:${escapeRegex(day)}\\s*>=\\s*1|1\\s*<=\\s*${escapeRegex(day)})$`, "i"))
        && has(new RegExp(`^(?:${escapeRegex(day)}\\s*<=\\s*${daysPattern}|${daysPattern}\\s*>=\\s*${escapeRegex(day)})$`, "i"))
        && positiveDerivedCondition(condition, timestampName);
      if (positiveBounds) { boundsGuard = true; timestampGuard = true; }
    }
    if (captureGuard && boundsGuard && timestampGuard) return true;
  }
  return false;
}

function returnIsPathValidated(text, expression, returnOffset, seedNames, requestedErrors) {
  const identifier = expression.match(/^([a-z_$][a-z0-9_$]*)$/i)?.[1]?.toLowerCase();
  if (!identifier) return { proven: false, partitions: new Set() };
  if (seedNames.includes(identifier)) return { proven: true, partitions: new Set() };
  const binding = visibleDerivedBinding(text, identifier, returnOffset, seedNames);
  if (!binding) return { proven: false, partitions: new Set() };
  const calendarProven = calendarDateStringValidation(text, binding, returnOffset, identifier, seedNames, requestedErrors);
  const proven = adjacentInvalidRejection(text, binding, returnOffset, identifier, requestedErrors)
    || enclosingPositiveValidation(text, binding, returnOffset, identifier) || calendarProven;
  const partition = binding.transform === "date-object" ? "invalid-date-object" : "invalid-date-string";
  const partitions = new Set(proven ? [partition] : []);
  if (calendarProven) partitions.add("invalid-calendar-date-string");
  return { proven, partitions };
}

function branchReturns(consequent, seedNames, requestedErrors, absoluteStart, context = consequent) {
  const returns = [];
  for (const match of consequent.matchAll(/\breturn\b/gi)) {
    const tail = consequent.slice(match.index + match[0].length);
    const expression = tail.slice(0, [tail.indexOf(";"), tail.indexOf("\n")]
      .filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? tail.length).trim();
    const proof = expression
      ? returnIsPathValidated(context, expression, absoluteStart + match.index, seedNames, requestedErrors)
      : { proven: false, partitions: new Set() };
    returns.push({ offset: absoluteStart + match.index, ...proof });
  }
  return returns;
}

function eagerReturnInvocation(callable, statementStart, matchIndex, callEnd) {
  const semicolonEnd = callable.body.indexOf(";", callEnd);
  const newlineEnd = callable.body.indexOf("\n", callEnd);
  const statementEnd = semicolonEnd >= 0
    ? semicolonEnd
    : newlineEnd >= 0 ? newlineEnd : callable.body.length;
  if (matchIndex < statementStart || callEnd > statementEnd) return false;
  const statement = callable.body.slice(statementStart, statementEnd).trim();
  const expression = statement.match(/^return\s+([\s\S]+)$/i)?.[1]?.trim();
  if (!expression) return false;
  const eagerExpression = expression.replace(/arguments\s*\.\s*length\s*<\s*\d+\s*\?\s*date\s*\.\s*now\s*\(\s*\)\s*:\s*[a-z_$][a-z0-9_$]*/gi, "__pi_default_selection__");
  // Calls nested in eager operators still execute before the return settles.
  // Reject every short-circuit/lazy form so a normalizer can never be skipped.
  return !/=>|\b(?:function|class)\b|&&|\|\||\?\?|\?/i.test(eagerExpression);
}

function intrinsicBindingsStable(code, callable) {
  const baseIntrinsic = "(?:date|number|regexp|array)";
  if (/\b(?:globalthis|global)\b/i.test(code) || callable.parameters.some((name) => /^(?:date|number|regexp|array)$/i.test(name))) return false;
  if (new RegExp(`\\b(?:function|class)\\s+${baseIntrinsic}\\b|\\b(?:const|let|var)\\s+(?:${baseIntrinsic}\\b|\\{[^}\\n]{0,500}\\b${baseIntrinsic}\\b|\\[[^\\]\\n]{0,500}\\b${baseIntrinsic}\\b)|\\bimport\\b[^;\\n]{0,500}\\b${baseIntrinsic}\\b`, "i").test(code)) return false;
  if (new RegExp(`(?:\\{[^}\\n]{0,500}\\b${baseIntrinsic}\\b[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${baseIntrinsic}\\b[^\\]\\n]{0,500}\\])\\s*=`, "i").test(code)) return false;
  const trusted = new Set(["date", "number", "regexp", "array"]);
  for (let pass = 0; pass < 4; pass += 1) {
    for (const match of code.matchAll(/\b(?:const|let|var)\s+([^;\n]{1,1000})(?:;|\n|$)/gi)) {
      for (const part of topLevelCommaParts(match[1])) {
        const declaration = part.match(/^([a-z_$][a-z0-9_$]*)\s*=\s*([\s\S]+)$/i);
        if (!declaration) continue;
        const referencesIntrinsic = [...trusted].some((name) => new RegExp(`(?<![.$a-z0-9_])${escapeRegex(name)}\\b`, "i").test(declaration[2]));
        const invokesValue = /\b(?:new\s+)?[a-z_$][a-z0-9_$]*(?:\s*\.\s*[a-z_$][a-z0-9_$]*)*\s*\(/i.test(declaration[2]);
        if (referencesIntrinsic && !invokesValue) {
          trusted.add(declaration[1].toLowerCase());
        }
      }
    }
  }
  const intrinsic = `(?:${[...trusted].map(escapeRegex).join("|")})`;
  const target = `${intrinsic}(?:(?:\\s*\\.\\s*[a-z_$][a-z0-9_$]*)|(?:\\s*\\[[^\\]\\n]{1,300}\\])){0,4}`;
  if (new RegExp(`(?<![.$a-z0-9_])${target}\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=)|(?:\\+\\+|--)\\s*(?<![.$a-z0-9_])${target}`, "i").test(code)) return false;
  if (new RegExp(`\\b(?:object\\s*\\.\\s*(?:assign|defineproperties|defineproperty|setprototypeof)|reflect\\s*\\.\\s*(?:defineproperty|set|setprototypeof))\\s*\\(\\s*${target}\\s*[,)]`, "i").test(code)) return false;
  return !new RegExp(`(?<![.$a-z0-9_])${target}\\s*\\.\\s*__(?:definegetter|definesetter)__\\s*\\(`, "i").test(code);
}

function modeledGuardCondition(condition, safeNumericNames = new Set()) {
  const numericNames = new Set(safeNumericNames);
  let value = withoutOuterParentheses(condition);
  value = value.replace(/new\s+date\s*\(\s*date\s*\.\s*utc\s*\(\s*([a-z_$][a-z0-9_$]*)\s*,\s*([a-z_$][a-z0-9_$]*)\s*,\s*0\s*\)\s*\)\s*\.\s*getutcdate\s*\(\s*\)/gi,
    (expression, year, month) => {
      if (!numericNames.has(year.toLowerCase()) || !numericNames.has(month.toLowerCase())) return expression;
      numericNames.add("__pi_calendar_days_value__");
      return "__pi_calendar_days_value__";
    });
  if (!value || /[?;{},`]|=>|(?<![=!<>])=(?!=|>)|\+\+|--|\b(?:new|delete|await|yield)\b/i.test(value)) return false;
  const arithmetic = value.replace(/-\s*\d+(?:\.\d+)?/g, "");
  if (/[+*/%]/.test(arithmetic) || /\b[a-z_$][a-z0-9_$]*\s*-\s*[a-z_$0-9]/i.test(arithmetic)) return false;
  for (const match of value.matchAll(/\b([a-z_$][a-z0-9_$]*(?:\s*\.\s*[a-z_$][a-z0-9_$]*)*)\s*\(/gi)) {
    if (!/^(?:number\s*\.\s*(?:isnan|isfinite|isinteger|issafeinteger)|array\s*\.\s*isarray)$/i.test(match[1])) return false;
  }
  for (const match of value.matchAll(/\b([a-z_$][a-z0-9_$]*)\s*\.\s*([a-z_$][a-z0-9_$]*)/gi)) {
    const member = `${match[1]}.${match[2]}`;
    const tail = value.slice(match.index + match[0].length);
    if (!/^(?:number\.(?:isnan|isfinite|isinteger|issafeinteger)|array\.isarray)$/i.test(member)
      || !/^\s*\(/.test(tail)) return false;
  }
  const relationPattern = /([a-z_$][a-z0-9_$]*|-?\d+(?:\.\d+)?)\s*(?:<=|>=|<|>)\s*([a-z_$][a-z0-9_$]*|-?\d+(?:\.\d+)?)/gi;
  for (const relation of value.matchAll(relationPattern)) {
    if (relation.slice(1).some((operand) => /^[a-z_$]/i.test(operand) && !numericNames.has(operand.toLowerCase()))) return false;
  }
  if (/[<>]/.test(value.replace(relationPattern, ""))) return false;
  return !/[\[\]]/.test(value) && /^[a-z0-9_$\.\s!<>=&|()+*-]+$/i.test(value);
}

function rewrittenCalendarCaptureAliases(raw, forbiddenBindings = []) {
  const text = String(raw ?? "");
  const capturePattern = /\bconst\s+([a-z_$][a-z0-9_$]*)\s*=\s*__pi_iso_calendar_capture_regex_literal__\s*\.\s*exec\s*\(\s*[a-z_$][a-z0-9_$]*\s*\)\s*;/gi;
  const captures = [...text.matchAll(capturePattern)];
  const destructured = [];
  for (const capture of captures) {
    const name = capture[1], escaped = escapeRegex(name);
    const pattern = new RegExp(`\\bconst\\s*\\[([^\\]\\n]{1,300})\\]\\s*=\\s*${escaped}\\s*;`, "gi");
    for (const match of text.matchAll(pattern)) {
      if (match.index > capture.index + capture[0].length) destructured.push({ capture: name, match });
    }
  }
  if (destructured.length === 0) return text;
  if (destructured.length !== 1) return null;

  const [{ capture, match }] = destructured;
  const slots = match[1].split(",").map((item) => item.trim());
  if (slots.length < 4 || slots.some((item) => item && !/^[a-z_$][a-z0-9_$]*$/i.test(item))) return null;
  const aliases = slots.map((item) => item.toLowerCase()).filter(Boolean);
  if (new Set(aliases).size !== aliases.length) return null;

  const start = match.index, end = start + match[0].length;
  const protectedBindings = new Set([
    capture.toLowerCase(), ...forbiddenBindings.map((item) => String(item).toLowerCase()),
    "arguments", "array", "date", "number", "object", "reflect", "regexp", "undefined",
    "aggregateerror", "error", "evalerror", "rangeerror", "referenceerror", "syntaxerror", "typeerror", "urierror"
  ]);
  const surrounding = `${text.slice(0, start)}${text.slice(end)}`;
  if (aliases.some((alias) => protectedBindings.has(alias)
    || new RegExp(`\\b(?:function|class|const|let|var)\\s+${escapeRegex(alias)}\\b`, "i").test(surrounding))) return null;
  let suffix = text.slice(end), residual = suffix;
  const bindings = [];
  for (let index = 1; index < slots.length; index += 1) {
    const alias = slots[index];
    if (!alias) continue;
    const escaped = escapeRegex(alias);
    const numeric = new RegExp(`\\bnumber\\s*\\(\\s*${escaped}\\s*\\)`, "gi");
    const hasNumericUse = numeric.test(suffix);
    numeric.lastIndex = 0;
    suffix = suffix.replace(numeric, alias);
    numeric.lastIndex = 0;
    residual = residual.replace(numeric, "");

    const forwardUndefined = new RegExp(`\\b${escaped}\\b\\s*!={1,2}\\s*undefined\\b`, "gi");
    const reverseUndefined = new RegExp(`\\bundefined\\b\\s*!={1,2}\\s*${escaped}\\b`, "gi");
    if ((forwardUndefined.test(suffix) || reverseUndefined.test(suffix)) && !hasNumericUse) return null;
    forwardUndefined.lastIndex = 0;
    reverseUndefined.lastIndex = 0;
    suffix = suffix.replace(forwardUndefined, `!Number.isNaN(${alias})`)
      .replace(reverseUndefined, `!Number.isNaN(${alias})`);
    residual = residual.replace(forwardUndefined, "").replace(reverseUndefined, "");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(residual)) return null;
    if (hasNumericUse) bindings.push(`${alias} = Number(${capture}[${index}])`);
  }
  if (slots.slice(1, 4).some((alias) => !bindings.some((binding) => binding.startsWith(`${alias} =`)))) return null;
  return `${text.slice(0, start)}const ${bindings.join(", ")};${suffix}`;
}

function pureNormalizerInitializer(raw) {
  const value = String(raw ?? "").trim(), name = "[a-z_$][a-z0-9_$]*";
  return new RegExp(`^(?:date\\s*\\.\\s*parse\\s*\\(\\s*${name}\\s*\\)|${name}\\s*\\.\\s*gettime\\s*\\(\\s*\\)|__pi_iso_calendar_capture_regex_literal__\\s*\\.\\s*exec\\s*\\(\\s*${name}\\s*\\)|number\\s*\\(\\s*${name}\\s*\\[\\s*[1-9][0-9]?\\s*\\]\\s*\\)|new\\s+date\\s*\\(\\s*date\\s*\\.\\s*utc\\s*\\(\\s*${name}\\s*,\\s*${name}\\s*,\\s*0\\s*\\)\\s*\\)\\s*\\.\\s*getutcdate\\s*\\(\\s*\\)|${name}\\s+instanceof\\s+date\\s*\\?\\s*${name}\\s*\\.\\s*gettime\\s*\\(\\s*\\)\\s*:\\s*date\\s*\\.\\s*parse\\s*\\(\\s*${name}\\s*\\))$`, "i").test(value);
}

function numericNormalizerInitializer(raw) {
  const value = String(raw ?? "").trim(), name = "[a-z_$][a-z0-9_$]*";
  return new RegExp(`^(?:date\\s*\\.\\s*parse\\s*\\(\\s*${name}\\s*\\)|${name}\\s*\\.\\s*gettime\\s*\\(\\s*\\)|number\\s*\\(\\s*${name}\\s*\\[\\s*[1-9][0-9]?\\s*\\]\\s*\\)|new\\s+date\\s*\\(\\s*date\\s*\\.\\s*utc\\s*\\(\\s*${name}\\s*,\\s*${name}\\s*,\\s*0\\s*\\)\\s*\\)\\s*\\.\\s*getutcdate\\s*\\(\\s*\\)|${name}\\s+instanceof\\s+date\\s*\\?\\s*${name}\\s*\\.\\s*gettime\\s*\\(\\s*\\)\\s*:\\s*date\\s*\\.\\s*parse\\s*\\(\\s*${name}\\s*\\))$`, "i").test(value);
}

function modeledTopLevelStatements(text, requestedErrors, inheritedNumericNames = new Set()) {
  const safeNumericNames = new Set(inheritedNumericNames);
  let cursor = 0;
  while ((cursor = skipWhitespace(text, cursor)) < text.length) {
    if (text[cursor] === ";") { cursor += 1; continue; }
    const elseIf = text.slice(cursor).match(/^else\s+(?=if\b)/i);
    if (elseIf) cursor = skipWhitespace(text, cursor + elseIf[0].length);
    const guard = ifStatementAt(text, cursor);
    if (guard) {
      let consequent = guard.consequent.trim();
      if (!modeledGuardCondition(guard.condition, safeNumericNames)) return false;
      if (consequent.startsWith("{") && balancedEnd(consequent, 0, "{", "}") === consequent.length) consequent = consequent.slice(1, -1);
      if (!modeledTopLevelStatements(consequent, requestedErrors, safeNumericNames)) return false;
      cursor = guard.consequentEnd;
      continue;
    }
    const end = text.indexOf(";", cursor);
    if (end === -1) return false;
    const statement = text.slice(cursor, end + 1).trim();
    if (/^return\s+[a-z_$][a-z0-9_$]*\s*;$/i.test(statement) || exactRejectionClass(statement, requestedErrors)) {
      cursor = end + 1;
      continue;
    }
    const declaration = statement.match(/^const\s+([\s\S]+)\s*;$/i);
    const parts = declaration ? topLevelCommaParts(declaration[1]) : [];
    if (parts.length === 0) return false;
    for (const part of parts) {
      const item = part.match(/^([a-z_$][a-z0-9_$]*)\s*=\s*([\s\S]+)$/i);
      if (!item || !pureNormalizerInitializer(item[2])) return false;
      if (numericNormalizerInitializer(item[2])) safeNumericNames.add(item[1].toLowerCase());
    }
    cursor = end + 1;
  }
  return true;
}

export function synchronousNormalizerProof(input) {
  const { bodies, name, requestedErrors, requiredInputNames, inputDerivedNames, sourceCallableBindingIsStable, validationConditionProof } = input;
  const scannedCallable = bodies.get(name);
  const retainedExpiryProof = retainedExpiryCalendarProof(scannedCallable, requestedErrors);
  const rewrittenBody = scannedCallable && !retainedExpiryProof.recognized
    ? rewrittenCalendarCaptureAliases(scannedCallable.body, scannedCallable.parameters) : null;
  const callable = retainedExpiryProof.recognized ? scannedCallable
    : scannedCallable && rewrittenBody !== null ? { ...scannedCallable, body: rewrittenBody } : null;
  const candidate = Boolean(callable?.parameters?.length > 0 && /\breturn\s+[a-z_$][a-z0-9_$]*\s*(?:;|\n|$)/i.test(callable.body)
    && /\bthrow\s+(?:new\s+)?[a-z_$][a-z0-9_$]*\s*\(/i.test(callable.body));
  const fail = () => ({ generic: false, partitions: new Set(), candidate });
  if (!callable || callable.asynchronous || callable.parameters.length === 0
    || /\b(?:async|await|yield|try|catch|finally|function|class)\b|=>|\b(?:eval|with)\s*\(/i.test(callable.body)
    || !sourceCallableBindingIsStable({ text: callable.sourceCode }, name)
    || !intrinsicBindingsStable(callable.sourceCode, callable)) return fail();
  if (retainedExpiryProof.recognized) return retainedExpiryProof;
  if (!modeledTopLevelStatements(callable.body, requestedErrors)) return fail();

  const seeds = Array.isArray(requiredInputNames) && requiredInputNames.length > 0 ? requiredInputNames : callable.parameters;
  const names = inputDerivedNames(callable, seeds);
  for (const parameter of callable.parameters) {
    const escaped = escapeRegex(parameter);
    if (inputNameWrittenBefore(callable, parameter, callable.body.length)
      || new RegExp(`\\b(?:function|class|const|let|var)\\s+${escaped}\\b|\\bcatch\\s*\\([^)]*\\b${escaped}\\b`, "i").test(callable.body)
      || new RegExp(`\\b${escaped}(?:\\s*\\.\\s*[a-z_$][a-z0-9_$]*|\\s*\\[[^\\]]+\\]){0,4}\\s*\\.\\s*(?:copywithin|fill|pop|push|reverse|shift|sort|splice|unshift|set|add|delete|clear)\\s*\\(`, "i").test(callable.body)) {
      return fail();
    }
  }
  for (const derived of names) {
    if (inputNameWrittenBefore(callable, derived, callable.body.length)) return fail();
  }
  const hasTerminalError = Boolean(terminalError(callable, requestedErrors));

  const allReturns = [...callable.body.matchAll(/\breturn\b/gi)].map((match) => match.index);
  const coveredReturns = new Set();
  const partitions = new Set();
  for (const match of callable.body.matchAll(/\bif\s*\(/gi)) {
    if (braceDepthAt(callable.body, match.index) !== 0 || priorUnconditionalExit(callable.body, match.index)) continue;
    const conditionOpen = callable.body.indexOf("(", match.index);
    const conditionEnd = balancedEnd(callable.body, conditionOpen);
    if (conditionEnd === -1) continue;
    let consequentStart = conditionEnd;
    while (/\s/.test(callable.body[consequentStart] ?? "")) consequentStart += 1;
    const consequentEnd = callable.body[consequentStart] === "{"
      ? balancedEnd(callable.body, consequentStart, "{", "}")
      : (callable.body.indexOf(";", consequentStart) + 1 || callable.body.length);
    if (consequentEnd === -1) continue;
    const condition = callable.body.slice(conditionOpen + 1, conditionEnd - 1);
    const liveNames = names.filter((candidate) => !inputNameWrittenBefore(callable, candidate, match.index));
    const consequent = callable.body.slice(consequentStart, consequentEnd);
    if (exactRejectionClass(consequent, requestedErrors)) {
      const rejectionProof = validationConditionProof(condition, liveNames, bodies);
      if (rejectionProof.generic) {
        for (const partition of rejectionProof.partitions) partitions.add(partition);
      }
      continue;
    }
    const liveSeeds = seeds.filter((candidate) => !inputNameWrittenBefore(callable, candidate, match.index));
    const returns = branchReturns(consequent, liveSeeds, requestedErrors, consequentStart, callable.body);
    if (returns.length === 0) continue;
    const guardProof = validationConditionProof(condition, liveNames, bodies);
    if (!positiveGuardForNames(condition, liveNames, callable.parameters) || !guardProof.generic) return fail();
    if (returns.some((item) => !item.proven)) return fail();
    for (const partition of guardProof.partitions) partitions.add(partition);
    for (const item of returns) {
      coveredReturns.add(item.offset);
      for (const partition of item.partitions) partitions.add(partition);
    }
  }
  for (const match of callable.body.matchAll(/\breturn\b/gi)) {
    if (braceDepthAt(callable.body, match.index) !== 0) continue;
    const tail = callable.body.slice(match.index + match[0].length);
    const end = tail.indexOf(";");
    const proof = returnIsPathValidated(callable.body, tail.slice(0, end === -1 ? tail.length : end).trim(), match.index, seeds, requestedErrors);
    if (proof.proven) {
      coveredReturns.add(match.index);
      for (const partition of proof.partitions) partitions.add(partition);
    }
  }
  const generic = allReturns.length > 0 && allReturns.every((offset) => coveredReturns.has(offset));
  return { generic: generic && (hasTerminalError || partitions.size > 0), partitions, candidate };
}

export function exactNormalizerInvocation(input) {
  const { callable, matchIndex, callEnd, argumentsText, helper, helperParameters, inputDerivedNames,
    helperBindingIsShadowedInCallable, omissionSensitiveInputNames = [] } = input;
  if (callable.asynchronous || braceDepthAt(callable.body, matchIndex) !== 0
    || helperBindingIsShadowedInCallable(callable, helper) || /\b(?:try|catch|finally)\b/i.test(callable.body)) return { accepted: false, derivedParameters: [] };
  const statementStart = Math.max(callable.body.lastIndexOf(";", matchIndex - 1) + 1, callable.body.lastIndexOf("}", matchIndex - 1) + 1);
  if (priorUnconditionalExit(callable.body, statementStart)) return { accepted: false, derivedParameters: [] };
  const newlineEnd = callable.body.indexOf("\n", callEnd), semicolonEnd = callable.body.indexOf(";", callEnd);
  const statementEnd = [newlineEnd, semicolonEnd].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? callable.body.length;
  const prefix = callable.body.slice(statementStart, matchIndex).trim(), suffix = callable.body.slice(callEnd, statementEnd).trim();
  const exactStatement = !suffix && (prefix === "" || /^const\s+[a-z_$][a-z0-9_$]*\s*=\s*$/i.test(prefix) || /^return\s*$/i.test(prefix));
  const liveNames = inputDerivedNames(callable).filter((candidate) => !inputNameWrittenBefore(callable, candidate, matchIndex));
  const escapedHelper = escapeRegex(helper);
  const statement = callable.body.slice(statementStart, statementEnd).trim();
  const omittedThenNormalize = statement.match(new RegExp(`^const\\s+[a-z_$][a-z0-9_$]*\\s*=\\s*arguments\\s*\\.\\s*length\\s*<\\s*(\\d+)\\s*\\?\\s*date\\s*\\.\\s*now\\s*\\(\\s*\\)\\s*:\\s*${escapedHelper}\\s*\\(\\s*([a-z_$][a-z0-9_$]*)\\s*\\)$`, "i"));
  const normalizeThenOmitted = statement.match(new RegExp(`^const\\s+[a-z_$][a-z0-9_$]*\\s*=\\s*arguments\\s*\\.\\s*length\\s*>=\\s*(\\d+)\\s*\\?\\s*${escapedHelper}\\s*\\(\\s*([a-z_$][a-z0-9_$]*)\\s*\\)\\s*:\\s*date\\s*\\.\\s*now\\s*\\(\\s*\\)$`, "i"));
  const omissionSelection = omittedThenNormalize ?? normalizeThenOmitted;
  const wrapped = `(${argumentsText})`;
  const argumentsList = evidenceTopLevelArguments(wrapped, 0, wrapped.length).map((argument) => argument.trim());
  if (argumentsList.length === 0) return { accepted: false, derivedParameters: [] };
  const inlineOmissionSelection = (argument) => argument.match(/^arguments\s*\.\s*length\s*<\s*(\d+)\s*\?\s*date\s*\.\s*now\s*\(\s*\)\s*:\s*([a-z_$][a-z0-9_$]*)$/i)
    ?? argument.match(/^arguments\s*\.\s*length\s*>=\s*(\d+)\s*\?\s*([a-z_$][a-z0-9_$]*)\s*:\s*date\s*\.\s*now\s*\(\s*\)$/i);
  const omissionNames = Array.isArray(omissionSensitiveInputNames) && omissionSensitiveInputNames.length > 0
    ? inputDerivedNames(callable, omissionSensitiveInputNames) : [];
  const omissionInputReferenced = omissionNames.some((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, "i").test(argumentsText));
  if (omissionInputReferenced) {
    const exactStatementSelection = omissionSelection && omissionNames.includes(omissionSelection[2].toLowerCase())
      && Number(omissionSelection[1]) === callable.parameters.indexOf(omissionSelection[2].toLowerCase()) + 1;
    const exactInlineSelection = argumentsList.some((argument) => {
      const selection = inlineOmissionSelection(argument), name = selection?.[2]?.toLowerCase();
      return name && omissionNames.includes(name)
        && Number(selection[1]) === callable.parameters.indexOf(name) + 1;
    });
    const argumentsUses = callable.body.match(/\barguments\b/gi) ?? [];
    const inputUsedBeforeSelection = omissionNames.some((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, "i")
      .test(callable.body.slice(0, statementStart)));
    if (callable.ownsArguments !== true || callable.parameters.includes("arguments") || argumentsUses.length !== 1
      || inputUsedBeforeSelection || (!exactStatementSelection && !exactInlineSelection)) {
      return { accepted: false, derivedParameters: [] };
    }
  }
  if (omissionSelection) {
    const inputName = omissionSelection[2].toLowerCase();
    const exactThreshold = callable.parameters.indexOf(inputName) + 1;
    const inputUsedBeforeSelection = new RegExp(`\\b${escapeRegex(inputName)}\\b`, "i")
      .test(callable.body.slice(0, statementStart));
    if (!inputUsedBeforeSelection && liveNames.includes(inputName)
      && Number(omissionSelection[1]) === exactThreshold && helperParameters[0]) {
      return { accepted: true, derivedParameters: [helperParameters[0]] };
    }
    return { accepted: false, derivedParameters: [] };
  }
  if (!exactStatement && !eagerReturnInvocation(callable, statementStart, matchIndex, callEnd)) {
    return { accepted: false, derivedParameters: [] };
  }

  const derivedParameters = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const identifier = argument.match(/^([a-z_$][a-z0-9_$]*)$/i)?.[1]?.toLowerCase();
    if (identifier && liveNames.includes(identifier)) {
      if (helperParameters[index]) derivedParameters.push(helperParameters[index]);
      continue;
    }
    const defaultSelection = inlineOmissionSelection(argument);
    const defaultName = defaultSelection?.[2]?.toLowerCase();
    const exactOmissionThreshold = defaultName ? callable.parameters.indexOf(defaultName) + 1 : -1;
    if (defaultSelection && liveNames.includes(defaultName)
      && Number(defaultSelection[1]) === exactOmissionThreshold) {
      if (helperParameters[index]) derivedParameters.push(helperParameters[index]);
      continue;
    }
    if (!/^(?:true|false|null|undefined|-?(?:\d+(?:\.\d+)?|\.\d+)|__pi_[a-z0-9_]+__)$/i.test(argument)) {
      return { accepted: false, derivedParameters: [] };
    }
  }
  return { accepted: derivedParameters.length > 0, derivedParameters: [...new Set(derivedParameters)] };
}

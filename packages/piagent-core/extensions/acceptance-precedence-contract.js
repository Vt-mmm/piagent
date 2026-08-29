import path from "node:path";

const ASSIGNMENT_OPERATORS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&&=", "||=", "??=", "++", "--"]);
const MUTATING_METHODS = new Set(["copywithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"]);
const FALSEY_PARTITIONS = new Set(["false", "zero", "empty-string", "null"]);

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function onlyUndefinedPrecedenceContract(value) {
  const text = normalizedText(value);
  const undefinedOnly = /\babsent\s+only\s+when[^.\n]{0,100}\bundefined\b/.test(text)
    || /\bonly\s+undefined[^.\n]{0,100}\b(?:fall(?:s)?\s+through|absent|missing)\b/.test(text)
    || /\bundefined[^.\n]{0,100}\bonly\s+(?:value\s+)?(?:that\s+)?fall(?:s)?\s+through\b/.test(text);
  return undefinedOnly
    && /\b(?:precedence|priority|fall(?:s)?\s+through|fallback)\b/.test(text)
    && /\b(?:for\s+each|each|every)\s+(?:static\s+)?(?:key|field|property)\b/.test(text);
}

function readString(source, start, quote) {
  let value = "";
  let cursor = start + 1;
  let dynamic = false;
  while (cursor < source.length) {
    const current = source[cursor];
    if (current === "\\") {
      const next = source[cursor + 1];
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
      value += Object.hasOwn(escapes, next) ? escapes[next] : (next ?? "");
      cursor += 2;
      continue;
    }
    if (quote === "`" && current === "$" && source[cursor + 1] === "{") dynamic = true;
    if (current === quote) return { value, dynamic, end: cursor + 1 };
    value += current;
    cursor += 1;
  }
  return { value, dynamic: true, end: source.length };
}

function tokenize(sourceValue) {
  const source = String(sourceValue ?? "");
  const tokens = [];
  const operators = ["===", "!==", "...", "??=", "||=", "&&=", "=>", "??", "||", "&&", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "==", "!=", "<=", ">="];
  for (let cursor = 0; cursor < source.length;) {
    const current = source[cursor], next = source[cursor + 1];
    if (/\s/.test(current)) { cursor += 1; continue; }
    if (current === "/" && next === "/") {
      cursor = source.indexOf("\n", cursor + 2);
      if (cursor === -1) break;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", cursor + 2);
      cursor = end === -1 ? source.length : end + 2;
      continue;
    }
    if (current === "\"" || current === "'" || current === "`") {
      const parsed = readString(source, cursor, current);
      tokens.push({ type: parsed.dynamic ? "dynamic-string" : "string", value: parsed.value, start: cursor, end: parsed.end });
      cursor = parsed.end;
      continue;
    }
    const identifier = source.slice(cursor).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0];
    if (identifier) {
      tokens.push({ type: "identifier", value: identifier, start: cursor, end: cursor + identifier.length });
      cursor += identifier.length;
      continue;
    }
    const number = source.slice(cursor).match(/^(?:0|[1-9]\d*)(?:\.\d+)?/)?.[0];
    if (number) {
      tokens.push({ type: "number", value: number, start: cursor, end: cursor + number.length });
      cursor += number.length;
      continue;
    }
    const operator = operators.find((candidate) => source.startsWith(candidate, cursor));
    if (operator) {
      tokens.push({ type: "punctuator", value: operator, start: cursor, end: cursor + operator.length });
      cursor += operator.length;
      continue;
    }
    tokens.push({ type: "punctuator", value: current, start: cursor, end: cursor + 1 });
    cursor += 1;
  }
  return tokens;
}

function matchingToken(tokens, openIndex, opening = "(", closing = ")") {
  if (tokens[openIndex]?.value !== opening) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === opening) depth += 1;
    else if (tokens[index].value === closing && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(tokens, separator = ",") {
  const output = [];
  let start = 0, parentheses = 0, braces = 0, brackets = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(") parentheses += 1;
    else if (value === ")") parentheses -= 1;
    else if (value === "{") braces += 1;
    else if (value === "}") braces -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    else if (value === separator && parentheses === 0 && braces === 0 && brackets === 0) {
      output.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  output.push(tokens.slice(start));
  return output.filter((item) => item.length > 0);
}

function stripOuterParentheses(tokens) {
  let value = tokens;
  while (value[0]?.value === "(" && matchingToken(value, 0) === value.length - 1) value = value.slice(1, -1);
  return value;
}

function parameterNames(tokens) {
  return splitTopLevel(tokens).map((part) => part.find((token) => token.type === "identifier")?.value).filter(Boolean);
}

function exportedCallables(entry) {
  const tokens = tokenize(entry?.text);
  const callables = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "export") continue;
    let cursor = index + 1;
    const asynchronous = tokens[cursor]?.value === "async";
    if (asynchronous) cursor += 1;
    if (tokens[cursor]?.value === "function" && tokens[cursor + 1]?.type === "identifier" && tokens[cursor + 2]?.value === "(") {
      const parametersEnd = matchingToken(tokens, cursor + 2);
      const bodyStart = parametersEnd >= 0 ? parametersEnd + 1 : -1;
      const bodyEnd = bodyStart >= 0 && tokens[bodyStart]?.value === "{" ? matchingToken(tokens, bodyStart, "{", "}") : -1;
      if (bodyEnd >= 0) callables.push({
        name: tokens[cursor + 1].value,
        parameters: parameterNames(tokens.slice(cursor + 3, parametersEnd)),
        body: tokens.slice(bodyStart + 1, bodyEnd), tokens, path: entry.path, asynchronous
      });
    }
  }
  return callables;
}

function taskMentionsCallable(taskText, name, namedTargets) {
  return (Array.isArray(namedTargets) && namedTargets.some((target) => normalizedText(target) === normalizedText(name)))
    || new RegExp(`(?:\\b|\`)${escapeRegex(name)}(?:\\b|\`)`, "i").test(String(taskText ?? ""));
}

function returnObject(callable) {
  if (callable.body.filter((token) => token.value === "return").length !== 1) return { disposition: "ambiguous" };
  let parentheses = 0, braces = 0, brackets = 0;
  for (let index = 0; index < callable.body.length; index += 1) {
    const value = callable.body[index].value;
    if (value === "(") parentheses += 1;
    else if (value === ")") parentheses -= 1;
    else if (value === "{") braces += 1;
    else if (value === "}") braces -= 1;
    else if (value === "[") brackets += 1;
    else if (value === "]") brackets -= 1;
    if (value !== "return" || parentheses !== 0 || braces !== 0 || brackets !== 0) continue;
    if (callable.body[index + 1]?.value !== "{") return { disposition: "ambiguous" };
    const end = matchingToken(callable.body, index + 1, "{", "}");
    if (end < 0) return { disposition: "ambiguous" };
    const properties = [];
    for (const raw of splitTopLevel(callable.body.slice(index + 2, end))) {
      if (raw[0]?.value === "..." || raw[0]?.value === "[") return { disposition: "ambiguous" };
      const colon = raw.findIndex((token) => token.value === ":");
      if (colon !== 1 || !["identifier", "string"].includes(raw[0]?.type)) return { disposition: "ambiguous" };
      properties.push({ key: String(raw[0].value), expression: raw.slice(colon + 1) });
    }
    return { disposition: "resolved", properties };
  }
  return { disposition: "ambiguous" };
}

function memberReference(tokens) {
  const value = stripOuterParentheses(tokens);
  return value.length === 3 && value[0].type === "identifier" && value[1].value === "." && value[2].type === "identifier"
    ? { root: value[0].value, key: value[2].value } : undefined;
}

function expressionResolution(tokens, key) {
  const value = stripOuterParentheses(tokens);
  if (value[0]?.type === "identifier" && value[1]?.value === "(" && matchingToken(value, 1) === value.length - 1) {
    const members = splitTopLevel(value.slice(2, -1)).map(memberReference);
    if (members.length >= 2 && members.every((member) => member?.key === key)) {
      return { selector: value[0].value, layers: members.map((member) => member.root), forbidden: false };
    }
  }
  const operators = value.filter((token) => token.value === "||" || token.value === "??").map((token) => token.value);
  if (operators.length > 0) {
    const operator = operators[0];
    const parts = splitTopLevel(value, operator);
    const members = parts.map(memberReference);
    if (operators.every((item) => item === operator) && members.length >= 2 && members.every((member) => member?.key === key)) {
      return { selector: operator, layers: members.map((member) => member.root), forbidden: true };
    }
  }
  return undefined;
}

function helperExpression(tokens, helperName) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (!["const", "let", "var"].includes(tokens[index].value) || tokens[index + 1]?.value !== helperName || tokens[index + 2]?.value !== "=") continue;
    let cursor = index + 3, parameterTokens = [];
    if (tokens[cursor]?.value === "(") {
      const end = matchingToken(tokens, cursor);
      if (end < 0) return undefined;
      parameterTokens = tokens.slice(cursor + 1, end);
      cursor = end + 1;
    } else {
      parameterTokens = [tokens[cursor]];
      cursor += 1;
    }
    if (tokens[cursor]?.value !== "=>") return undefined;
    const end = tokens.findIndex((token, candidate) => candidate > cursor && token.value === ";");
    return { declaration: tokens[index].value, parameters: parameterNames(parameterTokens), expression: tokens.slice(cursor + 1, end < 0 ? tokens.length : end) };
  }
  return undefined;
}

function selectorProvesUndefinedOnly(callable, selector) {
  if (["||", "??"].includes(selector)) return "rejected";
  const helper = helperExpression(callable.body, selector) ?? helperExpression(callable.tokens, selector);
  if (!helper) return "abstain";
  if (helper.declaration !== "const" || helper.parameters.length !== 1) return "rejected";
  const expression = stripOuterParentheses(helper.expression);
  if (expression.some((token) => token.value === "||" || token.value === "??")) return "rejected";
  if (expression[0]?.value !== helper.parameters[0] || expression[1]?.value !== "." || expression[2]?.value !== "find" || expression[3]?.value !== "(") return "rejected";
  const end = matchingToken(expression, 3);
  if (end !== expression.length - 1) return "rejected";
  const callback = expression.slice(4, end);
  const arrow = callback.findIndex((token) => token.value === "=>");
  if (arrow < 0) return "rejected";
  const parameters = parameterNames(stripOuterParentheses(callback.slice(0, arrow)));
  const predicate = stripOuterParentheses(callback.slice(arrow + 1));
  if (parameters.length !== 1 || predicate.length !== 3 || predicate[1].value !== "!==") return "rejected";
  return (predicate[0].value === parameters[0] && predicate[2].value === "undefined")
    || (predicate[2].value === parameters[0] && predicate[0].value === "undefined") ? "proved" : "rejected";
}

function selectorBindingIsStable(callable, selector) {
  if (callable.parameters.includes(selector)) return false;
  let declarations = 0;
  for (let index = 0; index < callable.tokens.length; index += 1) {
    if (["const", "let", "var", "function"].includes(callable.tokens[index].value) && callable.tokens[index + 1]?.value === selector) declarations += 1;
    if (callable.tokens[index].value !== selector) continue;
    const declaration = ["const", "let", "var", "function"].includes(callable.tokens[index - 1]?.value);
    if (!declaration && (ASSIGNMENT_OPERATORS.has(callable.tokens[index + 1]?.value) || ["++", "--"].includes(callable.tokens[index - 1]?.value))) return false;
    if ([".", "["].includes(callable.tokens[index + 1]?.value)) {
      for (let cursor = index + 2; cursor < Math.min(callable.tokens.length, index + 8); cursor += 1) {
        if (ASSIGNMENT_OPERATORS.has(callable.tokens[cursor].value)) return false;
        if ([",", ";", ")"].includes(callable.tokens[cursor].value)) break;
      }
    }
  }
  return declarations === 1;
}

function hasAlternateControlFlow(callable) {
  return callable.asynchronous || callable.body.some((token) => ["if", "switch", "try", "catch", "throw"].includes(token.value));
}

function mutatesInput(callable) {
  const roots = new Set(callable.parameters);
  const tokens = callable.body;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "delete" && roots.has(tokens[index + 1]?.value) && [".", "["].includes(tokens[index + 2]?.value)) return true;
    if (roots.has(value) && [".", "["].includes(tokens[index + 1]?.value)) {
      for (let cursor = index + 2; cursor < Math.min(tokens.length, index + 8); cursor += 1) {
        if (ASSIGNMENT_OPERATORS.has(tokens[cursor].value)) return true;
        if ([",", ";", ")"].includes(tokens[cursor].value)) break;
      }
    }
    if (["object", "reflect"].includes(value.toLowerCase()) && tokens[index + 1]?.value === "."
      && ["assign", "defineproperty", "defineproperties", "set"].includes(tokens[index + 2]?.value.toLowerCase())
      && tokens[index + 3]?.value === "(" && roots.has(tokens[index + 4]?.value)) return true;
    if (tokens[index].type === "identifier" && tokens[index + 1]?.value === "(" && roots.has(tokens[index + 2]?.value)
      && [",", ")"].includes(tokens[index + 3]?.value)) return true;
  }
  return false;
}

function taskLayersMatch(taskText, layers) {
  const clauses = normalizedText(taskText).split(/[.!?;\n]+/);
  return clauses.some((clause) => {
    if (!/\b(?:precedence|priority|fallback)\b/.test(clause)) return false;
    const positions = layers.map((layer) => clause.search(new RegExp(`\\b${escapeRegex(normalizedText(layer))}\\b`)));
    return positions.every((position) => position >= 0) && positions.every((position, index) => index === 0 || positions[index - 1] < position);
  });
}

function sourceContract(input) {
  const candidates = (input.sourceEntries ?? []).flatMap(exportedCallables)
    .filter((callable) => taskMentionsCallable(input.taskText, callable.name, input.namedTargets));
  if (candidates.length !== 1) return { disposition: "abstain" };
  const callable = candidates[0], returned = returnObject(callable);
  if (returned.disposition !== "resolved") return { disposition: "abstain", callable };
  if (returned.properties.length < 2) return { disposition: "not-applicable", callable };
  const resolutions = returned.properties.map((property) => expressionResolution(property.expression, property.key));
  if (resolutions.some((item) => !item)) return { disposition: "abstain", callable };
  const keys = returned.properties.map((property) => property.key);
  const layers = resolutions[0].layers;
  const sameShape = resolutions.every((item) => item.selector === resolutions[0].selector
    && item.layers.length === layers.length && item.layers.every((layer, index) => layer === layers[index]));
  const selectorProof = selectorProvesUndefinedOnly(callable, resolutions[0].selector);
  if (selectorProof === "abstain") return { disposition: "abstain", callable, keys, layers };
  if (hasAlternateControlFlow(callable)) return { disposition: "abstain", callable, keys, layers };
  const sourceOk = sameShape && layers.length >= 2 && layers.every((layer) => callable.parameters.includes(layer))
    && taskLayersMatch(input.taskText, layers) && !resolutions[0].forbidden
    && selectorProof === "proved" && selectorBindingIsStable(callable, resolutions[0].selector) && !mutatesInput(callable);
  return { disposition: "applicable", callable, keys, layers, sourceOk };
}

function relativeImportMatches(testPath, sourcePath, specifier) {
  if (!specifier.startsWith(".")) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(String(testPath).replaceAll("\\", "/")), specifier));
  const source = path.posix.normalize(String(sourcePath).replaceAll("\\", "/"));
  return resolved === source || (!path.posix.extname(resolved) && [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].some((extension) => `${resolved}${extension}` === source));
}

function importBindings(tokens, testPath, contract) {
  const targetBindings = [], assertionBindings = [];
  const importRanges = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "import") continue;
    const from = tokens.findIndex((token, candidate) => candidate > index && candidate < index + 30 && token.value === "from");
    if (from < 0 || tokens[from + 1]?.type !== "string") continue;
    importRanges.push([index, from + 1]);
    const specifier = tokens[from + 1].value;
    if (["node:assert", "node:assert/strict", "assert", "assert/strict"].includes(specifier)) {
      if (tokens[index + 1]?.type === "identifier") assertionBindings.push(tokens[index + 1].value);
      if (tokens[index + 1]?.value === "*" && tokens[index + 2]?.value === "as" && tokens[index + 3]?.type === "identifier") assertionBindings.push(tokens[index + 3].value);
    }
    if (!relativeImportMatches(testPath, contract.callable.path, specifier) || tokens[index + 1]?.value !== "{") continue;
    const close = matchingToken(tokens, index + 1, "{", "}");
    for (const part of splitTopLevel(tokens.slice(index + 2, close))) {
      if (part[0]?.value !== contract.callable.name) continue;
      targetBindings.push(part[2]?.value === "as" && part[3]?.type === "identifier" ? part[3].value : part[0].value);
    }
  }
  return { targetBindings: [...new Set(targetBindings)], assertionBindings: [...new Set(assertionBindings)], importRanges };
}

function literalValue(tokens, environment = {}) {
  const value = stripOuterParentheses(tokens);
  if (value.length !== 1) return undefined;
  const token = value[0];
  if (token.type === "string") return { kind: "string", value: token.value };
  if (token.type === "number" && Number(token.value) === 0) return { kind: "zero", value: 0 };
  if (token.value === "false") return { kind: "false", value: false };
  if (token.value === "true") return { kind: "true", value: true };
  if (token.value === "null") return { kind: "null", value: null };
  if (token.value === "undefined") return { kind: "undefined", value: undefined };
  return environment[token.value];
}

function partition(value) {
  if (!value) return undefined;
  if (value.kind === "string" && value.value === "") return "empty-string";
  return FALSEY_PARTITIONS.has(value.kind) ? value.kind : undefined;
}

function sameLiteral(left, right) {
  return Boolean(left && right && left.kind === right.kind && Object.is(left.value, right.value));
}

function literalArray(tokens, environment = {}) {
  const value = stripOuterParentheses(tokens);
  if (value[0]?.value !== "[" || matchingToken(value, 0, "[", "]") !== value.length - 1) return undefined;
  const items = splitTopLevel(value.slice(1, -1)).map((item) => literalValue(item, environment));
  return items.length > 0 && items.every(Boolean) ? items : undefined;
}

function constArrays(tokens) {
  const arrays = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "const" || tokens[index + 1]?.type !== "identifier" || tokens[index + 2]?.value !== "=" || tokens[index + 3]?.value !== "[") continue;
    const end = matchingToken(tokens, index + 3, "[", "]"), values = end < 0 ? undefined : literalArray(tokens.slice(index + 3, end + 1));
    if (!values) continue;
    const name = tokens[index + 1].value;
    let mutable = false;
    for (let cursor = end + 1; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value !== name) continue;
      if (ASSIGNMENT_OPERATORS.has(tokens[cursor + 1]?.value)
        || (tokens[cursor + 1]?.value === "." && MUTATING_METHODS.has(tokens[cursor + 2]?.value.toLowerCase()))) { mutable = true; break; }
    }
    if (!mutable) arrays.set(name, values);
  }
  return arrays;
}

function literalLoops(tokens, arrays) {
  const loops = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "for" || tokens[index + 1]?.value !== "(") continue;
    const headerEnd = matchingToken(tokens, index + 1), header = headerEnd < 0 ? [] : tokens.slice(index + 2, headerEnd);
    if (header[0]?.value !== "const" || header[1]?.type !== "identifier" || header[2]?.value !== "of") continue;
    const iterable = header.slice(3), values = literalArray(iterable) ?? (iterable.length === 1 ? arrays.get(iterable[0].value) : undefined);
    if (!values || tokens[headerEnd + 1]?.value !== "{") continue;
    const bodyEnd = matchingToken(tokens, headerEnd + 1, "{", "}");
    if (bodyEnd > headerEnd) loops.push({ variable: header[1].value, values, start: headerEnd + 2, end: bodyEnd });
  }
  return loops;
}

function environmentsFor(index, loops) {
  let environments = [{}];
  for (const loop of loops.filter((item) => item.start <= index && index < item.end).sort((left, right) => left.start - right.start)) {
    environments = environments.flatMap((environment) => loop.values.map((value) => ({ ...environment, [loop.variable]: value })));
  }
  return environments;
}

function runtimeObject(tokens, environment) {
  const value = stripOuterParentheses(tokens);
  if (value[0]?.value !== "{" || matchingToken(value, 0, "{", "}") !== value.length - 1) return undefined;
  const object = new Map();
  for (const property of splitTopLevel(value.slice(1, -1))) {
    if (property[0]?.value === "...") return undefined;
    let key, colon;
    if (property[0]?.value === "[") {
      const close = matchingToken(property, 0, "[", "]");
      const computed = literalValue(property.slice(1, close), environment);
      if (computed?.kind !== "string") return undefined;
      key = computed.value; colon = close + 1;
    } else {
      key = property[0]?.value; colon = 1;
    }
    if (!key || property[colon]?.value !== ":") return undefined;
    const resolved = literalValue(property.slice(colon + 1), environment);
    if (!resolved) return undefined;
    object.set(String(key), resolved);
  }
  return object;
}

function targetCall(tokens, binding, environment, contract) {
  const value = stripOuterParentheses(tokens);
  if (value[0]?.value !== binding || value[1]?.value !== "(") return undefined;
  const callEnd = matchingToken(value, 1);
  if (callEnd < 0) return undefined;
  const args = splitTopLevel(value.slice(2, callEnd)).map((item) => runtimeObject(item, environment));
  if (args.length !== contract.layers.length || args.some((item) => !item)) return undefined;
  let selectedKey;
  const suffix = value.slice(callEnd + 1);
  if (suffix.length === 2 && suffix[0].value === "." && suffix[1].type === "identifier") selectedKey = suffix[1].value;
  if (suffix[0]?.value === "[" && suffix.at(-1)?.value === "]") {
    const computed = literalValue(suffix.slice(1, -1), environment);
    if (computed?.kind === "string") selectedKey = computed.value;
  }
  if (suffix.length > 0 && !selectedKey) return undefined;
  const result = new Map();
  for (const key of contract.keys) {
    const values = args.map((object) => object.has(key) ? object.get(key) : { kind: "undefined", value: undefined });
    result.set(key, { value: values.find((item) => item.kind !== "undefined") ?? values.at(-1), values });
  }
  return { result, selectedKey };
}

function disabledOrDeadEvidence(tokens) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (["xit", "xtest", "xdescribe"].includes(tokens[index].value.toLowerCase())) return true;
    if (["test", "it", "describe"].includes(tokens[index].value.toLowerCase()) && tokens[index + 1]?.value === "." && ["skip", "todo"].includes(tokens[index + 2]?.value.toLowerCase())) return true;
    if (["if", "switch", "try", "catch", "finally", "return", "break", "continue", "throw", "&&", "||", "??", "?"].includes(tokens[index].value)) return true;
  }
  return false;
}

function bindingIsStable(tokens, binding, importRanges) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== binding || importRanges.some(([start, end]) => start <= index && index <= end)) continue;
    if (tokens[index + 1]?.value === "(") continue;
    return false;
  }
  return true;
}

function assertionBindingIsStable(tokens, binding, importRanges) {
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== binding || importRanges.some(([start, end]) => start <= index && index <= end)) continue;
    if (tokens[index + 1]?.value === "." && tokens[index + 2]?.type === "identifier" && tokens[index + 3]?.value === "(") continue;
    return false;
  }
  return true;
}

function recordCoverage(coverage, key, selected, expected) {
  if (!selected || !sameLiteral(selected.value, expected)) return;
  const first = selected.values[0], falsey = partition(first);
  if (falsey) coverage.get(key).partitions.add(falsey);
  if (first?.kind === "undefined" && selected.values.slice(1).some((value) => value.kind !== "undefined")) coverage.get(key).undefinedFallback = true;
}

function testContract(input, contract) {
  const coverage = new Map(contract.keys.map((key) => [key, { partitions: new Set(), undefinedFallback: false }]));
  let boundFile = false;
  for (const entry of input.testEntries ?? []) {
    const tokens = tokenize(entry.text);
    if (tokens.some((token) => token.type === "dynamic-string") || disabledOrDeadEvidence(tokens)) continue;
    const bindings = importBindings(tokens, entry.path, contract);
    const assertionBindings = bindings.assertionBindings.filter((binding) => assertionBindingIsStable(tokens, binding, bindings.importRanges));
    if (bindings.targetBindings.length !== 1 || assertionBindings.length === 0
      || !bindingIsStable(tokens, bindings.targetBindings[0], bindings.importRanges)) continue;
    boundFile = true;
    const arrays = constArrays(tokens), loops = literalLoops(tokens, arrays);
    for (let index = 0; index < tokens.length; index += 1) {
      if (!assertionBindings.includes(tokens[index].value) || tokens[index + 1]?.value !== "."
        || !["equal", "strictequal", "deepequal"].includes(tokens[index + 2]?.value.toLowerCase()) || tokens[index + 3]?.value !== "(") continue;
      const end = matchingToken(tokens, index + 3), args = end < 0 ? [] : splitTopLevel(tokens.slice(index + 4, end));
      if (args.length < 2) continue;
      for (const environment of environmentsFor(index, loops)) {
        const actual = targetCall(args[0], bindings.targetBindings[0], environment, contract);
        if (!actual) continue;
        if (actual.selectedKey) {
          const expected = literalValue(args[1], environment);
          if (coverage.has(actual.selectedKey)) recordCoverage(coverage, actual.selectedKey, actual.result.get(actual.selectedKey), expected);
          continue;
        }
        const expected = runtimeObject(args[1], environment);
        if (!expected) continue;
        for (const key of contract.keys) if (expected.has(key)) recordCoverage(coverage, key, actual.result.get(key), expected.get(key));
      }
    }
  }
  return boundFile && [...coverage.values()].every((item) => item.undefinedFallback
    && [...FALSEY_PARTITIONS].every((partitionName) => item.partitions.has(partitionName)));
}

export function acceptancePrecedenceContractEvidence(input = {}) {
  if (!onlyUndefinedPrecedenceContract(input.taskText)) return { disposition: "not-applicable", sourceOk: false, testOk: false };
  const contract = sourceContract(input);
  if (contract.disposition !== "applicable") return { ...contract, sourceOk: false, testOk: false };
  const testOk = testContract(input, contract);
  return { ...contract, testOk, proved: contract.sourceOk && testOk };
}

export function acceptancePrecedenceContractGuidance(input = {}) {
  if (!onlyUndefinedPrecedenceContract(input.taskText)) return [];
  const contract = sourceContract(input);
  if (contract.disposition !== "applicable") return [];
  const line = `Defined-fallback proof for ${contract.callable.name}: keys ${contract.keys.join(", ")}; precedence ${contract.layers.join(" > ")}. For every key, prove undefined fallback and preserve null, false, 0, and empty string with assertions bound directly to ${contract.callable.name}.`;
  return line.trim().split(/\s+/).length <= 120 ? [line] : [];
}

export function acceptancePrecedenceReceiptEvidence(input = {}) {
  if (input.obligation !== "boundary-case") return { handled: false };
  const proof = acceptancePrecedenceContractEvidence(input);
  if (proof.disposition === "not-applicable") return { handled: false };
  const complete = proof.proved && input.passingVerifier && (input.sourceFiles ?? []).length > 0 && input.verifierCoversTests;
  return {
    handled: true,
    evidence: complete ? {
      ...input.verifierEvidence,
      kind: "verifier-backed-defined-fallback-test",
      summary: "Configured verifier passed with per-key defined-fallback source and focused-test proof.",
      paths: [...new Set([...(input.sourceFiles ?? []), ...(input.testFiles ?? [])])]
    } : undefined
  };
}

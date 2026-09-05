function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function callArgumentNames(slice) {
  const body = slice.slice(slice.indexOf("(") + 1, -1);
  return [...body.matchAll(/(?:^|,)\s*([a-z_$][a-z0-9_$]*)\s*(?=,|$)/gi)].map((match) => match[1]);
}

export function boundStringValue(token, strings) {
  const index = Number(String(token ?? "").match(/^__pi_bound_string_(\d+)__$/)?.[1]);
  return Number.isInteger(index) ? strings[index] : undefined;
}

export function exactBoundValue(expression, strings) {
  const value = String(expression ?? "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return boundStringValue(value, strings);
}

export function splitTopLevel(value) {
  const parts = [];
  let start = 0, round = 0, square = 0, curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const token = value[index];
    if (token === "(") round += 1;
    else if (token === ")") round -= 1;
    else if (token === "[") square += 1;
    else if (token === "]") square -= 1;
    else if (token === "{") curly += 1;
    else if (token === "}") curly -= 1;
    else if (token === "," && round === 0 && square === 0 && curly === 0) {
      parts.push(value.slice(start, index).trim()); start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

// These are deliberately restricted dataflow facts, not an evaluator. Unknown
// expressions, escaping references and control-flow scopes remain unproven.
export function braceScope(code, position) {
  const scope = [];
  for (let index = 0; index < position; index += 1) {
    if (code[index] === "{") scope.push(index);
    else if (code[index] === "}") scope.pop();
  }
  return scope;
}

export function sameScope(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function unconditionalEvidenceScope(code, position) {
  const scope = braceScope(code, position);
  const bodyPrefix = code.slice((scope.at(-1) ?? -1) + 1, position);
  return scope.every((open) => (
    /\b(?:test|it)\s*\(\s*__pi_bound_string_\d+__\s*,\s*(?:async\s*)?(?:\([^()]*\)\s*=>|function\s*\([^()]*\))\s*$/.test(code.slice(0, open))
  )) && !/(?:&&|\|\||\?|=>|\b(?:if|for|while|switch|return|throw|break|continue|try|catch|finally|function)\b)|\bprocess\s*\.\s*(?:exit|abort)\s*\(/.test(bodyPrefix);
}

export function constantDeclarations(code) {
  const declarations = [];
  for (const match of code.matchAll(/\b(const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=(?!=|>)/gi)) {
    const start = match.index + match[0].length;
    let round = 0, square = 0, curly = 0;
    for (let end = start; end < code.length; end += 1) {
      const token = code[end];
      if (token === "(") round += 1;
      if (token === ")") round -= 1;
      if (token === "[") square += 1;
      if (token === "]") square -= 1;
      if (token === "{") curly += 1;
      if (token === "}") curly -= 1;
      if (round < 0 || square < 0 || curly < 0) break;
      if (token === ";" && round === 0 && square === 0 && curly === 0) {
        declarations.push({ kind: match[1], name: match[2], start: match.index, end: end + 1,
          expression: code.slice(start, end).trim(), scope: braceScope(code, match.index) });
        break;
      }
    }
  }
  return declarations;
}

export function literalBinding(call, name, before, seen = new Set()) {
  if (seen.has(name)) return undefined;
  const scope = braceScope(call.code, before);
  const candidates = call.declarations.filter((entry) => entry.name === name && entry.end <= before
    && entry.scope.every((open, index) => scope[index] === open));
  const declaration = candidates.sort((left, right) => left.scope.length - right.scope.length || left.start - right.start).at(-1);
  if (!declaration || declaration.kind !== "const") return undefined;
  // A callback parameter can shadow an outer declaration without another const.
  if (scope.some((open) => new RegExp(`(?:\\(|,)\\s*${escapeRegex(name)}\\s*(?:,|\\))`).test(
    call.code.slice(Math.max(0, open - 160), open)))) return undefined;
  const nextSeen = new Set([...seen, name]);
  const value = literalExpression(call, declaration.expression, declaration.start, nextSeen);
  if (!value) return undefined;
  // Permit only independent shallow-copy declarations before the use. Any
  // mutation, reassignment, alias, unknown call, or other escape makes it unknown.
  let between = call.code.slice(declaration.end, before);
  for (const copy of call.declarations.filter((entry) => entry.start >= declaration.end && entry.end <= before)) {
    if (copy.kind === "const" && new RegExp(`^(?:\\[\\s*\\.\\.\\.\\s*${escapeRegex(name)}\\s*\\]|\\{\\s*\\.\\.\\.\\s*${escapeRegex(name)}\\s*\\})$`).test(copy.expression)) {
      const offset = copy.start - declaration.end;
      between = between.slice(0, offset) + " ".repeat(copy.end - copy.start) + between.slice(copy.end - declaration.end);
    }
  }
  if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(between)) return undefined;
  return { ...value, declaration };
}

function literalExpression(call, expression, before, seen = new Set()) {
  const value = expression.trim();
  const bound = exactBoundValue(value, call.strings);
  if (bound !== undefined) return { kind: "primitive", value: bound };
  if (/^(?:null|undefined|[-+]?\d+(?:\.\d+)?n?)$/.test(value)) return { kind: "primitive" };
  if (/^[a-z_$][a-z0-9_$]*$/i.test(value)) {
    const resolved = literalBinding(call, value, before, seen);
    return resolved?.kind === "primitive" ? resolved : undefined;
  }
  const spread = value.match(/^(\[|\{)\s*\.\.\.\s*([a-z_$][a-z0-9_$]*)\s*(\]|\})$/i);
  if (spread) {
    const source = literalBinding(call, spread[2], before, seen);
    return source?.kind === (spread[1] === "[" ? "array" : "object") ? source : undefined;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const elements = splitTopLevel(value.slice(1, -1)).filter((item) => item !== "")
      .map((item) => literalExpression(call, item, before, seen));
    return elements.every((item) => item?.kind === "primitive") ? { kind: "array", elements } : undefined;
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    const entries = splitTopLevel(value.slice(1, -1)).filter((item) => item !== "");
    return entries.every((entry) => {
      const property = entry.match(/^([a-z_$][a-z0-9_$]*|__pi_bound_string_\d+__)\s*:\s*([\s\S]+)$/i);
      return property && property[1] !== "__proto__" && boundStringValue(property[1], call.strings) !== "__proto__"
        && literalExpression(call, property[2], before, seen)?.kind === "primitive";
    }) ? { kind: "object" } : undefined;
  }
  return undefined;
}

export function flatObjectSnapshot(call, argument, assertionComparisons) {
  const escaped = escapeRegex(argument);
  if (call.safeScope && literalBinding(call, argument, call.start)?.kind === "object") {
    const scope = braceScope(call.code, call.start);
    const snapshot = call.declarations.filter((entry) => entry.kind === "const" && entry.end <= call.start
      && sameScope(entry.scope, scope)
      && new RegExp(`^\\{\\s*\\.\\.\\.\\s*${escaped}\\s*\\}$`).test(entry.expression)).at(-1);
    if (snapshot && !new RegExp(`\\b${escapeRegex(snapshot.name)}\\b`).test(call.code.slice(snapshot.end, call.start))) {
      const comparison = call.scopedAssertions.find((entry) => entry.start >= call.end
        && assertionComparisons({ ...call, assertions: [entry.code] }).some(({ actual, expected }) => (
          actual.trim() === argument && expected.trim() === snapshot.name
        )));
      if (comparison && !new RegExp(`\\b(?:${escaped}|${escapeRegex(snapshot.name)})\\b`).test(call.code.slice(call.end, comparison.start))) {
        return { name: snapshot.name };
      }
    }
    return { name: undefined };
  }
  return undefined;
}

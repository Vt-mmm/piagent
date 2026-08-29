import { evidenceTopLevelArguments } from "./acceptance-executable-evidence.js";

const MAX_SCAN_LENGTH = 64_000;
const MAX_CALLABLES = 128;
const MAX_STATEMENTS = 128;

function balancedEnd(text, openIndex, opening = "(", closing = ")", ceiling = 8_000) {
  if (text[openIndex] !== opening) return -1;
  let depth = 0;
  for (let index = openIndex; index < Math.min(text.length, openIndex + ceiling); index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing && --depth === 0) return index + 1;
  }
  return -1;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function formalParameterNames(parameters, preserveCase = false) {
  const wrapped = `(${String(parameters ?? "")})`;
  const names = [];
  for (const raw of evidenceTopLevelArguments(wrapped, 0, wrapped.length)) {
    const value = raw.trim().replace(/^(?:public|private|protected|readonly)\s+/, "").replace(/^\.\.\./, "");
    const direct = value.match(/^([a-z_$][a-z0-9_$]*)\s*(?:[?:=]|$)/i);
    if (direct) {
      names.push(direct[1]);
      continue;
    }
    const object = value.match(/^\{([^}]*)\}/)?.[1];
    if (object) {
      for (const item of object.split(",")) {
        const binding = item.trim().match(/^(?:[a-z_$][a-z0-9_$]*\s*:\s*)?([a-z_$][a-z0-9_$]*)/i);
        if (binding) names.push(binding[1]);
      }
      continue;
    }
    const array = value.match(/^\[([^\]]*)\]/)?.[1];
    if (array) names.push(...(array.match(/[a-z_$][a-z0-9_$]*/gi) ?? []));
  }
  const result = uniqueStrings(names).slice(0, 16);
  return preserveCase ? result : result.map((item) => item.toLowerCase());
}

function defaultedFormalParameterNames(parameters, preserveCase = false) {
  const wrapped = `(${String(parameters ?? "")})`;
  const names = [];
  for (const raw of evidenceTopLevelArguments(wrapped, 0, wrapped.length)) {
    const value = raw.trim().replace(/^(?:public|private|protected|readonly)\s+/, "").replace(/^\.\.\./, "");
    const direct = value.match(/^([a-z_$][a-z0-9_$]*)\s*(?:\?\s*)?=/i);
    if (direct) names.push(direct[1]);
  }
  const result = uniqueStrings(names).slice(0, 16);
  return preserveCase ? result : result.map((item) => item.toLowerCase());
}

function braceDepthAt(text, offset) {
  let depth = 0;
  for (let index = 0; index < Math.min(text.length, Math.max(0, offset)); index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth -= 1;
    if (depth < 0) return -1;
  }
  return depth;
}

function declarationStart(code, keywordStart) {
  const prefixStart = Math.max(0, keywordStart - 48);
  const prefix = code.slice(prefixStart, keywordStart);
  const exported = prefix.match(/\bexport\s+(?:default\s+)?$/i);
  return exported ? prefixStart + exported.index : keywordStart;
}

function withOptionalSemicolon(code, end) {
  let cursor = end;
  while (/\s/.test(code[cursor] ?? "")) cursor += 1;
  return code[cursor] === ";" ? cursor + 1 : end;
}

function statementKind(source) {
  const value = source.trim();
  if (/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b/i.test(value)) return "function-declaration";
  if (/^(?:export\s+)?const\b/i.test(value)) return "immutable-binding";
  if (/^(?:export\s+)?(?:let|var)\b/i.test(value)) return "mutable-binding";
  return "statement";
}

function statementEnd(code, start, ceiling) {
  let braces = 0, parentheses = 0, brackets = 0;
  const prefix = code.slice(start, Math.min(ceiling, start + 80)).trimStart();
  const closesWithBlock = /^(?:(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b|class\b|if\b|for\b|while\b|switch\b|try\b|\{)/i.test(prefix);
  for (let index = start; index < ceiling; index += 1) {
    const character = code[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1;
    else if (character === "}") {
      braces -= 1;
      if (braces === 0 && parentheses === 0 && brackets === 0 && closesWithBlock) {
        const rest = code.slice(index + 1, Math.min(ceiling, index + 32));
        if (!/^\s*(?:else|catch|finally|while\b)/i.test(rest)) return index + 1;
      }
    } else if (character === ";" && braces === 0 && parentheses === 0 && brackets === 0) return index + 1;
    if (braces < 0 || parentheses < 0 || brackets < 0) return index;
  }
  return ceiling;
}

/** Return a bounded, case-preserving inventory of complete module statements. */
export function boundedTopLevelStatements(code, declarations = []) {
  const ceiling = Math.min(String(code ?? "").length, MAX_SCAN_LENGTH);
  const callableRanges = declarations.filter((item) => item.braceDepth === 0)
    .sort((left, right) => left.start - right.start);
  const statements = [];
  let cursor = 0;
  while (cursor < ceiling && statements.length < MAX_STATEMENTS) {
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    if (cursor >= ceiling) break;
    const declaration = callableRanges.find((item) => item.start === cursor);
    const end = declaration?.end ?? statementEnd(code, cursor, ceiling);
    if (end <= cursor) break;
    const source = code.slice(cursor, end);
    statements.push({
      start: cursor, end, braceDepth: braceDepthAt(code, cursor), source,
      kind: declaration ? declaration.kind : statementKind(source),
      declarationName: declaration?.name ?? null
    });
    cursor = end;
  }
  const remainder = code.slice(cursor, ceiling).trim();
  return { statements, complete: code.length <= MAX_SCAN_LENGTH && statements.length < MAX_STATEMENTS && !remainder };
}

/**
 * Collect bounded callable bodies from already-sanitized JavaScript evidence.
 * Besides the legacy lower-case lookup keys, each callable keeps exact declared
 * names/parameters and structural spans. Consumers that prove a closed shape
 * must use those exact fields instead of case-folded semantic identifiers.
 */
export function callableBodies(rawCode) {
  const code = String(rawCode ?? "");
  const bodies = new Map();
  const declarations = [];
  const add = (name, parameters, start, open, end, asynchronous, ownsArguments, kind, body) => {
    if (declarations.length >= MAX_CALLABLES) return;
    const exactParameters = formalParameterNames(parameters, true);
    const closeEnd = open === -1 ? end : balancedEnd(code, open, "{", "}");
    const callable = {
      name: name.toLowerCase(), declarationName: name, exactDeclarationName: name,
      body, parameters: exactParameters.map((item) => item.toLowerCase()), exactParameters,
      parameterSource: parameters, exactParameterSource: parameters,
      defaultedParameters: defaultedFormalParameterNames(parameters),
      exactDefaultedParameters: defaultedFormalParameterNames(parameters, true),
      sourceCode: code, asynchronous, ownsArguments, declarationKind: kind,
      declarationStart: start, declarationEnd: end, bodyOpen: open,
      bodyStart: open === -1 ? null : open + 1, bodyEnd: open === -1 ? end : closeEnd - 1,
      braceDepth: braceDepthAt(code, start), exactDeclarationKind: kind
    };
    callable.exactBraceDepth = callable.braceDepth;
    callable.exactDeclarationStart = start;
    callable.exactDeclarationEnd = end;
    const declaration = { name, normalizedName: name.toLowerCase(), parameters: exactParameters,
      start, end, open, braceDepth: callable.braceDepth, kind, callable };
    declarations.push(declaration);
    if (!bodies.has(callable.name)) bodies.set(callable.name, callable);
  };
  const afterParameters = (open) => {
    const end = balancedEnd(code, open);
    if (end === -1) return null;
    let cursor = end;
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    return { end, cursor };
  };

  for (const match of code.matchAll(/\b(async\s+)?function\s+([a-z_$][a-z0-9_$]*)\s*\(/gi)) {
    const open = match.index + match[0].lastIndexOf("(");
    const parameters = afterParameters(open);
    if (!parameters || code[parameters.cursor] !== "{") continue;
    const bodyEnd = balancedEnd(code, parameters.cursor, "{", "}");
    if (bodyEnd === -1) continue;
    const start = declarationStart(code, match.index);
    add(match[2], code.slice(open + 1, parameters.end - 1), start, parameters.cursor,
      withOptionalSemicolon(code, bodyEnd), Boolean(match[1]), true, "function-declaration",
      code.slice(parameters.cursor + 1, bodyEnd - 1));
  }
  for (const match of code.matchAll(/^\s*(async\s+)?([a-z_$][a-z0-9_$]*)\s*\(/gim)) {
    if (["catch", "for", "function", "if", "switch", "while", "with"].includes(match[2].toLowerCase())) continue;
    const open = match.index + match[0].lastIndexOf("(");
    const parameters = afterParameters(open);
    if (!parameters || code[parameters.cursor] !== "{") continue;
    const bodyEnd = balancedEnd(code, parameters.cursor, "{", "}");
    if (bodyEnd === -1) continue;
    add(match[2], code.slice(open + 1, parameters.end - 1),
      match.index + (match[0].match(/^\s*/)?.[0].length ?? 0), parameters.cursor, bodyEnd,
      Boolean(match[1]), true, "method-declaration", code.slice(parameters.cursor + 1, bodyEnd - 1));
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*(async\s+)?/gi)) {
    let cursor = match.index + match[0].length;
    let parameters = "";
    if (code[cursor] === "(") {
      const parsed = afterParameters(cursor);
      if (!parsed) continue;
      parameters = code.slice(cursor + 1, parsed.end - 1);
      cursor = parsed.cursor;
    } else {
      const direct = code.slice(cursor).match(/^([a-z_$][a-z0-9_$]*)/i);
      if (!direct) continue;
      parameters = direct[1];
      cursor += direct[0].length;
      while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    }
    if (code.slice(cursor, cursor + 2) !== "=>") continue;
    cursor += 2;
    while (/\s/.test(code[cursor] ?? "")) cursor += 1;
    const start = declarationStart(code, match.index);
    if (code[cursor] === "{") {
      const bodyEnd = balancedEnd(code, cursor, "{", "}");
      if (bodyEnd !== -1) add(match[1], parameters, start, cursor, withOptionalSemicolon(code, bodyEnd),
        Boolean(match[2]), false, "arrow-declaration", code.slice(cursor + 1, bodyEnd - 1));
    } else {
      const end = [code.indexOf(";", cursor), code.indexOf("\n", cursor)].filter((item) => item >= 0).sort((a, b) => a - b)[0] ?? code.length;
      add(match[1], parameters, start, -1, code[end] === ";" ? end + 1 : end,
        Boolean(match[2]), false, "arrow-expression", code.slice(cursor, end));
    }
  }

  declarations.sort((left, right) => left.start - right.start);
  const inventory = boundedTopLevelStatements(code, declarations);
  const folded = new Map();
  for (const declaration of declarations) {
    const names = folded.get(declaration.normalizedName) ?? [];
    names.push(declaration.name);
    folded.set(declaration.normalizedName, names);
  }
  bodies.declarations = declarations;
  bodies.topLevelStatements = inventory.statements;
  bodies.scanComplete = code.length <= MAX_SCAN_LENGTH && inventory.complete && declarations.length < MAX_CALLABLES;
  bodies.caseFoldCollisions = new Set([...folded].filter(([, names]) => new Set(names).size > 1 || names.length > 1).map(([name]) => name));
  for (const callable of bodies.values()) callable.topLevelStatements = bodies.topLevelStatements;
  return bodies;
}

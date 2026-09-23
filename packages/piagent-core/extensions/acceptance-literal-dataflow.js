import { parse as parseByteEvidence } from "@babel/parser";
import { testProofIntrinsicsAreStable, literalArrayIterationEnvironmentIsStable } from "./acceptance-executable-evidence.js";

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
        const pieces = splitTopLevel(code.slice(start, end));
        const records = []; let cursor = start;
        for (const [index, piece] of pieces.entries()) {
          const offset = code.indexOf(piece, cursor), next = offset + piece.length;
          const item = index === 0 ? { name: match[2], expression: piece }
            : (() => { const value = /^([a-z_$][a-z0-9_$]*)\s*=(?!=|>)\s*([\s\S]+)$/i.exec(piece);
              return value ? { name: value[1], expression: value[2] } : null; })();
          if (!item || offset < cursor) { records.length = 0; break; }
          records.push({ kind: match[1], ...item, start: index === 0 ? match.index : offset,
            end: index === pieces.length - 1 ? end + 1 : next + 1, scope: braceScope(code, match.index) });
          cursor = next + 1;
        }
        declarations.push(...records);
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


function snapshotIntrinsicsStable(call) {
  const code = call.code.replace(/__pi_bound_string_\d+__/g, token => {
    const value = boundStringValue(token, call.strings);
    return /^node:assert(?:\/strict)?$/.test(value ?? "") ? "__pi_node_assert_module_literal__"
      : value === "node:test" ? "__pi_node_test_module_literal__" : "__pi_string_literal__";
  });
  if (!/\bimport\s+(?:\*\s+as\s+)?assert\s+from\s+__pi_node_assert_module_literal__/.test(code)
    || call.declarations.some(entry => entry.name === "assert") || /\b(?:function|class)\s+assert\b/.test(code)) return false;
  const views = [code, ...(call.sourceEntries ?? []).map(entry => entry.evidenceText ?? entry.text)];
  for (const view of views) {
    if (typeof view !== "string" || view.length > 64_000 || !testProofIntrinsicsAreStable(view.toLowerCase()) || !literalArrayIterationEnvironmentIsStable(view)
      || /\b(?:globalThis|global|self|this|eval|createRequire)\b|\.\s*constructor\b|__pi_(?:code_generation|module_loader)_module_literal__/.test(view)) return false;
    for (const match of view.matchAll(/\bstructuredClone\b/g)) {
      if (!/^\s*\(/.test(view.slice(match.index + match[0].length))
        || /(?:\.|\bfunction)\s*$/.test(view.slice(0, match.index))) return false;
    }
    for (const match of view.matchAll(/\bJSON\b/g)) if (!/^\.(?:parse|stringify)\s*\(/.test(view.slice(match.index + 4))) return false;
  }
  return /__pi_node_assert_module_literal__/.test(code);
}

function ownSnapshotData(call, argument, before) {
  const scope = braceScope(call.code, before);
  const declaration = call.declarations.filter(entry => entry.name === argument && entry.kind === "const"
    && entry.end <= before && sameScope(entry.scope, scope)).at(-1);
  if (!declaration || new RegExp(`\\b${escapeRegex(argument)}\\b`).test(call.code.slice(declaration.end, before))) return false;
  const literal = (expression, depth = 0) => {
    if (depth > 12) return false;
    const value = expression.trim();
    if (exactBoundValue(value, call.strings) !== undefined || /^(?:null|[-+]?\d+(?:\.\d+)?)$/.test(value)) return true;
    if (value.startsWith("[") && value.endsWith("]")) {
      const items = splitTopLevel(value.slice(1, -1)); if (items.at(-1) === "") items.pop();
      return items.length <= 128 && items.every(item => item && literal(item, depth + 1));
    }
    if (value.startsWith("{") && value.endsWith("}")) {
      const fields = splitTopLevel(value.slice(1, -1)); if (fields.at(-1) === "") fields.pop();
      const seen = new Set();
      return fields.length <= 128 && fields.every(field => {
        const part = /^([a-z_$][a-z0-9_$]*|__pi_bound_string_\d+__)\s*:\s*([\s\S]+)$/i.exec(field);
        if (!part) return false;
        const key = boundStringValue(part[1], call.strings) ?? part[1];
        if (key === "__proto__" || key.includes("\\") || seen.has(key)) return false;
        seen.add(key); return literal(part[2], depth + 1);
      });
    }
    return false;
  };
  return literal(declaration.expression);
}

// Snapshot identity must survive from capture to the live comparison. A passing
// test can otherwise edit the expected snapshot to conceal a real input write.
export function stableDeepSnapshot(call, argument, snapshotName, assertionComparisons) {
  if (!call.safeScope || !snapshotIntrinsicsStable(call)) return false;
  const scope = braceScope(call.code, call.start), escaped = escapeRegex(argument);
  const expression = new RegExp(`^(?:structuredClone\\s*\\(\\s*${escaped}\\s*\\)|JSON\\.parse\\s*\\(\\s*JSON\\.stringify\\s*\\(\\s*${escaped}\\s*\\)\\s*\\))$`);
  const snapshot = call.declarations.filter(entry => entry.kind === "const" && entry.name === snapshotName
    && entry.end <= call.start && sameScope(entry.scope, scope) && expression.test(entry.expression)).at(-1);
  if (!snapshot || !unconditionalEvidenceScope(call.code, snapshot.start) || !ownSnapshotData(call, argument, snapshot.start)) return false;
  const mentionsSnapshot = new RegExp(`\\b${escapeRegex(snapshotName)}\\b`);
  if (mentionsSnapshot.test(call.code.slice(snapshot.end, call.start)) || mentionsSnapshot.test(call.slice)) return false;
  let beforeCall = call.code.slice(snapshot.end, call.start);
  for (const copy of call.declarations.filter(entry => entry.kind === "const" && entry.start >= snapshot.end && entry.end <= call.start
    && sameScope(entry.scope, scope) && new RegExp(`^\\[\\s*\\.\\.\\.\\s*${escaped}\\s*\\]$`).test(entry.expression))) {
    const offset = copy.start - snapshot.end;
    beforeCall = beforeCall.slice(0, offset) + " ".repeat(copy.end - copy.start) + beforeCall.slice(copy.end - snapshot.end);
  }
  if (new RegExp(`\\b${escaped}\\b`).test(beforeCall)) return false;
  const comparisons = call.scopedAssertions.filter(entry => entry.start >= call.end
    && assertionComparisons({ ...call, assertions: [entry.code] }).some(({actual, expected}) =>
      actual.trim() === argument && expected.trim() === snapshotName));
  for (const comparison of comparisons) {
    const comparisonOpen = comparison.code.indexOf("("), argumentsList = splitTopLevel(comparison.code.slice(comparisonOpen + 1, -1));
    if (!/^assert\.(?:deepEqual|deepStrictEqual|strictEqual)\s*\(/.test(comparison.code)
      || argumentsList.length < 2 || argumentsList.length > 3
      || argumentsList.length === 3 && typeof exactBoundValue(argumentsList[2], call.strings) !== "string") continue;
    const between = call.code.slice(call.end, comparison.start);
    if (mentionsSnapshot.test(between)) continue;
    // Only read-only assertions may intervene. Reject writes and unknown calls,
    // including calls through a pre-existing alias which could restore the input.
    let remaining = between;
    for (const check of call.scopedAssertions.filter(entry => entry.start >= call.end && entry.end <= comparison.start)) {
      if (!/^assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual)\s*\(/.test(check.code)
        || /(?:\+\+|--|=(?!=|>)|\b(?:delete|new|await)\b)/.test(check.code)
        || /\([^()]*\(/.test(check.code)) continue;
      remaining = remaining.replace(check.code, " ".repeat(check.code.length));
    }
    const containing = call.scopedAssertions.find(entry => entry.start < call.start && entry.end >= call.end);
    if (containing) {
      const pair = assertionComparisons({ ...call, assertions: [containing.code] }).find(item => item.actual.trim() === call.slice);
      const primitive = pair && (exactBoundValue(pair.expected, call.strings) !== undefined || /^(?:null|[-+]?\d+(?:\.\d+)?)$/.test(pair.expected));
      const indices = pair && /^\[[\s\S]*\]$/.test(pair.expected)
        && splitTopLevel(pair.expected.slice(1, -1)).every(item => new RegExp(`^${escaped}\\[\\d+\\]$`).test(item));
      if (!primitive && !indices) continue;
      remaining = remaining.slice(containing.end - call.end);
    }
    if (remaining.replace(/[;\s]/g, "")) continue;
    return true;
  }
  return false;
}

// Bounded fresh flat-object factories used by test data. These facts do not
// evaluate statements, arithmetic, getters, arbitrary calls or hidden aliases.
export function flatRecordFactories(ast, nested = false) {
  const factories = new Map();
  for (const statement of ast.program.body) {
    if (statement.type !== "VariableDeclaration" || statement.kind !== "const") continue;
    for (const declaration of statement.declarations) {
      const fn = declaration.init, parameter = fn?.params?.[0];
      if (nested && declaration.id.type === "Identifier" && fn?.type === "ArrowFunctionExpression" && !fn.async
        && fn.params.length === 0 && fn.body.type === "ObjectExpression") {
        factories.set(declaration.id.name, factories.has(declaration.id.name) ? null : {declaration,parameter:null,base:fn.body}); continue;
      }
      if (declaration.id.type !== "Identifier" || fn?.type !== "ArrowFunctionExpression" || fn.async || fn.params.length !== 1
        || parameter.type !== "AssignmentPattern" || parameter.left.type !== "Identifier" || parameter.right.type !== "ObjectExpression"
        || parameter.right.properties.length !== 0 || fn.body.type !== "ObjectExpression") continue;
      const spread = fn.body.properties.at(-1);
      if (spread?.type !== "SpreadElement" || spread.argument.type !== "Identifier" || spread.argument.name !== parameter.left.name
        || fn.body.properties.slice(0,-1).some(node => node.type !== "ObjectProperty" || node.computed || node.method)) continue;
      if (factories.has(declaration.id.name)) { factories.set(declaration.id.name,null); continue; }
      factories.set(declaration.id.name,{declaration,parameter:parameter.left.name,base:{type:"ObjectExpression",properties:fn.body.properties.slice(0,-1)}});
    }
  }
  return factories;
}
export function flatRecordValue(node, bindings = new Map(), factories = new Map(), before = Infinity, depth = 0, nested = false) {
  if (!node || depth > 6) return undefined;
  if (["NumericLiteral","StringLiteral","BooleanLiteral","NullLiteral"].includes(node.type)) return {kind:"primitive",value:node.type === "NullLiteral" ? null : node.value};
  if (node.type === "Identifier") {
    if (bindings.has(node.name)) return bindings.get(node.name);
    if (["NaN","Infinity","undefined"].includes(node.name)) return {kind:"primitive",value:node.name === "NaN" ? NaN : node.name === "Infinity" ? Infinity : undefined};
  }
  if (node.type === "UnaryExpression" && ["+","-"].includes(node.operator)) {
    const input = flatRecordValue(node.argument,bindings,factories,before,depth+1,nested);
    return input?.kind === "primitive" && typeof input.value === "number" ? {kind:"primitive",value:node.operator === "-" ? -input.value : input.value} : undefined;
  }
  if (node.type === "ArrayExpression" && (node.elements.length === 0 || nested && node.elements.length <= 32)) {
    const elements = node.elements.map(item=>flatRecordValue(item,bindings,factories,before,depth+1,nested));
    return elements.every(Boolean) ? {kind:"array",elements} : undefined;
  }
  if (node.type === "ObjectExpression" && node.properties.length <= 32) {
    const fields = new Map();
    for (const property of node.properties) {
      if (property.type !== "ObjectProperty" || property.method) return undefined;
      const key = !property.computed && property.key.type === "Identifier" ? property.key.name
        : flatRecordValue(property.key,bindings,factories,before,depth+1,nested)?.value;
      const value = flatRecordValue(property.value,bindings,factories,before,depth+1,nested);
      if (typeof key !== "string" || ["__proto__","constructor","prototype"].includes(key) || fields.has(key) || !value || !(nested ? ["primitive","record","array"].includes(value.kind) : value.kind === "primitive")) return undefined;
      fields.set(key,value);
    }
    return {kind:"record",fields};
  }
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.arguments.length <= 1) {
    const factory = factories.get(node.callee.name);
    if (!factory || factory.declaration.end > before || factory.parameter === null && node.arguments.length !== 0) return undefined;
    const base = flatRecordValue(factory.base,new Map(),new Map(),before,depth+1,nested);
    const supplied = node.arguments.length ? flatRecordValue(node.arguments[0],bindings,factories,before,depth+1,nested) : {kind:"record",fields:new Map()};
    const changes = supplied?.kind === "primitive" && supplied.value === undefined ? {kind:"record",fields:new Map()} : supplied;
    if (base?.kind !== "record" || changes?.kind !== "record") return undefined;
    return {kind:"record",fields:new Map([...base.fields,...changes.fields])};
  }
  return undefined;
}

const byteMember = node => node?.type === "Identifier" ? node.name : node?.type === "MemberExpression" && !node.computed
  ? `${byteMember(node.object)}.${node.property.name}` : null;
function walkByteEvidence(node, visit, parent, grandparent, depth = 0, budget = { count: 0 }) {
  if (!node || typeof node.type !== "string") return;
  if (++budget.count > 12_000 || depth > 128) throw new Error("byte-evidence-budget");
  visit(node, parent, grandparent);
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
    if (Array.isArray(value)) value.forEach(item => walkByteEvidence(item, visit, node, parent, depth + 1, budget));
    else if (value && typeof value === "object") walkByteEvidence(value, visit, node, parent, depth + 1, budget);
  }
}
// Input aliases may only enter native byte decoding. All stores target owned
// locals; unknown calls, native escapes and alternate writes remain unproved.
function readOnlyByteSource(entries, binding) {
  try {
    const selected = entries.filter(entry => entry.path === binding.sourcePath);
    if (selected.length !== 1 || entries.length !== 1 || selected[0].text.length > 64_000) return false;
    const ast = parseByteEvidence(selected[0].text, { sourceType: "module" });
    if (ast.program.body.length !== 1) return false;
    const exported = ast.program.body[0], fn = exported.declaration;
    if (exported.type !== "ExportNamedDeclaration" || fn?.type !== "FunctionDeclaration" || fn.async || fn.generator
      || fn.id?.name !== binding.sourceName || fn.params.length !== 1 || fn.params[0].type !== "Identifier") return false;
    const parents = new WeakMap(), scopes = new Map([[fn.id.name, [fn]]]);
    walkByteEvidence(fn, (node, parent) => { if (parent) parents.set(node, parent); });
    const enclosing = node => { for (let at = parents.get(node); at; at = parents.get(at)) if (["BlockStatement", "ForOfStatement", "ForStatement"].includes(at.type)) return at; return fn; };
    const bind = (name, scope) => scopes.set(name, [...(scopes.get(name) ?? []), scope]);
    const inScope = (node, name) => { for (let at = node; at; at = parents.get(at)) if ((scopes.get(name) ?? []).includes(at)) return true; return false; };
    bind(fn.params[0].name, fn);
    const input = fn.params[0].name, native = new Set(["Array", "Uint8Array", "TextDecoder", "JSON", "TypeError", "Error"]);
    const locals = new Set([input, fn.id.name]), elements = new Set(), decoders = new Set(), helpers = new Set(), permitted = new Set([fn.params[0]]);
    walkByteEvidence(fn.body, (node, parent) => {
      if (node.type === "VariableDeclarator") {
        if (node.id.type !== "Identifier" || native.has(node.id.name) || node.id.name === input) throw new Error("byte-local");
        locals.add(node.id.name); bind(node.id.name, enclosing(node));
        if (node.init?.type === "NewExpression" && node.init.callee.name === "TextDecoder") decoders.add(node.id.name);
        if (node.init?.type === "ArrowFunctionExpression") helpers.add(node.id.name);
      }
      if (/Function/.test(node.type) && node.params) for (const param of node.params) {
        const name = param.type === "Identifier" ? param.name : param.type === "AssignmentPattern" && param.left.type === "Identifier" ? param.left.name : null;
        if (!name || native.has(name) || name === input) throw new Error("byte-parameter"); locals.add(name); bind(name, node);
      }
      if (node.type === "ForOfStatement" && node.right.type === "Identifier" && node.right.name === input) {
        const declaration = node.left?.declarations?.[0];
        if (node.await || node.left.type !== "VariableDeclaration" || node.left.kind !== "const" || node.left.declarations.length !== 1 || declaration.id.type !== "Identifier") throw new Error("byte-loop");
        elements.add(declaration.id.name); permitted.add(node.right); permitted.add(declaration.id);
      }
      if (node.type === "CallExpression" && byteMember(node.callee) === `${input}.some`) {
        const callback = node.arguments[0], predicate = callback?.body?.argument;
        if (node.arguments.length !== 1 || callback?.type !== "ArrowFunctionExpression" || callback.async || callback.params.length !== 1
          || callback.params[0].type !== "Identifier" || callback.body.type !== "UnaryExpression" || callback.body.operator !== "!"
          || predicate?.type !== "BinaryExpression" || predicate.operator !== "instanceof" || predicate.left.name !== callback.params[0].name || predicate.right.name !== "Uint8Array") throw new Error("byte-shape");
        elements.add(callback.params[0].name); permitted.add(node.callee.object); permitted.add(callback.params[0]); permitted.add(predicate.left);
      }
      if (node.type === "CallExpression" && byteMember(node.callee) === "Array.isArray" && node.arguments.length === 1 && node.arguments[0].name === input) permitted.add(node.arguments[0]);
    });
    if (!elements.size || decoders.size !== 1) return false;
    const decoder = [...decoders][0];
    walkByteEvidence(fn, (node, parent, grandparent) => {
      if (node.type === "Identifier" && (node.name === input || elements.has(node.name))) {
        const nativeRead = parent?.type === "CallExpression" && byteMember(parent.callee) === `${decoder}.decode`
          && parent.arguments[0] === node && elements.has(node.name);
        if (!permitted.has(node) && !nativeRead) throw new Error("byte-input-escape");
      }
      if (node.type === "Identifier" && native.has(node.name)) {
        const allowed = node.name === "TextDecoder" && parent?.type === "NewExpression" && parent.callee === node
          || ["TypeError", "Error"].includes(node.name) && parent?.type === "NewExpression" && parent.callee === node
          || node.name === "Uint8Array" && parent?.type === "BinaryExpression" && parent.operator === "instanceof" && parent.right === node
          || ["Array", "JSON"].includes(node.name) && parent?.type === "MemberExpression" && parent.object === node
            && grandparent?.type === "CallExpression" && grandparent.callee === parent && ["Array.isArray", "JSON.parse"].includes(byteMember(parent));
        if (!allowed) throw new Error("byte-native-escape");
      }
      if (node.type === "Identifier" && node.name === decoder && !(parent?.type === "VariableDeclarator" && parent.id === node)
        && !(parent?.type === "MemberExpression" && parent.object === node && byteMember(parent) === `${decoder}.decode`
          && grandparent?.type === "CallExpression" && grandparent.callee === parent)) throw new Error("byte-decoder-escape");
      if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
        const target = node.left ?? node.argument;
        if (target.type !== "Identifier" || !locals.has(target.name) || [input, decoder, ...elements, ...helpers, fn.id.name].includes(target.name)) throw new Error("byte-store");
      }
      if (node.type === "UnaryExpression" && node.operator === "delete" || ["ThisExpression", "AwaitExpression", "YieldExpression"].includes(node.type)
        || node.type === "MemberExpression" && (node.computed || ["prototype", "constructor", "__proto__"].includes(node.property.name))) throw new Error("byte-reflection");
      if (node.type === "NewExpression" && !["TextDecoder", "TypeError", "Error"].includes(node.callee.name)) throw new Error("byte-constructor");
      if (node.type === "CallExpression") {
        const member = byteMember(node.callee);
        const localMethod = node.callee.type === "MemberExpression" && locals.has(node.callee.object.name)
          && ![input, ...elements, decoder].includes(node.callee.object.name) && ["split", "pop", "push", "endsWith", "slice"].includes(node.callee.property.name);
        if (!helpers.has(node.callee.name) && !["Array.isArray", "JSON.parse", `${input}.some`, `${decoder}.decode`].includes(member) && !localMethod) throw new Error("byte-call");
      }
      if (node.type === "Identifier" && !inScope(node, node.name) && !native.has(node.name)
        && !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed)
        && !(parent?.type === "ObjectProperty" && parent.key === node && !parent.computed)) throw new Error("byte-free-name");
    });
    return true;
  } catch { return false; }
}
function byteSnapshotProgram(profile, binding) {
  if (!testProofIntrinsicsAreStable(profile.evidenceCode) || !literalArrayIterationEnvironmentIsStable(profile.evidenceCode)) return null;
  try {
    const ast = parseByteEvidence(profile.raw, { sourceType: "module" }), imports = ast.program.body.filter(node => node.type === "ImportDeclaration");
    const local = module => imports.filter(node => node.source.value === module).flatMap(node => node.specifiers.filter(item => item.type === "ImportDefaultSpecifier").map(item => item.local.name));
    const asserts = [...local("node:assert/strict"), ...local("node:assert")], runners = local("node:test");
    if (imports.length !== 3 || asserts.length !== 1 || runners.length !== 1) return null;
    const assertName = asserts[0], testName = runners[0], native = new Set(["Array", "ArrayBuffer", "Uint8Array", "TextEncoder"]), encoders = new Set(), registrations = [];
    for (const statement of ast.program.body) {
      if (statement.type === "ImportDeclaration") continue;
      if (statement.type === "VariableDeclaration" && statement.kind === "const" && statement.declarations.length === 1) {
        const declaration = statement.declarations[0], fn = declaration.init, call = fn?.body, owner = call?.callee?.object;
        if (declaration.id.type !== "Identifier" || fn?.type !== "ArrowFunctionExpression" || fn.async || fn.params.length !== 1 || fn.params[0].type !== "Identifier"
          || call?.type !== "CallExpression" || call.callee.type !== "MemberExpression" || call.callee.computed || call.callee.property.name !== "encode"
          || owner?.type !== "NewExpression" || owner.callee.name !== "TextEncoder" || owner.arguments.length !== 0
          || call.arguments.length !== 1 || call.arguments[0].name !== fn.params[0].name) return null;
        encoders.add(declaration.id.name); continue;
      }
      const call = statement.type === "ExpressionStatement" ? statement.expression : null;
      if (call?.type !== "CallExpression" || call.callee.name !== testName || call.arguments.length !== 2 || call.arguments[0].type !== "StringLiteral"
        || call.arguments[1].type !== "ArrowFunctionExpression" || call.arguments[1].async || call.arguments[1].params.length !== 0 || call.arguments[1].body.type !== "BlockStatement") return null;
      registrations.push(call.arguments[1].body);
    }
    if (!encoders.size) return null;
    const protectedNames = new Set([...native, assertName, testName, binding.testName, ...encoders]);
    walkByteEvidence(ast, (node, parent, grandparent) => {
      if (node.type === "ImportDeclaration" || parent?.type === "ImportDefaultSpecifier" || parent?.type === "ImportSpecifier") return;
      if (node.type === "AssignmentExpression" || node.type === "UnaryExpression" && node.operator === "delete") throw new Error("byte-test-store");
      if (node.type === "UpdateExpression" && (node.argument.type !== "Identifier" || protectedNames.has(node.argument.name))) throw new Error("byte-test-update");
      if (node.type === "MemberExpression" && (["prototype", "constructor", "__proto__"].includes(node.property.name)
        || node.computed && node.property.type !== "NumericLiteral")) throw new Error("byte-test-reflection");
      if (node.type === "Identifier" && ["globalThis", "global", "process", "Reflect", "Proxy", "Function", "eval", "Symbol", "Object"].includes(node.name)) throw new Error("byte-test-global");
      if (node.type === "Identifier" && native.has(node.name)) {
        if (!(node.name === "Array" && parent?.type === "MemberExpression" && parent.object === node && byteMember(parent) === "Array.from"
          && grandparent?.type === "CallExpression" && grandparent.callee === parent)
          && !(node.name !== "Array" && parent?.type === "NewExpression" && parent.callee === node)) throw new Error("byte-test-native");
      }
      if (/Function/.test(node.type) && node.params?.some(param => param.type !== "Identifier" || protectedNames.has(param.name))) throw new Error("byte-test-parameter");
      if (node.type === "VariableDeclarator" && (node.id.type !== "Identifier" || protectedNames.has(node.id.name) && !encoders.has(node.id.name))) throw new Error("byte-test-binding");
      if (node.type === "Identifier" && encoders.has(node.name) && !(parent?.type === "VariableDeclarator" && parent.id === node)
        && !(parent?.type === "CallExpression" && parent.callee === node)
        && !(parent?.type === "MemberExpression" && parent.property === node && !parent.computed && parent.object.type === "NewExpression"
          && parent.object.callee.name === "TextEncoder" && grandparent?.type === "CallExpression" && grandparent.callee === parent)) throw new Error("byte-encoder-escape");
    });
    return { assertName, testName, encoders, registrations, protectedNames };
  } catch { return null; }
}
function byteSnapshotBody(body, program, binding) {
  const facts = new Map(); let callIndex = -1, chunksName, snapshotName, identitiesName;
  const byteRoots = node => node?.type === "ArrayExpression" && node.elements.length > 0 && node.elements.length <= 16
    ? node.elements.map(item => item?.type === "CallExpression" && byteMember(item.callee) === "Array.from" && item.arguments.length === 1 && item.arguments[0].type === "Identifier"
      && facts.get(item.arguments[0].name)?.kind === "bytes" && facts.get(item.arguments[0].name).root === item.arguments[0].name ? item.arguments[0].name : null) : null;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => value === b[index]);
  for (const [position, statement] of body.body.entries()) {
    if (statement.type !== "VariableDeclaration") { callIndex = position; break; }
    if (statement.kind !== "const") return false;
    for (const declaration of statement.declarations) {
      const name = declaration.id.name, init = declaration.init;
      if (declaration.id.type !== "Identifier" || facts.has(name) || program.protectedNames.has(name)) return false;
      if (init?.type === "CallExpression" && program.encoders.has(init.callee.name) && init.arguments.length === 1 && init.arguments[0].type === "StringLiteral") {
        const text = init.arguments[0].value; if (text.length > 32_000) return false;
        facts.set(name, { kind: "bytes", root: name, length: new TextEncoder().encode(text).length }); continue;
      }
      if (init?.type === "CallExpression" && init.callee.type === "MemberExpression" && !init.callee.computed && init.callee.property.name === "subarray") {
        const owner = init.callee.object.name, fact = facts.get(owner), [start, end] = init.arguments;
        if (fact?.kind !== "bytes" || fact.root !== owner || init.arguments.length !== 2 || start.type !== "NumericLiteral" || !Number.isInteger(start.value) || start.value <= 0
          || end.type !== "BinaryExpression" || end.operator !== "-" || byteMember(end.left) !== `${owner}.length` || end.right.type !== "NumericLiteral"
          || !Number.isInteger(end.right.value) || end.right.value <= 0 || start.value + end.right.value >= fact.length) return false;
        facts.set(name, { kind: "bytes", root: owner, length: fact.length - start.value - end.right.value, partial: true }); continue;
      }
      if (init?.type === "ArrayExpression" && init.elements.length > 0 && init.elements.length <= 16 && init.elements.every(node => node?.type === "Identifier" && facts.get(node.name)?.kind === "bytes")) {
        if (chunksName) return false; chunksName = name; facts.set(name, { kind: "chunks", names: init.elements.map(node => node.name) }); continue;
      }
      const roots = byteRoots(init);
      if (roots?.every(Boolean)) { if (snapshotName) return false; snapshotName = name; facts.set(name, { kind: "snapshot", roots }); continue; }
      if (init?.type === "ArrayExpression" && init.elements.length === 1 && init.elements[0]?.type === "SpreadElement" && init.elements[0].argument.name === chunksName) {
        if (identitiesName) return false; identitiesName = name; facts.set(name, { kind: "identities" }); continue;
      }
      return false;
    }
  }
  if (callIndex < 0 || !chunksName || !snapshotName || !identitiesName) return false;
  const chunks = facts.get(chunksName), roots = [...new Set(chunks.names.map(name => facts.get(name).root))];
  if (!same(roots, facts.get(snapshotName).roots) || !chunks.names.some(name => facts.get(name).partial)) return false;
  const first = body.body[callIndex]?.expression, invocation = first?.arguments?.[0];
  if (first?.type !== "CallExpression" || ![`${program.assertName}.deepEqual`, `${program.assertName}.deepStrictEqual`].includes(byteMember(first.callee)) || first.arguments.length !== 2
    || invocation?.type !== "CallExpression" || invocation.callee.name !== binding.testName || invocation.arguments.length !== 1 || invocation.arguments[0].name !== chunksName
    || !flatByteExpected(first.arguments[1])) return false;
  let length = false, array = false, bytes = false; const identities = new Set();
  for (const statement of body.body.slice(callIndex + 1)) {
    const call = statement.type === "ExpressionStatement" ? statement.expression : null, [left, right] = call?.arguments ?? [];
    if (call?.type !== "CallExpression" || call.arguments.length !== 2) return false;
    const method = byteMember(call.callee);
    if ([`${program.assertName}.equal`, `${program.assertName}.strictEqual`].includes(method) && byteMember(left) === `${chunksName}.length` && byteMember(right) === `${identitiesName}.length`) { length = true; continue; }
    if ([`${program.assertName}.deepEqual`, `${program.assertName}.deepStrictEqual`].includes(method) && left.name === chunksName && right.name === identitiesName) { array = true; continue; }
    if (method === `${program.assertName}.strictEqual` && left.type === "MemberExpression" && left.computed && left.object.name === chunksName && left.property.type === "NumericLiteral"
      && Number.isInteger(left.property.value) && left.property.value >= 0 && chunks.names[left.property.value] === right.name) { identities.add(left.property.value); continue; }
    if ([`${program.assertName}.deepEqual`, `${program.assertName}.deepStrictEqual`].includes(method) && same(byteRoots(left), roots) && right.name === snapshotName) { bytes = true; continue; }
    return false;
  }
  return length && array && bytes && identities.size === chunks.names.length;
}
function flatByteExpected(node, depth = 0) {
  if (!node || depth > 6) return false;
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(node.type)) return true;
  if (node.type === "ArrayExpression") return node.elements.length <= 32 && node.elements.every(item => flatByteExpected(item, depth + 1));
  return node.type === "ObjectExpression" && node.properties.length <= 16 && node.properties.every(item => item.type === "ObjectProperty" && !item.computed && !item.method
    && item.key.type === "Identifier" && !["__proto__", "prototype", "constructor"].includes(item.key.name) && flatByteExpected(item.value, depth + 1));
}
export function byteArrayNonMutationEvidence({ rawCriterion, profiles, sourceEntries }) {
  if (!/^Do not mutate the (?:chunk|byte) array or its buffers(?: and do not add dependencies)?[.;]?$/i.test(String(rawCriterion).replace(/\s+/g, " ").trim())) return false;
  return profiles.some(profile => (profile.bindings ?? []).some(binding => {
    if (!readOnlyByteSource(sourceEntries, binding)) return false;
    const program = byteSnapshotProgram(profile, binding);
    return program?.registrations.some(body => byteSnapshotBody(body, program, binding)) === true;
  }));
}

// Effects are checked over every source branch. Frozen witnesses alone cannot
// establish this property: a conditional write on ordinary input still fails.
function immutableRecordValue(node, values = new Map(), allowFreeze = false, depth = 0) {
  if (!node || depth > 8) return null;
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(node.type)) return { kind: "scalar", value: node.type === "NullLiteral" ? null : node.value };
  if (node.type === "Identifier") return values.get(node.name) ?? null;
  if (allowFreeze && node.type === "CallExpression" && byteMember(node.callee) === "Object.freeze" && node.arguments.length === 1)
    return immutableRecordValue(node.arguments[0], values, allowFreeze, depth + 1);
  if (node.type === "ArrayExpression" && node.elements.length <= 32) {
    const items = node.elements.map(item => immutableRecordValue(item, values, allowFreeze, depth + 1));
    return items.every(Boolean) ? { kind: "array", items } : null;
  }
  if (node.type === "ObjectExpression" && node.properties.length <= 32) {
    const fields = new Map();
    for (const property of node.properties) {
      if (property.type === "SpreadElement") {
        const source = immutableRecordValue(property.argument, values, allowFreeze, depth + 1);
        if (source?.kind !== "record") return null;
        for (const [key, value] of source.fields) fields.set(key, value);
        continue;
      }
      if (property.type !== "ObjectProperty" || property.computed || property.method || property.key.type !== "Identifier"
        || ["__proto__", "constructor", "prototype"].includes(property.key.name)) return null;
      const value = immutableRecordValue(property.value, values, allowFreeze, depth + 1); if (!value) return null;
      fields.set(property.key.name, value);
    }
    return { kind: "record", fields };
  }
  return null;
}
function pureRecordSource(entries, binding) {
  try {
    if (entries.length !== 1 || entries[0].path !== binding.sourcePath || entries[0].text.length > 64_000) return null;
    const ast = parseByteEvidence(entries[0].text, { sourceType: "module" }), constants = new Map(), functions = [];
    const protectedNames = new Set(["Object", "Number", "Array", "Reflect", "Proxy", "Function", "eval", "global", "globalThis", "process"]);
    walkByteEvidence(ast, () => {});
    for (const statement of ast.program.body) {
      if (statement.type !== "ExportNamedDeclaration" || statement.source) return null;
      const declaration = statement.declaration;
      if (declaration?.type === "FunctionDeclaration") { functions.push(declaration); continue; }
      if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const" || declaration.declarations.length !== 1) return null;
      const item = declaration.declarations[0];
      if (item.id.type !== "Identifier" || protectedNames.has(item.id.name) || constants.has(item.id.name)) return null;
      const value = immutableRecordValue(item.init, constants, true); if (!value || value.kind !== "record") return null;
      constants.set(item.id.name, value);
    }
    const fn = functions[0];
    if (functions.length !== 1 || !fn || fn.id?.name !== binding.sourceName || fn.async || fn.generator || fn.params.length !== 2
      || constants.has(fn.id.name) || protectedNames.has(fn.id.name)) return null;
    const names = new Set(constants.keys());
    for (const parameter of fn.params) {
      const name = parameter.type === "Identifier" ? parameter.name : parameter.type === "AssignmentPattern" && parameter.left.type === "Identifier"
        && parameter.right.type === "Identifier" && constants.has(parameter.right.name) ? parameter.left.name : null;
      if (!name || names.has(name) || protectedNames.has(name) || name === fn.id.name) return null;
      names.add(name);
    }
    const expression = (node, scope, depth = 0) => {
      if (!node || depth > 64) return false;
      if (["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(node.type)) return true;
      if (node.type === "Identifier") return scope.has(node.name);
      if (node.type === "MemberExpression") return !node.computed && !["constructor", "prototype", "__proto__"].includes(node.property.name) && expression(node.object, scope, depth + 1);
      if (node.type === "UnaryExpression") return ["!", "typeof", "+", "-"].includes(node.operator) && expression(node.argument, scope, depth + 1);
      if (node.type === "BinaryExpression") return ["===", "!==", "<", "<=", ">", ">=", "+", "-"].includes(node.operator) && expression(node.left, scope, depth + 1) && expression(node.right, scope, depth + 1);
      if (node.type === "LogicalExpression") return ["&&", "||", "??"].includes(node.operator) && expression(node.left, scope, depth + 1) && expression(node.right, scope, depth + 1);
      if (node.type === "ConditionalExpression") return [node.test, node.consequent, node.alternate].every(item => expression(item, scope, depth + 1));
      if (node.type === "ArrayExpression") return node.elements.length <= 32 && node.elements.every(item => expression(item?.type === "SpreadElement" ? item.argument : item, scope, depth + 1));
      if (node.type === "ObjectExpression") return node.properties.length <= 32 && node.properties.every(item => item.type === "SpreadElement" ? expression(item.argument, scope, depth + 1)
        : item.type === "ObjectProperty" && !item.computed && !item.method && item.key.type === "Identifier" && !["constructor", "prototype", "__proto__"].includes(item.key.name) && expression(item.value, scope, depth + 1));
      return node.type === "CallExpression" && ["Number.isInteger", "Number.isFinite", "Number.isSafeInteger"].includes(byteMember(node.callee))
        && node.arguments.length === 1 && expression(node.arguments[0], scope, depth + 1);
    };
    const statements = (nodes, scope, depth = 0) => depth <= 32 && nodes.every(node => {
      if (node.type === "ReturnStatement") return expression(node.argument, scope);
      if (node.type === "BlockStatement") return statements(node.body, new Set(scope), depth + 1);
      if (node.type === "IfStatement") return expression(node.test, scope) && statements([node.consequent], new Set(scope), depth + 1)
        && (!node.alternate || statements([node.alternate], new Set(scope), depth + 1));
      if (node.type !== "VariableDeclaration" || node.kind !== "const") return false;
      return node.declarations.every(item => {
        if (item.id.type !== "Identifier" || scope.has(item.id.name) || protectedNames.has(item.id.name) || !expression(item.init, scope)) return false;
        scope.add(item.id.name); return true;
      });
    });
    return fn.body.body.length > 0 && statements(fn.body.body, names) ? { constants } : null;
  } catch { return null; }
}
function pureRecordTestWitness(profile, binding, source) {
  if (!testProofIntrinsicsAreStable(profile.evidenceCode) || !literalArrayIterationEnvironmentIsStable(profile.evidenceCode)) return false;
  try {
    if (profile.raw.length > 64_000) return false;
    const ast = parseByteEvidence(profile.raw, { sourceType: "module" }), imports = ast.program.body.filter(node => node.type === "ImportDeclaration");
    const local = module => imports.filter(node => node.source.value === module).flatMap(node => node.specifiers.filter(item => item.type === "ImportDefaultSpecifier").map(item => item.local.name));
    const asserts = [...local("node:assert/strict"), ...local("node:assert")], runners = local("node:test");
    if (imports.length !== 3 || asserts.length !== 1 || runners.length !== 1) return false;
    const assertName = asserts[0], testName = runners[0], initial = new Map(), protectedNames = new Set([assertName, testName, "Object", "Number", "Array", binding.testName]);
    for (const declaration of imports.filter(node => !node.source.value.startsWith("node:"))) for (const item of declaration.specifiers) {
      if (item.type !== "ImportSpecifier") return false;
      if (source.constants.has(item.imported.name)) { initial.set(item.local.name, source.constants.get(item.imported.name)); protectedNames.add(item.local.name); }
      else if (item.local.name !== binding.testName || item.imported.name !== binding.sourceName) return false;
    }
    const methods = new Set(["equal", "strictEqual", "deepEqual", "deepStrictEqual", "notEqual", "notStrictEqual"]);
    walkByteEvidence(ast, (node, parent, grandparent) => {
      if (["AssignmentExpression", "UpdateExpression", "AwaitExpression", "ThisExpression"].includes(node.type) || node.type === "UnaryExpression" && node.operator === "delete") throw new Error("record-test-store");
      if (node.type === "MemberExpression" && (node.computed || ["constructor", "prototype", "__proto__"].includes(node.property.name))) throw new Error("record-test-reflection");
      if (node.type === "Identifier" && ["global", "globalThis", "process", "Reflect", "Proxy", "Function", "eval", "Symbol"].includes(node.name)) throw new Error("record-test-global");
      if (node.type === "Identifier" && node.name === "Object" && !(parent?.type === "MemberExpression" && parent.object === node && byteMember(parent) === "Object.freeze"
        && grandparent?.type === "CallExpression" && grandparent.callee === parent)) throw new Error("record-test-native");
      if (/Function/.test(node.type) && node.params?.some(param => param.type !== "Identifier" || protectedNames.has(param.name))) throw new Error("record-test-parameter");
      if (node.type === "VariableDeclarator") {
        const names = node.id.type === "Identifier" ? [node.id.name] : node.id.type === "ArrayPattern" ? node.id.elements.map(item => item?.name) : [];
        if (!names.length || names.some(name => !name || protectedNames.has(name))) throw new Error("record-test-binding");
      }
      if (node.type === "CallExpression" && ![binding.testName, testName, "Object.freeze", ...[...methods].map(name => `${assertName}.${name}`)].includes(byteMember(node.callee))) throw new Error("record-test-call");
    });
    let witnessed = false, expanded = 0;
    const containsArray = (value, depth = 0) => depth < 8 && (value?.kind === "array" ? value.items.length > 0 : value?.kind === "record" && [...value.fields.values()].some(item => containsArray(item, depth + 1)));
    const observe = (call, values) => {
      if (call?.type !== "CallExpression" || call.callee.name !== binding.testName || call.arguments.length !== 2) return;
      const args = call.arguments.map(node => immutableRecordValue(node, values, true));
      if (args.every(value => value?.kind === "record" && containsArray(value))) witnessed = true;
    };
    const condition = (node, values) => {
      const literal = immutableRecordValue(node, values, true); if (literal?.kind === "scalar" && typeof literal.value === "boolean") return literal.value;
      if (node?.type !== "BinaryExpression" || !["===", "!=="].includes(node.operator)) return null;
      const left = immutableRecordValue(node.left, values, true), right = immutableRecordValue(node.right, values, true);
      return left?.kind === "scalar" && right?.kind === "scalar" ? (left.value === right.value) === (node.operator === "===") : null;
    };
    const read = (nodes, values, depth = 0) => {
      if (depth > 4) throw new Error("record-test-depth");
      for (const statement of nodes) {
        if (++expanded > 512) throw new Error("record-test-expansion");
        if (statement.type === "VariableDeclaration" && statement.kind === "const") {
          for (const item of statement.declarations) {
            if (item.id.type !== "Identifier") throw new Error("record-test-local");
            const value = immutableRecordValue(item.init, values, true);
            if (value) values.set(item.id.name, value); else { observe(item.init, values); values.delete(item.id.name); }
          }
          continue;
        }
        if (statement.type === "ForOfStatement" && !statement.await && statement.left.type === "VariableDeclaration" && statement.left.kind === "const" && statement.left.declarations.length === 1) {
          const pattern = statement.left.declarations[0].id, rows = immutableRecordValue(statement.right, values, true);
          if (rows?.kind !== "array" || rows.items.length > 32) throw new Error("record-test-rows");
          for (const row of rows.items) {
            const nested = new Map(values);
            if (pattern.type === "Identifier") nested.set(pattern.name, row);
            else if (pattern.type === "ArrayPattern" && row.kind === "array" && row.items.length === pattern.elements.length && pattern.elements.every(node => node?.type === "Identifier"))
              pattern.elements.forEach((node, index) => nested.set(node.name, row.items[index]));
            else throw new Error("record-test-tuple");
            read(statement.body.type === "BlockStatement" ? statement.body.body : [statement.body], nested, depth + 1);
          }
          continue;
        }
        if (statement.type === "IfStatement") {
          const selected = condition(statement.test, values); if (selected === null) throw new Error("record-test-condition");
          const branch = selected ? statement.consequent : statement.alternate;
          if (branch) read(branch.type === "BlockStatement" ? branch.body : [branch], new Map(values), depth + 1); continue;
        }
        const call = statement.type === "ExpressionStatement" ? statement.expression : null;
        if (call?.type !== "CallExpression" || call.callee.type !== "MemberExpression" || call.callee.object.name !== assertName || !methods.has(call.callee.property.name)) throw new Error("record-test-statement");
        for (const argument of call.arguments) observe(argument, values);
      }
    };
    for (const statement of ast.program.body) {
      if (statement.type === "ImportDeclaration") continue;
      const call = statement.type === "ExpressionStatement" ? statement.expression : null, callback = call?.arguments?.[1];
      if (call?.type !== "CallExpression" || call.callee.name !== testName || call.arguments.length !== 2 || call.arguments[0].type !== "StringLiteral"
        || callback?.type !== "ArrowFunctionExpression" || callback.async || callback.params.length !== 0 || callback.body.type !== "BlockStatement") return false;
      read(callback.body.body, new Map(initial));
    }
    return witnessed;
  } catch { return false; }
}
export function pureRecordNonMutationEvidence({ rawCriterion, profiles, sourceEntries }) {
  if (!/^Do not mutate state, actions, or result arrays[.;]?$/i.test(String(rawCriterion).replace(/\s+/g, " ").trim())) return false;
  return profiles.some(profile => (profile.bindings ?? []).some(binding => {
    const source = pureRecordSource(sourceEntries, binding);
    return source !== null && pureRecordTestWitness(profile, binding, source);
  }));
}

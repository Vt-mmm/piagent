import { parse } from "@babel/parser";
import { protocolShape as shape, validateValue, numberValue } from "./acceptance-executor/values.mjs";

export const DECLARED_API_VERSION = "declared-positional-api-v1";
const NAME = /^[a-zA-Z_$][\w$]{0,127}$/;
const fail = () => { throw new TypeError("declared-api-unsupported"); };

/** Explicit host expectation for declarations only. Parameter names and function
 * bodies are not API proofs; behavior/default results require the other cases.
 * This comparator never executes source or reads a model-supplied expectation.
 */
export function validateDeclaredApi(value) {
  shape(value, ["version", "exports"]);
  if (value.version !== DECLARED_API_VERSION || !Array.isArray(value.exports) || value.exports.length < 1 || value.exports.length > 32) fail();
  let previous = "";
  for (const entry of value.exports) {
    if (typeof entry.name !== "string" || !NAME.test(entry.name) || entry.name <= previous) fail(); previous = entry.name;
    if (entry.kind === "function") {
      shape(entry, ["name", "kind", "async", "generator", "parameters"]);
      if (typeof entry.async !== "boolean" || typeof entry.generator !== "boolean" || !Array.isArray(entry.parameters) || entry.parameters.length > 16) fail();
      for (const parameter of entry.parameters) {
        if (parameter === "required") continue;
        if (parameter?.kind === "default-binding") {
          shape(parameter, ["kind", "name", "value", "frozen"]); if (typeof parameter.name !== "string" || !NAME.test(parameter.name) || typeof parameter.frozen !== "boolean") fail();
          validateValue(parameter.value, false);
        } else {
          shape(parameter, ["kind", "value"]); if (parameter.kind !== "default") fail();
          validateValue(parameter.value, false);
        }
      }
    } else {
      shape(entry, ["name", "kind", "value", "frozen"]);
      if (entry.kind !== "const-value" || typeof entry.frozen !== "boolean") fail();
      validateValue(entry.value, false);
    }
  }
  if (JSON.stringify(value).length > 65536) fail();
  return value;
}

/** Closed, bounded declaration inspection, not a return-type or equivalence
 * prover. Dynamic/re-exported APIs, destructuring, rest parameters and arbitrary
 * initializer execution remain unknown. Const values must be inert literals.
 */
export function observeDeclaredApi(source) {
  try {
    if (typeof source !== "string" || Buffer.byteLength(source) > 64000) fail();
    const ast = parse(source, { sourceType: "module", errorRecovery: false, attachComment: false });
    const bindings = new Map(), exported = new Map(); let nodes = 0;
    function visit(node, depth = 0) {
      if (!node || typeof node.type !== "string") return;
      if (++nodes > 12000 || depth > 128) fail();
      // Conservative refusal of rebinding a public name, including ambiguous
      // shadowing. Do not certify a declaration that source later replaces.
      const target = node.type === "AssignmentExpression" ? node.left : node.type === "UpdateExpression" ? node.argument : null;
      if (target?.type === "Identifier" && [...exported.values()].includes(target.name)) fail();
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
        else if (value && typeof value === "object") visit(value, depth + 1);
      }
    }
    for (const statement of ast.program.body) {
      const isExport = statement.type === "ExportNamedDeclaration";
      if (isExport && statement.source) fail();
      const node = isExport ? statement.declaration : statement;
      if (isExport && !node) {
        for (const item of statement.specifiers) {
          if (item.type !== "ExportSpecifier" || item.local.type !== "Identifier" || item.exported.type !== "Identifier" || exported.has(item.exported.name)) fail();
          exported.set(item.exported.name, item.local.name);
        }
        continue;
      }
      const declarations = node?.type === "FunctionDeclaration" ? [[node.id?.name, node]]
        : node?.type === "VariableDeclaration" && node.kind === "const" ? node.declarations.map(item => [item.id.type === "Identifier" ? item.id.name : null, item]) : null;
      if (!declarations) fail();
      for (const [name, declaration] of declarations) {
        if (!name || bindings.has(name)) fail(); bindings.set(name, declaration);
        if (isExport) { if (exported.has(name)) fail(); exported.set(name, name); }
      }
    }
    visit(ast);
    const literal = node => {
      if (node?.type === "NullLiteral") return { type: "null" };
      if (node?.type === "Identifier" && node.name === "undefined" && !bindings.has("undefined")) return { type: "undefined" };
      if (node?.type === "NumericLiteral") return { type: "number", value: numberValue(node.value) };
      if (node?.type === "StringLiteral") return { type: "string", value: node.value };
      if (node?.type === "BooleanLiteral") return { type: "boolean", value: node.value };
      if (node?.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral") return { type: "number", value: numberValue(-node.argument.value) };
      if (node?.type === "ArrayExpression") return { type: "array", value: node.elements.map(literal) };
      if (node?.type === "ObjectExpression") {
        const keys = new Set();
        return { type: "record", value: node.properties.map(item => {
          if (item.type !== "ObjectProperty" || item.computed || item.method || item.shorthand) fail();
          const key = item.key.type === "Identifier" ? item.key.name : item.key.type === "StringLiteral" ? item.key.value : null;
          if (key === null || key === "__proto__" || keys.has(key)) fail(); keys.add(key);
          return { key, value: literal(item.value) };
        }) };
      }
      return fail();
    };
    const constValue = node => {
      if (node?.type !== "VariableDeclarator") fail();
      let value = node.init, frozen = false;
      if (value?.type === "CallExpression" && !value.optional && value.arguments.length === 1 && value.callee.type === "MemberExpression"
        && !value.callee.computed && value.callee.object.type === "Identifier" && value.callee.object.name === "Object"
        && value.callee.property.name === "freeze" && !bindings.has("Object")) { value = value.arguments[0]; frozen = true; }
      return { value: literal(value), frozen };
    };
    const entries = [...exported].map(([name, local]) => {
      const node = bindings.get(local); if (!node) fail();
      if (node.type !== "FunctionDeclaration") return { name, kind: "const-value", ...constValue(node) };
      const parameters = node.params.map(parameter => {
        if (parameter.type === "Identifier") return "required";
        if (parameter.type !== "AssignmentPattern" || parameter.left.type !== "Identifier") fail();
        const right = parameter.right;
        if (right.type === "Identifier" && bindings.has(right.name)) {
          return { kind: "default-binding", name: right.name, ...constValue(bindings.get(right.name)) };
        }
        return { kind: "default", value: literal(right) };
      });
      return { name, kind: "function", async: node.async, generator: node.generator, parameters };
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    return { status: "observed", value: validateDeclaredApi({ version: DECLARED_API_VERSION, exports: entries }) };
  } catch { return { status: "unsupported", reason: "declared-api-unsupported" }; }
}

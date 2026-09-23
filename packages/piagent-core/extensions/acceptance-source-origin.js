import path from "node:path";
import { parse } from "@babel/parser";

const cache = new Map();
const MAX_SOURCE_LENGTH = 64_000, MAX_NODES = 12_000, MAX_CACHE_ENTRIES = 32;
const modulePath = value => path.posix.normalize(String(value).replace(/\\/g, "/"));
const callable = node => ["FunctionExpression", "ArrowFunctionExpression"].includes(node?.type);
const nameOf = node => node?.type === "Identifier" ? node.name
  : node?.type === "PrivateName" ? node.id.name
    : ["StringLiteral", "NumericLiteral"].includes(node?.type) ? String(node.value) : null;
const bindingNames = node => node?.type === "Identifier" ? [node.name]
  : node?.type === "ObjectPattern" ? node.properties.flatMap(item => bindingNames(item.type === "RestElement" ? item.argument : item.value))
    : node?.type === "ArrayPattern" ? node.elements.flatMap(bindingNames)
      : node?.type === "AssignmentPattern" ? bindingNames(node.left)
        : node?.type === "RestElement" ? bindingNames(node.argument) : [];


// A computed store of a plain record into a function-local fresh copy does
// not introduce a callable origin under that dynamic key. Its child members
// are still inventoried normally. This classifies origin only, not behavior.
function localRecordStore(node, enclosing, ast) {
  if (node.operator !== "=" || !node.left.computed || node.right.type !== "ObjectExpression"
    || node.right.properties.some(item => item.type !== "ObjectProperty" || item.computed || item.method)) return false;
  let receiver = node.left.object;
  while (receiver?.type === "MemberExpression" && !receiver.computed) {
    if (["constructor", "prototype", "__proto__"].includes(receiver.property.name)) return false;
    receiver = receiver.object;
  }
  if (receiver?.type !== "Identifier" || ["module", "exports", "global", "globalThis", "Object", "Function"].includes(receiver.name)) return false;
  const fn = [...enclosing].reverse().find(item => ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"].includes(item.type));
  if (!fn || fn.async || fn.generator || fn.body.type !== "BlockStatement" || fn.params.some(item => bindingNames(item).includes(receiver.name))) return false;
  const declarations = fn.body.body.filter(item => item.type === "VariableDeclaration" && item.kind === "const")
    .flatMap(item => item.declarations).filter(item => item.id.type === "Identifier" && item.id.name === receiver.name && item.end < node.start);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0], value = declaration.init;
  const cloned = value?.type === "CallExpression" && value.callee.type === "Identifier" && value.callee.name === "structuredClone"
    && value.arguments.length === 1 && value.arguments[0].type === "Identifier" && fn.params.some(item => item.type === "Identifier" && item.name === value.arguments[0].name);
  if (!cloned && !(value?.type === "ObjectExpression" && value.properties.length === 0)) return false;
  let count = 0, valid = true;
  const inspect = (item, parent, local, depth = 0) => {
    if (!item || typeof item.type !== "string") return;
    if (++count > MAX_NODES || depth > 128) throw new Error("source-origin-local-store-budget");
    const inside = local || item === fn;
    if (inside && item.type === "VariableDeclarator" && item !== declaration && bindingNames(item.id).includes(receiver.name)) valid = false;
    if (inside && item !== fn && /Function|Method|Class/.test(item.type) && (item.id?.name === receiver.name || item.params?.some(param => bindingNames(param).includes(receiver.name)))) valid = false;
    if (inside && item.type === "CatchClause" && bindingNames(item.param).includes(receiver.name)) valid = false;
    if (inside && ["AssignmentExpression", "UpdateExpression"].includes(item.type) && bindingNames(item.left ?? item.argument).includes(receiver.name)) valid = false;
    if (cloned && item.type === "Identifier" && item.name === "structuredClone"
      && !(parent?.type === "CallExpression" && parent.callee === item && parent.arguments.length === 1)) valid = false;
    for (const [key, child] of Object.entries(item)) {
      if (["loc", "start", "end", "extra", "comments", "tokens", "errors"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(part => inspect(part, item, inside, depth + 1));
      else if (child && typeof child === "object") inspect(child, item, inside, depth + 1);
    }
  };
  inspect(ast, null, false);
  return valid;
}

// Parse syntax only: never load project modules, run configuration, or evaluate
// initializers. Cache compact origin records, not ASTs or acceptance results.
function sourceOrigins(entry) {
  if (typeof entry.text !== "string" || entry.text.length > MAX_SOURCE_LENGTH) return null;
  const extension = path.posix.extname(entry.path).toLowerCase();
  const key = `${extension}\0${entry.text}`;
  if (cache.has(key)) return cache.get(key);
  let result = null;
  try {
    const plugins = /\.[cm]?tsx?$/.test(extension) ? ["typescript"] : [];
    if (!/\.[cm]?ts$/.test(extension)) plugins.push("jsx");
    const ast = parse(entry.text, { sourceType: "unambiguous", plugins,
      errorRecovery: false, attachComment: false, allowReturnOutsideFunction: false });
    const origins = [], exportEdges = [], exportObjects = new Set(), seen = new Set();
    let count = 0, localStoreChecks = 0, unresolvedComputedMember = false, commonJsSeen = false, commonJsRebound = false;
    const add = (name, kind, node, topLevel = false, referenceName = null) => {
      if (typeof name !== "string") { unresolvedComputedMember = true; return; }
      const identity = `${name}\0${node.start}\0${node.end}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      origins.push(Object.freeze({ name, kind, start: node.start, end: node.end, topLevel, referenceName }));
    };
    const memberPath = node => node?.type === "Identifier" ? [node.name]
      : node?.type === "MemberExpression" && (!node.computed || node.property.type === "StringLiteral")
        ? [...(memberPath(node.object) ?? []), nameOf(node.property)] : null;
    const commonJsExport = node => {
      const names = memberPath(node);
      if (names?.[0] === "exports" && names.length === 2) return names[1];
      if (names?.[0] === "module" && names[1] === "exports" && names.length <= 3) return names[2] ?? "default";
      return null;
    };
    for (const statement of ast.program.body) {
      if (statement.type === "ExportNamedDeclaration") {
        if (statement.source) unresolvedComputedMember = true;
        else if (statement.declaration?.id) exportEdges.push({ exportName: statement.declaration.id.name, localName: statement.declaration.id.name });
        else if (statement.declaration?.type === "VariableDeclaration") {
          for (const declaration of statement.declaration.declarations) {
            if (declaration.id.type === "Identifier") exportEdges.push({ exportName: declaration.id.name, localName: declaration.id.name });
          }
        } else for (const specifier of statement.specifiers) {
          if (specifier.type === "ExportSpecifier") exportEdges.push({ exportName: nameOf(specifier.exported), localName: specifier.local.name });
        }
      }
      if (statement.type === "ExportDefaultDeclaration") {
        const localName = statement.declaration.id?.name ?? (statement.declaration.type === "Identifier" ? statement.declaration.name : null);
        if (localName) exportEdges.push({ exportName: "default", localName });
      }
      const assignment = statement.type === "ExpressionStatement" ? statement.expression : null;
      const exportedName = assignment?.type === "AssignmentExpression" ? commonJsExport(assignment.left) : null;
      if (exportedName !== null) {
        commonJsSeen = true;
        if (assignment.operator !== "=") unresolvedComputedMember = true;
        else if (assignment.right.type === "Identifier") exportEdges.push({ exportName: exportedName, localName: assignment.right.name });
        else if (exportedName === "default" && assignment.right.type === "ObjectExpression") {
          exportObjects.add(assignment.right);
          for (const property of assignment.right.properties) {
            const exportName = property.computed && property.key?.type !== "StringLiteral" ? null : nameOf(property.key);
            if (property.type !== "ObjectProperty" || !exportName || property.value.type !== "Identifier") unresolvedComputedMember = true;
            else exportEdges.push({ exportName, localName: property.value.name });
          }
        } else unresolvedComputedMember = true;
      }
    }
    const visit = (node, parent, ancestors, depth = 0) => {
      if (!node || typeof node.type !== "string") return;
      if (++count > MAX_NODES || depth > 128) throw new Error("source-origin-budget");
      const enclosing = [...ancestors, parent].filter(Boolean);
      const topLevel = enclosing.every(item => ["File", "Program", "ExportNamedDeclaration",
        "ExportDefaultDeclaration", "VariableDeclaration"].includes(item.type));
      if (node.type === "FunctionDeclaration" && node.id) add(node.id.name, "function", node, topLevel);
      if (node.type === "TSDeclareFunction" && node.id) add(node.id.name, "declaration-only", node, topLevel);
      if (node.type === "ClassDeclaration" && node.id) add(node.id.name, "class", node, topLevel);
      if (node.type === "VariableDeclarator") {
        for (const name of bindingNames(node.id)) {
          add(name, node.id.type === "Identifier" && callable(node.init) ? "function" : "binding", node.init ?? node, topLevel);
        }
      }
      if (node.type === "FunctionExpression" && node.id
        && !(parent?.type === "VariableDeclarator" && parent.id.name === node.id.name)) add(node.id.name, "nested-function", node);
      if (["ObjectMethod", "ClassMethod", "ClassPrivateMethod", "ObjectProperty", "ClassProperty", "ClassPrivateProperty"].includes(node.type)) {
        const name = node.computed && node.key.type !== "StringLiteral" && node.key.type !== "NumericLiteral" ? null : nameOf(node.key);
        if (!exportObjects.has(parent)) {
          const reference = node.value?.type === "Identifier" ? node.value.name : null;
          const rootObject = enclosing.every(item => ["File", "Program", "ExportNamedDeclaration", "VariableDeclaration", "VariableDeclarator", "ObjectExpression"].includes(item.type));
          add(name, reference ? "member-reference" : node.type.endsWith("Method") || callable(node.value) ? "method" : "property", node, rootObject, reference);
        }
      }
      if (node.type === "AssignmentExpression") {
        if (bindingNames(node.left).some(name => ["module", "exports"].includes(name))) commonJsRebound = true;
        const cjs = commonJsExport(node.left);
        const rootAssignment = enclosing.every(item => ["File", "Program", "ExpressionStatement"].includes(item.type));
        if (cjs !== null && !rootAssignment) unresolvedComputedMember = true;
        if (cjs === null && node.left.type === "MemberExpression") {
          const name = node.left.computed && node.left.property.type !== "StringLiteral" ? null : nameOf(node.left.property);
          if (name !== null || localStoreChecks++ >= 32 || !localRecordStore(node, enclosing, ast)) add(name, "member-assignment", node);
        }
      }
      if (node.type === "ExportAllDeclaration") unresolvedComputedMember = true;
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "start", "end", "extra", "comments", "tokens", "errors"].includes(key)) continue;
        if (Array.isArray(value)) for (const item of value) visit(item, node, enclosing, depth + 1);
        else if (value && typeof value === "object") visit(value, node, enclosing, depth + 1);
      }
    };
    visit(ast, null, []);
    if (commonJsSeen && (commonJsRebound || origins.some(origin => origin.topLevel && ["module", "exports"].includes(origin.name)))) unresolvedComputedMember = true;
    result = Object.freeze({ origins: Object.freeze(origins), exportEdges: Object.freeze(exportEdges.map(Object.freeze)), unresolvedComputedMember });
  } catch { /* Unsupported or malformed syntax has no source-origin authority. */ }
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

/** Route names to existing proof engines by unique source origin, never by a
 * corpus-wide export-name match alone. This does not prove runtime behavior. */
export function routeNamedSourceTargets({ namedTargets, provenanceTargets, sourceEntries, exports, taskText = "" }) {
  if (namedTargets.length === 0 || sourceEntries.length === 0) return {
    strictTargets: namedTargets.filter(name => provenanceTargets.has(name)),
    structuralTargets: namedTargets.filter(name => !provenanceTargets.has(name)), unresolvedTargets: [], routes: []
  };
  const entries = sourceEntries.map(entry => ({ path: modulePath(entry.path), inventory: sourceOrigins(entry) }));
  const incomplete = entries.some(entry => !entry.inventory || entry.inventory.unresolvedComputedMember);
  const origins = entries.flatMap(entry => (entry.inventory?.origins ?? []).map(origin => ({ ...origin, path: entry.path })));
  const explicitPaths = [...new Set((String(taskText).match(/[^\s`"'<>()[\]{}:,;!?=]+\.[cm]?[jt]sx?\b/g) ?? []).map(modulePath))];
  const routes = namedTargets.map(target => {
    const exported = exports.filter(item => item.contractName === target);
    const candidates = origins.filter(origin => origin.name.toLowerCase() === target || exported.some(binding =>
      modulePath(binding.sourcePath) === origin.path && binding.sourceName === origin.name.toLowerCase()));
    const distinct = candidates.filter(origin => origin.kind !== "member-reference" || !origin.topLevel
      || !candidates.some(other => other.kind === "function" && other.topLevel && other.path === origin.path
        && other.name === origin.referenceName && origin.name === other.name));
    const unresolved = reason => ({ target, kind: "unresolved", reason });
    if (incomplete) return unresolved("source-origin-inventory-incomplete");
    if (distinct.length !== 1 || exported.length > 1) return unresolved("source-origin-ambiguous-or-missing");
    const origin = distinct[0];
    if (explicitPaths.length > 1) return unresolved("criterion-module-ambiguous");
    if (explicitPaths.length === 1 && explicitPaths[0] !== origin.path) return unresolved("criterion-module-mismatch");
    if (exported.length === 1) {
      const binding = exported[0];
      if (origin.kind !== "function" || !origin.topLevel || modulePath(binding.sourcePath) !== origin.path
        || binding.sourceName !== origin.name.toLowerCase()) return unresolved("export-does-not-own-source-origin");
      const owned = entries.find(entry => entry.path === origin.path).inventory.exportEdges.some(edge =>
        edge.localName === origin.name && edge.exportName?.toLowerCase() === binding.exportName);
      if (!owned) return unresolved("export-does-not-own-source-origin");
      return { target, kind: "export", origin };
    }
    if (origin.kind === "method" && !provenanceTargets.has(target)) return { target, kind: "structural", origin };
    return unresolved("source-origin-not-an-exported-callable");
  });
  return {
    strictTargets: routes.filter(route => route.kind === "export").map(route => route.target),
    structuralTargets: routes.filter(route => route.kind === "structural").map(route => route.target),
    unresolvedTargets: routes.filter(route => route.kind === "unresolved").map(route => route.target), routes
  };
}

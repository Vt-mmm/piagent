import crypto from "node:crypto";
import { isApiPreservationCriterion } from "../../extensions/acceptance-api-baseline.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "@babel/parser";
import { acceptanceCriterionBindingValid } from "../../extensions/acceptance-behavior-proof.js";
import { acceptanceLanguageAdapterForPath, isAcceptanceTestPath } from "../../extensions/acceptance-language-adapters.js";
import { matchesAnyPath } from "../../extensions/policy-core.js";
import { allConfiguredVerifierEvidenceCurrent, latestObservedVerificationEvidence } from "../../extensions/verification-intelligence.js";
import { workingTreeEvidenceDigest } from "../../extensions/working-tree-digest.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";
import { decodeBaselineRepoPath, readTaskBaselineBlob, readTaskBaselineManifest,
  taskBaselineRetentionState } from "../inspection/source-evidence-store.ts";
import { readWorkspaceFile } from "../inspection/workspace-file-reader.ts";
import { routeNamedSourceTargets } from "../../extensions/acceptance-source-origin.js";

const MAX_FILE_BYTES = 64_000, MAX_FILES = 8, MAX_NODES = 12_000;
const hash = value => `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
const reject = reason => { throw Object.assign(new Error(reason), { apiProofReason: reason }); };
const mathMethods = new Set(["ceil", "floor", "round", "trunc", "abs", "min", "max"]);

function safePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || path.posix.isAbsolute(value)
    || value.split("/").some(part => !part || part === "..") || value.includes("\0")) reject("api-source-scope-unavailable");
  return path.posix.normalize(value);
}

/** A syntax-only, closed API contract: static named function exports, plain
 * positional parameters and a proven primitive or local-array return representation. Bodies
 * are not equated; behavioral compatibility remains with the other criteria.
 */
function publicApi(text, includeImplementation = false) {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) reject("api-proof-limit");
  const ast = parse(text, { sourceType: "module", errorRecovery: false, attachComment: false });
  const functions = new Map(), exports = [];
  const parameterName = node => node.type === "AssignmentPattern" ? node.left.name : node.name;
  const parameterDefault = node => {
    if (node.type === "Identifier") return undefined;
    if (node.type !== "AssignmentPattern" || node.left.type !== "Identifier") reject("api-contract-unsupported");
    const value = node.right;
    if (value.type === "Identifier" && value.name === "undefined") return { intrinsic: "undefined" };
    if (["NumericLiteral", "StringLiteral", "BooleanLiteral", "NullLiteral"].includes(value.type)) return { type: value.type, value: value.value ?? null };
    if (value.type === "UnaryExpression" && ["+", "-"].includes(value.operator) && value.argument.type === "NumericLiteral") {
      return { type: "signed-number", operator: value.operator, value: value.argument.value };
    }
    if (value.type === "MemberExpression" && !value.computed && value.object.name === "Number" && value.property.name === "MAX_SAFE_INTEGER") return { intrinsic: "Number.MAX_SAFE_INTEGER" };
    if (value.type === "CallExpression" && value.arguments.length === 0 && value.callee.type === "MemberExpression"
      && !value.callee.computed && value.callee.object.name === "Date" && value.callee.property.name === "now") return { intrinsic: "Date.now()" };
    reject("api-contract-unsupported");
  };
  let nodes = 0;
  let booleanSurface = false, numericSurface = false, dateIntrinsicsUsed = false, arrayIntrinsicUsed = false;
  const booleanExpression = node => node?.type === "BooleanLiteral"
    || node?.type === "UnaryExpression" && node.operator === "!"
    || node?.type === "BinaryExpression" && ["===", "!==", "==", "!=", "<", "<=", ">", ">=", "in", "instanceof"].includes(node.operator);
  const memberPath = node => node?.type === "Identifier" ? node.name
    : node?.type === "MemberExpression" && !node.computed ? `${memberPath(node.object)}.${node.property.name}` : "";
  const booleanHelperCall = node => {
    if (!booleanSurface || node.callee?.type !== "MemberExpression" || node.callee.computed) return false;
    const callee = node.callee, member = memberPath(callee);
    if (["Date.now", "Date.parse", "Date.UTC", "Date.prototype.getTime.call", "Number.isNaN"].includes(member)) return true;
    if (callee.object.type === "RegExpLiteral") return callee.property.name === "exec";
    return ["slice", "padEnd", "getTime", "setUTCFullYear", "setUTCHours", "getUTCFullYear", "getUTCMonth", "getUTCDate"].includes(callee.property.name);
  };
  const numericExpression = node => node?.type === "NumericLiteral"
    || node?.type === "CallExpression" && (node.callee.type === "Identifier" && node.callee.name === "Number"
      || node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object.name === "Math" && mathMethods.has(node.callee.property.name));
  const reduceCall = node => node?.type === "CallExpression" && node.callee.type === "MemberExpression"
    && !node.callee.computed && node.callee.property.name === "reduce" && node.arguments.length === 2
    && node.arguments[0].type === "ArrowFunctionExpression" && !node.arguments[0].async
    && node.arguments[0].params.every(parameter => parameter.type === "Identifier")
    && new Set(node.arguments[0].params.map(parameter => parameter.name)).size === node.arguments[0].params.length;
  const collectionBindings = new Map(), collectionValidity = new Map();
  const collectionMethods = { array: new Set(["push", "map", "sort"]), map: new Set(["get", "has", "set", "values"]) };
  const bindingsFor = fn => {
    const names = new Set(), collections = new Map();
    let valid = true;
    const bind = id => {
      if (id?.type !== "Identifier" || names.has(id.name) || ["Map", "Math", "Number"].includes(id.name)) { valid = false; return; }
      names.add(id.name);
    };
    fn.params.forEach(node => bind(node.type === "AssignmentPattern" ? node.left : node));
    let bindingNodes = 0;
    const visit = (node, depth = 0) => {
      if (!node || typeof node.type !== "string") return;
      if (++bindingNodes > MAX_NODES || depth > 128) reject("api-proof-limit");
      if (["FunctionExpression", "FunctionDeclaration", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"].includes(node.type)) valid = false;
      if (node.type === "VariableDeclarator") {
        bind(node.id);
        if (node.init?.type === "ArrayExpression") collections.set(node.id.name, "array");
        if (node.init?.type === "NewExpression" && node.init.callee.type === "Identifier"
          && node.init.callee.name === "Map" && !functions.has("Map") && node.init.arguments.length === 0) collections.set(node.id.name, "map");
      }
      if (node.type === "ArrowFunctionExpression") {
        if (node.async) valid = false;
        node.params.forEach(bind);
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item => visit(item, depth + 1));
        else if (value && typeof value === "object") visit(value, depth + 1);
      }
    };
    visit(fn.body); collectionValidity.set(fn, valid); return collections;
  };
  const collectionCall = (node, owner) => {
    const callee = node?.callee;
    if (node?.type !== "CallExpression" || callee?.type !== "MemberExpression" || callee.computed) return false;
    const kind = callee.object.type === "ArrayExpression" ? "array"
      : callee.object.type === "Identifier" ? collectionBindings.get(owner)?.get(callee.object.name) : undefined;
    return Boolean(kind && collectionMethods[kind].has(callee.property.name) && collectionValidity.get(owner));
  };
  const inspect = (node, parent, grandparent, depth = 0, owner = null) => {
    if (!node || typeof node.type !== "string") return;
    if (++nodes > MAX_NODES || depth > 128) reject("api-proof-limit");
    if (node.type === "FunctionDeclaration") {
      owner = node;
      collectionBindings.set(owner, bindingsFor(node));
    }
    if (["AssignmentExpression", "UpdateExpression", "AwaitExpression", "YieldExpression"].includes(node.type)) reject("api-contract-unsupported");
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.id.name === "undefined") reject("api-contract-unsupported");
    const numericDefault = node.type === "Identifier" && node.name === "Number" && parent?.type === "MemberExpression"
      && parent.object === node && !parent.computed && parent.property.name === "MAX_SAFE_INTEGER"
      && grandparent?.type === "AssignmentPattern" && grandparent.right === parent;
    if (!numericDefault && node.type === "Identifier" && ["Math", "Number"].includes(node.name)
      && !(node.name === "Number" && parent?.type === "CallExpression" && parent.callee === node)
      && !(parent?.type === "MemberExpression" && !parent.computed && parent.object === node
        && (node.name === "Math" ? mathMethods.has(parent.property.name) : ["isInteger", "isSafeInteger", "isFinite", ...(booleanSurface ? ["isNaN"] : [])].includes(parent.property.name))
        && grandparent?.type === "CallExpression" && grandparent.callee === parent)) {
      reject("api-contract-unsupported");
    }
    if (numericSurface && arrayIntrinsicUsed && node.type === "Identifier" && node.name === "Array"
      && !(parent?.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.name === "isArray"
        && grandparent?.type === "CallExpression" && grandparent.callee === parent)) reject("api-contract-unsupported");
    if (dateIntrinsicsUsed && node.type === "Identifier" && node.name === "Date"
      && !(parent?.type === "NewExpression" && parent.callee === node)
      && !(parent?.type === "BinaryExpression" && parent.operator === "instanceof" && parent.right === node)
      && !(parent?.type === "MemberExpression" && !parent.computed && parent.object === node
        && ["now", "parse", "UTC", "prototype"].includes(parent.property.name))) reject("api-contract-unsupported");
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const intrinsic = callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier"
        && (callee.object.name === "Math" && mathMethods.has(callee.property.name)
          || callee.object.name === "Number" && ["isInteger", "isSafeInteger", "isFinite"].includes(callee.property.name));
      if (!intrinsic && !collectionCall(node, owner) && !booleanHelperCall(node)
        && !(parent?.type === "AssignmentPattern" && parent.right === node && memberPath(callee) === "Date.now" && node.arguments.length === 0)
        && !(numericSurface && (reduceCall(node) || memberPath(callee) === "Array.isArray"))
        && !(callee.type === "Identifier" && callee.name === "Number" && !functions.has("Number"))
        && !(callee.type === "Identifier" && functions.has(callee.name))) reject("api-contract-unsupported");
    }
    if (node.type === "NewExpression" && !(node.callee.type === "Identifier"
      && (["Error", "TypeError", "RangeError"].includes(node.callee.name) || booleanSurface && node.callee.name === "Date" || node.callee.name === "Map" && node.arguments.length === 0 && collectionValidity.get(owner))
      && !functions.has(node.callee.name))) reject("api-contract-unsupported");
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(item => inspect(item, node, parent, depth + 1, owner));
      else if (value && typeof value === "object") inspect(value, node, parent, depth + 1, owner);
    }
  };
  for (const statement of ast.program.body) {
    const node = statement.type === "ExportNamedDeclaration" && !statement.source ? statement.declaration : statement;
    if (node?.type !== "FunctionDeclaration" || !node.id || node.id.name === "undefined" || functions.has(node.id.name)
      || node.async || node.generator || node.params.some(item => !["Identifier", "AssignmentPattern"].includes(item.type))
      || node.params.some(item => parameterName(item) === "undefined")
      || new Set(node.params.map(parameterName)).size !== node.params.length) reject("api-contract-unsupported");
    node.params.forEach(parameterDefault);
    functions.set(node.id.name, node);
    if (statement.type === "ExportNamedDeclaration") exports.push(node);
  }
  if (exports.length === 0) reject("api-contract-unsupported");
  // Only a closed module with syntactically boolean public returns admits these helper calls.
  // Function bindings cannot escape or be shadowed; the normal return-path walk still applies.
  let surfaceNodes = 0, closed = true, numericClosed = true;
  const inspectSurface = (node, parent, returns, depth = 0) => {
    if (!node || typeof node.type !== "string") return;
    if (++surfaceNodes > MAX_NODES || depth > 128) reject("api-proof-limit");
    if (["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration", "ObjectMethod", "ClassMethod"].includes(node.type)) {
      closed = false;
      if (node.type !== "ArrowFunctionExpression" || !reduceCall(parent) || parent.arguments[0] !== node) numericClosed = false;
    }
    if (node.type === "Identifier" && functions.has(node.name)
      && !(parent?.type === "CallExpression" && parent.callee === node)) closed = numericClosed = false;
    if (node.type === "NewExpression" && node.callee?.name === "Date"
      || node.type === "CallExpression" && memberPath(node.callee).startsWith("Date.")) dateIntrinsicsUsed = true;
    if (node.type === "CallExpression" && memberPath(node.callee) === "Array.isArray") arrayIntrinsicUsed = true;
    if (node.type === "ReturnStatement") returns.push(node.argument);
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(item => inspectSurface(item, node, node.type === "ArrowFunctionExpression" ? [] : returns, depth + 1));
      else if (value && typeof value === "object") inspectSurface(value, node, node.type === "ArrowFunctionExpression" ? [] : returns, depth + 1);
    }
  };
  const publicReturns = [], numericReturns = [];
  for (const fn of functions.values()) {
    const returns = [];
    if (fn.params.some(parameter => functions.has(parameterName(parameter)))) closed = numericClosed = false;
    fn.params.forEach(parameter => inspectSurface(parameter, fn, []));
    inspectSurface(fn.body, fn, returns);
    if (exports.includes(fn)) {
      publicReturns.push(returns.length > 0 && returns.every(booleanExpression));
      numericReturns.push(returns.length > 0 && returns.every(numericExpression));
    }
  }
  booleanSurface = closed && publicReturns.every(Boolean);
  numericSurface = numericClosed && numericReturns.every(Boolean);
  inspect(ast);
  const kinds = new Map(), active = new Set();
  const resultKind = name => {
    if (kinds.has(name)) return kinds.get(name);
    if (active.has(name) || !functions.has(name)) return undefined;
    active.add(name);
    const fn = functions.get(name), locals = new Map(fn.params.map(item => [parameterName(item), undefined]));
    const expressionKind = expression => {
      if (!expression) return undefined;
      const literal = { NumericLiteral: "number", StringLiteral: "string", BooleanLiteral: "boolean", NullLiteral: "null" }[expression.type];
      if (literal) return literal;
      if (booleanExpression(expression)) return "boolean";
      if (expression.type === "ArrayExpression") return "array";
      if (expression.type === "NewExpression" && expression.callee.type === "Identifier"
        && expression.callee.name === "Map") return "local-map";
      if (expression.type === "Identifier") return locals.get(expression.name);
      if (expression.type === "UnaryExpression" && ["+", "-"].includes(expression.operator)
        && expressionKind(expression.argument) === "number") return "number";
      if (expression.type === "BinaryExpression" && ["+", "-", "*", "/", "%", "**"].includes(expression.operator)
        && expressionKind(expression.left) === "number" && expressionKind(expression.right) === "number") return "number";
      if (expression.type === "ConditionalExpression") {
        const yes = expressionKind(expression.consequent), no = expressionKind(expression.alternate);
        return yes && yes === no ? yes : undefined;
      }
      if (expression.type === "CallExpression") {
        const callee = expression.callee;
        if (callee.type === "Identifier" && callee.name === "Number" && !locals.has("Number") && !functions.has("Number")) return "number";
        if (callee.type === "MemberExpression" && !callee.computed && ["map", "sort"].includes(callee.property.name)
          && expressionKind(callee.object) === "array" && collectionCall(expression, fn)) return "array";
        if (callee.type === "MemberExpression" && !callee.computed && callee.object.type === "Identifier"
          && callee.object.name === "Math" && mathMethods.has(callee.property.name)) return "number";
        if (callee.type === "Identifier" && !locals.has(callee.name)) return resultKind(callee.name);
      }
      return undefined;
    };
    const walk = statements => {
      const returns = new Set();
      for (const statement of statements) {
        if (statement.type === "ReturnStatement") {
          const kind = expressionKind(statement.argument); if (!kind) reject("api-contract-unsupported");
          returns.add(kind); return { terminal: true, returns };
        }
        if (statement.type === "ThrowStatement") return { terminal: true, returns };
        if (statement.type === "IfStatement") {
          const before = new Map(locals);
          const left = walk(statement.consequent.type === "BlockStatement" ? statement.consequent.body : [statement.consequent]);
          locals.clear(); before.forEach((value, key) => locals.set(key, value));
          const right = statement.alternate ? walk(statement.alternate.type === "BlockStatement" ? statement.alternate.body : [statement.alternate])
            : { terminal: false, returns: new Set() };
          locals.clear(); before.forEach((value, key) => locals.set(key, value));
          for (const kind of [...left.returns, ...right.returns]) returns.add(kind);
          if (left.terminal && right.terminal) return { terminal: true, returns };
        } else if (statement.type === "VariableDeclaration" && statement.kind === "const") {
          for (const item of statement.declarations) {
            if (item.id.type !== "Identifier" || locals.has(item.id.name)) reject("api-contract-unsupported");
            locals.set(item.id.name, (booleanSurface || numericSurface) && exports.includes(fn) ? undefined : expressionKind(item.init));
          }
        } else if (statement.type === "ForOfStatement" && !statement.await
          && statement.left.type === "VariableDeclaration" && statement.left.kind === "const"
          && statement.left.declarations.length === 1 && statement.left.declarations[0].id.type === "Identifier") {
          const before = new Map(locals), binding = statement.left.declarations[0].id.name;
          if (locals.has(binding)) reject("api-contract-unsupported");
          locals.set(binding, undefined);
          const body = walk(statement.body.type === "BlockStatement" ? statement.body.body : [statement.body]);
          if (body.returns.size || body.terminal) reject("api-contract-unsupported");
          locals.clear(); before.forEach((value, key) => locals.set(key, value));
        } else if (statement.type === "ExpressionStatement" && statement.expression.type === "CallExpression"
          && (collectionCall(statement.expression, fn)
            || statement.expression.callee.type === "Identifier" && functions.has(statement.expression.callee.name)
              && !locals.has(statement.expression.callee.name))) {
          // Ignoring a local helper's result cannot establish a return type;
          // the caller's own subsequent return must still prove it.
        } else reject("api-contract-unsupported");
      }
      return { terminal: false, returns };
    };
    const result = walk(fn.body.body);
    active.delete(name);
    const kind = result.terminal && result.returns.size === 1 ? [...result.returns][0] : undefined;
    kinds.set(name, kind); return kind;
  };
  const contracts = exports.map(fn => {
    const result = resultKind(fn.id.name); if (!result || result === "local-map" || result === "array" && !collectionValidity.get(fn)) reject("api-contract-unsupported");
    const defaults = fn.params.map(parameterDefault);
    return { ...(defaults.some(value => value !== undefined) ? { defaults: defaults.map(value => value ?? null), functionLength: fn.params.findIndex(item => item.type === "AssignmentPattern") } : {}), exportName: fn.id.name, callable: "sync-function", parameters: fn.params.map(parameterName), result: result === "array" ? "collection:array" : `primitive:${result}` };
  }).sort((a, b) => a.exportName.localeCompare(b.exportName, "en"));
  if (!includeImplementation) return contracts;
  const metadata = new Set(["start", "end", "loc", "extra", "leadingComments", "trailingComments", "innerComments", "comments"]);
  const implementationClosure = name => {
    const closure = new Map(), pending = [name];
    while (pending.length) {
      const next = pending.pop();
      if (closure.has(next)) continue;
      const fn = functions.get(next);
      closure.set(next, JSON.stringify(fn, (key, value) => metadata.has(key) ? undefined : value));
      const visit = node => {
        if (!node || typeof node.type !== "string") return;
        if (node.type === "Identifier" && functions.has(node.name) && !closure.has(node.name)) pending.push(node.name);
        for (const [key, value] of Object.entries(node)) {
          if (metadata.has(key)) continue;
          if (Array.isArray(value)) value.forEach(visit);
          else if (value && typeof value === "object") visit(value);
        }
      };
      visit(fn);
    }
    return JSON.stringify([...closure].sort(([a], [b]) => a.localeCompare(b, "en")));
  };
  return { contracts, implementations: new Map(exports.map(fn => [fn.id.name, implementationClosure(fn.id.name)])) };
}

// Parameter spelling is local implementation detail. Keep the positions of any
// retained names as a conservative reorder check; defaults and arity stay exact.
function samePublicContracts(before, after, permittedDefaults = new Set()) {
  return before.length === after.length && before.every((previous, index) => {
    const next = after[index], { parameters: oldNames, ...oldShape } = previous;
    const { parameters: newNames, ...newShape } = next;
    if (permittedDefaults.has(previous.exportName) && next.exportName === previous.exportName
      && oldShape.defaults && newShape.defaults && oldShape.defaults.length === newShape.defaults.length) {
      const changes = oldShape.defaults.flatMap((value, position) => JSON.stringify(value) === JSON.stringify(newShape.defaults[position]) ? [] : [position]);
      // Permission to change an initializer does not add/remove a parameter or
      // a default, change function.length, or waive any behavioral criterion.
      if (changes.length === 1 && oldShape.defaults[changes[0]] !== null && newShape.defaults[changes[0]] !== null) {
        delete oldShape.defaults;
        delete newShape.defaults;
      }
    }
    return oldNames.length === newNames.length && JSON.stringify(oldShape) === JSON.stringify(newShape)
      && oldNames.every((name, position) => !newNames.includes(name) || newNames[position] === name);
  });
}

function permittedDefaultInitializerChanges(task, targeted) {
  const request = task.operatorRequest;
  if (typeof request !== "string" || task.operatorRequestDigest !== hash(request).replace("sha256:", "operator-request-v1:")
    || targeted.size !== 1) return new Set();
  const normalize = text => text.replace(/\s+/g, " ").trim();
  const requestClauses = request.split(/\r?\n|(?<=[.!?;])\s+/).map(normalize);
  const permitted = task.acceptanceCriteria.some((text, index) =>
    acceptanceCriterionBindingValid(task, task.acceptanceReceipt, task.acceptanceReceipt.criteria[index], index)
    && /^Changing the formal default initializer(?: to [^.;\n]{1,200})? is permitted[.;]?$/i.test(text.trim())
    && requestClauses.includes(normalize(text)));
  return permitted ? new Set(targeted) : new Set();
}

export function compareSupportedPublicApi(before, after) {
  try {
    const baseline = publicApi(before), current = publicApi(after);
    return { compatible: samePublicContracts(baseline, current), baseline, current };
  } catch (error) { return { compatible: null, reason: error.apiProofReason ?? "api-contract-unsupported" }; }
}

function targetedExports(task, apiCriterion, sourceEntries, inventories) {
  const targets = new Set();
  const exports = inventories.flatMap(({ file, current }) => current.contracts.map(({ exportName }) => ({
    contractName: exportName.toLowerCase(), exportName: exportName.toLowerCase(), sourceName: exportName.toLowerCase(), sourcePath: file
  })));
  task.acceptanceReceipt.criteria.forEach((criterion, index) => {
    if (criterion.id === apiCriterion.id || !["requested-behavior", "boundary-case", "invalid-input-rejection"].includes(criterion.obligation)
      || !acceptanceCriterionBindingValid(task, task.acceptanceReceipt, criterion, index)) return;
    const text = task.acceptanceCriteria[index];
    // Only an explicit callable subject can authorize its implementation change.
    // A name in an example, comparison, dependency or test title is not a target.
    const subject = /^\s*(?:`([a-z_$][a-z0-9_$]*)(?:\([^`\n]*\))?`|([a-z_$][a-z0-9_$]*)\([^\n)]*\))\s+(?:must\s+|shall\s+)?(?:use|returns?|rejects?|throws?|clamps?)\b/i.exec(text);
    const explicitChange = /^\s*(?:Fix|Repair)\s+`([a-z_$][a-z0-9_$]*)\([^`\n]*\)`\s+in\s+`([^`\n]+)`\.\s*$/i.exec(text);
    if (!subject && !explicitChange) return;
    if (explicitChange && !sourceEntries.some(entry => entry.path === explicitChange[2])) return;
    const name = (explicitChange?.[1] ?? subject[1] ?? subject[2]).toLowerCase();
    const route = routeNamedSourceTargets({ namedTargets: [name], provenanceTargets: new Set(), sourceEntries, exports, taskText: text }).routes[0];
    if (route?.kind === "export") targets.add(`${route.origin.path}:${route.origin.name}`);
  });
  return targets;
}

// Protected entries deliberately have no bytes. They do not invalidate a complete
// inventory's unrelated source entries, but truncation or failed reads still do.
function readableBaselineRoot(root) {
  return root.state === "current" || root.state === "unavailable" && root.reasonCode === "protected-path"
    && root.entries.some(entry => entry.state === "protected")
    && root.entries.every(entry => !["oversized", "unavailable"].includes(entry.state));
}
function readableBaseline(manifest) {
  return manifest && (manifest.captureState === "current"
    || manifest.captureState === "unavailable" && manifest.reasonCode === "protected-path")
    && manifest.roots.every(readableBaselineRoot);
}

// Reuse the captured task-start head and dirty blobs for both API and scoped
// material checks. The sparse working-tree map is not a raw content inventory.
export function readTaskBaselineSource(cwd, task, file) {
  file = safePath(file);
  const manifest = readTaskBaselineManifest(cwd, task.taskRunId);
  if (!readableBaseline(manifest)) reject("api-baseline-unavailable");
  if (manifest.taskId !== task.taskId || manifest.taskRunId !== task.taskRunId
    || manifest.sessionIdentityHash !== hash(task.sessionId) || manifest.capturedAt !== task.createdAt
    || manifest.baselineTreeDigest !== workingTreeEvidenceDigest(task.baselineFileDigests)
    || Date.parse(manifest.capturedAt) > Date.now()) reject("api-baseline-binding-mismatch");
  if (taskBaselineRetentionState(manifest) !== "active") reject("api-baseline-expired");
  const roots = manifest.roots.filter(root => root.projectPath === "." || file.startsWith(`${safePath(root.projectPath)}/`));
  if (roots.length !== 1 || !readableBaselineRoot(roots[0])) reject("api-baseline-scope-unavailable");
  const root = roots[0], relative = root.projectPath === "." ? file : file.slice(root.projectPath.length + 1);
  const entries = root.entries.filter(entry => decodeBaselineRepoPath(entry) === relative);
  if (entries.length > 1) reject("api-baseline-scope-unavailable");
  if (entries.length === 1) {
    const entry = entries[0];
    if (entry.state !== "blob" || !["100644", "100755"].includes(entry.mode)) reject("api-baseline-unavailable");
    return readTaskBaselineBlob(cwd, task.taskRunId, entry.contentRef, MAX_FILE_BYTES).toString("utf8");
  }
  if (root.headState !== "head" || !root.headOid) reject("api-baseline-unavailable");
  const rootPath = root.projectPath === "." ? cwd : path.join(cwd, safePath(root.projectPath));
  if (fs.realpathSync(rootPath) !== rootPath) reject("api-baseline-scope-unavailable");
  const git = args => execFileSync("git", ["--no-replace-objects", "--literal-pathspecs", "-c", "core.fsmonitor=false",
    "--no-optional-locks", "-C", rootPath, ...args], { timeout: 1500, maxBuffer: MAX_FILE_BYTES + 1, stdio: ["ignore", "pipe", "ignore"] });
  const entriesAtHead = git(["ls-tree", "-z", root.headOid, "--", relative]).toString("utf8").split("\0").filter(Boolean);
  if (entriesAtHead.length !== 1) reject("api-baseline-unavailable");
  const tree = /^(100644|100755) blob ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entriesAtHead[0]);
  if (!tree || tree[3] !== relative) reject("api-baseline-unavailable");
  return git(["cat-file", "blob", tree[2]]).toString("utf8");
}

/** Receipt integration boundary. This never executes the target module, uses
 * current HEAD as task-start authority, or replaces behavioral criteria.
 * Unknown and incompatible outcomes carry explicit reasons and no evidence.
 */
export function apiBaselineCriterionEvidence(input) {
  const { task, criterion, corpus, currentWorkingTreeDigest } = input;
  const index = task?.acceptanceReceipt?.criteria?.findIndex(item => item.id === criterion?.id) ?? -1;
  const text = task?.acceptanceCriteria?.[index];
  if (typeof text !== "string" || !isApiPreservationCriterion(text)) return { handled: false };
  try {
    if (task.changeMode !== "source-change"
      || !acceptanceCriterionBindingValid(task, task.acceptanceReceipt, criterion, index)) reject("api-criterion-binding-mismatch");
    const cwd = fs.realpathSync(input.cwd);
    const before = captureWorkspaceVerificationSnapshot(cwd);
    if (!before.proofCapable || before.digest !== currentWorkingTreeDigest
      || (input.workspaceRevisionDigest !== undefined && input.workspaceRevisionDigest !== before.workspaceRevisionDigest)) reject("api-current-tree-mismatch");
    if (!allConfiguredVerifierEvidenceCurrent(task, before.digest, before.workspaceRevisionDigest)) reject("api-current-verifier-missing");
    const manifest = readTaskBaselineManifest(cwd, task.taskRunId);
    if (!readableBaseline(manifest)) reject("api-baseline-unavailable");
    if (manifest.taskId !== task.taskId || manifest.taskRunId !== task.taskRunId
      || manifest.sessionIdentityHash !== hash(task.sessionId) || manifest.capturedAt !== task.createdAt
      || manifest.baselineTreeDigest !== workingTreeEvidenceDigest(task.baselineFileDigests)
      || Date.parse(manifest.capturedAt) > Date.now()) reject("api-baseline-binding-mismatch");
    if (taskBaselineRetentionState(manifest) !== "active") reject("api-baseline-expired");
    const files = (corpus?.files ?? []).filter(file => !isAcceptanceTestPath(file)).map(safePath);
    if (!files.length || files.length > MAX_FILES || new Set(files).size !== files.length) reject("api-source-scope-unavailable");
    if (files.some(file => acceptanceLanguageAdapterForPath(file).disposition !== "supported"
      || !matchesAnyPath(file, task.scope ?? []) || matchesAnyPath(file, [...(task.protectedPaths ?? []), ...(task.outOfScope ?? [])]))) {
      reject("api-source-scope-unavailable");
    }
    const inventories = [];
    for (const file of files) {
      const entries = (corpus.sourceEntries ?? []).filter(entry => safePath(entry.path) === file);
      const current = readWorkspaceFile(cwd, file, MAX_FILE_BYTES).toString("utf8");
      if (entries.length !== 1 || entries[0].text !== current) reject("api-source-corpus-mismatch");
      let previous, next;
      try {
        previous = publicApi(readTaskBaselineSource(cwd, task, file), true);
        next = publicApi(current, true);
      } catch (error) { reject(error.apiProofReason ?? "api-contract-unsupported"); }
      inventories.push({ file, baseline: previous, current: next });
    }
    const targeted = targetedExports(task, criterion, corpus.sourceEntries.filter(entry => files.includes(entry.path)), inventories);
    const permittedDefaults = permittedDefaultInitializerChanges(task, targeted);
    for (const item of inventories) {
      const permittedNames = new Set([...permittedDefaults].filter(target => target.slice(0, target.lastIndexOf(":")) === item.file)
        .map(target => target.slice(target.lastIndexOf(":") + 1)));
      if (!samePublicContracts(item.baseline.contracts, item.current.contracts, permittedNames)) reject("api-contract-changed");
      for (const [name, implementation] of item.baseline.implementations) {
        if (!targeted.has(`${item.file}:${name}`) && implementation !== item.current.implementations.get(name)) {
          reject("api-unrelated-implementation-changed");
        }
      }
    }
    const after = captureWorkspaceVerificationSnapshot(cwd);
    if (!after.proofCapable || after.digest !== before.digest || after.workspaceRevisionDigest !== before.workspaceRevisionDigest) reject("api-current-tree-mismatch");
    const command = task.verifyCommands[0], observed = latestObservedVerificationEvidence(task.verifyEvidence).get(command.trim());
    return { handled: true, evidence: { kind: "task-baseline-public-api", summary:
      "Task-start baseline preserves the supported public export, positional calling and primitive/local-array result contract, allowing only an operator-authorized initializer change when bound; all configured verifiers passed the current tree. Behavioral equivalence is not inferred.",
      paths: files, command: observed.command, exitCode: 0, workingTreeDigest: before.digest } };
  } catch (error) { return { handled: true, reason: error.apiProofReason ?? "api-baseline-unavailable" }; }
}

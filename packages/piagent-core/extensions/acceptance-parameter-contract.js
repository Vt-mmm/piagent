import { parse, parseExpression } from "@babel/parser";
import { flatRecordFactories, flatRecordValue } from "./acceptance-literal-dataflow.js";
import { literalArrayIterationEnvironmentIsStable } from "./acceptance-executable-evidence.js";
import { integerAssertionArguments, integerTestInputsStable } from "./acceptance-integer-domains.js";

/** A closed rejection clause declares its input domain. Test literals may
 * witness that domain, but cannot add requirements for incidental arguments.
 * Other prose remains with the existing engines; never consume a substring
 * and silently discard an additional constraint.
 */
export function rejectedIntegerParameter(text, contextText) {
  const clause = String(text ?? "").replace(/\s+/g, " ").trim();
  const match = /^`?([A-Za-z_$][\w$]*)`?\s+must\s+reject\s+(?:a\s+)?non-integer\s+`?([A-Za-z_$][\w$]*)`?\s+with\s+`?(TypeError|RangeError|Error)`?[.;]?$/i.exec(clause);
  if (match) return { target: match[1], parameter: match[2], errorClass: match[3] };
  const plain = clause.replaceAll("`", "");
  if (!/^Reject\s+negative(?:\/|\s+or\s+)non-integer\b/i.test(plain)) return null;
  const compound = /^Reject\s+negative(?:\/|\s+or\s+)non-integer\s+([A-Za-z_$][\w$]*(?:\s+(?:or|and)\s+[A-Za-z_$][\w$]*)*)\s+inputs?\s+with\s+(TypeError|RangeError|Error)[.;]?$/i.exec(plain);
  const parameters = compound ? compound[1].split(/\s+(?:or|and)\s+/i) : [];
  const contract = { target: null, parameters, errorClass: compound?.[2] ?? null, partitions: ["negative", "fractional"] };
  const fields = recordIntegerContext(contract, contextText);
  return fields ? { ...contract, recordFields: fields } : contract;

}

const memberName = node => node?.type === "Identifier" ? node.name
  : node?.type === "MemberExpression" && !node.computed
    ? `${memberName(node.object)}.${node.property.name}` : null;

function hasFractionalWitness(assertions, binding, index) {
  return assertions.some(assertion => {
    if (!binding.testNames.some(name => assertion.targets.includes(name))) return false;
    try {
      const operation = parseExpression(assertion.operation);
      const body = operation.body?.type === "BlockStatement" && operation.body.body.length === 1
        ? operation.body.body[0]?.argument : operation.body;
      if (body?.type !== "CallExpression" || body.arguments.some(argument => argument.type === "SpreadElement")
        || !binding.testNames.includes(memberName(body.callee))) return false;
      const argument = body.arguments[index];
      const value = argument?.type === "NumericLiteral" ? argument.value
        : argument?.type === "UnaryExpression" && argument.operator === "-" && argument.argument.type === "NumericLiteral"
          ? -argument.argument.value : undefined;
      return typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value);
    } catch { return false; }
  });
}

// This additional domain proof is deliberately exact: an unshadowed intrinsic
// predicate, before any effect or early return, immediately throws the declared
// intrinsic error. Existing import, source-origin, verifier and tree gates are
// still mandatory. More complex guards need their own supported proof.
function directIntegerGuard(sourceEntries, binding, contract, parameterIndex) {
  let selected;
  try {
    for (const entry of sourceEntries) {
      if (entry.text.length > 64_000) return false;
      const ast = parse(entry.text, { sourceType: "unambiguous", plugins: /\.[cm]?tsx?$/.test(entry.path) ? ["typescript"] : ["jsx"] });
      let safe = true, count = 0;
      const visit = (node, parent, grandparent, depth = 0) => {
        if (!node || typeof node.type !== "string") return;
        if (++count > 12_000 || depth > 128) throw new Error("parameter-proof-budget");
        if (node.type === "Identifier" && node.name === "Number") {
          if (!(parent?.type === "MemberExpression" && parent.object === node && !parent.computed
            && ["isInteger", "isSafeInteger", "isFinite"].includes(parent.property.name)
            && grandparent?.type === "CallExpression" && grandparent.callee === parent)) safe = false;
        }
        for (const [key, value] of Object.entries(node)) {
          if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
          if (Array.isArray(value)) value.forEach(item => visit(item, node, parent, depth + 1));
          else if (value && typeof value === "object") visit(value, node, parent, depth + 1);
        }
      };
      visit(ast);
      if (!safe) return false;
      if (entry.path !== binding.sourcePath) continue;
      for (const statement of ast.program.body) {
        const node = statement.declaration ?? statement;
        if (node.type === "FunctionDeclaration" && node.id?.name.toLowerCase() === binding.sourceName) selected = node;
        if (node.type === "VariableDeclaration") for (const item of node.declarations) {
          if (item.id.name?.toLowerCase() === binding.sourceName && ["ArrowFunctionExpression", "FunctionExpression"].includes(item.init?.type)) selected = item.init;
        }
      }
    }
    if (!selected?.params.every(parameter => parameter.type === "Identifier")
      || selected.params[parameterIndex].name !== (contract.parameter ?? contract.parameters[parameterIndex]) || selected.async || selected.generator) return false;
    const candidates = contract.parameters ? selected.body?.body?.slice(0, contract.parameters.length) : [selected.body?.body?.[0]];
    const parameterFor = statement => {
      const condition = statement?.test, predicate = condition?.type === "LogicalExpression" && condition.operator === "||" ? condition.left : null;
      const lower = condition?.right, name = predicate?.argument?.arguments?.[0]?.name;
      return statement?.type === "IfStatement" && !statement.alternate && predicate?.type === "UnaryExpression" && predicate.operator === "!"
        && predicate.argument.type === "CallExpression" && memberName(predicate.argument.callee) === "Number.isInteger"
        && predicate.argument.arguments.length === 1 && predicate.argument.arguments[0].type === "Identifier"
        && lower?.type === "BinaryExpression" && lower.operator === "<" && lower.left.type === "Identifier" && lower.left.name === name
        && lower.right.type === "NumericLiteral" && lower.right.value === 0 ? name : null;
    };
    if (contract.parameters && (candidates?.length !== contract.parameters.length
      || new Set(candidates.map(parameterFor)).size !== contract.parameters.length
      || candidates.some(statement => !contract.parameters.includes(parameterFor(statement))))) return false;
    const first = contract.parameters ? candidates.find(statement => parameterFor(statement) === contract.parameter) : candidates[0];
    const condition = contract.parameters ? first?.test?.left : first?.test;
    if (first?.type !== "IfStatement" || condition?.type !== "UnaryExpression" || condition.operator !== "!"
      || condition.argument?.type !== "CallExpression" || memberName(condition.argument.callee) !== "Number.isInteger"
      || condition.argument.arguments.length !== 1 || condition.argument.arguments[0].type !== "Identifier"
      || condition.argument.arguments[0].name !== contract.parameter) return false;
    const consequent = first.consequent.type === "BlockStatement" && first.consequent.body.length === 1
      ? first.consequent.body[0] : first.consequent;
    const error = consequent?.argument;
    return consequent?.type === "ThrowStatement" && error?.type === "NewExpression"
      && error.callee.type === "Identifier" && error.callee.name === contract.errorClass
      && error.arguments.every(argument => ["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(argument.type));
  } catch { return false; }
}

export function integerParameterBindingEvidence({ contract, binding, parameters, assertions, sourceEntries, testEntries = [] }) {
  if (contract?.recordFields) return recordWitnesses({ contract, binding, assertions, sourceEntries, testEntries });
  if (!contract) return null;
  if (contract.parameters) {
    const unique = new Set(contract.parameters.map(name => name.toLowerCase()));
    const indices = contract.parameters.map(name => parameters.indexOf(name.toLowerCase()));
    const bound = indices.length > 0 && indices.length <= 8 && unique.size === indices.length && indices.every(index => index >= 0);
    const invocations = assertions.flatMap(assertion => binding.testNames.flatMap(name => integerAssertionArguments(assertion, name)));
    const valid = value => value?.kind === "number" && Number.isInteger(value.value) && value.value >= 0;
    return {
      sourceOk: bound && indices.every((index, order) => directIntegerGuard(sourceEntries, binding, { ...contract, parameter: contract.parameters[order] }, index)),
      testOk: bound && indices.every(index => contract.partitions.every(partition => invocations.some(args =>
        args[index]?.kind === "number" && indices.every(other => other === index || valid(args[other]))
        && (partition === "negative" ? args[index].value < 0 : Number.isFinite(args[index].value) && !Number.isInteger(args[index].value))))),
      inputs: bound ? indices.map(index => ({ name: parameters[index], partitions: contract.partitions })) : []
    };
  }
  const index = parameters.findIndex(name => name === contract.parameter.toLowerCase());
  const bound = binding.target === contract.target.toLowerCase() && index >= 0;
  return {
    sourceOk: bound && directIntegerGuard(sourceEntries, binding, contract, index),
    testOk: bound && hasFractionalWitness(assertions, binding, index),
    inputs: bound ? [{ name: parameters[index], partitions: ["fractional"] }] : []
  };
}

// Related task prose can bind a monetary input to a per-record field. This
// projection supplies names only; it cannot replace source guards or witnesses.
function recordIntegerContext(contract, contextText) {
  if (!contract?.parameters || contract.parameters.length !== 2 || !contract.parameters.includes("money")
    || typeof contextText !== "string" || contextText.length > 16_000) return null;
  const context = contextText.replace(/\s+/g, " ");
  if (!/\bAll values are integer cents or basis points\./i.test(context)) return null;
  const matches = [...context.matchAll(/\bFor each [a-z]+, multiply `([A-Za-z_$][\w$]*)` by the positive integer `([A-Za-z_$][\w$]*)` \(default ([1-9]\d*)\)/g)];
  const tuples = [...new Set(matches.map(match => JSON.stringify(match.slice(1))))].map(value => JSON.parse(value));
  if (tuples.length !== 1) return null;
  const [money, quantity, defaultValue] = tuples[0];
  if (money === quantity || !contract.parameters.includes(quantity) || !Number.isSafeInteger(Number(defaultValue))) return null;
  return [{ name: money, minimum: 0 }, { name: quantity, minimum: 1, defaultValue: Number(defaultValue) }];
}

const recordFail = () => { throw new Error("unsupported-record-integer-proof"); };
const recordNumber = node => node?.type === "NumericLiteral" && Number.isFinite(node.value) ? node.value
  : memberName(node) === "Number.MAX_SAFE_INTEGER" ? Number.MAX_SAFE_INTEGER : undefined;
const recordParameter = node => node?.type === "Identifier" ? node.name
  : node?.type === "AssignmentPattern" && node.left.type === "Identifier" && recordNumber(node.right) !== undefined ? node.left.name : null;
function recordSourceFunctions(entries, sourcePath) {
  let selected;
  for (const entry of entries) {
    if (entry.text.length > 64_000) recordFail();
    const ast = parse(entry.text, { sourceType: "module", errorRecovery: false });
    const functions = new Map(), protectedNames = new Set(["Number", "Math", "Array", "TypeError", "RangeError", "Error"]);
    for (const statement of ast.program.body) {
      const fn = statement.type === "ExportNamedDeclaration" && !statement.source ? statement.declaration : statement;
      if (fn?.type !== "FunctionDeclaration" || fn.async || fn.generator || !fn.id || functions.has(fn.id.name)
        || protectedNames.has(fn.id.name)) recordFail();
      functions.set(fn.id.name, fn);
    }
    for (const name of functions.keys()) protectedNames.add(name);
    let count = 0;
    const visit = (node, parent, depth = 0) => {
      if (!node || typeof node.type !== "string") return;
      if (++count > 12_000 || depth > 128) recordFail();
      if (["AssignmentExpression", "UpdateExpression", "AwaitExpression", "YieldExpression", "ThisExpression"].includes(node.type)) recordFail();
      if (node.type === "CallExpression" && !functions.has(node.callee.name)
        && !["Number.isInteger", "Number.isSafeInteger", "Number.isFinite", "Math.round", "Math.floor", "Math.ceil", "Array.isArray"].includes(memberName(node.callee))
        && !(node.callee.type === "MemberExpression" && !node.callee.computed && ["reduce", "every"].includes(node.callee.property.name))) recordFail();
      if (node.type === "Identifier" && ["Number", "Math", "Array"].includes(node.name)
        && !(parent?.type === "MemberExpression" && parent.object === node && !parent.computed)) recordFail();
      if (node.type === "VariableDeclarator" && (node.id.type !== "Identifier" || protectedNames.has(node.id.name))) recordFail();
      if (/Function/.test(node.type) && node.params) {
        const names = node.params.map(recordParameter);
        if (names.some(name => !name || protectedNames.has(name)) || new Set(names).size !== names.length) recordFail();
      }
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item => visit(item, node, depth + 1));
        else if (value && typeof value === "object") visit(value, node, depth + 1);
      }
    };
    visit(ast);
    if (entry.path === sourcePath) selected = functions;
  }
  return selected ?? recordFail();
}
function recordError(statement, errorClass) {
  const body = statement?.type === "BlockStatement" && statement.body.length === 1 ? statement.body[0] : statement;
  return body?.type === "ThrowStatement" && body.argument?.type === "NewExpression"
    && body.argument.callee.type === "Identifier" && body.argument.callee.name === errorClass
    && body.argument.arguments.every(node => ["StringLiteral", "NumericLiteral", "NullLiteral", "BooleanLiteral"].includes(node.type));
}
function recordGuard(call, functions, errorClass) {
  const helper = call?.type === "CallExpression" && call.callee.type === "Identifier" ? functions.get(call.callee.name) : null;
  if (!helper || call.arguments.length < 2 || call.arguments.length > helper.params.length || helper.params.length > 3
    || helper.body.body.length !== 2 || helper.body.body[1].type !== "ReturnStatement"
    || helper.body.body[1].argument?.name !== recordParameter(helper.params[0])) return null;
  const names = helper.params.map(recordParameter), constants = new Map();
  for (let index = 1; index < names.length; index++) {
    const value = recordNumber(call.arguments[index] ?? helper.params[index]?.right);
    if (!Number.isSafeInteger(value)) return null;
    constants.set(names[index], value);
  }
  const guard = helper.body.body[0], terms = [];
  const flatten = node => node?.type === "LogicalExpression" && node.operator === "||"
    ? (flatten(node.left), flatten(node.right)) : terms.push(node);
  flatten(guard?.test);
  const predicate = terms[0]?.argument;
  if (guard?.type !== "IfStatement" || guard.alternate || !recordError(guard.consequent, errorClass)
    || terms.length < 2 || terms.length > 3 || terms[0].type !== "UnaryExpression" || terms[0].operator !== "!"
    || predicate?.type !== "CallExpression" || !["Number.isInteger", "Number.isSafeInteger"].includes(memberName(predicate.callee))
    || predicate.arguments.length !== 1 || predicate.arguments[0].type !== "Identifier" || predicate.arguments[0].name !== names[0]) return null;
  const bound = (term, operator) => term?.type === "BinaryExpression" && term.operator === operator
    && term.left.type === "Identifier" && term.left.name === names[0]
    ? recordNumber(term.right) ?? constants.get(term.right.name) : undefined;
  const minimum = bound(terms[1], "<"), maximum = terms.length === 3 ? bound(terms[2], ">") : Infinity;
  if (!Number.isSafeInteger(minimum) || !(maximum >= minimum)) return null;
  return { minimum, maximum, safe: memberName(predicate.callee) === "Number.isSafeInteger" };
}
function recordPureNumber(node, names) {
  if (node?.type === "Identifier") return names.has(node.name);
  if (node?.type === "NumericLiteral") return Number.isFinite(node.value);
  if (node?.type === "UnaryExpression" && ["+", "-"].includes(node.operator)) return recordPureNumber(node.argument, names);
  if (node?.type === "BinaryExpression" && ["+", "-", "*", "/", "%", "**"].includes(node.operator)) return recordPureNumber(node.left, names) && recordPureNumber(node.right, names);
  return node?.type === "CallExpression" && ["Math.round", "Math.floor", "Math.ceil"].includes(memberName(node.callee))
    && node.arguments.length === 1 && recordPureNumber(node.arguments[0], names);
}
function recordSourceProfile({ contract, binding, sourceEntries }) {
  try {
    const functions = recordSourceFunctions(sourceEntries, binding.sourcePath);
    const candidates = [...functions.values()].filter(fn => fn.id.name.toLowerCase() === binding.sourceName);
    if (candidates.length !== 1) return null;
    const fn = candidates[0], params = fn.params.map(recordParameter), statements = fn.body.body;
    const guard = statements[0], array = guard?.test?.argument;
    if (guard?.type !== "IfStatement" || guard.alternate || guard.test.type !== "UnaryExpression" || guard.test.operator !== "!"
      || array?.type !== "CallExpression" || memberName(array.callee) !== "Array.isArray" || array.arguments.length !== 1
      || array.arguments[0].type !== "Identifier" || !params.includes(array.arguments[0].name)
      || !recordError(guard.consequent, contract.errorClass)) return null;
    const arrayName = array.arguments[0].name, arrayIndex = params.indexOf(arrayName), scalars = new Map(), numbers = new Set();
    const allNames = new Set([...params, ...functions.keys(), "Number", "Array", "Math"]);
    let fields;
    for (const statement of statements.slice(1, -1)) {
      if (statement.type === "ExpressionStatement") {
        const call = statement.expression, domain = recordGuard(call, functions, contract.errorClass), name = call.arguments?.[0]?.name;
        if (fields || !domain || !params.includes(name) || name === arrayName || scalars.has(name)) return null;
        scalars.set(name, domain); numbers.add(name); continue;
      }
      if (statement.type !== "VariableDeclaration" || statement.kind !== "const" || statement.declarations.length !== 1 || fields) return null;
      const declaration = statement.declarations[0], call = declaration.init, callback = call?.arguments?.[0];
      if (declaration.id.type !== "Identifier" || allNames.has(declaration.id.name) || call?.type !== "CallExpression"
        || memberName(call.callee) !== `${arrayName}.reduce` || call.arguments.length !== 2 || recordNumber(call.arguments[1]) === undefined
        || callback?.type !== "ArrowFunctionExpression" || callback.async || callback.params.length !== 2
        || callback.params.some(param => param.type !== "Identifier" || allNames.has(param.name))
        || callback.body.type !== "BlockStatement") return null;
      const [accumulator, element] = callback.params.map(param => param.name), locals = new Set([accumulator]), seen = new Set(allNames);
      seen.add(accumulator); seen.add(element); fields = new Map();
      for (const step of callback.body.body.slice(0, -1)) {
        if (step.type !== "VariableDeclaration" || step.kind !== "const" || step.declarations.length !== 1) return null;
        const local = step.declarations[0], invocation = local.init, domain = recordGuard(invocation, functions, contract.errorClass);
        let property = invocation?.arguments?.[0], defaultValue;
        if (property?.type === "LogicalExpression" && property.operator === "??") { defaultValue = recordNumber(property.right); property = property.left; if (defaultValue === undefined) return null; }
        if (local.id.type !== "Identifier" || seen.has(local.id.name) || !domain
          || !["OptionalMemberExpression", "MemberExpression"].includes(property?.type) || property.computed
          || property.object.type !== "Identifier" || property.object.name !== element || fields.has(property.property.name)) return null;
        fields.set(property.property.name, { ...domain, defaultValue }); seen.add(local.id.name); locals.add(local.id.name);
      }
      const last = callback.body.body.at(-1);
      if (last?.type !== "ReturnStatement" || !recordPureNumber(last.argument, locals)) return null;
      numbers.add(declaration.id.name);
    }
    if (!fields || scalars.size !== params.length - 1 || statements.at(-1)?.type !== "ReturnStatement"
      || !recordPureNumber(statements.at(-1).argument, numbers)) return null;
    if (!contract.recordFields.every(field => fields.has(field.name) && fields.get(field.name).minimum === field.minimum
      && fields.get(field.name).defaultValue === field.defaultValue)) return null;
    return { arrayIndex, fields, scalars: params.map(name => scalars.get(name)), defaults: fn.params.map(param => param.type === "AssignmentPattern" ? recordNumber(param.right) : undefined) };
  } catch { return null; }
}
function recordLiteral(node, bindings = new Map(), depth = 0) {
  if (!node || depth > 4) return null;
  if (node.type === "Identifier" && bindings.has(node.name)) return bindings.get(node.name);
  if (node.type === "ArrayExpression" && node.elements.length <= 16) {
    const values = node.elements.map(item => recordLiteral(item, bindings, depth + 1));
    return values.every(Boolean) ? { kind: "array", values } : null;
  }
  if (node.type === "ObjectExpression" && node.properties.length <= 16) {
    const values = new Map();
    for (const property of node.properties) {
      if (property.type !== "ObjectProperty" || property.computed || property.method || property.key.type !== "Identifier"
        || ["__proto__", "constructor", "prototype"].includes(property.key.name) || values.has(property.key.name)) return null;
      const value = recordLiteral(property.value, bindings, depth + 1); if (!value) return null;
      values.set(property.key.name, value);
    }
    return { kind: "record", values };
  }
  if (node.type === "NumericLiteral") return { kind: "number", value: node.value };
  if (node.type === "UnaryExpression" && ["+", "-"].includes(node.operator)) { const value = recordLiteral(node.argument, bindings, depth + 1); return value?.kind === "number" ? { kind: "number", value: node.operator === "-" ? -value.value : value.value } : null; }
  return null;
}
function recordWitnesses({ contract, binding, assertions, sourceEntries, testEntries }) {
  const profile = recordSourceProfile({ contract, binding, sourceEntries });
  if (!profile) return { sourceOk: false, testOk: false, inputs: [], recordSourceOk: false };
  const valid = (value, domain) => value?.kind === "number" && Number.isInteger(value.value)
    && (!domain.safe || Number.isSafeInteger(value.value)) && value.value >= domain.minimum && value.value <= domain.maximum;
  let stable = testEntries.length > 0 && testEntries.every(entry => integerTestInputsStable(entry.text)
    && literalArrayIterationEnvironmentIsStable(entry.text));
  for (const entry of testEntries) {
    try {
      const ast = parse(entry.text, { sourceType: "module" });
      const inspect = (node, parent, grandparent) => {
        if (!node || typeof node.type !== "string") return;
        if (node.type === "Identifier" && node.name === "Array" && !(parent?.type === "MemberExpression"
          && parent.object === node && !parent.computed && ["isArray", "from", "of"].includes(parent.property.name)
          && grandparent?.type === "CallExpression" && grandparent.callee === parent)) stable = false;
        if (node.type === "ObjectProperty" && node.key.type === "Identifier" && !node.computed
          && [...profile.fields.keys()].some(name => name.toLowerCase() === node.key.name.toLowerCase() && name !== node.key.name)) stable = false;
        for (const [key, value] of Object.entries(node)) { if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue; if (Array.isArray(value)) value.forEach(item => inspect(item, node, parent)); else if (value && typeof value === "object") inspect(value, node, parent); }
      };
      inspect(ast);
    } catch { stable = false; }
  }
  const invocations = assertions.flatMap(assertion => binding.testNames.flatMap(name => integerAssertionArguments(assertion, name, recordLiteral)));
  const testOk = stable && contract.recordFields.every(field => contract.partitions.every(partition => invocations.some(args => {
    const array = args[profile.arrayIndex];
    if (array?.kind !== "array" || array.values.length !== 1 || array.values[0].kind !== "record"
      || args.length > profile.scalars.length || profile.scalars.some((domain, index) => domain && !valid(args[index] ?? { kind: "number", value: profile.defaults[index] }, domain))) return false;
    const record = array.values[0].values, candidate = record.get(field.name.toLowerCase());
    if (candidate?.kind !== "number" || !(partition === "negative" ? candidate.value < 0 : Number.isFinite(candidate.value) && !Number.isInteger(candidate.value))) return false;
    return [...profile.fields].every(([name, domain]) => name === field.name
      || valid(record.get(name.toLowerCase()) ?? { kind: "number", value: domain.defaultValue }, domain));
  })));
  return { sourceOk: true, testOk, inputs: [], recordSourceOk: true };
}

export { recordSourceFunctions as closedNumericValidationFunctions, recordError as closedLiteralError };

// A bounded record-transition contract keeps identifier rejection and applied
// order together. Names come from the declared signature and field clause.
function orderedRecordContract(text, contextText) {
  let clause=String(text??'').replace(/\s+/g,' ').trim();
  if(!/Preserve applied-event order and reject malformed state or event shapes/i.test(clause))return null;
  const result={supported:false},context=String(contextText??'');if(context.length>16000)return result;
  const declarations=[...new Set([...context.matchAll(/Each event has a unique non-empty string `[\w$]+`, a non-empty string `[\w$]+`, an integer `[\w$]+`, and `[\w$]+`\./g)].map(item=>item[0]))];
  if(declarations.length>1)return result;
  if(/^Preserve applied-event order and reject malformed state or event shapes, including empty IDs, with `?TypeError`?[.;]?$/i.test(clause)&&declarations.length===1)clause=declarations[0]+' '+clause;
  const match=/^Each event has a unique non-empty string `([\w$]+)`, a non-empty string `([\w$]+)`, an integer `([\w$]+)`, and `([\w$]+)`\. Preserve applied-event order and reject malformed state or event shapes, including empty IDs, with `?(TypeError)`?[.;]?$/i.exec(clause);
  if(!match)return result;
  const signatures=[...new Set([...context.matchAll(/`([A-Za-z_$][\w$]*)\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)`/g)].map(item=>JSON.stringify(item.slice(1))))].map(value=>JSON.parse(value));
  if(signatures.length!==1||new Set(match.slice(1,5)).size!==4||signatures[0][1]===signatures[0][2])return result;
  return {supported:true,target:signatures[0][0],parameters:signatures[0].slice(1),id:match[1],owner:match[2],revision:match[3],payload:match[4],errorClass:match[5]};
}
const orderedTerms=(node,operator)=>node?.type==='LogicalExpression'&&node.operator===operator?[...orderedTerms(node.left,operator),...orderedTerms(node.right,operator)]:[node];
const orderedIdentifier=(node,name)=>node?.type==='Identifier'&&node.name===name;
const orderedMember=(node,root,field)=>memberName(node)===`${root}.${field}`;
const orderedCall=(node,name,args)=>node?.type==='CallExpression'&&memberName(node.callee)===name&&node.arguments.length===args.length&&args.every((check,index)=>check(node.arguments[index]));
const orderedNot=(node,check)=>node?.type==='UnaryExpression'&&node.operator==='!'&&check(node.argument);
const orderedNumber=(node,value)=>node?.type==='NumericLiteral'&&node.value===value;
const orderedConst=node=>node?.type==='VariableDeclaration'&&node.kind==='const'&&node.declarations.length===1&&node.declarations[0].id.type==='Identifier'?node.declarations[0]:null;
function orderedWalk(node,visit,parent=null,depth=0,budget={count:0}) {
  if(!node||typeof node.type!=='string')return;
  if(++budget.count>12000||depth>128)throw new Error('ordered-record-budget');visit(node,parent);
  for(const [key,value]of Object.entries(node)){
    if(['loc','extra','comments','tokens','errors'].includes(key))continue;
    if(Array.isArray(value))value.forEach(item=>orderedWalk(item,visit,node,depth+1,budget));
    else if(value&&typeof value==='object')orderedWalk(value,visit,node,depth+1,budget);
  }
}
function orderedPredicate(fn,kind) {
  if(!fn||fn.async||fn.generator||fn.params.length!==1||fn.params[0].type!=='Identifier'||fn.body.body.length!==1||fn.body.body[0].type!=='ReturnStatement')return false;
  const name=fn.params[0].name,terms=orderedTerms(fn.body.body[0].argument,'&&');
  const type=(node,wanted)=>node?.type==='BinaryExpression'&&node.operator==='==='&&node.left.type==='UnaryExpression'&&node.left.operator==='typeof'
    &&orderedIdentifier(node.left.argument,name)&&node.right.type==='StringLiteral'&&node.right.value===wanted;
  return kind==='record'?terms.length===3&&orderedIdentifier(terms[0],name)&&type(terms[1],'object')
    &&orderedNot(terms[2],node=>orderedCall(node,'Array.isArray',[arg=>orderedIdentifier(arg,name)]))
    :terms.length===2&&type(terms[0],'string')&&terms[1].type==='BinaryExpression'&&terms[1].operator==='>'
      &&orderedMember(terms[1].left,name,'length')&&orderedNumber(terms[1].right,0);
}
function orderedRecordSource(contract,binding,sourceEntries) {
  if(!contract.supported||binding.sourceName.toLowerCase()!==contract.target.toLowerCase()||sourceEntries.length!==1||sourceEntries[0].path!==binding.sourcePath)return null;
  try {
    const entry=sourceEntries[0];if(entry.text.length>64000)return null;
    const ast=parse(entry.text,{sourceType:'module'}),functions=new Map(),exports=[];
    for(const statement of ast.program.body){
      const fn=statement.type==='ExportNamedDeclaration'&&!statement.source?statement.declaration:statement;
      if(fn?.type!=='FunctionDeclaration'||fn.async||fn.generator||!fn.id||functions.has(fn.id.name))return null;
      functions.set(fn.id.name,fn);if(statement.type==='ExportNamedDeclaration')exports.push(fn.id.name);
    }
    if(functions.size!==3||exports.length!==1||exports[0]!==contract.target)return null;
    const fn=functions.get(contract.target);if(fn.params.length!==2||fn.params.some((node,index)=>!orderedIdentifier(node,contract.parameters[index]))||fn.body.body.length!==5)return null;
    const [initial,events]=contract.parameters,[guard,copyDeclaration,setDeclaration,loop,returned]=fn.body.body,parts=orderedTerms(guard?.test,'||');
    const recordName=parts[0]?.argument?.callee?.name,stringName=parts[3]?.arguments?.[0]?.body?.argument?.callee?.name;
    if(recordName===stringName||recordName===contract.target||stringName===contract.target||!orderedPredicate(functions.get(recordName),'record')||!orderedPredicate(functions.get(stringName),'string'))return null;
    const safeField=name=>typeof name==='string'&&/^[A-Za-z_$][\w$]*$/.test(name)&&!['constructor','prototype','__proto__'].includes(name);
    const dictionary=parts[1]?.argument?.arguments?.[0]?.property?.name,appliedField=parts[2]?.argument?.arguments?.[0]?.property?.name;
    if(!safeField(dictionary)||!safeField(appliedField)||dictionary===appliedField)return null;
    const record=(node,check)=>orderedNot(node,call=>orderedCall(call,recordName,[check]));
    const string=(node,check)=>orderedNot(node,call=>orderedCall(call,stringName,[check]));
    const integer=(node,check)=>orderedNot(node,call=>orderedCall(call,'Number.isInteger',[check]));
    const negative=(node,check)=>node?.type==='BinaryExpression'&&node.operator==='<'&&check(node.left)&&orderedNumber(node.right,0);
    const callback=parts[3]?.arguments?.[0];
    if(guard.type!=='IfStatement'||guard.alternate||!recordError(guard.consequent,contract.errorClass)||parts.length!==5
      ||!record(parts[0],arg=>orderedIdentifier(arg,initial))||!record(parts[1],arg=>orderedMember(arg,initial,dictionary))
      ||!orderedNot(parts[2],call=>orderedCall(call,'Array.isArray',[arg=>orderedMember(arg,initial,appliedField)]))
      ||!orderedCall(parts[3],`${initial}.${appliedField}.some`,[arg=>arg===callback])||callback.type!=='ArrowFunctionExpression'||callback.async||callback.params.length!==1||callback.params[0].type!=='Identifier'
      ||!string(callback.body,arg=>orderedIdentifier(arg,callback.params[0].name))||!orderedNot(parts[4],call=>orderedCall(call,'Array.isArray',[arg=>orderedIdentifier(arg,events)])))return null;
    const copy=orderedConst(copyDeclaration),set=orderedConst(setDeclaration),output=copy?.id.name,seen=set?.id.name;
    if(!copy||!set||!orderedCall(copy.init,'structuredClone',[arg=>orderedIdentifier(arg,initial)])||set.init?.type!=='NewExpression'||!orderedIdentifier(set.init.callee,'Set')
      ||set.init.arguments.length!==1||!orderedMember(set.init.arguments[0],output,appliedField))return null;
    const iterator=loop.type==='ForOfStatement'&&!loop.await&&loop.left.type==='VariableDeclaration'&&loop.left.kind==='const'&&loop.left.declarations.length===1?loop.left.declarations[0].id:null;
    const item=iterator?.name;
    if(iterator?.type!=='Identifier'||!orderedIdentifier(loop.right,events)||loop.body.type!=='BlockStatement'||loop.body.body.length!==9||returned.type!=='ReturnStatement'||!orderedIdentifier(returned.argument,output))return null;
    const [itemGuard,duplicate,currentDeclaration,currentGuard,versionDeclaration,conflict,store,append,mark]=loop.body.body;
    const itemParts=orderedTerms(itemGuard.test,'||'),field=name=>node=>orderedMember(node,item,name);
    if(itemGuard.type!=='IfStatement'||itemGuard.alternate||!recordError(itemGuard.consequent,contract.errorClass)||itemParts.length!==5
      ||!record(itemParts[0],arg=>orderedIdentifier(arg,item))||!string(itemParts[1],field(contract.id))||!string(itemParts[2],field(contract.owner))
      ||!integer(itemParts[3],field(contract.revision))||!negative(itemParts[4],field(contract.revision)))return null;
    if(duplicate.type!=='IfStatement'||duplicate.alternate||!orderedCall(duplicate.test,`${seen}.has`,[field(contract.id)])||duplicate.consequent.type!=='ContinueStatement'||duplicate.consequent.label)return null;
    const current=orderedConst(currentDeclaration),version=orderedConst(versionDeclaration),currentName=current?.id.name,versionName=version?.id.name;
    if(!current||!version||current.init?.type!=='MemberExpression'||!current.init.computed||!orderedMember(current.init.object,output,dictionary)||!field(contract.owner)(current.init.property))return null;
    const currentParts=orderedTerms(currentGuard.test?.right,'||'),versionField=currentParts[1]?.argument?.arguments?.[0]?.property?.name;
    if(!safeField(versionField)||currentGuard.type!=='IfStatement'||currentGuard.alternate||currentGuard.test?.type!=='LogicalExpression'||currentGuard.test.operator!=='&&'
      ||currentGuard.test.left.type!=='BinaryExpression'||currentGuard.test.left.operator!=='!=='||!orderedIdentifier(currentGuard.test.left.left,currentName)||!orderedIdentifier(currentGuard.test.left.right,'undefined')
      ||currentParts.length!==3||!record(currentParts[0],arg=>orderedIdentifier(arg,currentName))||!integer(currentParts[1],arg=>orderedMember(arg,currentName,versionField))
      ||!negative(currentParts[2],arg=>orderedMember(arg,currentName,versionField))||!recordError(currentGuard.consequent,contract.errorClass))return null;
    const readVersion=version.init?.left;
    if(version.init?.type!=='LogicalExpression'||version.init.operator!=='??'||readVersion?.type!=='OptionalMemberExpression'||!readVersion.optional||readVersion.computed
      ||!orderedIdentifier(readVersion.object,currentName)||readVersion.property.name!==versionField||!orderedNumber(version.init.right,0))return null;
    if(conflict.type!=='IfStatement'||conflict.alternate||conflict.test?.type!=='BinaryExpression'||conflict.test.operator!=='!=='||!orderedIdentifier(conflict.test.left,versionName)
      ||!field(contract.revision)(conflict.test.right)||!recordError(conflict.consequent,'Error'))return null;
    const assignment=store.type==='ExpressionStatement'?store.expression:null,properties=assignment?.right?.properties;
    if(assignment?.type!=='AssignmentExpression'||assignment.operator!=='='||assignment.left.type!=='MemberExpression'||!assignment.left.computed
      ||!orderedMember(assignment.left.object,output,dictionary)||!field(contract.owner)(assignment.left.property)||assignment.right.type!=='ObjectExpression'||properties.length!==2
      ||properties.some(property=>property.type!=='ObjectProperty'||property.computed||property.method||!safeField(property.key.name))||properties[0].key.name!==versionField
      ||properties[0].value.type!=='BinaryExpression'||properties[0].value.operator!=='+'||!orderedIdentifier(properties[0].value.left,versionName)||!orderedNumber(properties[0].value.right,1)
      ||properties[1].key.name===versionField||!orderedCall(properties[1].value,'structuredClone',[field(contract.payload)]))return null;
    if(append.type!=='ExpressionStatement'||!orderedCall(append.expression,`${output}.${appliedField}.push`,[field(contract.id)])
      ||mark.type!=='ExpressionStatement'||!orderedCall(mark.expression,`${seen}.add`,[field(contract.id)]))return null;
    const locals=[...contract.parameters,output,seen,item,currentName,versionName],protectedNames=new Set(['Array','Number','Set','structuredClone','TypeError','Error','undefined',...functions.keys()]);
    if(new Set(locals).size!==locals.length||locals.some(name=>protectedNames.has(name)))return null;
    orderedWalk(ast,(node,parent)=>{
      if(node.type==='Identifier'&&['Array','Number'].includes(node.name)&&!(parent?.type==='MemberExpression'&&parent.object===node&&!parent.computed))throw new Error('ordered-native');
      if(node.type==='Identifier'&&node.name==='structuredClone'&&!(parent?.type==='CallExpression'&&parent.callee===node))throw new Error('ordered-native');
      if(node.type==='Identifier'&&node.name==='Set'&&!(parent?.type==='NewExpression'&&parent.callee===node))throw new Error('ordered-native');
      if(/Function/.test(node.type)&&node.params.some(parameter=>parameter.type!=='Identifier'||protectedNames.has(parameter.name)))throw new Error('ordered-shadow');
      if(node.type==='VariableDeclarator'&&(node.id.type!=='Identifier'||protectedNames.has(node.id.name)))throw new Error('ordered-shadow');
    });
    return {dictionary,appliedField,versionField};
  } catch{return null;}
}
function orderedRecordTests(contract,profile,binding,testEntries) {
  if(!profile)return {testOk:false};
  const observed=new Set();let order=false,calls=0;
  const isRecord=value=>value?.kind==='record',isArray=value=>value?.kind==='array',primitive=value=>value?.kind==='primitive',field=(value,name)=>value?.fields?.get(name);
  const validId=value=>primitive(value)&&typeof value.value==='string'&&value.value.length>0;
  const validInteger=value=>primitive(value)&&Number.isInteger(value.value)&&value.value>=0;
  const validState=value=>isRecord(value)&&isRecord(field(value,profile.dictionary))&&isArray(field(value,profile.appliedField))&&field(value,profile.appliedField).elements.every(validId);
  const validEvent=value=>isRecord(value)&&validId(field(value,contract.id))&&validId(field(value,contract.owner))&&validInteger(field(value,contract.revision));
  const examine=args=>{
    if(args.length!==2||!args.every(Boolean))return;calls++;
    const [state,events]=args;
    if(isArray(events)&&events.elements.length===0){
      if(primitive(state)&&state.value===null)observed.add('state:null');
      if(isArray(state))observed.add('state:array');
      if(isRecord(state)&&state.fields.size===0)observed.add('state:missing');
      if(isRecord(state)&&isArray(field(state,profile.appliedField))&&field(state,profile.appliedField).elements.every(validId)&&primitive(field(state,profile.dictionary))&&field(state,profile.dictionary).value===null)observed.add('state:dictionary');
      if(isRecord(state)&&isRecord(field(state,profile.dictionary))){
        if(primitive(field(state,profile.appliedField)))observed.add('state:applied-array');
        if(isArray(field(state,profile.appliedField))&&field(state,profile.appliedField).elements.some(value=>primitive(value)&&value.value===''))observed.add('state:applied-id');
      }
    }
    if(!validState(state)||!isArray(events)||events.elements.length!==1)return;
    const value=events.elements[0];
    if(primitive(value)&&value.value===null)observed.add('event:null');
    if(isArray(value))observed.add('event:array');
    if(isRecord(value)&&value.fields.size===0)observed.add('event:missing');
    for(const name of [contract.id,contract.owner]){
      const other=name===contract.id?contract.owner:contract.id,candidate=field(value,name);
      if(!isRecord(value)||!validId(field(value,other))||!validInteger(field(value,contract.revision))||!primitive(candidate))continue;
      if(candidate.value==='')observed.add(name+':empty');
      if(typeof candidate.value!=='string')observed.add(name+':type');
    }
    const revision=field(value,contract.revision);
    if(isRecord(value)&&[contract.id,contract.owner].every(name=>validId(field(value,name)))&&primitive(revision)){
      if(typeof revision.value==='number'&&Number.isFinite(revision.value)&&!Number.isInteger(revision.value))observed.add('revision:fractional');
      if(typeof revision.value!=='number')observed.add('revision:type');
    }
  };
  for(const link of binding.testBindings??[{testPath:binding.testPath,testName:binding.testName}]){
    const entry=testEntries.find(item=>item.path===link.testPath);if(!entry||entry.text.length>64000)continue;
    try {
      const ast=parse(entry.text,{sourceType:'module'}),factories=flatRecordFactories(ast,true),imports=ast.program.body.filter(node=>node.type==='ImportDeclaration');
      const imported=module=>imports.filter(node=>node.source.value===module).flatMap(node=>node.specifiers.filter(item=>item.type==='ImportDefaultSpecifier').map(item=>item.local.name));
      const asserts=[...imported('node:assert/strict'),...imported('node:assert')],runners=imported('node:test');
      if(imports.length!==3||asserts.length!==1||runners.length!==1||[...factories.values()].some(value=>!value))continue;
      const assertName=asserts[0],testName=runners[0],sourceImport=imports.find(node=>!node.source.value.startsWith('node:'));
      if(sourceImport?.specifiers.length!==1||sourceImport.specifiers[0].type!=='ImportSpecifier'||sourceImport.specifiers[0].local.name.toLowerCase()!==link.testName||sourceImport.specifiers[0].imported.name!==contract.target)continue;
      const target=sourceImport.specifiers[0].local.name,protectedNames=new Set([assertName,testName,target,'structuredClone','TypeError',...factories.keys()]);
      const methods=['throws','doesNotThrow','deepEqual','deepStrictEqual','equal','strictEqual','notStrictEqual'];
      orderedWalk(ast,(node,parent)=>{
        if(node.type==='ImportDeclaration'||parent?.type==='ImportSpecifier'||parent?.type==='ImportDefaultSpecifier')return;
        if(node.type==='Identifier'&&['Array','Number','Object','Set','Reflect','Proxy','Function','eval','globalThis','global','process','Symbol'].includes(node.name))throw new Error('ordered-test-native');
        if(node.type==='MemberExpression'&&(node.computed||['constructor','prototype','__proto__'].includes(node.property.name)))throw new Error('ordered-test-reflection');
        if(node.type==='Identifier'&&['undefined','nan','infinity'].includes(node.name.toLowerCase())&&(!['undefined','NaN','Infinity'].includes(node.name)||!(parent?.type==='ObjectProperty'&&parent.value===node||parent?.type==='ArrayExpression'||parent?.type==='CallExpression'&&parent.arguments.includes(node)||parent?.type==='UnaryExpression'&&parent.argument===node)))throw new Error('ordered-test-literal-shadow');
        if(node.type==='CallExpression'&&![target,testName,'structuredClone',...factories.keys(),...methods.map(name=>`${assertName}.${name}`)].includes(memberName(node.callee)))throw new Error('ordered-test-call');
        if(node.type==='Identifier'&&protectedNames.has(node.name)){
          const factory=factories.get(node.name),declaration=factory?.declaration;
          if(!(parent?.type==='CallExpression'&&parent.callee===node||parent?.type==='VariableDeclarator'&&parent===declaration&&parent.id===node
            ||node.name===assertName&&parent?.type==='MemberExpression'&&parent.object===node||node.name==='TypeError'&&parent?.type==='CallExpression'&&memberName(parent.callee)===`${assertName}.throws`&&parent.arguments[1]===node))throw new Error('ordered-test-binding');
        }
      });
      let expansion=0;
      const actualCall=node=>node?.type==='CallExpression'&&orderedIdentifier(node.callee,target)&&node.arguments.length===2&&!node.arguments.some(arg=>arg.type==='SpreadElement');
      const rejection=node=>{
        const call=node?.type==='ExpressionStatement'?node.expression:null,callback=call?.arguments?.[0];
        return orderedCall(call,`${assertName}.throws`,[arg=>arg===callback,arg=>orderedIdentifier(arg,contract.errorClass)])&&callback.type==='ArrowFunctionExpression'&&!callback.async&&callback.params.length===0&&actualCall(callback.body)?callback.body:null;
      };
      const collect=(node,values,before,depth=0)=>{
        if(++expansion>512||depth>2)throw new Error('ordered-test-budget');
        const call=rejection(node);if(call){examine(call.arguments.map(arg=>flatRecordValue(arg,values,factories,before,0,true)));return true;}
        if(node.type==='BlockStatement')return node.body.length>0&&node.body.every(item=>collect(item,values,before,depth));
        if(node.type!=='ForOfStatement'||node.await||node.left.type!=='VariableDeclaration'||node.left.kind!=='const'||node.left.declarations.length!==1||node.left.declarations[0].id.type!=='Identifier'
          ||node.right.type!=='ArrayExpression'||!node.right.elements.length||node.right.elements.length>32)return false;
        const variable=node.left.declarations[0].id.name;if(protectedNames.has(variable)||values.has(variable))return false;
        const rows=node.right.elements.map(arg=>flatRecordValue(arg,values,factories,before,0,true));if(!rows.every(Boolean))return false;
        return rows.every(value=>collect(node.body,new Map([...values,[variable,value]]),before,depth+1));
      };
      for(const statement of ast.program.body){
        if(statement.type==='ImportDeclaration')continue;
        if(statement.type==='VariableDeclaration'&&statement.kind==='const'&&statement.declarations.every(item=>factories.get(item.id.name)?.declaration===item))continue;
        const registration=statement.type==='ExpressionStatement'?statement.expression:null,callback=registration?.arguments?.[1];
        if(!orderedCall(registration,testName,[node=>node.type==='StringLiteral',node=>node===callback])||callback.type!=='ArrowFunctionExpression'||callback.async||callback.params.length!==0||callback.body.type!=='BlockStatement')throw new Error('ordered-test-registration');
        for(const item of callback.body.body)if(!collect(item,new Map(),registration.start))break;
        const values=new Map();let pending=null;
        orderPrefix: for(const item of callback.body.body){
          if(item.type==='VariableDeclaration'&&item.kind==='const'){
            for(const declaration of item.declarations){
              if(declaration.id.type!=='Identifier'||protectedNames.has(declaration.id.name)||values.has(declaration.id.name))throw new Error('ordered-order-binding');
              if(actualCall(declaration.init))pending={name:declaration.id.name,args:declaration.init.arguments.map(arg=>flatRecordValue(arg,values,factories,registration.start,0,true))};
              const value=flatRecordValue(declaration.init,values,factories,registration.start,0,true);if(value)values.set(declaration.id.name,value);else if(!actualCall(declaration.init)&&!orderedCall(declaration.init,'structuredClone',[node=>Boolean(flatRecordValue(node,values,factories,registration.start,0,true))]))break orderPrefix;
            }
            continue;
          }
          const call=item.type==='ExpressionStatement'?item.expression:null;
          if(pending&&call?.type==='CallExpression'&&[`${assertName}.deepEqual`,`${assertName}.deepStrictEqual`].includes(memberName(call.callee))&&call.arguments.length===2&&orderedIdentifier(call.arguments[0],pending.name)){
            const expected=flatRecordValue(call.arguments[1],values,factories,registration.start,0,true),[state,events]=pending.args;
            if(validState(state)&&isArray(events)&&events.elements.every(validEvent)&&isRecord(expected)&&isArray(field(expected,profile.appliedField))){
              const ids=field(state,profile.appliedField).elements.map(value=>value.value),newIds=[];
              for(const event of events.elements){const id=field(event,contract.id).value;if(!ids.includes(id)){ids.push(id);newIds.push(id);}}
              const actual=field(expected,profile.appliedField).elements;
              if(newIds.length>=2&&actual.length===ids.length&&actual.every((value,index)=>validId(value)&&value.value===ids[index]))order=true;
            }
          }
          break;
        }
      }
    } catch{return {testOk:false,observed:[...observed],order,calls};}
  }
  const required=['state:null','state:array','state:missing','state:dictionary','state:applied-array','state:applied-id','event:null','event:array','event:missing','revision:fractional','revision:type',...[contract.id,contract.owner].flatMap(name=>[name+':empty',name+':type'])];
  return {testOk:order&&required.every(name=>observed.has(name)),observed:[...observed],missing:required.filter(name=>!observed.has(name)),order,calls};
}
export function orderedRecordRejectionEvidence({taskText,contextText,bindings,sourceEntries,testEntries}) {
  const contract=orderedRecordContract(taskText,contextText);if(!contract)return null;
  const results=bindings.map(binding=>{const profile=orderedRecordSource(contract,binding,sourceEntries);return {sourceOk:Boolean(profile),...orderedRecordTests(contract,profile,binding,testEntries)};});
  return {sourceOk:contract.supported&&results.length>0&&results.every(result=>result.sourceOk),testOk:contract.supported&&results.length>0&&results.every(result=>result.testOk),results};
}

// Only fresh local visitation maps and result arrays may be written. The
// recursive edge walk and both visitation states remain part of the proof.
function dependencyGraphSource(entries,binding) {
  try {
    const selected=entries.filter(entry=>entry.path===binding.sourcePath);
    if(entries.length!==1||selected.length!==1||selected[0].text.length>64000)return null;
    const ast=parse(selected[0].text,{sourceType:'module'}),exported=ast.program.body[0],fn=exported?.declaration;
    if(ast.program.body.length!==1||exported.type!=='ExportNamedDeclaration'||fn?.type!=='FunctionDeclaration'||fn.async||fn.generator
      ||fn.id.name.toLowerCase()!==binding.sourceName.toLowerCase()||fn.params.length!==1||fn.params[0].type!=='Identifier'||fn.body.body.length!==6)return null;
    const input=fn.params[0].name,[indexNode,stateNode,resultNode,visit,outer,returned]=fn.body.body;
    const index=orderedConst(indexNode),state=orderedConst(stateNode),result=orderedConst(resultNode);
    if(!index||!state||!result)return null;
    const indexName=index.id.name,stateName=state.id.name,resultName=result.id.name;
    const nativeMap=node=>node?.type==='NewExpression'&&orderedIdentifier(node.callee,'Map');
    if(!nativeMap(index.init)||index.init.arguments.length!==1||!nativeMap(state.init)||state.init.arguments.length!==0||result.init?.type!=='ArrayExpression'||result.init.elements.length)return null;
    const mapping=index.init.arguments[0],callback=mapping?.arguments?.[0];
    if(!orderedCall(mapping,`${input}.map`,[node=>node===callback])||callback?.type!=='ArrowFunctionExpression'||callback.async||callback.params.length!==1||callback.params[0].type!=='Identifier'
      ||callback.body.type!=='ArrayExpression'||callback.body.elements.length!==2)return null;
    const item=callback.params[0].name,[key,value]=callback.body.elements,keyField=key?.property?.name;
    const safeField=name=>typeof name==='string'&&/^[A-Za-z_$][\w$]*$/.test(name)&&!['constructor','prototype','__proto__'].includes(name);
    if(!safeField(keyField)||!orderedMember(key,item,keyField)||!orderedIdentifier(value,item))return null;
    if(visit.type!=='FunctionDeclaration'||visit.async||visit.generator||visit.params.length!==1||visit.params[0].type!=='Identifier'||visit.body.body.length!==6)return null;
    const visitName=visit.id.name,name=visit.params[0].name,[active,done,markActive,edges,markDone,append]=visit.body.body;
    const stateValue=(node,value)=>node?.type==='BinaryExpression'&&node.operator==='==='&&orderedCall(node.left,`${stateName}.get`,[arg=>orderedIdentifier(arg,name)])&&orderedNumber(node.right,value);
    const thrown=active.consequent?.type==='ThrowStatement'?active.consequent.argument:null;
    if(active.type!=='IfStatement'||active.alternate||!stateValue(active.test,1)||thrown?.type!=='NewExpression'||!orderedIdentifier(thrown.callee,'Error')||thrown.arguments.length!==1||thrown.arguments[0].type!=='StringLiteral')return null;
    if(done.type!=='IfStatement'||done.alternate||!stateValue(done.test,2)||done.consequent.type!=='ReturnStatement'||done.consequent.argument)return null;
    const setState=(node,value)=>node?.type==='ExpressionStatement'&&orderedCall(node.expression,`${stateName}.set`,[arg=>orderedIdentifier(arg,name),arg=>orderedNumber(arg,value)]);
    if(!setState(markActive,1)||!setState(markDone,2)||append.type!=='ExpressionStatement'||!orderedCall(append.expression,`${resultName}.push`,[arg=>orderedIdentifier(arg,name)]))return null;
    const iterator=node=>node?.type==='ForOfStatement'&&!node.await&&node.left.type==='VariableDeclaration'&&node.left.kind==='const'&&node.left.declarations.length===1&&node.left.declarations[0].id.type==='Identifier'&&!node.left.declarations[0].init?node.left.declarations[0].id.name:null;
    const dependency=iterator(edges),outerItem=iterator(outer),lookup=edges.right?.left,edgeField=lookup?.property?.name;
    if(!dependency||!outerItem||!safeField(edgeField)||edgeField===keyField||edges.right?.type!=='LogicalExpression'||edges.right.operator!=='??'||edges.right.right.type!=='ArrayExpression'||edges.right.right.elements.length
      ||lookup?.type!=='OptionalMemberExpression'||!lookup.optional||lookup.computed||!orderedCall(lookup.object,`${indexName}.get`,[arg=>orderedIdentifier(arg,name)]))return null;
    const guard=edges.body;
    if(guard.type!=='IfStatement'||guard.alternate||!orderedCall(guard.test,`${indexName}.has`,[arg=>orderedIdentifier(arg,dependency)])||guard.consequent.type!=='ExpressionStatement'
      ||!orderedCall(guard.consequent.expression,visitName,[arg=>orderedIdentifier(arg,dependency)]))return null;
    if(!orderedIdentifier(outer.right,input)||outer.body.type!=='ExpressionStatement'||!orderedCall(outer.body.expression,visitName,[arg=>orderedMember(arg,outerItem,keyField)])
      ||returned.type!=='ReturnStatement'||!orderedIdentifier(returned.argument,resultName))return null;
    const roles=[fn.id.name,input,indexName,stateName,resultName,visitName,name,dependency],native=new Set(['Map','Error','Array','Object','undefined']);
    if(new Set(roles).size!==roles.length||roles.some(role=>native.has(role))||[item,outerItem].some(role=>native.has(role)||roles.includes(role)))return null;
    orderedWalk(ast,(node,parent)=>{
      if(node.type==='Identifier'&&native.has(node.name)&&!(parent?.type==='NewExpression'&&parent.callee===node&&['Map','Error'].includes(node.name)))throw new Error('graph-native-binding');
      if(node.type==='Identifier'&&node.name===visitName&&!(parent===visit&&parent.id===node||parent?.type==='CallExpression'&&parent.callee===node))throw new Error('graph-recursion-alias');
    });
    return {sourceName:fn.id.name,keyField,edgeField,message:thrown.arguments[0].value};
  } catch {return null;}
}
function literalDependencyGraph(value,source) {
  if(value?.kind!=='array'||value.elements.length>32)return null;
  const byKey=new Map();
  for(const item of value.elements){
    const key=item?.fields?.get(source.keyField),edges=item?.fields?.get(source.edgeField);
    if(item?.kind!=='record'||key?.kind!=='primitive'||typeof key.value!=='string'||!key.value||byKey.has(key.value)
      ||edges!==undefined&&(edges.kind!=='array'||edges.elements.some(edge=>edge?.kind!=='primitive'||typeof edge.value!=='string')))return null;
    byKey.set(key.value,edges?.elements.map(edge=>edge.value)??[]);
  }
  const state=new Map(),order=[],stack=[];let direct=false,indirect=false;
  const visit=key=>{
    if(state.get(key)===1){if(stack.at(-1)===key)direct=true;else indirect=true;return;}
    if(state.get(key)===2)return;state.set(key,1);stack.push(key);
    for(const edge of byKey.get(key))if(byKey.has(edge))visit(edge);
    stack.pop();state.set(key,2);order.push(key);
  };
  for(const key of byKey.keys())visit(key);
  return {direct,indirect,order,hasEdge:[...byKey].some(([key,edges])=>edges.some(edge=>edge!==key&&byKey.has(edge)))};
}
function dependencyGraphTests(text,target,source) {
  const evidence={direct:false,indirect:false,mutableSuccess:false,snapshot:false};
  try {
    if(text.length>64000)return evidence;
    const ast=parse(text,{sourceType:'module'}),imports=ast.program.body.filter(node=>node.type==='ImportDeclaration');
    const local=module=>imports.filter(node=>node.source.value===module).flatMap(node=>node.specifiers.filter(item=>item.type==='ImportDefaultSpecifier').map(item=>item.local.name));
    const asserts=[...local('node:assert/strict'),...local('node:assert')],runners=local('node:test');
    if(imports.length!==3||asserts.length!==1||runners.length!==1)return evidence;
    const assertName=asserts[0],testName=runners[0],imported=imports.find(node=>!node.source.value.startsWith('node:'));
    if(imported?.specifiers.length!==1||imported.specifiers[0].type!=='ImportSpecifier'||imported.specifiers[0].imported.name!==source.sourceName||imported.specifiers[0].local.name.toLowerCase()!==target.toLowerCase())return evidence;
    target=imported.specifiers[0].local.name;
    const protectedNames=new Set([assertName,testName,target,'Error','Object','Set','structuredClone']);
    orderedWalk(ast,(node,parent)=>{
      if(parent?.type==='ImportSpecifier'||parent?.type==='ImportDefaultSpecifier')return;
      if(['AssignmentExpression','UpdateExpression','AwaitExpression','ThisExpression','NewExpression'].includes(node.type)&&!(node.type==='NewExpression'&&orderedIdentifier(node.callee,'Set')&&node.arguments.length===1&&node.arguments[0].type==='Identifier'))throw new Error('graph-test-effect');
      if(node.type==='UnaryExpression'&&node.operator==='delete'||node.type==='MemberExpression'&&(node.computed||['constructor','prototype','__proto__'].includes(node.property.name)))throw new Error('graph-test-reflection');
      if(node.type==='Identifier'&&['global','globalThis','process','Reflect','Proxy','Function','eval','Symbol','Array','Map'].includes(node.name))throw new Error('graph-test-global');
      if(node.type==='Identifier'&&protectedNames.has(node.name)){
        const allowed=parent?.type==='CallExpression'&&parent.callee===node&&[target,testName,'structuredClone'].includes(node.name)
          ||parent?.type==='MemberExpression'&&parent.object===node&&(node.name===assertName||node.name==='Object'&&parent.property.name==='freeze')
          ||node.name==='Error'&&parent?.type==='BinaryExpression'&&parent.operator==='instanceof'&&parent.right===node
          ||node.name==='Set'&&parent?.type==='NewExpression'&&parent.callee===node;
        if(!allowed)throw new Error('graph-test-binding');
      }
      if(node.type==='CallExpression'&&![target,testName,'structuredClone','Object.freeze',...['throws','deepEqual','deepStrictEqual','equal','strictEqual'].map(method=>`${assertName}.${method}`)].includes(memberName(node.callee))
        &&!(node.callee.type==='MemberExpression'&&!node.callee.computed&&node.callee.property.name==='includes'&&node.callee.object.type==='MemberExpression'&&node.callee.object.property.name==='message'))throw new Error('graph-test-call');
    });
    let expansion=0;
    const facts=(node,values)=>{
      if(orderedCall(node,'Object.freeze',[arg=>Boolean(arg)])){const value=facts(node.arguments[0],values);if(value)value.frozen=true;return value??null;}
      if(node?.type==='ArrayExpression'){const elements=node.elements.map(item=>facts(item,values));return elements.every(Boolean)?{kind:'array',elements}:null;}
      if(node?.type==='ObjectExpression'){
        const fields=new Map();for(const property of node.properties){if(property.type!=='ObjectProperty'||property.computed||property.method||!['Identifier','StringLiteral'].includes(property.key.type))return null;
          const key=property.key.name??property.key.value,value=facts(property.value,values);if(!value||fields.has(key)||['constructor','prototype','__proto__'].includes(key))return null;fields.set(key,value);}
        return {kind:'record',fields};
      }
      return flatRecordValue(node,values,new Map(),Infinity,0,true);
    };
    const mutable=value=>value?.kind==='array'&&!value.frozen&&value.elements.every(item=>!item.frozen&&(!item.fields.get(source.edgeField)||!item.fields.get(source.edgeField).frozen));
    const actual=node=>node?.type==='CallExpression'&&orderedIdentifier(node.callee,target)&&node.arguments.length===1&&node.arguments[0].type!=='SpreadElement';
    const expectedMessage=callback=>{
      if(callback?.type!=='ArrowFunctionExpression'||callback.async||callback.params.length!==1||callback.params[0].type!=='Identifier')return null;
      const name=callback.params[0].name,body=callback.body;
      return !protectedNames.has(name)&&body.type==='LogicalExpression'&&body.operator==='&&'&&body.left.type==='BinaryExpression'&&body.left.operator==='instanceof'&&orderedIdentifier(body.left.left,name)&&orderedIdentifier(body.left.right,'Error')
        &&orderedCall(body.right,`${name}.message.includes`,[arg=>arg.type==='StringLiteral'])?body.right.arguments[0].value:null;
    };
    const read=(nodes,values=new Map(),depth=0)=>{
      if(depth>2)throw new Error('graph-test-depth');const snapshots=new Map(),results=new Map(),called=new Set();
      const observe=call=>{if(!actual(call))return null;const value=facts(call.arguments[0],values),graph=literalDependencyGraph(value,source);if(!graph)return null;
        if(call.arguments[0].type==='Identifier')called.add(call.arguments[0].name);return {graph,mutable:mutable(value)};};
      const order=(observation,expected)=>{
        if(!observation||observation.graph.direct||observation.graph.indirect||expected?.kind!=='array')return;
        if(observation.mutable&&observation.graph.hasEdge&&expected.elements.length===observation.graph.order.length&&expected.elements.every((value,index)=>value.kind==='primitive'&&value.value===observation.graph.order[index]))evidence.mutableSuccess=true;
      };
      for(const statement of nodes){
        if(++expansion>512)throw new Error('graph-test-budget');
        if(statement.type==='VariableDeclaration'&&statement.kind==='const'){
          for(const declaration of statement.declarations){
            if(declaration.id.type!=='Identifier'||protectedNames.has(declaration.id.name)||values.has(declaration.id.name)||snapshots.has(declaration.id.name)||results.has(declaration.id.name))throw new Error('graph-test-local');
            const name=declaration.id.name,value=facts(declaration.init,values);if(declaration.init?.type==='Identifier')return;if(value){values.set(name,value);continue;}
            if(orderedCall(declaration.init,'structuredClone',[arg=>arg.type==='Identifier'&&values.has(arg.name)])){if(called.has(declaration.init.arguments[0].name))return;snapshots.set(name,declaration.init.arguments[0].name);continue;}
            const observed=observe(declaration.init);if(observed){results.set(name,observed);continue;}
            return;
          }
          continue;
        }
        if(statement.type==='ForOfStatement'&&!statement.await&&statement.left.type==='VariableDeclaration'&&statement.left.kind==='const'&&statement.left.declarations.length===1&&statement.left.declarations[0].id.type==='Identifier'){
          const name=statement.left.declarations[0].id.name,rows=facts(statement.right,values);
          if(protectedNames.has(name)||values.has(name)||rows?.kind!=='array'||rows.elements.length>32)return;
          for(const row of rows.elements)read(statement.body.type==='BlockStatement'?statement.body.body:[statement.body],new Map([...values,[name,row]]),depth+1);continue;
        }
        const call=statement.type==='ExpressionStatement'?statement.expression:null;
        if(call?.type!=='CallExpression')return;
        if(memberName(call.callee)===`${assertName}.throws`&&call.arguments.length===2){
          const callback=call.arguments[0],message=expectedMessage(call.arguments[1]);
          if(callback?.type!=='ArrowFunctionExpression'||callback.async||callback.params.length||!message||!source.message.includes(message))return;
          const observed=observe(callback.body);if(!observed)return;
          if(message.includes('cycle')){evidence.direct ||= observed.graph.direct;evidence.indirect ||= observed.graph.indirect;}
          continue;
        }
        if([`${assertName}.deepEqual`,`${assertName}.deepStrictEqual`].includes(memberName(call.callee))&&call.arguments.length===2){
          const [left,right]=call.arguments;
          if(left.type==='Identifier'&&right.type==='Identifier'&&snapshots.get(right.name)===left.name&&called.has(left.name)&&mutable(values.get(left.name)))evidence.snapshot=true;
          order(left.type==='Identifier'?results.get(left.name):observe(left),facts(right,values));continue;
        }
        if([`${assertName}.equal`,`${assertName}.strictEqual`].includes(memberName(call.callee))&&call.arguments.length===2)continue;
        return;
      }
    };
    for(const statement of ast.program.body){
      if(statement.type==='ImportDeclaration')continue;
      const call=statement.type==='ExpressionStatement'?statement.expression:null,callback=call?.arguments?.[1];
      if(!orderedCall(call,testName,[node=>node.type==='StringLiteral',node=>node===callback])||callback?.type!=='ArrowFunctionExpression'||callback.async||callback.params.length||callback.body.type!=='BlockStatement')throw new Error('graph-test-registration');
      read(callback.body.body);
    }
    return evidence;
  } catch {return {direct:false,indirect:false,mutableSuccess:false,snapshot:false};}
}
export function dependencyCycleEvidence({taskText,bindings,sourceEntries,testEntries}) {
  const clause=String(taskText??'').replace(/\s+/g,' ').trim();
  if(!/\bcycle\b/i.test(clause)||!/^Throw an? `?Error`? containing/i.test(clause))return null;
  const supported=/^Throw an `Error` containing `cycle` when an in-repository cycle exists[.;]?$/i.test(clause);
  const results=bindings.map(binding=>{
    const source=supported&&dependencyGraphSource(sourceEntries,binding),links=binding.testBindings??[{testPath:binding.testPath,testName:binding.testName}];
    const evidence=source?links.map(link=>{const entry=testEntries.find(entry=>entry.path===link.testPath);return entry?dependencyGraphTests(entry.text,link.testName,source):{};}):[];
    return {sourceOk:Boolean(source&&source.message.includes('cycle')),testOk:evidence.some(item=>item.direct&&item.indirect),evidence,links};
  });
  return {sourceOk:supported&&results.length>0&&results.every(item=>item.sourceOk),testOk:supported&&results.length>0&&results.every(item=>item.testOk),results};
}
export function dependencyGraphNonMutationEvidence({rawCriterion,profiles,sourceEntries}) {
  if(!/^Do not mutate input[.;]?$/i.test(String(rawCriterion).replace(/\s+/g,' ').trim()))return false;
  return profiles.some(profile=>(profile.bindings??[]).some(binding=>{const source=dependencyGraphSource(sourceEntries,binding);if(!source)return false;
    const evidence=dependencyGraphTests(profile.raw,binding.testName,source);return evidence.mutableSuccess&&evidence.snapshot;}));
}

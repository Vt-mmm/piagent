import { parse } from "@babel/parser";
import { testProofIntrinsicsAreStable, literalArrayIterationEnvironmentIsStable } from "./acceptance-executable-evidence.js";
import { integerTestInputsStable } from "./acceptance-integer-domains.js";
import { flatRecordFactories, flatRecordValue } from "./acceptance-literal-dataflow.js";
import { closedNumericValidationFunctions, closedLiteralError } from "./acceptance-parameter-contract.js";
function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

export function explicitUndefinedTemporalContract(text) {
  const value = normalizedText(text);
  const explicitValue = /\bexplicit(?:ly)?\s+(?:(?:supplied|provided|passed)\s+){0,2}(?:falsey|falsy|undefined|value)\b|\b(?:falsey|falsy)\s+value\b/.test(value);
  const omissionContrast = /\b(?:omit(?:ted|ting|s)?|absent|not\s+(?:provided|supplied|passed))\b[^.\n;]{0,180}\bexplicit(?:ly)?\s+(?:(?:supplied|provided|passed)\s+){0,2}(?:falsey|falsy|undefined|value)\b/.test(value);
  const clockReference = /\b(?:machine(?:'s)?|system|current)\s+(?:clock|time)\b|\bdate\.now\b/.test(value);
  return explicitValue && (clockReference || omissionContrast);
}

function requirements(text) {
  const value = normalizedText(text);
  const rejectionIntent = /\b(?:invalid|malformed|unsupported)\b[^.\n;]{0,180}\b(?:throw|reject)/.test(value)
    || /\b(?:throw|reject(?:s|ed|ing)?)\b[^.\n;]{0,180}\b(?:invalid|malformed|unsupported|anything|everything|all\s+other|else)\b/.test(value)
    || /\b(?:must|shall|should)\s+throw\s+(?:an?\s+)?(?:typeerror|rangeerror|syntaxerror|error)\b/.test(value);
  const strictIsoDate = /\biso(?:[-\s]+8601)?(?:[-\s]+timestamp)?(?:[-\s]+strings?)?\b/.test(value)
    && rejectionIntent;
  const explicitUndefinedTime = explicitUndefinedTemporalContract(value)
    && /\b(?:millisecond\s+)?number\s+or\s+(?:a\s+)?`?date`?\s+for\s+`?[a-z_$][a-z0-9_$]*`?\b/.test(value)
    && rejectionIntent;
  return { strictIsoDate, explicitUndefinedTime };
}

function signatureArguments(text, target) {
  const escaped = escapeRegex(target);
  for (const match of String(text ?? "").matchAll(new RegExp(`\`${escaped}\\s*\\(([^\`]*)\\)\``, "gi"))) {
    const parameters = match[1].split(",").map((item) => item.trim().match(/^([a-z_$][a-z0-9_$]*)/i)?.[1]?.toLowerCase()).filter(Boolean);
    if (parameters.length > 0) return parameters;
  }
  return [];
}

function contractArguments(binding, parameters, taskText) {
  const declared = signatureArguments(taskText, binding.target ?? binding.sourceName);
  if (declared.length === parameters.length && declared.every((name, index) => name === parameters[index])) return declared;
  return parameters;
}

function strictIsoArgumentIndices(taskText, binding, parameters) {
  const names = contractArguments(binding, parameters, taskText);
  const indices = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = escapeRegex(names[index]);
    if (new RegExp(`\\biso\\b[^,.\\n;]{0,180}\\bfor\\s+\`?${name}\`?\\b`, "i").test(taskText)) indices.push(index);
  }
  if (indices.length > 0) return [...new Set(indices)];
  if (names.length === 1) return [0];
  if (/\b(?:both|each|all)\s+(?:task-bound\s+)?(?:arguments?|parameters?|inputs?)\b[^.\n;]{0,120}\biso\b|\biso\b[^.\n;]{0,120}\b(?:both|each|all)\s+(?:task-bound\s+)?(?:arguments?|parameters?|inputs?)\b/i.test(taskText)) {
    return names.map((_, index) => index);
  }
  const semantic = names.map((name, index) => /(?:expir|timestamp|deadline|validuntil|validto)/i.test(name) ? index : -1).filter((index) => index >= 0);
  if (semantic.length > 1 && !/\b(?:both|each|all)\b[^.\n;]{0,120}\biso\b|\biso\b[^.\n;]{0,120}\b(?:both|each|all)\b/i.test(taskText)) return [semantic[0]];
  return semantic;
}

function explicitTimeArgumentIndex(taskText, binding, parameters, isoIndices) {
  const names = contractArguments(binding, parameters, taskText);
  const exact = names.findIndex((name) => /^(?:now|currenttime|currenttimestamp)$/i.test(name));
  if (exact >= 0) return exact;
  for (let index = 0; index < names.length; index += 1) {
    const name = escapeRegex(names[index]);
    if (new RegExp(`\\b(?:millisecond\\s+)?number\\s+or\\s+(?:a\\s+)?\`?date\`?\\s+for\\s+\`?${name}\`?\\b`, "i").test(taskText)) return index;
  }
  const current = names.findIndex((name) => /current|clock/i.test(name));
  if (current >= 0) return current;
  return names.length === 2 && isoIndices.length === 1 ? (isoIndices[0] === 0 ? 1 : 0) : -1;
}

function testPartitions(requirement, index) {
  return new Set(requirement?.invalidArgumentPartitions?.find((item) => item.index === index)?.partitions ?? []);
}

/** Derive per-parameter temporal proof from operator prose, independently of model-authored tests. */
export function temporalContractEvidence(input = {}) {
  const contract = requirements(input.taskText);
  if (!contract.strictIsoDate && !contract.explicitUndefinedTime) return { active: false, testOk: true, bindings: [] };
  if (!Array.isArray(input.bindings) || input.bindings.length === 0) return { active: true, testOk: false, bindings: [] };
  let testOk = true;
  const derivedBindings = input.bindings.map((binding) => {
    const callable = (input.bodyMaps?.get(binding.sourcePath) ?? new Map()).get(binding.sourceName);
    const parameters = callable?.parameters ?? [];
    const observed = (input.testRequirements ?? []).find((item) => item.sourcePath === binding.sourcePath && item.sourceName === binding.sourceName);
    const byIndex = new Map();
    const add = (index, partitions) => {
      if (index < 0 || !parameters[index]) { testOk = false; return; }
      const current = byIndex.get(index) ?? new Set();
      partitions.forEach((partition) => current.add(partition));
      byIndex.set(index, current);
      const covered = testPartitions(observed, index);
      if (!partitions.every((partition) => covered.has(partition))) testOk = false;
    };
    const isoIndices = contract.strictIsoDate ? strictIsoArgumentIndices(input.taskText, binding, parameters) : [];
    if (contract.strictIsoDate && isoIndices.length === 0) testOk = false;
    for (const isoIndex of isoIndices) add(isoIndex, ["invalid-date-string", "invalid-calendar-date-string", "invalid-date-object"]);
    if (contract.explicitUndefinedTime) add(explicitTimeArgumentIndex(input.taskText, binding, parameters, isoIndices), ["missing"]);
    return {
      sourcePath: binding.sourcePath,
      sourceName: binding.sourceName,
      inputs: [...byIndex.entries()].map(([index, partitions]) => ({ name: parameters[index], partitions: [...partitions].sort() }))
    };
  });
  return { active: true, testOk, bindings: derivedBindings };
}

export function temporalInputRequirements(input = {}) {
  const { binding, observed, parameters = [], requestedPartitions = [], temporalBindings = [] } = input;
  const observedInputs = !observed ? [] : observed.invalidArgumentIndices.map((index) => ({
    name: parameters[index],
    partitions: (observed.invalidArgumentPartitions?.find((item) => item.index === index)?.partitions ?? [])
      .filter((partition) => requestedPartitions.length === 0 || requestedPartitions.includes(partition))
  })).filter((item) => item.name);
  const derivedInputs = temporalBindings
    .find((item) => item.sourcePath === binding.sourcePath && item.sourceName === binding.sourceName)?.inputs ?? [];
  const merged = new Map();
  for (const item of [...observedInputs, ...derivedInputs]) {
    const partitions = merged.get(item.name) ?? new Set();
    item.partitions.forEach((partition) => partitions.add(partition));
    merged.set(item.name, partitions);
  }
  return merged.size === 0 ? null
    : [...merged.entries()].map(([name, partitions]) => ({ name, partitions: [...partitions] }));
}

/** Keep only adjacent temporal criteria needed to interpret an invalid-date obligation. */
export function relatedTemporalCriteria(selected, criteria, excluded = new Set()) {
  if (!/\b(?:dates?|timestamps?|expiry|expires?)\b/i.test(String(selected ?? ""))
    && !/\b(?:argument|parameter)\b[^.\n]{0,120}\bundefined\b[^.\n]{0,120}\bclock\b/i.test(String(selected ?? ""))) return [];
  return uniqueStrings(Array.isArray(criteria) ? criteria : []).filter((item) => (
    item !== selected
    && !excluded.has(item)
    && (/\b(?:dates?|timestamps?|expiry|expires?|now|falsey|falsy|undefined)\b/i.test(item)
      || explicitUndefinedTemporalContract(item))
  ));
}

export function contextualTemporalCriterion(identifierContext, selected, task, excluded = new Set()) {
  const context = [task?.summary, task?.expectedOutput, ...(task?.acceptanceCriteria ?? [])];
  return [identifierContext, ...relatedTemporalCriteria(selected, context, excluded)].join("\n");
}

// This clause needs adjacent task context: a generic null/object rejection
// does not establish the declared timestamp fields or interval relations.
export function finiteIntervalRecordContract(selected, contextText) {
  const text = String(contextText ?? "").replace(/\s+/g, " ");
  if (!/\bAll timestamps and the skew must be finite integers\b/i.test(text)
    || !/\bmalformed\s+values\s+throw\b/i.test(String(selected))) return null;
  const result = { supported: false };
  if (text.length > 16_000 || !/^malformed values throw `?(TypeError|RangeError|Error)`?[.;]?$/i.test(String(selected).trim())) return result;
  const signatures = [...text.matchAll(/`([A-Za-z_$][\w$]*)\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)`/g)];
  const intervals = [...text.matchAll(/`([A-Za-z_$][\w$]*)\s*<=\s*([A-Za-z_$][\w$]*)\s*<\s*([A-Za-z_$][\w$]*)`/g)];
  const clocks = [...text.matchAll(/`([A-Za-z_$][\w$]*)` is earlier than `([A-Za-z_$][\w$]*)` by more than `([A-Za-z_$][\w$]*)`/g)];
  const unique = matches => [...new Set(matches.map(match => JSON.stringify(match.slice(1))))].map(value => JSON.parse(value));
  const signature = unique(signatures), interval = unique(intervals), clock = unique(clocks);
  if (signature.length !== 1 || interval.length !== 1 || clock.length !== 1) return result;
  const [target, first, second] = signature[0], [start, occurred, end] = interval[0], [received, clockOccurred, skew] = clock[0];
  const fields = [start, occurred, end, received, skew];
  if (first === second || new Set(fields).size !== 5 || occurred !== clockOccurred
    || !/\bthe skew must be non-negative\b/i.test(text)
    || !text.includes(`\`${start} < ${end}\``) || !text.includes(`\`${end} + ${skew}\``)) return result;
  return { supported: true, target, parameters: [first, second], fields, start, occurred, end, received, skew,
    errorClass: String(selected).match(/\b(TypeError|RangeError|Error)\b/i)[1] };
}

const intervalMember = node => node?.type === "MemberExpression" && !node.computed
  && node.object.type === "Identifier" && node.property.type === "Identifier" ? `${node.object.name}.${node.property.name}` : null;
const intervalSameMember = (node, name) => intervalMember(node) === name;
const intervalDisjunction = node => node?.type === "LogicalExpression" && node.operator === "||"
  ? [...intervalDisjunction(node.left), ...intervalDisjunction(node.right)] : [node];
function intervalObjectTerms(terms, parameter) {
  const [missing, shape] = terms;
  return missing?.type === "UnaryExpression" && missing.operator === "!" && missing.argument.type === "Identifier" && missing.argument.name === parameter
    && shape?.type === "BinaryExpression" && shape.operator === "!==" && shape.left.type === "UnaryExpression" && shape.left.operator === "typeof"
    && shape.left.argument.type === "Identifier" && shape.left.argument.name === parameter && shape.right.type === "StringLiteral" && shape.right.value === "object";
}
function intervalIntegerPredicate(functions, name) {
  const fn = functions.get(name);
  if (!fn || fn.async || fn.generator || fn.params.length !== 1 || fn.params[0].type !== "Identifier" || fn.body.body.length !== 1
    || fn.body.body[0].type !== "ReturnStatement") return false;
  const expression = fn.body.body[0].argument;
  const exact = (node, member) => node?.type === "CallExpression" && intervalMember(node.callee) === member
    && node.arguments.length === 1 && node.arguments[0].type === "Identifier" && node.arguments[0].name === fn.params[0].name;
  return exact(expression, "Number.isInteger") || expression?.type === "LogicalExpression" && expression.operator === "&&"
    && ((exact(expression.left, "Number.isFinite") && exact(expression.right, "Number.isInteger"))
      || (exact(expression.right, "Number.isFinite") && exact(expression.left, "Number.isInteger")));
}

/** Establish the dominant typed guard for every declared field, independently
 * of which malformed examples the model chose to test. No test can supply a
 * missing source field, predicate, relation or error-class obligation. */
export function finiteIntervalRecordSource({ contract, binding, sourceEntries }) {
  const unproved = reason => ({ sourceOk: false, reason });
  if (!contract?.supported) return unproved("finite-interval-context-unresolved");
  if (String(binding?.sourceName).toLowerCase() !== contract.target.toLowerCase()) return unproved("finite-interval-target-mismatch");
  try {
    const functions = closedNumericValidationFunctions(sourceEntries, binding.sourcePath);
    const fn = functions.get(contract.target);
    if (!fn || fn.params.length !== 2 || fn.params.some((node,index)=>node.type !== "Identifier" || node.name !== contract.parameters[index])) return unproved("finite-interval-signature-mismatch");
    const guard = fn.body.body[0], parts = intervalDisjunction(guard?.test);
    if (guard?.type !== "IfStatement" || guard.alternate || parts.length !== 7 || !closedLiteralError(guard.consequent, contract.errorClass)
      || !intervalObjectTerms(parts.slice(0,2),contract.parameters[0]) || !intervalObjectTerms(parts.slice(2,4),contract.parameters[1])) return unproved("finite-interval-dominant-guard-unproved");
    const negative = parts[4], every = negative?.argument;
    if (negative?.type !== "UnaryExpression" || negative.operator !== "!" || every?.type !== "CallExpression" || every.arguments.length !== 1
      || every.callee.type !== "MemberExpression" || every.callee.computed || every.callee.property.name !== "every"
      || every.callee.object.type !== "ArrayExpression" || every.callee.object.elements.length !== contract.fields.length
      || every.arguments[0].type !== "Identifier" || !intervalIntegerPredicate(functions,every.arguments[0].name)) return unproved("finite-interval-integer-predicate-unproved");
    const fields = new Map();
    for (const node of every.callee.object.elements) {
      const member = intervalMember(node), name = node?.property?.name, index = contract.parameters.indexOf(node?.object?.name);
      if (!member || index < 0 || !contract.fields.includes(name) || fields.has(name)) return unproved("finite-interval-field-binding-unproved");
      fields.set(name,{name,parameterIndex:index,member});
    }
    let memberBindingsStable = true;
    const inspectMembers = node => {
      if (!node || typeof node.type !== "string") return;
      if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)) {
        const name = node.computed ? node.property.value : node.property.name;
        if (fields.has(name) && intervalMember(node) !== fields.get(name).member) memberBindingsStable = false;
      }
      for (const [key,value] of Object.entries(node)) {
        if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(inspectMembers); else if (value && typeof value === "object") inspectMembers(value);
      }
    };
    inspectMembers(fn.body);
    if (!memberBindingsStable) return unproved("finite-interval-field-receiver-mismatch");
    const sign = parts[5], order = parts[6];
    if (sign?.type !== "BinaryExpression" || sign.operator !== "<" || !intervalSameMember(sign.left,fields.get(contract.skew)?.member)
      || sign.right.type !== "NumericLiteral" || sign.right.value !== 0 || order?.type !== "BinaryExpression" || order.operator !== ">="
      || !intervalSameMember(order.left,fields.get(contract.start)?.member) || !intervalSameMember(order.right,fields.get(contract.end)?.member)) return unproved("finite-interval-relations-unproved");
    return {sourceOk:true, fields:[...fields.values()], signature:contract.parameters, errorClass:contract.errorClass};
  } catch { return unproved("finite-interval-source-environment-unproved"); }
}

function intervalTestProgram(entry, names, errorClass) {
  if (!entry.code || !testProofIntrinsicsAreStable(entry.code) || !literalArrayIterationEnvironmentIsStable(entry.code)
    || !integerTestInputsStable(entry.text)) return null;
  try {
    const ast = parse(entry.text,{sourceType:"module",errorRecovery:false}), factories = flatRecordFactories(ast);
    const imports = ast.program.body.filter(node=>node.type === "ImportDeclaration");
    const imported = module => imports.filter(node=>node.source.value === module).flatMap(node=>node.specifiers.filter(item=>item.type === "ImportDefaultSpecifier").map(item=>item.local.name));
    const asserts = [...imported("node:assert/strict"),...imported("node:assert")], runners = imported("node:test");
    if (asserts.length !== 1 || runners.length !== 1 || [...factories.values()].some(value=>!value)) return null;
    const [assertName] = asserts, [testName] = runners, targets = new Set(names.map(name=>name.toLowerCase()));
    if (imports.length !== 3 || imports.some(node=>!["node:assert/strict","node:assert","node:test"].includes(node.source.value)
      && (node.specifiers.length !== 1 || node.specifiers[0].type !== "ImportSpecifier" || !targets.has(node.specifiers[0].local.name.toLowerCase())))) return null;
    const protectedNames = new Set([...factories.keys(),assertName,testName,errorClass,"structuredClone",...names].map(name=>name.toLowerCase()));
    let count = 0, stable = true;
    const inspect = (node,parent,grandparent,depth=0) => {
      if (!node || typeof node.type !== "string" || node.type === "ImportDeclaration") return;
      if (++count > 12_000 || depth > 128) throw new Error("finite-interval-test-budget");
      if (node.type === "MemberExpression" && (node.computed || ["constructor","prototype","__proto__"].includes(node.property.name))) stable = false;
      if (node.type === "Identifier" && node.name === "structuredClone" && !(parent?.type === "CallExpression" && parent.callee === node)) stable = false;
      if (node.type === "CallExpression" && !(node.callee.type === "Identifier" && (targets.has(node.callee.name.toLowerCase()) || factories.has(node.callee.name)
        || [testName,"structuredClone"].includes(node.callee.name))) && !(node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object.name === assertName)) stable = false;
      if (["AssignmentExpression","UpdateExpression"].includes(node.type) || node.type === "Identifier"
        && ["globalThis","global","process","Reflect","Proxy","Function","eval","Symbol"].includes(node.name)) stable = false;
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && protectedNames.has(node.id.name.toLowerCase())
        && factories.get(node.id.name)?.declaration !== node) stable = false;
      if (/Function/.test(node.type) && node.params?.some(param=>protectedNames.has(String(param.name ?? param.left?.name).toLowerCase()))) stable = false;
      if (node.type === "Identifier" && factories.has(node.name) && !(parent?.type === "VariableDeclarator" && parent.id === node)
        && !(parent?.type === "CallExpression" && parent.callee === node)) stable = false;
      if (node.type === "Identifier" && node.name === "Array" && !(parent?.type === "MemberExpression" && parent.object === node
        && !parent.computed && grandparent?.type === "CallExpression" && grandparent.callee === parent)) stable = false;
      for (const [key,value] of Object.entries(node)) {
        if (["loc","extra","comments","tokens","errors"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item=>inspect(item,node,parent,depth+1)); else if (value && typeof value === "object") inspect(value,node,parent,depth+1);
      }
    };
    inspect(ast); if (!stable) return null;
    const registrations = [];
    for (const statement of ast.program.body) {
      if (statement.type === "ImportDeclaration") continue;
      if (statement.type === "VariableDeclaration" && statement.kind === "const" && statement.declarations.every(node=>factories.get(node.id.name)?.declaration === node)) continue;
      const call = statement.type === "ExpressionStatement" ? statement.expression : null;
      if (call?.type !== "CallExpression" || call.callee.type !== "Identifier" || call.callee.name !== testName || call.arguments.length !== 2
        || call.arguments[0].type !== "StringLiteral" || call.arguments[1].type !== "ArrowFunctionExpression" || call.arguments[1].async
        || call.arguments[1].params.length !== 0 || call.arguments[1].body.type !== "BlockStatement") return null;
      registrations.push(call);
    }
    return {factories,assertName,testName,targets,protectedNames,registrations};
  } catch { return null; }
}

function intervalTestCalls(entry, names, errorClass, expectedLiteral) {
  const program = intervalTestProgram(entry,names,errorClass);
  if (!program) return [];
  const {factories,assertName,testName,targets,protectedNames,registrations} = program;
  try {
    const calls = []; let expanded = 0;
    const assertionCall = statement => {
      const call = statement?.type === "ExpressionStatement" ? statement.expression : null;
      if (call?.type !== "CallExpression" || call.arguments.length !== 2) return null;
      let invocation, wanted = true;
      if (expectedLiteral !== undefined) {
        if (![`${assertName}.equal`, `${assertName}.strictEqual`].includes(intervalMember(call.callee)) || call.arguments[1].type !== "StringLiteral") return null;
        invocation = call.arguments[0]; wanted = call.arguments[1].value === expectedLiteral;
      } else {
        if (intervalMember(call.callee) !== `${assertName}.throws` || call.arguments[1].type !== "Identifier" || call.arguments[1].name !== errorClass) return null;
        const callback = call.arguments[0];
        if (callback?.type !== "ArrowFunctionExpression" || callback.async || callback.params.length !== 0) return null;
        invocation = callback.body;
      }
      if (invocation?.type !== "CallExpression" || invocation.callee.type !== "Identifier" || !targets.has(invocation.callee.name.toLowerCase())
        || invocation.arguments.length !== 2 || invocation.arguments.some(node=>node.type === "SpreadElement")) return null;
      return {invocation,wanted};
    };
    const loopShape = (statement,depth=0) => {
      if (depth > 2) return false;
      if (assertionCall(statement)) return true;
      if (statement?.type === "IfStatement" && !statement.alternate && statement.test.type === "BinaryExpression" && ["===","!=="].includes(statement.test.operator)) return Boolean(assertionCall(statement.consequent));
      if (statement?.type === "BlockStatement") return statement.body.length > 0 && statement.body.every(node=>loopShape(node,depth));
      return statement?.type === "ForOfStatement" && !statement.await && statement.left.type === "VariableDeclaration" && statement.left.kind === "const"
        && statement.left.declarations.length === 1 && statement.left.declarations[0].id.type === "Identifier"
        && !protectedNames.has(statement.left.declarations[0].id.name.toLowerCase()) && statement.right.type === "ArrayExpression"
        && statement.right.elements.length > 0 && statement.right.elements.length <= 32 && loopShape(statement.body,depth+1);
    };
    const collect = (statement,bindings,before) => {
      if (++expanded > 512) throw new Error("finite-interval-witness-budget");
      const call = assertionCall(statement);
      if (call) {
        const args = call.invocation.arguments.map(node=>flatRecordValue(node,bindings,factories,before));
        if (call.wanted && args.every(Boolean)) calls.push(args); return;
      }
      if (statement.type === "BlockStatement") { statement.body.forEach(node=>collect(node,bindings,before)); return; }
      if (statement.type === "IfStatement") {
        const left = flatRecordValue(statement.test.left,bindings,factories,before), right = flatRecordValue(statement.test.right,bindings,factories,before);
        if (left?.kind !== "primitive" || right?.kind !== "primitive") return;
        if ((left.value === right.value) === (statement.test.operator === "===")) collect(statement.consequent,bindings,before);
        return;
      }
      const name = statement.left.declarations[0].id.name;
      if (bindings.has(name)) return;
      const values = statement.right.elements.map(node=>flatRecordValue(node,bindings,factories,before));
      if (!values.every(Boolean)) return;
      for (const value of values) collect(statement.body,new Map([...bindings,[name,value]]),before);
    };
    for (const call of registrations) for (const item of call.arguments[1].body.body) {
      if (!loopShape(item)) break; collect(item,new Map(),call.start);
    }
    return calls;
  } catch { return []; }
}

export function finiteIntervalRecordTests({contract,profile,binding,testEntries}) {
  if (!contract?.supported || !profile?.sourceOk) return {testOk:false,reason:"finite-interval-source-binding-required"};
  const observed = new Set(), paths = binding.testBindings ?? [{testPath:binding.testPath,testName:binding.testName}];
  const calls = testEntries.flatMap(entry=>intervalTestCalls(entry,paths.filter(item=>item.testPath === entry.path).map(item=>item.testName),contract.errorClass));
  const fieldValue = (args,name) => { const field=profile.fields.find(item=>item.name === name); return args[field.parameterIndex]?.fields?.get(name); };
  const integer = fact => fact?.kind === "primitive" && typeof fact.value === "number" && Number.isFinite(fact.value) && Number.isInteger(fact.value);
  const checkOthers = (args,exceptField,exceptIndex) => profile.fields.every(field=>field.name === exceptField || field.parameterIndex === exceptIndex || integer(fieldValue(args,field.name)));
  const relations = (args,except) => (except === "skew" || fieldValue(args,contract.skew).value >= 0)
    && (except === "order" || fieldValue(args,contract.start).value < fieldValue(args,contract.end).value);
  for (const args of calls) {
    for (const field of profile.fields) {
      const value=fieldValue(args,field.name);
      if (args.every(arg=>arg.kind === "record") && value?.kind === "primitive" && (value.value === undefined || typeof value.value === "number" && Number.isNaN(value.value))
        && checkOthers(args,field.name,-1) && (field.name === contract.skew || fieldValue(args,contract.skew).value >= 0)
        && ([contract.start,contract.end].includes(field.name) || fieldValue(args,contract.start).value < fieldValue(args,contract.end).value)) observed.add(`field:${field.name}`);
    }
    if (args.every(arg=>arg.kind === "record") && checkOthers(args,null,-1)) {
      if (fieldValue(args,contract.skew).value < 0 && relations(args,"skew")) observed.add("negative-skew");
      if (relations(args,"order") && fieldValue(args,contract.start).value === fieldValue(args,contract.end).value) observed.add("equal-period");
      if (relations(args,"order") && fieldValue(args,contract.start).value > fieldValue(args,contract.end).value) observed.add("reversed-period");
    }
    for (const index of [0,1]) if (args[index].kind === "primitive" && (args[index].value === null || args[index].value === undefined)
      && args[1-index].kind === "record" && checkOthers(args,null,index)
      && (profile.fields.find(field=>field.name === contract.skew).parameterIndex === index || fieldValue(args,contract.skew).value >= 0)
      && ([contract.start,contract.end].some(name=>profile.fields.find(field=>field.name === name).parameterIndex === index)
        || fieldValue(args,contract.start).value < fieldValue(args,contract.end).value)) observed.add(`object:${index}`);
  }
  const required=[...contract.fields.map(name=>`field:${name}`),"negative-skew","equal-period","reversed-period","object:0","object:1"];
  return {testOk:required.every(key=>observed.has(key)),observed:[...observed].sort(),missing:required.filter(key=>!observed.has(key)),expandedCalls:calls.length};
}

export function finiteIntervalRecordEvidence({ taskText, contextText, bindings, sourceEntries, testEntries }) {
  const cached = cachedRecordEvidence({taskText,contextText,bindings,sourceEntries,testEntries});
  if (cached) return cached;
  const contract = finiteIntervalRecordContract(taskText, contextText);
  if (!contract) return { sourceOk: true, testOk: true };
  if (!contract.supported || bindings.length === 0) return { sourceOk: false, testOk: false };
  const results = bindings.map(binding => {
    const profile = finiteIntervalRecordSource({ contract, binding, sourceEntries });
    return { ...profile, ...finiteIntervalRecordTests({ contract, profile, binding, testEntries }) };
  });
  return { sourceOk: results.every(item => item.sourceOk), testOk: results.every(item => item.testOk) };
}


function intervalFallbackContract(rawCriterion, contextText) {
  const selected = /^otherwise\s+return\s+`([^`\\\r\n]{1,80})`[.;]?$/i.exec(String(rawCriterion).trim());
  const text = String(contextText ?? '').replace(/\s+/g,' ');
  if (!selected || text.length > 16_000) return null;
  const unique = pattern => [...new Set([...text.matchAll(pattern)].map(match=>JSON.stringify(match.slice(1))))].map(value=>JSON.parse(value));
  const errors = unique(/\bmalformed values throw `(TypeError|RangeError|Error)`/g);
  if (errors.length !== 1) return null;
  const contract = finiteIntervalRecordContract(`malformed values throw \`${errors[0][0]}\`.`,text);
  if (!contract?.supported) return null;
  const outside = unique(/\bReturn `([^`\\]{1,80})` for an occurrence outside that interval/gi);
  const early = unique(/\breturn `([^`\\]{1,80})` when `([\w$]+)` is earlier than `([\w$]+)` by more than `([\w$]+)`/gi);
  const late = unique(/\breturn `([^`\\]{1,80})` when receipt is at or after `([\w$]+) \+ ([\w$]+)`/gi);
  const fallback = unique(/\botherwise return `([^`\\]{1,80})`/gi);
  if ([outside,early,late,fallback].some(matches=>matches.length !== 1)
    || early[0].slice(1).join() !== [contract.received,contract.occurred,contract.skew].join()
    || late[0].slice(1).join() !== [contract.end,contract.skew].join() || fallback[0][0] !== selected[1]) return null;
  const results = [outside[0][0],early[0][0],late[0][0],selected[1]];
  return new Set(results).size === results.length ? {...contract,results} : null;
}
function intervalFallbackSource(contract, binding, sourceEntries) {
  const profile = finiteIntervalRecordSource({contract,binding,sourceEntries});
  if (!profile.sourceOk) return null;
  try {
    const statements = closedNumericValidationFunctions(sourceEntries,binding.sourcePath).get(contract.target).body.body;
    const members = new Map(profile.fields.map(field=>[field.name,field.member]));
    const property = (node,name) => intervalSameMember(node,members.get(name));
    const comparison = (node,operator,left,right) => node?.type === 'BinaryExpression' && node.operator === operator && property(node.left,left) && property(node.right,right);
    const result = (node,value) => {
      const statement = node?.type === 'BlockStatement' && node.body.length === 1 ? node.body[0] : node;
      return statement?.type === 'ReturnStatement' && statement.argument?.type === 'StringLiteral' && statement.argument.value === value;
    };
    const branch = (node,value) => node?.type === 'IfStatement' && !node.alternate && result(node.consequent,value);
    if (statements.length !== 5 || !statements.slice(1,4).every((node,index)=>branch(node,contract.results[index]))
      || !result(statements[4],contract.results[3])) return null;
    const [outside,early,late] = statements.slice(1,4).map(node=>node.test);
    if (outside?.type !== 'LogicalExpression' || outside.operator !== '||'
      || !comparison(outside.left,'<',contract.occurred,contract.start) || !comparison(outside.right,'>=',contract.occurred,contract.end)) return null;
    const offsetComparison = (node,operator,left,operation,base) => node?.type === 'BinaryExpression' && node.operator === operator && property(node.left,left)
      && node.right.type === 'BinaryExpression' && node.right.operator === operation && property(node.right.left,base) && property(node.right.right,contract.skew);
    if (!offsetComparison(early,'<',contract.received,'-',contract.occurred) || !offsetComparison(late,'>=',contract.received,'+',contract.end)) return null;
    return profile;
  } catch { return null; }
}

// Otherwise is relative to the declared earlier branches. Bind their order and
// conditions before accepting a literal result observed by the real verifier.
export function finiteIntervalFallbackEvidence({rawCriterion,profiles,sourceEntries,contextText}) {
  const contract = intervalFallbackContract(rawCriterion,contextText);
  if (!contract) return false;
  return profiles.some(testProfile => (testProfile.bindings ?? []).some(binding => {
    const source = intervalFallbackSource(contract,binding,sourceEntries);
    if (!source) return false;
    const calls = intervalTestCalls({text:testProfile.raw,code:testProfile.evidenceCode},[binding.testName],contract.errorClass,contract.results[3]);
    return calls.some(args => {
      if (!args.every(arg=>arg.kind === 'record')) return false;
      const values = new Map(source.fields.map(field=>[field.name,args[field.parameterIndex].fields.get(field.name)?.value]));
      if (![...values.values()].every(value=>typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value))) return false;
      const [start,end,occurred,received,skew] = [contract.start,contract.end,contract.occurred,contract.received,contract.skew].map(name=>values.get(name));
      return skew >= 0 && start < end && occurred >= start && occurred < end && received >= occurred-skew && received < end+skew;
    });
  }));
}

function intervalRecordOutcome(contract, profile, args) {
  if (!args.every(arg=>arg?.kind === 'record')) return 'throw';
  const values = new Map(profile.fields.map(field=>[field.name,args[field.parameterIndex].fields.get(field.name)?.value]));
  if (![...values.values()].every(value=>typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value))) return 'throw';
  const [start,end,occurred,received,skew] = [contract.start,contract.end,contract.occurred,contract.received,contract.skew].map(name=>values.get(name));
  if (skew < 0 || start >= end) return 'throw';
  if (occurred < start || occurred >= end) return contract.results[0];
  if (received < occurred-skew) return contract.results[1];
  if (received >= end+skew) return contract.results[2];
  return contract.results[3];
}
function intervalSnapshotOutcomes(program, binding, contract, profile) {
  const observed = new Set();
  for (const registration of program.registrations) {
    const body = registration.arguments[1].body.body, loop = body[0];
    if (body.length !== 1 || loop?.type !== 'ForOfStatement' || loop.await || loop.left.type !== 'VariableDeclaration' || loop.left.kind !== 'const'
      || loop.left.declarations.length !== 1 || loop.left.declarations[0].id.type !== 'Identifier' || loop.right.type !== 'ArrayExpression'
      || loop.right.elements.length < 1 || loop.right.elements.length > 32 || loop.body.type !== 'BlockStatement' || loop.body.body.length !== 3) continue;
    const variable = loop.left.declarations[0].id.name;
    const [declaration, branch, assertion] = loop.body.body;
    if (program.protectedNames.has(variable.toLowerCase()) || declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const'
      || declaration.declarations.length !== 3 || declaration.declarations.some(node=>node.id.type !== 'Identifier')) continue;
    const names = declaration.declarations.map(node=>node.id.name), args = names.slice(0,2), snapshot = names[2];
    if (new Set([variable,...names]).size !== 4 || names.some(name=>program.protectedNames.has(name.toLowerCase()))) continue;
    const sameArguments = nodes => nodes.length === 2 && nodes.every((node,index)=>node?.type === 'Identifier' && node.name === args[index]);
    const group = node => node?.type === 'ArrayExpression' && sameArguments(node.elements);
    const clone = declaration.declarations[2].init;
    if (clone?.type !== 'CallExpression' || clone.callee.type !== 'Identifier' || clone.callee.name !== 'structuredClone'
      || clone.arguments.length !== 1 || !group(clone.arguments[0])) continue;
    const actualCall = node => node?.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.callee.name === binding.testName && sameArguments(node.arguments);
    const throws = branch.consequent?.type === 'ExpressionStatement' ? branch.consequent.expression : null;
    const callback = throws?.arguments?.[0], condition = branch.test, member = condition?.left?.argument;
    if (branch.type !== 'IfStatement' || condition?.type !== 'BinaryExpression' || condition.operator !== '==='
      || condition.left.type !== 'UnaryExpression' || condition.left.operator !== 'typeof' || condition.right.type !== 'StringLiteral'
      || condition.right.value !== 'string' || member?.type !== 'MemberExpression' || member.computed || !args.includes(member.object.name)
      || throws?.type !== 'CallExpression' || intervalMember(throws.callee) !== `${program.assertName}.throws` || throws.arguments.length !== 2
      || throws.arguments[1].type !== 'Identifier' || throws.arguments[1].name !== contract.errorClass
      || callback?.type !== 'ArrowFunctionExpression' || callback.async || callback.params.length !== 0 || !actualCall(callback.body)
      || branch.alternate?.type !== 'ExpressionStatement' || !actualCall(branch.alternate.expression)) continue;
    const comparison = assertion.type === 'ExpressionStatement' ? assertion.expression : null;
    if (comparison?.type !== 'CallExpression' || ![`${program.assertName}.deepEqual`,`${program.assertName}.deepStrictEqual`].includes(intervalMember(comparison.callee))
      || comparison.arguments.length !== 2 || !group(comparison.arguments[0]) || comparison.arguments[1].type !== 'Identifier' || comparison.arguments[1].name !== snapshot) continue;
    const rows = loop.right.elements.map(node=>flatRecordValue(node,new Map(),new Map(),registration.start));
    if (!rows.every(Boolean)) continue;
    const outcomes = new Set(); let complete = true;
    for (const row of rows) {
      const bindings = new Map([[variable,row]]);
      const values = declaration.declarations.slice(0,2).map(node=>flatRecordValue(node.init,bindings,program.factories,registration.start));
      if (!values.every(value=>value?.kind === 'record')) { complete = false; break; }
      const expectedThrow = typeof values[args.indexOf(member.object.name)].fields.get(member.property.name)?.value === 'string';
      const outcome = intervalRecordOutcome(contract,profile,values);
      if (expectedThrow !== (outcome === 'throw')) { complete = false; break; }
      outcomes.add(outcome);
    }
    if (complete) for (const outcome of outcomes) observed.add(outcome);
  }
  return observed;
}

export function finiteIntervalNonMutationEvidence({rawCriterion,profiles,sourceEntries,contextText}) {
  const cached = cachedRecordNonMutationEvidence({rawCriterion,profiles,sourceEntries,contextText});
  if (cached !== undefined) return cached;
  if (!/^Inputs must remain unchanged[.;]?$/i.test(String(rawCriterion).trim())) return false;
  const clauses = [...new Set([...String(contextText ?? '').matchAll(/otherwise\s+return\s+`[^`\\\r\n]{1,80}`/gi)].map(match=>match[0]))];
  if (clauses.length !== 1) return false;
  const contract = intervalFallbackContract(clauses[0],contextText);
  if (!contract) return false;
  return profiles.some(testProfile=>(testProfile.bindings ?? []).some(binding=>{
    const source = intervalFallbackSource(contract,binding,sourceEntries);
    if (!source) return false;
    const program = intervalTestProgram({text:testProfile.raw,code:testProfile.evidenceCode},[binding.testName],contract.errorClass);
    if (!program) return false;
    const outcomes = intervalSnapshotOutcomes(program,binding,contract,source);
    return [...contract.results,'throw'].every(outcome=>outcomes.has(outcome));
  }));
}


function cachedRecordContract(selected, contextText) {
  const text = String(contextText ?? '').replace(/\s+/g,' ');
  if (!/\bValidate all time and revision fields as finite integers\b/i.test(text) || !/\bmalformed input\b/i.test(String(selected))) return null;
  const unsupported = {supported:false};
  const clause = /^Throw `?(TypeError|RangeError|Error)`? for malformed input[.;]?$/i.exec(String(selected).trim());
  if (!clause || text.length > 16_000) return unsupported;
  const unique = pattern=>[...new Set([...text.matchAll(pattern)].map(match=>JSON.stringify(match.slice(1))))].map(value=>JSON.parse(value));
  const signatures=unique(/`([\w$]+)\(\s*([\w$]+)\s*,\s*([\w$]+)\s*\)`/g);
  const ids=unique(/\bmatching non-empty ([a-z, ]+?) identifiers\b/gi);
  const revisions=unique(/\bthe cached ([a-z ]+?) equals the current ([a-z ]+?);/gi);
  const times=unique(/`([\w$]+)\.([\w$]+)` is strictly before `([\w$]+)\.([\w$]+)`/g);
  const nullable=unique(/`([\w$]+)\.([\w$]+)` must be either null or a finite integer/g);
  if ([signatures,ids,revisions,times,nullable].some(values=>values.length !== 1) || !/\bevaluation is not in the future\b/i.test(text)) return unsupported;
  const [target,...parameters]=signatures[0], roles=ids[0][0].replace(/\band\b/gi,',').split(',').map(word=>word.trim()).filter(Boolean);
  const [nowOwner,nowName,expiryOwner,expiryName]=times[0], [nullableOwner,nullableName]=nullable[0];
  const phrase=value=>value.toLowerCase().replace(/\s+/g,'');
  if (parameters[0] === parameters[1] || roles.length < 1 || roles.length > 6 || new Set(roles).size !== roles.length || roles.some(role=>!/^\w+$/.test(role))
    || !parameters.includes(nowOwner) || !parameters.includes(expiryOwner) || nowOwner === expiryOwner || nullableOwner !== nowOwner
    || phrase(revisions[0][0]) !== phrase(revisions[0][1]) || !/revision$/i.test(revisions[0][0])
    || !text.includes(`revocation at or before \`${nowOwner}.${nowName}\` invalidates`)) return unsupported;
  return {supported:true,target,parameters,roles,errorClass:clause[1],now:`${nowOwner}.${nowName}`,expiry:`${expiryOwner}.${expiryName}`,
    nullable:`${nullableOwner}.${nullableName}`,revision:phrase(revisions[0][0]),currentRevision:'current'+phrase(revisions[0][1]),currentOwner:nowOwner,cachedOwner:expiryOwner};
}
const recordConjunction = node=>node?.type === 'LogicalExpression' && node.operator === '&&' ? [...recordConjunction(node.left),...recordConjunction(node.right)] : [node];
function singlePredicate(functions,name) {
  const fn=functions.get(name);
  return fn && !fn.async && !fn.generator && fn.params.length === 1 && fn.params[0].type === 'Identifier'
    && fn.body.body.length === 1 && fn.body.body[0].type === 'ReturnStatement' ? {value:fn.params[0].name,expression:fn.body.body[0].argument} : null;
}
function recordObjectPredicate(functions,name) {
  const predicate=singlePredicate(functions,name);if(!predicate)return false;
  const [value,type,array,...extra]=recordConjunction(predicate.expression);
  return extra.length === 0 && value?.type === 'Identifier' && value.name === predicate.value
    && type?.type === 'BinaryExpression' && type.operator === '===' && type.left.type === 'UnaryExpression' && type.left.operator === 'typeof'
    && type.left.argument.name === predicate.value && type.right.type === 'StringLiteral' && type.right.value === 'object'
    && array?.type === 'UnaryExpression' && array.operator === '!' && array.argument.type === 'CallExpression'
    && intervalMember(array.argument.callee) === 'Array.isArray' && array.argument.arguments.length === 1 && array.argument.arguments[0].name === predicate.value;
}
function recordStringPredicate(functions,name) {
  const predicate=singlePredicate(functions,name);if(!predicate)return false;
  const [type,length,...extra]=recordConjunction(predicate.expression);
  return extra.length === 0 && type?.type === 'BinaryExpression' && type.operator === '===' && type.left.type === 'UnaryExpression' && type.left.operator === 'typeof'
    && type.left.argument.name === predicate.value && type.right.type === 'StringLiteral' && type.right.value === 'string'
    && length?.type === 'BinaryExpression' && length.operator === '>' && intervalMember(length.left) === `${predicate.value}.length`
    && length.right.type === 'NumericLiteral' && length.right.value === 0;
}
function cachedRecordSource(contract,binding,sourceEntries) {
  if (!contract?.supported || binding?.sourceName?.toLowerCase() !== contract.target.toLowerCase()) return null;
  try {
    const functions=closedNumericValidationFunctions(sourceEntries,binding.sourcePath),fn=functions.get(contract.target);
    if (!fn || fn.params.length !== 2 || fn.params.some((node,index)=>node.type !== 'Identifier' || node.name !== contract.parameters[index]) || fn.body.body.length !== 2) return null;
    const [guard,result]=fn.body.body,terms=recordConjunction(result?.argument),parts=intervalDisjunction(guard?.test);
    if (guard.type !== 'IfStatement' || guard.alternate || !closedLiteralError(guard.consequent,contract.errorClass)
      || parts.length !== 5 || result.type !== 'ReturnStatement' || terms.length !== contract.roles.length+4) return null;
    const fields=new Map(),roleFields=[];
    const add=(member,kind)=>{
      const value=intervalMember(member),index=contract.parameters.indexOf(member?.object?.name);
      if (!value || index < 0 || fields.has(value)) return false;
      fields.set(value,{member:value,name:member.property.name,parameterIndex:index,kind});return true;
    };
    const roleName=name=>name.toLowerCase().replace(/(?:identifier|id)$/,'');
    for (const [index,role] of contract.roles.entries()) {
      const term=terms[index];
      if (term?.type !== 'BinaryExpression' || term.operator !== '===' || term.left.object?.name !== contract.cachedOwner || term.right.object?.name !== contract.currentOwner
        || roleName(term.left.property?.name ?? '') !== role.toLowerCase() || roleName(term.right.property?.name ?? '') !== role.toLowerCase()
        || !add(term.left,'string') || !add(term.right,'string')) return null;
      roleFields.push([intervalMember(term.left),intervalMember(term.right)]);
    }
    const [revision,evaluation,expiry,revocation]=terms.slice(contract.roles.length);
    if (revision?.type !== 'BinaryExpression' || revision.operator !== '===' || revision.left.object?.name !== contract.cachedOwner || revision.right.object?.name !== contract.currentOwner
      || revision.left.property?.name.toLowerCase() !== contract.revision || revision.right.property?.name.toLowerCase() !== contract.currentRevision
      || !add(revision.left,'integer') || !add(revision.right,'integer')) return null;
    if (evaluation?.type !== 'BinaryExpression' || evaluation.operator !== '<=' || intervalMember(evaluation.right) !== contract.now
      || evaluation.left.object?.name !== contract.cachedOwner || !/^(?:evaluatedat|evaluation(?:at|time|timestamp))$/i.test(evaluation.left.property?.name ?? '')
      || !add(evaluation.left,'integer') || !add(evaluation.right,'integer')) return null;
    if (expiry?.type !== 'BinaryExpression' || expiry.operator !== '<' || intervalMember(expiry.left) !== contract.now || intervalMember(expiry.right) !== contract.expiry || !add(expiry.right,'integer')) return null;
    const nullable=node=>node?.type === 'BinaryExpression' && node.operator === '!==' && intervalMember(node.left) === contract.nullable && node.right.type === 'NullLiteral';
    const revoked=revocation?.argument;
    if (revocation?.type !== 'UnaryExpression' || revocation.operator !== '!' || revoked?.type !== 'LogicalExpression' || revoked.operator !== '&&' || !nullable(revoked.left)
      || revoked.right.type !== 'BinaryExpression' || revoked.right.operator !== '<=' || intervalMember(revoked.right.left) !== contract.nullable
      || intervalMember(revoked.right.right) !== contract.now || !add(revoked.left.left,'nullable-integer')) return null;
    for (let index=0;index<2;index++) {
      const node=parts[index],call=node?.argument;
      if (node?.type !== 'UnaryExpression' || node.operator !== '!' || call?.type !== 'CallExpression' || call.callee.type !== 'Identifier'
        || call.arguments.length !== 1 || call.arguments[0].type !== 'Identifier' || call.arguments[0].name !== contract.parameters[index] || !recordObjectPredicate(functions,call.callee.name)) return null;
    }
    const every=(node,kind,predicate)=>{
      const call=node?.argument,expected=[...fields.values()].filter(field=>field.kind === kind).map(field=>field.member);
      if (node?.type !== 'UnaryExpression' || node.operator !== '!' || call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.computed
        || call.callee.property.name !== 'every' || call.callee.object.type !== 'ArrayExpression' || call.arguments.length !== 1 || call.arguments[0].type !== 'Identifier'
        || !predicate(functions,call.arguments[0].name)) return false;
      const observed=call.callee.object.elements.map(intervalMember);
      return observed.length === expected.length && new Set(observed).size === expected.length && expected.every(member=>observed.includes(member));
    };
    if (!every(parts[2],'string',recordStringPredicate) || !every(parts[3],'integer',intervalIntegerPredicate)) return null;
    const nullableGuard=parts[4],negative=nullableGuard?.right,invocation=negative?.argument;
    if (nullableGuard?.type !== 'LogicalExpression' || nullableGuard.operator !== '&&' || !nullable(nullableGuard.left)
      || negative?.type !== 'UnaryExpression' || negative.operator !== '!' || invocation?.type !== 'CallExpression' || invocation.callee.type !== 'Identifier'
      || invocation.arguments.length !== 1 || intervalMember(invocation.arguments[0]) !== contract.nullable || !intervalIntegerPredicate(functions,invocation.callee.name)) return null;
    return {fields:[...fields.values()],roleFields,revision:[intervalMember(revision.left),intervalMember(revision.right)],evaluation:intervalMember(evaluation.left)};
  } catch { return null; }
}
function cachedRecordTests(contract,profile,binding,testEntries) {
  if (!profile) return {testOk:false};
  const paths=binding.testBindings ?? [{testPath:binding.testPath,testName:binding.testName}];
  const calls=testEntries.flatMap(entry=>intervalTestCalls(entry,paths.filter(item=>item.testPath === entry.path).map(item=>item.testName),contract.errorClass));
  const fact=(args,field)=>args[field.parameterIndex]?.fields?.get(field.name);
  const valid=(value,kind)=>value?.kind === 'primitive' && (kind === 'string' ? typeof value.value === 'string' && value.value.length > 0
    : kind === 'nullable-integer' && value.value === null || typeof value.value === 'number' && Number.isFinite(value.value) && Number.isInteger(value.value));
  const observed=new Set();
  for (const args of calls) {
    for (const field of profile.fields) {
      if (!args.every(arg=>arg.kind === 'record') || !profile.fields.every(other=>other === field || valid(fact(args,other),other.kind))) continue;
      const value=fact(args,field);if(value?.kind !== 'primitive')continue;
      const key=field.member;
      if (field.kind === 'string') {
        if (value.value === '') observed.add(key+':empty');
        if (typeof value.value !== 'string') observed.add(key+':non-string');
      } else {
        if (typeof value.value === 'number' && !Number.isFinite(value.value)) observed.add(key+':non-finite');
        if (typeof value.value === 'number' && Number.isFinite(value.value) && !Number.isInteger(value.value)) observed.add(key+':fractional');
        if (typeof value.value !== 'number' && !(field.kind === 'nullable-integer' && value.value === null)) observed.add(key+':non-number');
      }
    }
    for (const index of [0,1]) if (args[1-index]?.kind === 'record' && profile.fields.every(field=>field.parameterIndex === index || valid(fact(args,field),field.kind))) {
      if (args[index].kind === 'primitive' && (args[index].value === null || args[index].value === undefined)) observed.add(`object:${index}:missing`);
      if (args[index].kind === 'array') observed.add(`object:${index}:array`);
    }
  }
  const required=profile.fields.flatMap(field=>(field.kind === 'string'?['empty','non-string']:['non-finite','fractional','non-number']).map(kind=>field.member+':'+kind));
  required.push(...[0,1].flatMap(index=>[`object:${index}:missing`,`object:${index}:array`]));
  return {testOk:required.every(key=>observed.has(key)),missing:required.filter(key=>!observed.has(key)),observed:[...observed].sort(),calls:calls.length};
}
function cachedRecordEvidence({taskText,contextText,bindings,sourceEntries,testEntries}) {
  const contract=cachedRecordContract(taskText,contextText);
  if (!contract) return null;
  const profiles=new Map(bindings.map(binding=>[binding,cachedRecordSource(contract,binding,sourceEntries)]));
  return {sourceOk:contract.supported && bindings.length > 0 && [...profiles.values()].every(Boolean),
    testOk:contract.supported && bindings.length > 0 && bindings.every(binding=>cachedRecordTests(contract,profiles.get(binding),binding,testEntries).testOk),
    provesSource:binding=>Boolean(profiles.get(binding))};
}


function cachedRecordOutcome(contract,profile,args) {
  if (!args.every(arg=>arg?.kind === 'record')) return 'throw';
  const values=new Map(profile.fields.map(field=>[field.member,args[field.parameterIndex].fields.get(field.name)?.value]));
  if (!profile.fields.every(field=>field.kind === 'string' ? typeof values.get(field.member) === 'string' && values.get(field.member).length > 0
    : field.kind === 'nullable-integer' && values.get(field.member) === null || typeof values.get(field.member) === 'number' && Number.isFinite(values.get(field.member)) && Number.isInteger(values.get(field.member)))) return 'throw';
  return profile.roleFields.every(([left,right])=>values.get(left) === values.get(right)) && values.get(profile.revision[0]) === values.get(profile.revision[1])
    && values.get(profile.evaluation) <= values.get(contract.now) && values.get(contract.now) < values.get(contract.expiry)
    && !(values.get(contract.nullable) !== null && values.get(contract.nullable) <= values.get(contract.now));
}
function cachedSnapshotOutcomes(program,binding,contract,profile) {
  const observed=new Set();
  for (const registration of program.registrations) {
    const body=registration.arguments[1].body.body,loop=body[0];
    if (body.length !== 1 || loop?.type !== 'ForOfStatement' || loop.await || loop.left.type !== 'VariableDeclaration' || loop.left.kind !== 'const'
      || loop.left.declarations.length !== 1 || loop.left.declarations[0].id.type !== 'Identifier' || loop.right.type !== 'ArrayExpression'
      || loop.right.elements.length < 1 || loop.right.elements.length > 32 || loop.body.type !== 'BlockStatement' || loop.body.body.length !== 4) continue;
    const variable=loop.left.declarations[0].id.name,[declaration,branch,...assertions]=loop.body.body;
    if (declaration.type !== 'VariableDeclaration' || declaration.kind !== 'const' || declaration.declarations.length !== 3
      || declaration.declarations.some(node=>node.id.type !== 'Identifier')) continue;
    const [cached,snapshotCached,snapshotInput]=declaration.declarations.map(node=>node.id.name),args=[cached,variable];
    if (new Set([variable,cached,snapshotCached,snapshotInput]).size !== 4 || [variable,cached,snapshotCached,snapshotInput].some(name=>program.protectedNames.has(name.toLowerCase()))) continue;
    const clone=(node,name)=>node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'structuredClone'
      && node.arguments.length === 1 && node.arguments[0].type === 'Identifier' && node.arguments[0].name === name;
    if (!clone(declaration.declarations[1].init,cached) || !clone(declaration.declarations[2].init,variable)) continue;
    const actualCall=node=>node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === binding.testName
      && node.arguments.length === 2 && node.arguments.every((arg,index)=>arg.type === 'Identifier' && arg.name === args[index]);
    const throws=branch.consequent?.type === 'ExpressionStatement' ? branch.consequent.expression : null,callback=throws?.arguments?.[0],condition=branch.test,member=condition?.left?.argument;
    if (branch.type !== 'IfStatement' || condition?.type !== 'BinaryExpression' || condition.operator !== '===' || condition.left.type !== 'UnaryExpression'
      || condition.left.operator !== 'typeof' || condition.right.type !== 'StringLiteral' || condition.right.value !== 'string'
      || member?.type !== 'MemberExpression' || member.computed || !args.includes(member.object.name)
      || throws?.type !== 'CallExpression' || intervalMember(throws.callee) !== `${program.assertName}.throws` || throws.arguments.length !== 2
      || throws.arguments[1].type !== 'Identifier' || throws.arguments[1].name !== contract.errorClass
      || callback?.type !== 'ArrowFunctionExpression' || callback.async || callback.params.length !== 0 || !actualCall(callback.body)
      || branch.alternate?.type !== 'ExpressionStatement' || !actualCall(branch.alternate.expression)) continue;
    const pair=(statement,actual,expected)=>{
      const call=statement?.type === 'ExpressionStatement' ? statement.expression : null;
      return call?.type === 'CallExpression' && [`${program.assertName}.deepEqual`,`${program.assertName}.deepStrictEqual`].includes(intervalMember(call.callee))
        && call.arguments.length === 2 && call.arguments[0].type === 'Identifier' && call.arguments[0].name === actual && call.arguments[1].type === 'Identifier' && call.arguments[1].name === expected;
    };
    if (!pair(assertions[0],cached,snapshotCached) || !pair(assertions[1],variable,snapshotInput)) continue;
    const rows=loop.right.elements.map(node=>flatRecordValue(node,new Map(),program.factories,registration.start));
    if (!rows.every(row=>row?.kind === 'record')) continue;
    const outcomes=new Set();let complete=true;
    for (const row of rows) {
      const value=flatRecordValue(declaration.declarations[0].init,new Map([[variable,row]]),program.factories,registration.start);
      if (value?.kind !== 'record') {complete=false;break;}
      const values=[value,row],outcome=cachedRecordOutcome(contract,profile,values);
      const expectedThrow=typeof values[args.indexOf(member.object.name)].fields.get(member.property.name)?.value === 'string';
      if (expectedThrow !== (outcome === 'throw')) {complete=false;break;}
      outcomes.add(outcome);
    }
    if (complete) for (const outcome of outcomes) observed.add(outcome);
  }
  return observed;
}
function cachedRecordNonMutationEvidence({rawCriterion,profiles,sourceEntries,contextText}) {
  if (!/^Do not mutate either argument[.;]?$/i.test(String(rawCriterion).trim()) || !/\bValidate all time and revision fields as finite integers\b/i.test(String(contextText).replace(/\s+/g,' '))) return undefined;
  const clauses=[...new Set([...String(contextText).replace(/\s+/g,' ').matchAll(/Throw `(TypeError|RangeError|Error)` for malformed input[.;]?/g)].map(match=>match[0]))];
  if (clauses.length !== 1) return false;
  const contract=cachedRecordContract(clauses[0],contextText);
  if (!contract?.supported) return false;
  return profiles.some(testProfile=>(testProfile.bindings ?? []).some(binding=>{
    const source=cachedRecordSource(contract,binding,sourceEntries);if(!source)return false;
    const program=intervalTestProgram({text:testProfile.raw,code:testProfile.evidenceCode},[binding.testName],contract.errorClass);if(!program)return false;
    const outcomes=cachedSnapshotOutcomes(program,binding,contract,source);
    return [true,false,'throw'].every(outcome=>outcomes.has(outcome));
  }));
}

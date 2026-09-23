import { parse, parseExpression } from "@babel/parser";
import { executableRejectionAssertions } from "./acceptance-executable-evidence.js";

const identifier = /^[A-Za-z_$][\w$]*$/;
const labelKey = value => value.replace(/[\s_]/g, "").toLowerCase();
const memberName = node => node?.type === "Identifier" ? node.name
  : node?.type === "MemberExpression" && !node.computed ? `${memberName(node.object)}.${node.property.name}` : null;
const fail = () => { throw new Error("unsupported-integer-domain-proof"); };

// Compile only the declared rejection clause. A leading behavioral clause is
// retained as an unproved obligation, never discarded to make the receipt pass.
export function declaredIntegerDomains(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  const candidate = /^`([A-Za-z_$][\w$]*)\(([^()]*)\)`\s+must\s+([\s\S]*?)throw\s+`?(TypeError|RangeError|Error)`?\s+unless\s+([\s\S]+?)[.;]?$/i.exec(text);
  if (!candidate) return null;
  const [, target, signature, prefix, errorClass, requirements] = candidate;
  if (!/\b(?:non-negative|positive)\s+(?:safe\s+)?integer\b/i.test(requirements)) return null;
  const parameters = signature.split(",").map(value => value.trim());
  const unproved = prefix.trim().replace(/,?\s*and\s*$/i, "").trim();
  const result = { target, parameters, errorClass, domains: [], unprovedClauses: unproved ? [unproved] : [], supported: false };
  if (!parameters.length || parameters.length > 8 || !parameters.every(name => identifier.test(name))
    || new Set(parameters.map(labelKey)).size !== parameters.length) return result;
  for (const requirement of requirements.split(/\s+and\s+/i)) {
    const clause = /^`?([A-Za-z_$][\w$]*(?:\s+[A-Za-z_$][\w$]*)*)`?\s+is\s+(?:a|an)\s+(non-negative|positive)\s+integer$/i.exec(requirement);
    if (!clause) return result;
    const index = parameters.findIndex(name => labelKey(name) === labelKey(clause[1]));
    if (index < 0 || result.domains.some(item => item.index === index)) return result;
    result.domains.push({ name: parameters[index], index, minimum: clause[2].toLowerCase() === "positive" ? 1 : 0 });
  }
  result.supported = result.domains.length === parameters.length;
  return result;
}

// An explicit expression fixes the requested arithmetic semantics. Natural-language
// "exact ceiling division" alone remains unproved: it may mean integer arithmetic.
function declaredNumberCeiling(contract) {
  if (contract.unprovedClauses.length !== 1 || contract.parameters.length !== 2) return null;
  const clause = /^return\s+`Math\.ceil\(([A-Za-z_$][\w$]*)\s*\/\s*([A-Za-z_$][\w$]*)\)`\s+using JavaScript Number division,\s*return zero for zero ([A-Za-z_$][\w$]*(?:\s+[A-Za-z_$][\w$]*)*)$/i.exec(contract.unprovedClauses[0]);
  if (!clause || !/`Math\.ceil\(/.test(clause[0]) || clause[1] === clause[2]) return null;
  const numerator = contract.parameters.indexOf(clause[1]), denominator = contract.parameters.indexOf(clause[2]);
  const words = name => name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase().split(/\s+/);
  const zeroWords = words(clause[3]);
  const zeroBindings = contract.parameters.flatMap((name, index) => {
    const parts = words(name);
    return parts.length >= zeroWords.length && parts.slice(-zeroWords.length).join(" ") === zeroWords.join(" ") ? [index] : [];
  });
  return numerator >= 0 && denominator >= 0 && zeroBindings.length === 1 && zeroBindings[0] === numerator
    && contract.domains.find(domain => domain.index === numerator)?.minimum === 0
    && contract.domains.find(domain => domain.index === denominator)?.minimum === 1 ? { numerator, denominator } : null;
}

function numberCeilingResult(node, contract, calculation) {
  const division = node?.arguments?.[0];
  return node?.type === "CallExpression" && memberName(node.callee) === "Math.ceil" && node.arguments.length === 1
    && division?.type === "BinaryExpression" && division.operator === "/"
    && division.left.type === "Identifier" && division.left.name === contract.parameters[calculation.numerator]
    && division.right.type === "Identifier" && division.right.name === contract.parameters[calculation.denominator];
}

function sourceFunctions(entry) {
  if (!entry || entry.text.length > 64_000) fail();
  const ast = parse(entry.text, { sourceType: "module", errorRecovery: false, attachComment: false });
  const functions = new Map(), protectedNames = new Set(["Number", "Math", "Error", "TypeError", "RangeError"]);
  for (const statement of ast.program.body) {
    const fn = statement.type === "ExportNamedDeclaration" && !statement.source ? statement.declaration : statement;
    if (fn?.type !== "FunctionDeclaration" || !fn.id || functions.has(fn.id.name) || protectedNames.has(fn.id.name)) fail();
    functions.set(fn.id.name, fn);
  }
  for (const name of functions.keys()) protectedNames.add(name);
  let count = 0;
  const inspect = (node, parent, grandparent, depth = 0) => {
    if (!node || typeof node.type !== "string") return;
    if (++count > 12_000 || depth > 128) fail();
    if (node.type === "Identifier" && ["Number", "Math"].includes(node.name)
      && !(parent?.type === "MemberExpression" && !parent.computed && parent.object === node
        && grandparent?.type === "CallExpression" && grandparent.callee === parent)) fail();
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
      const name = memberName(node.left ?? node.argument)?.split(".")[0];
      if (!name || protectedNames.has(name)) fail();
    }
    if (node.type === "VariableDeclarator" && (node.id.type !== "Identifier" || protectedNames.has(node.id.name))) fail();
    if (/Function/.test(node.type) && node.params?.some(param => param.type !== "Identifier" || protectedNames.has(param.name))) fail();
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(item => inspect(item, node, parent, depth + 1));
      else if (value && typeof value === "object") inspect(value, node, parent, depth + 1);
    }
  };
  inspect(ast);
  return functions;
}

function integerGuard(statement, parameter, minimum, errorClass, literalBindings = new Map()) {
  const condition = statement?.test;
  if (statement?.type !== "IfStatement" || statement.alternate || condition?.type !== "LogicalExpression" || condition.operator !== "||") return false;
  // Type rejection must happen first: comparing an object before this guard
  // can invoke valueOf/toPrimitive and throw an arbitrary, wrong error class.
  const terms = [condition.left];
  const integer = terms.find(term => term.type === "UnaryExpression" && term.operator === "!"
    && term.argument.type === "CallExpression" && memberName(term.argument.callee) === "Number.isInteger"
    && term.argument.arguments.length === 1 && term.argument.arguments[0].type === "Identifier"
    && term.argument.arguments[0].name === parameter);
  const lowerBound = [condition.right].find(term => term.type === "BinaryExpression" && term.operator === "<"
    && term.left.type === "Identifier" && term.left.name === parameter
    && (term.right.type === "NumericLiteral" ? term.right.value : literalBindings.get(term.right.name)) === minimum);
  const consequent = statement.consequent.type === "BlockStatement" && statement.consequent.body.length === 1
    ? statement.consequent.body[0] : statement.consequent;
  const error = consequent?.argument;
  return Boolean(integer && lowerBound && consequent.type === "ThrowStatement" && error?.type === "NewExpression"
    && error.callee.type === "Identifier" && error.callee.name === errorClass
    && error.arguments.every(item => ["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(item.type)));
}

function helperGuard(call, domain, contract, functions) {
  if (call?.type !== "CallExpression" || call.callee.type !== "Identifier"
    || contract.parameters.includes(call.callee.name) || call.arguments.some(item => item.type === "SpreadElement")) return false;
  const helper = functions.get(call.callee.name);
  if (!helper || helper.async || helper.generator || helper.params.length !== call.arguments.length
    || helper.params.some(item => item.type !== "Identifier") || helper.body.body.length !== 2) return false;
  const position = call.arguments.findIndex(item => item.type === "Identifier" && item.name === domain.name);
  if (position < 0 || call.arguments.filter(item => item.type === "Identifier").length !== 1) return false;
  const literalBindings = new Map();
  for (const [index, argument] of call.arguments.entries()) {
    if (index === position) continue;
    if (argument.type !== "NumericLiteral" || !Number.isSafeInteger(argument.value)) return false;
    literalBindings.set(helper.params[index].name, argument.value);
  }
  const parameter = helper.params[position].name, returned = helper.body.body[1];
  return returned.type === "ReturnStatement" && returned.argument?.type === "Identifier" && returned.argument.name === parameter
    && integerGuard(helper.body.body[0], parameter, domain.minimum, contract.errorClass, literalBindings);
}

function pureNumericResult(node, names) {
  if (!node) return false;
  if (node.type === "NumericLiteral") return Number.isFinite(node.value);
  if (node.type === "Identifier") return names.includes(node.name);
  if (node.type === "UnaryExpression" && ["+", "-"].includes(node.operator)) return pureNumericResult(node.argument, names);
  if (node.type === "BinaryExpression" && ["+", "-", "*", "/", "%", "**"].includes(node.operator)) {
    return pureNumericResult(node.left, names) && pureNumericResult(node.right, names);
  }
  return node.type === "CallExpression" && /^Math\.(?:ceil|floor|round|trunc|min|max|abs)$/.test(memberName(node.callee) ?? "")
    && node.arguments.length > 0 && node.arguments.every(item => pureNumericResult(item, names));
}

function sourceRejectionEstablished(contract, binding, sourceEntries, calculation = null) {
  try {
    const entries = sourceEntries.filter(entry => entry.path === binding.sourcePath);
    if (entries.length !== 1) return false;
    const functions = sourceFunctions(entries[0]);
    if (calculation) for (const entry of sourceEntries) if (entry !== entries[0]) sourceFunctions(entry);
    const matches = [...functions.values()].filter(fn => fn.id.name.toLowerCase() === binding.sourceName);
    const fn = matches.length === 1 ? matches[0] : null;
    if (!fn || fn.async || fn.generator || fn.params.length !== contract.parameters.length
      || fn.params.some((parameter, index) => parameter.name !== contract.parameters[index])) return false;
    const checked = new Set(), statements = fn.body.body;
    for (const statement of statements.slice(0, -1)) {
      const domains = contract.domains.filter(domain => integerGuard(statement, domain.name, domain.minimum, contract.errorClass)
        || statement.type === "ExpressionStatement" && helperGuard(statement.expression, domain, contract, functions));
      if (domains.length !== 1 || checked.has(domains[0].index)) return false;
      checked.add(domains[0].index);
    }
    const last = statements.at(-1);
    return checked.size === contract.domains.length && last?.type === "ReturnStatement"
      && (calculation ? numberCeilingResult(last.argument, contract, calculation) : pureNumericResult(last.argument, contract.parameters));
  } catch { return false; }
}

// Test syntax is already filtered by the existing live assertion/import engine.
// This reader accepts only closed literal values and bounded literal for-of
// expansions. It does not run callbacks or infer values from arbitrary names.
function literalValue(node) {
  if (node?.type === "NumericLiteral") return { kind: "number", value: node.value };
  if (node?.type === "UnaryExpression" && ["-", "+"].includes(node.operator)) {
    const value = literalValue(node.argument);
    return value?.kind === "number" ? { kind: "number", value: node.operator === "-" ? -value.value : +value.value } : null;
  }
  if (node?.type === "Identifier") {
    if (node.name === "infinity") return { kind: "number", value: Infinity };
    if (node.name === "nan") return { kind: "number", value: NaN };
    if (node.name === "undefined" || /^__pi_(?:string|empty_string|whitespace_string)_literal__$/.test(node.name)) return { kind: "non-number" };
  }
  if (["StringLiteral", "NullLiteral", "BooleanLiteral"].includes(node?.type)
    || node?.type === "ArrayExpression" && node.elements.length === 0
    || node?.type === "ObjectExpression" && node.properties.length === 0) return { kind: "non-number" };
  return null;
}

function assertionArguments(assertion, name, readLiteral = literalValue) {
  try {
    const operation = parseExpression(assertion.operation);
    if (!["ArrowFunctionExpression", "FunctionExpression"].includes(operation.type) || operation.async
      || operation.generator || operation.params.length !== 0) return [];
    const expression = operation.body.type === "BlockStatement" && operation.body.body.length === 1
      ? operation.body.body[0].argument ?? operation.body.body[0].expression : operation.body;
    if (expression?.type !== "CallExpression" || memberName(expression.callee) !== name
      || expression.arguments.some(item => item.type === "SpreadElement")) return [];
    const iterations = assertion.iterationBindings ?? [];
    if (iterations.length > 1) return [];
    let choices = [new Map()];
    if (iterations.length === 1) {
      const values = parseExpression(iterations[0].literal);
      if (values.type !== "ArrayExpression" || values.elements.length > 32) return [];
      choices = values.elements.map(item => new Map([[iterations[0].variable, literalValue(item)]]));
    }
    return choices.map(choice => expression.arguments.map(argument => argument.type === "Identifier" && choice.has(argument.name)
      ? choice.get(argument.name) : readLiteral(argument, choice))).filter(args => args.every(Boolean));
  } catch { return []; }
}

function testNumericInputsStable(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 64_000) return false;
    const ast = parse(raw, { sourceType: "unambiguous", errorRecovery: false, attachComment: false });
    let count = 0;
    const inspect = (node, parent, grandparent, depth = 0) => {
      if (!node || typeof node.type !== "string") return;
      if (++count > 12_000 || depth > 128) fail();
      if (node.type === "Identifier" && ["Number", "Math"].includes(node.name)
        && !(parent?.type === "MemberExpression" && parent.object === node && !parent.computed
          && grandparent?.type === "CallExpression" && grandparent.callee === parent)) fail();
      // The shared assertion view is lowercased. Require the original token
      // to be the exact unbound intrinsic, not a similarly spelled local.
      if (node.type === "Identifier" && ["infinity", "nan", "undefined"].includes(node.name.toLowerCase())
        && (!(["Infinity", "NaN", "undefined"].includes(node.name)) || !(parent?.type === "CallExpression" && parent.arguments.includes(node)
          || parent?.type === "ArrayExpression" || parent?.type === "UnaryExpression"
          || parent?.type === "BinaryExpression" || parent?.type === "ReturnStatement"))) fail();
      for (const [key, value] of Object.entries(node)) {
        if (["loc", "extra", "comments", "tokens", "errors"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item => inspect(item, node, parent, depth + 1));
        else if (value && typeof value === "object") inspect(value, node, parent, depth + 1);
      }
    };
    inspect(ast);
    return true;
  } catch { return false; }
}

function testsEstablishDomains(contract, binding, testCodeEntries) {
  if (!testCodeEntries.every(entry => testNumericInputsStable(entry.raw))) return false;
  const rows = [];
  for (const testBinding of binding.testBindings ?? []) {
    const entry = testCodeEntries.find(item => item.path === testBinding.testPath);
    if (!entry) continue;
    for (const assertion of executableRejectionAssertions(entry.code, new Set([testBinding.testName]))) {
      if (assertion.mode !== "throws" || !assertion.errorClasses.includes(contract.errorClass.toLowerCase())) continue;
      rows.push(...assertionArguments(assertion, testBinding.testName));
    }
  }
  const valid = (value, domain) => value?.kind === "number" && Number.isInteger(value.value) && value.value >= domain.minimum;
  return contract.domains.every(domain => {
    const seen = new Set();
    for (const args of rows) {
      if (args.length !== contract.parameters.length || contract.domains.some(other => other.index !== domain.index && !valid(args[other.index], other))) continue;
      const value = args[domain.index];
      if (value.kind !== "number") seen.add("non-number");
      else if (!Number.isFinite(value.value)) seen.add("non-finite");
      else if (!Number.isInteger(value.value)) seen.add("fractional");
      else if (value.value < 0) seen.add("negative");
      else if (value.value === 0 && domain.minimum === 1) seen.add("zero");
    }
    return ["non-number", "non-finite", "fractional", "negative", ...(domain.minimum === 1 ? ["zero"] : [])].every(item => seen.has(item));
  });
}

// Existing executable assertions supply live, source-bound invocation witnesses.
// They do not establish the formula; the closed source return above does that.
function numberCeilingWitnesses(contract, calculation, binding, testCodeEntries) {
  const number = (node, depth = 0) => {
    if (depth > 4) return null;
    if (node?.type === "NumericLiteral") return node.value;
    if (node?.type === "UnaryExpression" && ["+", "-"].includes(node.operator)) {
      const value = number(node.argument, depth + 1);
      return value === null ? null : node.operator === "-" ? -value : value;
    }
    if (node?.type === "BinaryExpression" && node.operator === "**") {
      const base = number(node.left, depth + 1), exponent = number(node.right, depth + 1);
      return base === 2 && Number.isInteger(exponent) && exponent >= 0 && exponent <= 60 ? base ** exponent : null;
    }
    return null;
  };
  const seen = new Set();
  for (const testBinding of binding.testBindings ?? []) {
    const entry = testCodeEntries.find(item => item.path === testBinding.testPath);
    if (!entry) continue;
    for (const assertion of executableRejectionAssertions(entry.code, new Set([testBinding.testName]), false, true)) {
      if (assertion.mode !== "does-not-throw" || assertion.iterationBindings?.length) continue;
      try {
        const call = parseExpression(assertion.operation);
        if (call.type !== "CallExpression" || memberName(call.callee) !== testBinding.testName || call.arguments.length !== 2) continue;
        const args = call.arguments.map(node => number(node));
        if (args.some((value, index) => value === null || !Number.isInteger(value)
          || value < contract.domains.find(domain => domain.index === index).minimum)) continue;
        const total = args[calculation.numerator], size = args[calculation.denominator];
        if (total === 0) seen.add("zero");
        else if (Number.isSafeInteger(total) && Number.isSafeInteger(size)) seen.add(total % size === 0 ? "exact" : "fractional");
        // A non-safe Number quotient witnesses the stated Number behavior.
        // Source proof still requires Math.ceil of Number division everywhere.
        if (total > Number.MAX_SAFE_INTEGER && size > 1) seen.add("number-rounding");
      } catch { /* unsupported invocation does not supply a witness */ }
    }
  }
  return ["zero", "exact", "fractional", "number-rounding"].every(partition => seen.has(partition));
}

export function integerDomainEvidence({ taskText, bindings, sourceEntries, testCodeEntries }) {
  const contract = declaredIntegerDomains(taskText);
  if (!contract) return null;
  const bound = contract.supported && bindings.length === 1 && bindings[0].target === contract.target.toLowerCase();
  const rejectionEstablished = bound && sourceRejectionEstablished(contract, bindings[0], sourceEntries);
  const calculation = contract.supported ? declaredNumberCeiling(contract) : null;
  const calculationEstablished = Boolean(bound && calculation && sourceRejectionEstablished(contract, bindings[0], sourceEntries, calculation));
  const unprovedClauses = calculationEstablished ? [] : contract.unprovedClauses;
  const testOk = bound && testsEstablishDomains(contract, bindings[0], testCodeEntries)
    && (!calculation || numberCeilingWitnesses(contract, calculation, bindings[0], testCodeEntries));
  return { sourceOk: rejectionEstablished && unprovedClauses.length === 0, testOk,
    integerDomainProof: { rejectionEstablished, calculationEstablished,
      wholeCriterionEstablished: rejectionEstablished && testOk && unprovedClauses.length === 0,
      unprovedClauses, supported: contract.supported,
      domains: contract.domains.map(({ name, index, minimum }) => ({ name, index, minimum })) } };
}

export { assertionArguments as integerAssertionArguments, testNumericInputsStable as integerTestInputsStable };

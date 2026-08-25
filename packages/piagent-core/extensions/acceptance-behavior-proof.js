import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { criterionGraphValidationErrors } from "./criterion-graph.js";
import { regexCanStartAfterLexicalChunks } from "./javascript-regex-evidence.js";
import { normalizePathCandidate } from "./policy-core.js";

const BOUND_STRING = "__pi_bound_string_";
const BEHAVIOR_STOPWORDS = new Set([
  "after", "also", "before", "behavior", "change", "configured", "every", "first", "remain", "requested",
  "return", "shape", "standalone", "support", "value", "verification", "without"
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex");
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function durableBehaviorProofRequired(text, changeMode = "source-change") {
  const value = String(text ?? "");
  if (changeMode === "read-only") return false;
  return /\b(?:concurren|do not mutate|must not mutate|without mutating|return shape|returned? (?:element|object|value|representation)|preserve (?:the )?(?:api|input|output|return)|public api|exact error|typeerror|syntaxerror|rangeerror)\b/i.test(value);
}

function boundCriterionGraphNode(task, criterion) {
  if (!task?.criterionGraph || criterionGraphValidationErrors(task.criterionGraph, task).length > 0) return undefined;
  const criterionIndex = (Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : [])
    .findIndex((text) => typeof text === "string" && sha256(text) === criterion?.hash);
  return criterionIndex < 0 ? undefined : task.criterionGraph.nodes.find((node) => node.criterionIndex === criterionIndex);
}

function boundCriterionText(task, criterion) {
  return (Array.isArray(task?.acceptanceCriteria) ? task.acceptanceCriteria : [])
    .find((text) => typeof text === "string" && sha256(text) === criterion?.hash);
}

export function criterionRequiresBehavioralProof(task, criterion, taskText) {
  return durableBehaviorProofRequired(taskText, task?.changeMode)
    && boundCriterionGraphNode(task, criterion)?.proofKinds?.includes("behavioral-check") === true;
}

export function isVerificationOnlyCriterion(text) {
  const value = normalizedText(text).replace(/^\s*\[[^\]]+\]\s*/, "").trim();
  return /^(?:verify(?: the)? project|(?:run|execute|rerun|re-run)\s+(?:the\s+)?(?:(?:configured|exact|project|workspace|focused)\s+)?(?:verification(?: commands?)?|verifiers?|tests?|typecheck|lint|build)\b[\s\S]*|(?:the\s+)?(?:(?:configured|exact|project|workspace)\s+)?(?:verification(?: command)?|verifier|tests?|typecheck|lint|build)\b[\s\S]*\b(?:pass(?:es)?|run|succeed(?:s)?|verify)\b[\s\S]*)[.!?]*$/.test(value);
}

/* A small lexer used only to bind executable module strings and call inputs. */
function bindJavaScriptStrings(value) {
  const source = String(value ?? "");
  const output = [];
  const strings = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      while (index < source.length && !/[\r\n]/.test(source[index])) { output.push(" "); index += 1; }
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const limit = end < 0 ? source.length : end + 2;
      while (index < limit) { output.push(/[\r\n]/.test(source[index]) ? source[index] : " "); index += 1; }
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      let cursor = index + 1;
      let payload = "";
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === "\\") { payload += source.slice(cursor, cursor + 2); cursor += 2; continue; }
        if (source[cursor] === quote) { cursor += 1; closed = true; break; }
        payload += source[cursor]; cursor += 1;
      }
      if (closed) {
        output.push(`${BOUND_STRING}${strings.length}__`);
        strings.push(payload);
      } else {
        output.push(" ".repeat(Math.max(1, cursor - index)));
      }
      index = cursor;
      continue;
    }
    if (current === "`") {
      let cursor = index + 1;
      let payload = "";
      let closed = false;
      let interpolated = false;
      while (cursor < source.length) {
        if (source[cursor] === "\\") { payload += source.slice(cursor, cursor + 2); cursor += 2; continue; }
        if (source[cursor] === "$" && source[cursor + 1] === "{") interpolated = true;
        if (source[cursor] === "`") { cursor += 1; closed = true; break; }
        payload += source[cursor]; cursor += 1;
      }
      if (closed && !interpolated) {
        output.push(`${BOUND_STRING}${strings.length}__`);
        strings.push(payload);
      } else {
        output.push(" ".repeat(Math.max(1, cursor - index)));
      }
      index = cursor;
      continue;
    }
    if (current === "/" && next !== "=" && regexCanStartAfterLexicalChunks(output)) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        if (source[cursor] === "\\") { cursor += 2; continue; }
        if (source[cursor] === "[") inClass = true;
        else if (source[cursor] === "]") inClass = false;
        else if (source[cursor] === "/" && !inClass) { cursor += 1; while (/[a-z]/i.test(source[cursor] ?? "")) cursor += 1; closed = true; break; }
        else if (/[\r\n]/.test(source[cursor])) break;
        cursor += 1;
      }
      if (closed) {
        output.push(" ".repeat(Math.max(1, cursor - index)));
        index = cursor;
        continue;
      }
    }
    output.push(current);
    index += 1;
  }
  return { code: output.join(""), strings };
}

function boundStringValue(token, strings) {
  const index = Number(String(token ?? "").match(/^__pi_bound_string_(\d+)__$/)?.[1]);
  return Number.isInteger(index) ? strings[index] : undefined;
}

function moduleRecords(entry) {
  const evidence = String(entry.evidenceText ?? "");
  if (!/\b(?:import|export|require)\b[\s\S]{0,260}\b__pi_[a-z0-9_]+__/i.test(evidence)) return [];
  const { code, strings } = bindJavaScriptStrings(entry.text);
  const records = [];
  const token = "(__pi_bound_string_[0-9]+__)";
  const patterns = [
    { kind: "module", pattern: new RegExp(`\\b(?:import|export)\\s+([\\s\\S]{0,220}?)\\s+from\\s+${token}`, "g") },
    { kind: "side-effect", pattern: new RegExp(`\\bimport\\s*(?:\\(\\s*)?${token}`, "g") },
    { kind: "require", pattern: new RegExp(`\\b(?:const|let|var)\\s+([^=;\\n]{1,160})=\\s*require\\s*\\(\\s*${token}`, "g") }
  ];
  for (const { kind, pattern } of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = boundStringValue(match.at(-1), strings);
      if (typeof specifier === "string") records.push({ kind, clause: match[1] ?? "", specifier });
    }
  }
  return records;
}

function importedBindings(record) {
  const bindings = [];
  const clause = record.clause.trim();
  for (const match of clause.matchAll(/(?:^|[{,])\s*([a-z_$][a-z0-9_$]*)\s*(?:as\s+([a-z_$][a-z0-9_$]*))?/gi)) {
    bindings.push({ exported: match[1], local: match[2] ?? match[1] });
  }
  const namespace = clause.match(/\*\s+as\s+([a-z_$][a-z0-9_$]*)/i)?.[1];
  if (namespace) bindings.push({ exported: "*", local: namespace });
  const defaultBinding = clause.match(/^([a-z_$][a-z0-9_$]*)\s*(?:,|$)/i)?.[1];
  if (defaultBinding && !bindings.some((item) => item.local === defaultBinding)) {
    bindings.push({ exported: "default", local: defaultBinding });
  }
  if (record.kind === "require") {
    for (const match of clause.matchAll(/(?:^|[{,])\s*([a-z_$][a-z0-9_$]*)\s*(?::\s*([a-z_$][a-z0-9_$]*))?/gi)) {
      bindings.push({ exported: match[1], local: match[2] ?? match[1] });
    }
  }
  return bindings;
}

function exportedNames(sourceEntries) {
  const names = new Set();
  for (const entry of sourceEntries) {
    const text = String(entry.evidenceText ?? "");
    for (const match of text.matchAll(/\bexport\s+(?:async\s+)?(?:function|class|const|let|var)\s+([a-z_$][a-z0-9_$]*)/gi)) names.add(match[1]);
    for (const match of text.matchAll(/\bexport\s*\{([^}]+)\}/gi)) {
      for (const item of match[1].split(",")) {
        const name = item.trim().match(/(?:^|\s+as\s+)([a-z_$][a-z0-9_$]*)$/i)?.[1];
        if (name) names.add(name);
      }
    }
    for (const match of text.matchAll(/\b(?:module\.exports|exports)\.([a-z_$][a-z0-9_$]*)\s*=/gi)) names.add(match[1]);
  }
  return names;
}

function resolvedSpecifierMatchesSource(testPath, specifier, sourceFiles) {
  if (!specifier.startsWith(".")) return false;
  const resolved = normalizePathCandidate(path.posix.normalize(path.posix.join(path.posix.dirname(testPath), specifier)));
  const candidates = new Set([resolved, resolved.replace(/\.[a-z0-9]+$/i, "")]);
  for (const source of sourceFiles.map((file) => normalizePathCandidate(file))) {
    const stem = source.replace(/\.[a-z0-9]+$/i, "");
    if (candidates.has(source) || candidates.has(stem) || stem === `${resolved.replace(/\/$/, "")}/index`) return true;
  }
  return false;
}

/* linked = proven; unknown = alias/barrel/indirect may be valid; unlinked = only unrelated imports. */
function testSourceLinkage(corpus) {
  const sourceExports = exportedNames(corpus.sourceEntries);
  const linkedEntries = [];
  let unresolvedProjectImport = false;
  for (const entry of corpus.testEntries) {
    const records = moduleRecords(entry);
    const callables = new Set();
    let linked = false;
    for (const record of records) {
      const bindings = importedBindings(record);
      if (resolvedSpecifierMatchesSource(entry.path, record.specifier, corpus.sourceFiles)) {
        linked = true;
        for (const binding of bindings) {
          if (binding.exported === "*") sourceExports.forEach((name) => callables.add(`${binding.local}.${name}`));
          else callables.add(binding.local);
        }
        continue;
      }
      if (record.specifier.startsWith(".") || /^[#@~]/.test(record.specifier)) unresolvedProjectImport = true;
    }
    if (linked) linkedEntries.push({ entry, callables: [...callables] });
  }
  if (linkedEntries.length > 0) return { status: "linked", entries: linkedEntries };
  return { status: unresolvedProjectImport ? "unknown" : "unlinked", entries: [] };
}

function balancedCallEnd(code, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === "(") depth += 1;
    else if (code[index] === ")" && --depth === 0) return index + 1;
  }
  return -1;
}

function assertionSlices(code) {
  const assertions = [];
  const pattern = /\b(?:assert(?:\.[a-z][a-z0-9_]*)?|expect)\s*\(/gi;
  for (const match of code.matchAll(pattern)) {
    const open = code.indexOf("(", match.index);
    let end = balancedCallEnd(code, open);
    if (end < 0) continue;
    if (/\bexpect\s*\(/i.test(match[0])) {
      const statementEnd = code.slice(end).search(/[;\r\n]/);
      if (statementEnd >= 0) end += statementEnd;
    }
    assertions.push({ start: match.index, end, code: code.slice(match.index, end) });
  }
  return assertions;
}

function assignedCallNames(code, callStart) {
  const prefix = code.slice(Math.max(0, callStart - 160), callStart);
  return [
    prefix.match(/\b(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*(?:await\s*)?$/i)?.[1],
    prefix.match(/\b([a-z_$][a-z0-9_$]*)\s*=\s*(?:await\s*)?$/i)?.[1]
  ].filter(Boolean);
}

function nextBindingWrite(code, name, after) {
  const escaped = escapeRegex(name);
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=|\\b${escaped}\\s*=(?!=|>)`, "g");
  pattern.lastIndex = after;
  return pattern.exec(code)?.index ?? Number.POSITIVE_INFINITY;
}

function callArgumentNames(slice) {
  const body = slice.slice(slice.indexOf("(") + 1, -1);
  return [...body.matchAll(/(?:^|,)\s*([a-z_$][a-z0-9_$]*)\s*(?=,|$)/gi)].map((match) => match[1]);
}

function callableSlices(code, strings, callables) {
  const calls = [];
  const assertions = assertionSlices(code);
  for (const callable of callables) {
    const pattern = new RegExp(`\\b${escapeRegex(callable)}\\s*\\(`, "g");
    for (const match of code.matchAll(pattern)) {
      const open = code.indexOf("(", match.index);
      const end = balancedCallEnd(code, open);
      if (end < 0) continue;
      const slice = code.slice(match.index, end);
      const values = [...slice.matchAll(/__pi_bound_string_[0-9]+__/g)]
        .map((item) => boundStringValue(item[0], strings)).filter((item) => typeof item === "string");
      const argumentNames = callArgumentNames(slice);
      const resultNames = [...new Set(assignedCallNames(code, match.index))];
      const bindingNames = [...resultNames, ...argumentNames];
      const resultWriteLimits = new Map(resultNames.map((name) => [name, nextBindingWrite(code, name, end)]));
      const boundAssertions = assertions.filter((assertion) => (
        (assertion.start <= match.index && assertion.end >= end)
        || assertion.start >= end && bindingNames.some((name) => (
          new RegExp(`\\b${escapeRegex(name)}\\b`).test(assertion.code)
          && (!resultWriteLimits.has(name) || assertion.start < resultWriteLimits.get(name))
        ))
      ));
      const assertionValues = boundAssertions.flatMap((assertion) => (
        [...assertion.code.matchAll(/__pi_bound_string_[0-9]+__/g)]
          .map((item) => boundStringValue(item[0], strings)).filter((item) => typeof item === "string")
      ));
      if (boundAssertions.length > 0) calls.push({
        slice, values, strings, resultNames, argumentNames, assertionValues, prelude: code.slice(0, match.index),
        assertions: boundAssertions.map((item) => item.code)
      });
    }
  }
  return calls;
}

function splitTopLevel(value) {
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

function assertionComparisons(call) {
  return call.assertions.flatMap((assertion) => {
    const assertCall = assertion.match(/^\s*assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/i);
    if (assertCall) {
      const open = assertion.indexOf("(", assertCall.index);
      const end = balancedCallEnd(assertion, open);
      const [actual, expected] = end > open ? splitTopLevel(assertion.slice(open + 1, end - 1)) : [];
      return actual && expected ? [{ actual, expected }] : [];
    }
    const expectCall = assertion.match(/^\s*expect\s*\(/i);
    if (!expectCall) return [];
    const open = assertion.indexOf("(", expectCall.index);
    const end = balancedCallEnd(assertion, open);
    const matcher = end > open ? assertion.slice(end).match(/^\s*\.to(?:Be|Equal|StrictEqual)\s*\(/i) : undefined;
    if (!matcher) return [];
    const expectedOpen = assertion.indexOf("(", end + matcher.index);
    const expectedEnd = balancedCallEnd(assertion, expectedOpen);
    return expectedEnd > expectedOpen ? [{ actual: assertion.slice(open + 1, end - 1).trim(), expected: assertion.slice(expectedOpen + 1, expectedEnd - 1).trim() }] : [];
  });
}

function exactBoundValue(expression, strings) {
  const value = String(expression ?? "").trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return boundStringValue(value, strings);
}

function propertyExpression(objectExpression, property, strings) {
  const value = String(objectExpression ?? "").trim();
  if (!(value.startsWith("{") && value.endsWith("}"))) return undefined;
  for (const member of splitTopLevel(value.slice(1, -1))) {
    const colon = member.indexOf(":");
    if (colon < 0) continue;
    const key = member.slice(0, colon).trim();
    if (key === property || boundStringValue(key, strings) === property) return member.slice(colon + 1).trim();
  }
  return undefined;
}

function callResultExpression(call, expression) {
  const value = String(expression ?? "");
  return call.resultNames.some((name) => new RegExp(`^\\s*${escapeRegex(name)}\\b`).test(value)) || value.includes(call.slice);
}

function actualField(call, actual, container, field) {
  if (!callResultExpression(call, actual)) return false;
  const dot = new RegExp(`\\.${escapeRegex(container)}\\s*\\.\\s*${escapeRegex(field)}\\b`);
  if (dot.test(actual)) return true;
  const bracket = new RegExp(`\\.${escapeRegex(container)}\\s*\\[\\s*(__pi_bound_string_[0-9]+__)\\s*\\]`).exec(actual);
  return bracket ? boundStringValue(bracket[1], call.strings) === field : false;
}

function actualContainer(call, actual, container) {
  return callResultExpression(call, actual) && new RegExp(`\\.${escapeRegex(container)}\\s*$`).test(actual);
}

function actualWholeResult(call, actual) {
  const value = String(actual ?? "").trim();
  return call.resultNames.includes(value) || value === call.slice;
}

function expectedValueMatches(expression, expected, strings) {
  return exactBoundValue(expression, strings) === expected;
}

function assertedFlagValue(call, flag, expected) {
  return assertionComparisons(call).some(({ actual, expected: asserted }) => {
    if (actualField(call, actual, "flags", flag)) return expectedValueMatches(asserted, expected, call.strings);
    const flags = actualContainer(call, actual, "flags") ? asserted
      : actualWholeResult(call, actual) ? propertyExpression(asserted, "flags", call.strings) : undefined;
    const field = propertyExpression(flags, flag, call.strings);
    return field !== undefined && expectedValueMatches(field, expected, call.strings);
  });
}

function exactStringArray(expression, strings) {
  const value = String(expression ?? "").trim();
  if (!(value.startsWith("[") && value.endsWith("]"))) return undefined;
  const items = splitTopLevel(value.slice(1, -1));
  if (items.length === 1 && items[0] === "") return [];
  const resolved = items.map((item) => boundStringValue(item, strings));
  return resolved.every((item) => typeof item === "string") ? resolved : undefined;
}

function assertedPositionalSuffix(call, suffix) {
  return assertionComparisons(call).some(({ actual, expected }) => {
    const positional = actualContainer(call, actual, "positional") ? expected
      : actualWholeResult(call, actual) ? propertyExpression(expected, "positional", call.strings) : undefined;
    const observed = exactStringArray(positional, call.strings);
    return observed !== undefined && JSON.stringify(observed) === JSON.stringify(suffix);
  });
}

function repeatedFlagExpectedValue(values) {
  const flags = [];
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (token === "--") break;
    if (!/^--[^=\s]+/.test(token)) continue;
    const equals = token.indexOf("=");
    if (equals >= 0) flags.push({ name: token.slice(0, equals), value: token.slice(equals + 1) });
    else if (values[index + 1] !== undefined && !/^--/.test(values[index + 1])) {
      flags.push({ name: token, value: values[index + 1] });
      index += 1;
    } else flags.push({ name: token, value: true });
  }
  const repeated = flags.filter((flag, index) => flags.some((other, otherIndex) => otherIndex < index && other.name === flag.name));
  return repeated.at(-1);
}

function preCallSnapshotName(call, argument) {
  const escaped = escapeRegex(argument);
  const deepPatterns = [
    new RegExp(`\\b(?:const|let)\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*structuredClone\\s*\\(\\s*${escaped}\\s*\\)`, "gi"),
    new RegExp(`\\b(?:const|let)\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*JSON\\.parse\\s*\\(\\s*JSON\\.stringify\\s*\\(\\s*${escaped}\\s*\\)\\s*\\)`, "gi")
  ];
  const deep = deepPatterns.flatMap((pattern) => [...call.prelude.matchAll(pattern)].map((match) => match[1])).at(-1);
  if (deep) return deep;
  const declaration = [...call.prelude.matchAll(new RegExp(`\\b(?:const|let)\\s+${escaped}\\s*=\\s*\\[([^\\]]*)\\]`, "gi"))].at(-1);
  const primitiveIndexFactory = new RegExp("\\b(?:const|let)\\s+" + escaped + "\\s*=\\s*Array\\.from\\s*\\(\\s*\\{\\s*length\\s*:\\s*\\d+\\s*\\}\\s*,\\s*\\(\\s*[a-z_$][a-z0-9_$]*\\s*,\\s*([a-z_$][a-z0-9_$]*)\\s*\\)\\s*=>\\s*\\1\\s*\\)", "i").test(call.prelude);
  const primitiveElements = primitiveIndexFactory || declaration && splitTopLevel(declaration[1]).every((item) => {
    const value = item.trim();
    return value === "" || exactBoundValue(value, call.strings) !== undefined
      || /^(?:true|false|null|undefined|[-+]?\\d+(?:\\.\\d+)?n?)$/.test(value);
  });
  if (!primitiveElements) return undefined;
  const shallowPatterns = [
    new RegExp(`\\b(?:const|let)\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*\\[\\s*\\.\\.\\.\\s*${escaped}\\s*\\]`, "gi"),
    new RegExp(`\\b(?:const|let)\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*${escaped}\\.(?:slice|concat)\\s*\\(\\s*\\)`, "gi"),
    new RegExp(`\\b(?:const|let)\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*Array\\.from\\s*\\(\\s*${escaped}\\s*\\)`, "gi")
  ];
  return shallowPatterns.flatMap((pattern) => [...call.prelude.matchAll(pattern)].map((match) => match[1])).at(-1);
}

function nonMutationAssertion(call) {
  return call.argumentNames.some((argument) => {
    const snapshot = preCallSnapshotName(call, argument);
    if (!snapshot) return false;
    return call.assertions.some((assertion) => (
      new RegExp(`\\bassert\\.(?:deepEqual|deepStrictEqual|strictEqual)\\s*\\(\\s*${escapeRegex(argument)}\\s*,\\s*${escapeRegex(snapshot)}\\b`, "i").test(assertion)
      || new RegExp(`\\bexpect\\s*\\(\\s*${escapeRegex(argument)}\\s*\\)\\s*\\.to(?:Strict)?Equal\\s*\\(\\s*${escapeRegex(snapshot)}\\b`, "i").test(assertion)
    ));
  });
}

function definedExpectedExpression(expression, strings, prelude = "") {
  const value = String(expression ?? "").trim();
  if (!value || /^(?:undefined|null|void\b)/i.test(value)) return false;
  const identifier = value.match(/^[a-z_$][a-z0-9_$]*$/i)?.[0];
  if (identifier && new RegExp(`\\b(?:const|let)\\s+${escapeRegex(identifier)}\\s*=\\s*(?:\\{|\\[|true\\b|false\\b|[-+]?\\d|${BOUND_STRING})`, "i").test(prelude)) return true;
  return exactBoundValue(value, strings) !== undefined
    || /^(?:true|false|[-+]?\d+(?:\.\d+)?n?|\{|\[)/.test(value);
}

function positiveDefinedPredicate(call, expression, field) {
  const value = String(expression ?? "").trim();
  if (actualContainer(call, value, field)) return true;
  const arrayCheck = value.match(/^Array\.isArray\s*\(([\s\S]+)\)$/i);
  if (arrayCheck && actualContainer(call, arrayCheck[1], field)) return true;
  const comparison = value.match(/^([\s\S]+?)\s*(===|==|!==|!=)\s*([\s\S]+)$/);
  if (!comparison || !actualContainer(call, comparison[1], field)) return false;
  const expected = comparison[3].trim();
  if (comparison[2] === "!==" && expected === "undefined") return true;
  if (comparison[2] === "!=" && /^(?:undefined|null)$/.test(expected)) return true;
  return ["===", "=="].includes(comparison[2]) && definedExpectedExpression(expected, call.strings, call.prelude);
}

function assertionProvesDefinedField(call, field) {
  if (assertionComparisons(call).some(({ actual, expected }) => {
    if (actualContainer(call, actual, field)) return definedExpectedExpression(expected, call.strings, call.prelude);
    if (!actualWholeResult(call, actual)) return false;
    const fieldValue = propertyExpression(expected, field, call.strings);
    return fieldValue !== undefined && definedExpectedExpression(fieldValue, call.strings, call.prelude);
  })) return true;
  return call.assertions.some((assertion) => {
    const ok = assertion.match(/^\s*assert\.ok\s*\(/i);
    if (ok) {
      const open = assertion.indexOf("(", ok.index);
      const end = balancedCallEnd(assertion, open);
      return end > open && positiveDefinedPredicate(call, assertion.slice(open + 1, end - 1), field);
    }
    const expected = assertion.match(/^\s*expect\s*\(/i);
    if (!expected) return false;
    const open = assertion.indexOf("(", expected.index);
    const end = balancedCallEnd(assertion, open);
    return end > open && actualContainer(call, assertion.slice(open + 1, end - 1), field)
      && /^\s*\.toBeDefined\s*\(/i.test(assertion.slice(end));
  });
}

function linkedTestEvidence(linkage) {
  const profiles = [];
  for (const { entry, callables } of linkage.entries) {
    if (!/\b(?:assert(?:\.[a-z][a-z0-9_]*)?\s*\(|expect\s*\()/i.test(entry.evidenceText)) continue;
    const bound = bindJavaScriptStrings(entry.text);
    const calls = callableSlices(bound.code, bound.strings, callables);
    if (calls.length > 0) profiles.push({ path: entry.path, code: bound.code, calls, callables });
  }
  return profiles;
}

function shellTokens(command) {
  return (String(command ?? "").match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [])
    .map((token) => token.replace(/^(['"])([\s\S]*)\1$/, "$2"));
}

function shellStructure(command) {
  const value = String(command ?? ""), segments = [], operators = [];
  let quote = "", escaped = false, start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const token = value[index];
    if (escaped) { escaped = false; continue; }
    if (token === "\\") { escaped = true; continue; }
    if (quote) { if (token === quote) quote = ""; continue; }
    if (token === "'" || token === '"') { quote = token; continue; }
    const pair = value.slice(index, index + 2);
    const width = ["&&", "||", "|&"].includes(pair) ? 2
      : token === ";" || token === "\n" || token === "|" || (token === "&" && !/[<>]/.test(value[index - 1] ?? "")) ? 1 : 0;
    if (!width) continue;
    if (value.slice(start, index).trim()) segments.push(value.slice(start, index).trim());
    operators.push(value.slice(index, index + width));
    start = index + width; index += width - 1;
  }
  if (value.slice(start).trim()) segments.push(value.slice(start).trim());
  return { segments, operators };
}

function shellSegments(command) { return shellStructure(command).segments; }

function workspacePredicatePath(cwd, candidate, executable) {
  if (typeof cwd !== "string" || !cwd) return false;
  const relative = normalizePathCandidate(String(candidate ?? "").replace(/^\.\//, ""));
  if (!relative || path.isAbsolute(relative) || relative.split("/").includes("..")) return false;
  try {
    const target = path.join(cwd, relative);
    if (executable) { fs.accessSync(target, fs.constants.X_OK); return fs.statSync(target).isFile(); }
    return fs.statSync(target).isFile();
  } catch { return false; }
}

function commandAvailable(command) {
  const name = String(command ?? "");
  return /^[a-z0-9_.-]+$/i.test(name) && String(process.env.PATH ?? "").split(path.delimiter).some((directory) => {
    try { fs.accessSync(path.join(directory, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function safeConditionPart(part, cwd) {
  const value = String(part ?? "").trim();
  const file = value.match(/^test\s+-(f|x)\s+([^\s]+)$/i);
  if (file) return workspacePredicatePath(cwd, file[2], file[1].toLowerCase() === "x");
  const available = value.match(/^command\s+-v\s+([a-z0-9_.-]+)(?:\s+>\/dev\/null\s+2>&1)?$/i);
  if (available) return commandAvailable(available[1]);
  if (/^node\s+-e\b/.test(value) && /scripts?\|\|\{\}/.test(value) && /s\.test\?0:1/.test(value)) {
    try { return typeof JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))?.scripts?.test === "string"; } catch { return false; }
  }
  return value === "true";
}

function verifierWorkingDirectory(cwd, body) {
  const target = body.map((segment) => segment.match(/^cd\s+([^\s]+)$/)?.[1]).find(Boolean);
  if (!target) return cwd;
  const relative = normalizePathCandidate(String(target).replace(/^\.\//, ""));
  const resolved = relative && cwd ? path.resolve(cwd, relative) : "";
  try {
    return resolved && !path.relative(cwd, resolved).split(path.sep).includes("..") && fs.statSync(resolved).isDirectory() ? resolved : undefined;
  } catch { return undefined; }
}

function executableVerifierPlan(command, cwd) {
  const { segments, operators } = shellStructure(command);
  if (operators.some((operator) => ["||", "|", "|&", "&"].includes(operator))) return { segments: [], cwd };
  let cursor = segments.findIndex((segment) => /^if\b/.test(segment));
  if (cursor < 0) return { segments: operators.some((operator) => operator === ";" || operator === "\n") ? [] : segments, cwd };
  let selected;
  while (cursor >= 0 && cursor < segments.length) {
    const marker = segments[cursor].match(/^(?:if|elif)\s+([\s\S]+)$/);
    if (!marker) return { segments: [], cwd };
    const condition = [marker[1]];
    cursor += 1;
    while (cursor < segments.length && !/^then\b/.test(segments[cursor])) condition.push(segments[cursor++]);
    if (cursor >= segments.length) return { segments: [], cwd };
    const body = [segments[cursor].replace(/^then\s*/, "")].filter(Boolean);
    cursor += 1;
    while (cursor < segments.length && !/^(?:elif|else|fi)\b/.test(segments[cursor])) body.push(segments[cursor++]);
    if (condition.every((part) => safeConditionPart(part, cwd))) { selected = body; break; }
    if (!/^elif\b/.test(segments[cursor] ?? "")) return { segments: [], cwd };
  }
  const end = segments.findIndex((segment, index) => index >= cursor && /^fi\b/.test(segment));
  const selectedCwd = selected && verifierWorkingDirectory(cwd, selected);
  return !selected || end < 0 || !selectedCwd ? { segments: [], cwd }
    : { segments: [...selected, ...segments.slice(end + 1)], cwd: selectedCwd };
}

function testPathMatchesToken(testPath, token) {
  const candidate = normalizePathCandidate(String(token ?? "").replace(/^\.\//, ""));
  const target = normalizePathCandidate(testPath);
  if (!/[?*]/.test(candidate)) return candidate === target;
  const pattern = escapeRegex(candidate).replace(/\\\*\\\*\//g, "(?:.*/)?").replace(/\\\*\\\*/g, ".*").replace(/\\\*/g, "[^/]*").replace(/\\\?/g, "[^/]");
  return new RegExp(`^${pattern}$`).test(target);
}

function testRunnerArguments(segment) {
  const tokens = shellTokens(segment).filter((token) => !["then", "do"].includes(token));
  while (/^[a-z_][a-z0-9_]*=/i.test(tokens[0] ?? "")) tokens.shift();
  if (/^(?:npm|pnpm|yarn|bun)$/.test(tokens[0] ?? "")) {
    const scriptIndex = tokens[1] === "run" ? 2 : 1, script = tokens[scriptIndex];
    if (script === "test") return { args: tokens.slice(scriptIndex + 1).filter((token) => token !== "--" && token !== "--if-present") };
    if (/^test:[a-z0-9_.-]+$/i.test(script ?? "")) return { args: [], packageScript: script };
    return undefined;
  }
  const joined = tokens.join(" ");
  const runners = [
    /^node --test\b/, /^(?:uv run |python -m )?pytest\b/,
    /^(?:npx )?(?:vitest(?: run)?|jest|playwright test|cypress run)\b/
  ];
  for (const runner of runners) {
    const match = joined.match(runner);
    if (match) return { args: shellTokens(joined.slice(match[0].length)).filter((token) => token !== "--") };
  }
  if (/^(?:flutter test|\.\/(?:mvnw|gradlew) test)$/.test(joined)) return { args: [] };
  return undefined;
}

function packageTestScriptCovers(cwd, scriptName, testPath) {
  if (typeof cwd !== "string" || !cwd) return false;
  try {
    const script = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"))?.scripts?.[scriptName];
    const structure = shellStructure(script);
    return typeof script === "string" && structure.segments.length === 1 && structure.operators.length === 0
      && verifierSegmentCoversTest(structure.segments[0], testPath, cwd, false);
  } catch { return false; }
}

function verifierSegmentCoversTest(segment, testPath, cwd, allowPackageScript = true) {
  const runner = testRunnerArguments(segment);
  if (!runner || runner.packageScript && !allowPackageScript) return false;
  if (runner.packageScript) return packageTestScriptCovers(cwd, runner.packageScript, testPath);
  if (/(?:^|\s)--if-present(?:\s|$)/.test(segment) && !packageTestScriptCovers(cwd, "test", testPath)) return false;
  const pathArguments = runner.args.filter((token) => !token.startsWith("-"));
  return pathArguments.length === 0 || pathArguments.some((token) => testPathMatchesToken(testPath, token));
}

export function verifierCommandsCoverTests(task, testPaths, cwd) {
  const commands = (Array.isArray(task?.verifyCommands) ? task.verifyCommands : []).filter((command) => typeof command === "string");
  return testPaths.length > 0 && testPaths.every((testPath) => commands.some((command) => {
    const plan = executableVerifierPlan(command, cwd);
    const prefix = normalizePathCandidate(cwd && plan.cwd ? path.relative(cwd, plan.cwd).replaceAll("\\", "/") : "");
    const normalizedTest = normalizePathCandidate(testPath);
    const relativeTest = prefix ? normalizedTest.startsWith(prefix + "/") ? normalizedTest.slice(prefix.length + 1) : "" : normalizedTest;
    return Boolean(relativeTest) && plan.segments.some((segment) => verifierSegmentCoversTest(segment, relativeTest, plan.cwd));
  }));
}

function criterionBehaviorMatches(task, criterion, profiles, sourceFiles) {
  const rawCriterion = boundCriterionText(task, criterion);
  if (!rawCriterion || profiles.length === 0) return false;
  const text = normalizedText(rawCriterion);
  const calls = profiles.flatMap((profile) => profile.calls);
  const code = calls.flatMap((call) => call.assertions).join("\n");
  const requirements = [];
  if (rawCriterion.split(";").filter((clause) => clause.trim()).length > 1) return false;
  if (/\bfocused\s+tests?\b/.test(text)) requirements.push(calls.length > 0);
  if (/--[a-z0-9_-]+=[a-z0-9_<[{]/i.test(text) || /\bname\s*=\s*value\b/.test(text)) {
    requirements.push(calls.some((call) => call.values.some((value) => {
      const match = value.match(/^--([^=\s]+)=(.+)$/);
      return match ? assertedFlagValue(call, match[1], match[2]) : false;
    })));
  }
  if (/--[a-z0-9_-]+\s+(?:value|<[^>]+>)/i.test(text)) {
    requirements.push(calls.some((call) => call.values.some((value, index) => {
      const name = value.match(/^--([^=\s]+)$/)?.[1], expected = call.values[index + 1];
      return name && expected !== undefined && !/^--/.test(expected) && assertedFlagValue(call, name, expected);
    })));
  }
  if (/\bboolean\b[\s\S]{0,30}--[a-z0-9_-]+/i.test(text)) {
    requirements.push(calls.some((call) => call.values.some((value, index) => {
      const name = value.match(/^--([^=\s]+)$/)?.[1];
      return name && (call.values[index + 1] === undefined || /^--/.test(call.values[index + 1]))
        && assertedFlagValue(call, name, true);
    })));
  }
  if (/\bstandalone\s+`?--`?(?=\s|$)|`?--`?\s+(?:ends?|stops?)\s+flag/i.test(text)) {
    requirements.push(calls.some((call) => {
      const delimiter = call.values.indexOf("--"), suffix = call.values.slice(delimiter + 1);
      return delimiter >= 0 && suffix.length > 0 && assertedPositionalSuffix(call, suffix);
    }));
  }
  if (/\bflag\s+followed\s+by\s+another\s+flag\b/.test(text)) {
    requirements.push(calls.some((call) => call.values.some((value, index) => {
      const name = value.match(/^--([^=\s]+)$/)?.[1];
      return name && /^--[^=\s]+$/.test(call.values[index + 1] ?? "") && assertedFlagValue(call, name, true);
    })));
  }
  if (/\brepeated?\s+flags?\b|\blast\s+value\b/.test(text)) {
    requirements.push(calls.some((call) => {
      const expected = repeatedFlagExpectedValue(call.values);
      return expected !== undefined && assertedFlagValue(call, expected.name.slice(2), expected.value);
    }));
  }
  if (/\b(?:do not|must not|without)\s+mutat|\bpreserve\s+(?:the\s+)?input/.test(text)) {
    requirements.push(calls.some(nonMutationAssertion));
  }
  if (/\breturn shape\b|\breturned? (?:object|representation)\b/.test(text)) {
    requirements.push(calls.some((call) => assertionProvesDefinedField(call, "flags")
      && assertionProvesDefinedField(call, "positional")));
  }
  if (/\bconcurren|\bparallel\b/.test(text)) requirements.push(/\bpromise\.all\s*\(|\ballsettled\s*\(/i.test(code));
  const errorClass = text.match(/\b(typeerror|syntaxerror|rangeerror)\b/)?.[1];
  if (errorClass) requirements.push(new RegExp(`\\b(?:assert\\.throws|rejects|tothrow)\\b[\\s\\S]{0,240}\\b${errorClass}\\b`, "i").test(code));
  if (requirements.length > 0) return requirements.every(Boolean);
  const names = new Set(profiles.flatMap((profile) => profile.callables).flatMap((name) => name.split(".")));
  const paths = [...sourceFiles, ...profiles.map((profile) => profile.path)].join("\n");
  const anchors = [...rawCriterion.matchAll(/\b[a-z_$][a-z0-9_$]{3,}\b/gi)]
    .map((match) => match[0]).filter((word) => !BEHAVIOR_STOPWORDS.has(word.toLowerCase()));
  return anchors.some((anchor) => names.has(anchor)
    || new RegExp(`\\b${escapeRegex(anchor)}\\b`, "i").test(code)
    || new RegExp(`(?:^|[/_.-])${escapeRegex(anchor)}(?:[/_.-]|$)`, "i").test(paths));
}

function behavioralFocusRequired(input) {
  if (input.obligation === "requested-behavior") {
    return criterionRequiresBehavioralProof(input.task, input.criterion, input.taskText)
      || input.criterion.priority === "critical";
  }
  return input.obligation === "backward-compatibility"
    && (criterionRequiresBehavioralProof(input.task, input.criterion, input.taskText) || input.criterion.priority === "critical");
}

export function criterionBehaviorProofDisposition(input) {
  if (!behavioralFocusRequired(input)) return "not-applicable";
  if (!input.passingVerifier) return "unlinked";
  if (!input.corpus.adapter.proofCapable) {
    return ["unsupported", "unresolved"].includes(input.corpus.adapter.status) ? "unknown" : "unlinked";
  }
  if (input.corpus.sourceFiles.length === 0 || input.corpus.testFiles.length === 0) return "unlinked";
  return testSourceLinkage(input.corpus).status;
}

function focusedBehaviorEvidence(input) {
  if (criterionBehaviorProofDisposition(input) !== "linked") return undefined;
  const linkage = testSourceLinkage(input.corpus);
  const profiles = linkedTestEvidence(linkage).filter((profile) => verifierCommandsCoverTests(input.task, [profile.path], input.cwd));
  if (!criterionBehaviorMatches(input.task, input.criterion, profiles, input.corpus.sourceFiles)) return undefined;
  return {
    ...input.verifierEvidence,
    kind: "verifier-backed-focused-test",
    summary: "Configured verifier passed with changed executable assertions tied to this criterion and changed source.",
    paths: [...new Set([...input.corpus.sourceFiles, ...profiles.map((profile) => profile.path)])]
  };
}

export function genericCriterionEvidence(input) {
  const behavioral = criterionRequiresBehavioralProof(input.task, input.criterion, input.taskText);
  if (input.obligation === "requested-behavior") {
    return { handled: true, evidence: behavioralFocusRequired(input)
      ? focusedBehaviorEvidence(input)
      : input.passingVerifier ? input.verifierEvidence : undefined };
  }
  if (input.obligation === "verification-evidence" || input.obligation === "backward-compatibility") {
    return { handled: true, evidence: behavioralFocusRequired(input) ? focusedBehaviorEvidence(input)
      : input.passingVerifier ? input.verifierEvidence : undefined };
  }
  return { handled: false, behavioral };
}

export function genericFallbackEvidence(input) {
  /* No criterion is available at this legacy fallback boundary: abstain for behavioral proof. */
  return input.behavioral ? undefined : input.passingVerifier ? input.verifierEvidence : undefined;
}

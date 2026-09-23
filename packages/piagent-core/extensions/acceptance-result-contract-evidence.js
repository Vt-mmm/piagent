import { finiteIntervalFallbackEvidence } from "./acceptance-temporal-contract.js";
import { normalizePathCandidate } from "./policy-core.js";

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function balancedEnd(code, openIndex, opening = "(", closing = ")") {
  let depth = 0;
  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === opening) depth += 1;
    else if (code[index] === closing && --depth === 0) return index + 1;
  }
  return -1;
}

function splitTopLevel(value) {
  const parts = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < value.length; index += 1) {
    const token = value[index];
    if (token === "(") round += 1;
    else if (token === ")") round -= 1;
    else if (token === "[") square += 1;
    else if (token === "]") square -= 1;
    else if (token === "{") curly += 1;
    else if (token === "}") curly -= 1;
    else if (token === "," && round === 0 && square === 0 && curly === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

function boundStringValue(token, strings) {
  const index = Number(String(token ?? "").match(/^__pi_bound_string_(\d+)__$/)?.[1]);
  return Number.isInteger(index) ? strings[index] : undefined;
}

function exactStringArray(expression, strings) {
  const value = String(expression ?? "").trim();
  if (!(value.startsWith("[") && value.endsWith("]"))) return undefined;
  const items = splitTopLevel(value.slice(1, -1));
  if (items.length === 1 && items[0] === "") return [];
  const resolved = items.map((item) => boundStringValue(item, strings));
  return resolved.every((item) => typeof item === "string") ? resolved : undefined;
}

function assertionComparisons(call) {
  return call.assertions.flatMap((assertion) => {
    const match = assertion.match(/^\s*assert\.(?:equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/i);
    if (!match) return [];
    const open = assertion.indexOf("(", match.index);
    const end = balancedEnd(assertion, open);
    const [actual, expected] = end > open ? splitTopLevel(assertion.slice(open + 1, end - 1)) : [];
    return actual && expected ? [{ actual, expected }] : [];
  });
}

function actualWholeResult(call, actual) {
  const value = String(actual ?? "").trim();
  return call.resultNames.includes(value) || value === call.slice;
}

function wholeResultStringArrays(call) {
  return assertionComparisons(call).flatMap(({ actual, expected }) => {
    if (!actualWholeResult(call, actual)) return [];
    const strings = exactStringArray(expected, call.strings);
    return strings === undefined ? [] : [strings];
  });
}

function callArgumentExpressions(call) {
  const open = call.slice.indexOf("(");
  const end = open >= 0 ? balancedEnd(call.slice, open) : -1;
  return end > open ? splitTopLevel(call.slice.slice(open + 1, end - 1)) : [];
}

function exactPositiveInteger(expression) {
  const value = String(expression ?? "").trim().replaceAll("_", "");
  if (!/^[+]?[0-9]+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function arrayExpressionLength(call, expression) {
  const value = String(expression ?? "").trim();
  let array = value;
  if (/^[a-z_$][a-z0-9_$]*$/i.test(value)) {
    const pattern = new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(value)}\\s*=\\s*\\[`, "gi");
    const declaration = [...call.prelude.matchAll(pattern)].at(-1);
    if (!declaration) return undefined;
    const open = call.prelude.indexOf("[", declaration.index + declaration[0].length - 1);
    const end = balancedEnd(call.prelude, open, "[", "]");
    if (end < 0) return undefined;
    array = call.prelude.slice(open, end);
  }
  if (!(array.startsWith("[") && array.endsWith("]"))) return undefined;
  const items = splitTopLevel(array.slice(1, -1));
  return items.length === 1 && items[0] === "" ? 0 : items.length;
}

function declaredFunction(sourceEntries, profile, call) {
  const binding = profile.bindings?.find((item) => item.testName === call.callable);
  const name = binding?.sourceName ?? call.callable.split(".").at(-1);
  const entries = binding
    ? sourceEntries.filter((entry) => normalizePathCandidate(entry.path) === binding.sourcePath)
    : sourceEntries;
  const pattern = new RegExp(`\\bfunction\\s+${escapeRegex(name)}\\s*\\(([^)]*)\\)\\s*\\{`, "i");
  for (const entry of entries) {
    const match = pattern.exec(entry.text);
    if (!match) continue;
    const open = entry.text.indexOf("{", match.index + match[0].length - 1);
    const end = balancedEnd(entry.text, open, "{", "}");
    const parameters = match[1].split(",").map((item) => item.trim());
    if (end > open && parameters.every((item) => /^[a-z_$][a-z0-9_$]*$/i.test(item))) {
      return { body: entry.text.slice(open + 1, end - 1), parameters };
    }
  }
  return undefined;
}

function returnExpressions(body) {
  return [...String(body ?? "").matchAll(/\breturn\s+([\s\S]{1,1200}?);/gi)].map((match) => match[1]);
}

function sourceResultContract(body, idsRequired, capParameter) {
  const idMap = /\.map\s*\(\s*(?:\(\s*)?([a-z_$][a-z0-9_$]*)\s*(?:\)\s*)?=>\s*(?:\{\s*return\s+)?\1\s*\.\s*id\b/i;
  const cap = capParameter
    ? new RegExp(`\\.slice\\s*\\(\\s*0\\s*,\\s*${escapeRegex(capParameter)}\\s*\\)`, "i")
    : undefined;
  return returnExpressions(body).some((expression) => (!idsRequired || idMap.test(expression)) && (!cap || cap.test(expression)));
}

export function acceptanceResultContractEvidence(rawCriterion, profiles, sourceEntries, contextText) {
  if (/^otherwise\s+return\b/i.test(String(rawCriterion).trim())) return finiteIntervalFallbackEvidence({ rawCriterion, profiles, sourceEntries, contextText });
  const text = String(rawCriterion ?? "").toLowerCase();
  const idsRequired = /\breturn(?:s|ed)?\s+only\b[^.;]{0,80}\bids?\b/.test(text);
  const capParameter = String(rawCriterion ?? "").match(/\bcapped\s+at\s+`?([a-z_$][a-z0-9_$]*)`?/i)?.[1];
  if (!idsRequired && !capParameter) return undefined;
  return profiles.some((profile) => profile.calls.some((call) => {
    const callable = declaredFunction(sourceEntries, profile, call);
    if (!callable) return false;
    const expectedArrays = wholeResultStringArrays(call);
    if (!sourceResultContract(callable.body, idsRequired, capParameter) || (idsRequired && expectedArrays.length === 0)) return false;
    if (!capParameter) return true;
    const parameterIndex = callable.parameters.indexOf(capParameter);
    const args = callArgumentExpressions(call);
    const cap = parameterIndex >= 0 ? exactPositiveInteger(args[parameterIndex]) : undefined;
    const inputLength = arrayExpressionLength(call, args[0]);
    return cap !== undefined && inputLength !== undefined && inputLength > cap
      && expectedArrays.some((expected) => expected.length === cap);
  }));
}

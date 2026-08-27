import { evidenceTopLevelArguments, executableRejectionAssertions,
  literalArrayIterationEnvironmentIsStable, testProofIntrinsicsAreStable } from "./acceptance-executable-evidence.js";
import { regexCanStartAfterLexicalChunks } from "./javascript-regex-evidence.js";

const ERROR_NAMES = new Set(["aggregateerror", "error", "evalerror", "rangeerror", "referenceerror", "syntaxerror", "typeerror", "urierror"]);
const DISCRIMINATORS = new Set(["eventtype", "kind", "tag", "type"]);

function escapeRegex(value) { return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function balancedEnd(text, open, opening = "(", closing = ")", ceiling = 8_000) {
  if (text[open] !== opening) return -1;
  let depth = 0;
  for (let index = open; index < Math.min(text.length, open + ceiling); index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing && --depth === 0) return index + 1;
  }
  return -1;
}
function braceDepthAt(text, offset) {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}
function normalize(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function stringToken(value, index) {
  if (value.length === 0) return "__pi_empty_string_literal__";
  const lower = value.trim().toLowerCase();
  if (["assert", "assert/strict", "node:assert", "node:assert/strict"].includes(lower)) return "__pi_node_assert_module_literal__";
  if (lower === "node:test") return "__pi_node_test_module_literal__";
  if (["node:process", "process"].includes(lower)) return "__pi_node_process_module_literal__";
  if (ERROR_NAMES.has(lower)) return `__pi_error_name_${lower}_literal__`;
  return `__pi_bound_string_${index}__`;
}

/** Erase comments/templates/regex while retaining bounded ordinary literal identities. */
function lexicalEvidence(value) {
  const source = String(value ?? ""), output = [], strings = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index], next = source[index + 1];
    if (current === "/" && next === "/") {
      let end = index + 2; while (end < source.length && !/[\r\n]/.test(source[end])) end += 1;
      output.push(" ".repeat(end - index)); index = end; continue;
    }
    if (current === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2), end = close === -1 ? source.length : close + 2;
      output.push(" ".repeat(end - index)); index = end; continue;
    }
    if (current === "'" || current === '"') {
      const quote = current; let end = index + 1, payload = "", closed = false;
      while (end < source.length) {
        if (source[end] === "\\") { payload += source.slice(end, end + 2); end += 2; continue; }
        if (source[end] === quote) { end += 1; closed = true; break; }
        payload += source[end++];
      }
      if (!closed) output.push(" ".repeat(end - index));
      else { const slot = strings.push(payload) - 1; output.push(stringToken(payload, slot)); }
      index = end; continue;
    }
    if (current === "`") {
      let end = index + 1, closed = false;
      while (end < source.length) {
        if (source[end] === "\\") { end += 2; continue; }
        if (source[end] === "`") { end += 1; closed = true; break; }
        end += 1;
      }
      output.push(closed ? "__pi_template_literal__" : " ".repeat(end - index)); index = end; continue;
    }
    if (current === "/" && next !== "=" && regexCanStartAfterLexicalChunks(output)) {
      let end = index + 1, inClass = false, closed = false;
      while (end < source.length) {
        if (source[end] === "\\") { end += 2; continue; }
        if (source[end] === "[") inClass = true;
        else if (source[end] === "]") inClass = false;
        else if (source[end] === "/" && !inClass) { end += 1; while (/[a-z]/iu.test(source[end] ?? "")) end += 1; closed = true; break; }
        else if (/[\r\n]/.test(source[end])) break;
        end += 1;
      }
      if (closed) { output.push("__pi_regex_literal__"); index = end; continue; }
    }
    output.push(current); index += 1;
  }
  const exactCode = output.join("");
  return { code: normalize(exactCode), exactCode, strings: strings.map(normalize), exactStrings: strings };
}

function callableBody(code, name) {
  const escaped = escapeRegex(name), matches = [];
  for (const match of code.matchAll(new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\s*\\(([^)]*)\\)\\s*\\{`, "g"))) {
    matches.push({ parameters: match[1], open: match.index + match[0].lastIndexOf("{") });
  }
  for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\(([^)]*)\\)|([a-z_$][a-z0-9_$]*))\\s*=>\\s*\\{`, "g"))) {
    matches.push({ parameters: match[1] ?? match[2], open: match.index + match[0].lastIndexOf("{") });
  }
  if (matches.length !== 1 || braceDepthAt(code, matches[0].open) !== 0) return undefined;
  const end = balancedEnd(code, matches[0].open, "{", "}");
  if (end === -1) return undefined;
  const parameters = matches[0].parameters.split(",").map((part) => part.trim().match(/^([a-z_$][a-z0-9_$]*)(?:\s*=.*)?$/)?.[1]);
  if (parameters.some((item) => !item) || parameters.length > 16) return undefined;
  return { body: code.slice(matches[0].open + 1, end - 1), parameters };
}

function boundString(token, strings) {
  const index = Number(String(token ?? "").match(/^__pi_bound_string_(\d+)__$/)?.[1]);
  return Number.isInteger(index) ? strings[index] : undefined;
}
function tagMatches(tag, variant) {
  return tag === variant;
}
function fieldKey(field) { return normalize(field); }
function qualifiedKey(variant, field, partition) { return `${variant}\u0000${field}\u0000${partition}`; }
function unwrappedBranchBody(value) {
  const body = String(value ?? "").trim();
  return body.startsWith("{") && balancedEnd(body, 0, "{", "}") === body.length ? body.slice(1, -1) : body;
}
function exactTagCondition(raw, strings) {
  const condition = stripOuterParentheses(raw);
  const tagged = condition.match(/^([a-z_$][a-z0-9_$]*)\s*\.\s*(type|kind|eventtype|tag)\s*===\s*(__pi_bound_string_\d+__)$/)
    ?? condition.match(/^(__pi_bound_string_\d+__)\s*===\s*([a-z_$][a-z0-9_$]*)\s*\.\s*(type|kind|eventtype|tag)$/);
  if (!tagged) return undefined;
  const reversed = tagged[1].startsWith("__pi_bound_string_"), root = reversed ? tagged[2] : tagged[1], token = reversed ? tagged[1] : tagged[3];
  const tag = boundString(token, strings);
  return tag ? { root, tag } : undefined;
}
function invalidContainerClause(raw, parameter, objectTokens) {
  const pattern = escapeRegex(parameter), value = stripOuterParentheses(raw);
  return new RegExp(`^!\\s*${pattern}$`).test(value)
    || new RegExp(`^(?:${pattern}\\s*(?:===|==)\\s*(?:null|undefined)|(?:null|undefined)\\s*(?:===|==)\\s*${pattern})$`).test(value)
    || (objectTokens.length > 0 && new RegExp(`^typeof\\s+${pattern}\\s*(?:!==|!=)\\s*(?:${objectTokens.map(escapeRegex).join("|")})$`).test(value))
    || new RegExp(`^array\\s*\\.\\s*isarray\\s*\\(\\s*${pattern}\\s*\\)$`).test(value);
}
function invalidEventContainerCondition(raw, root, strings, parameters) {
  const objectTokens = strings.flatMap((value, index) => value === "object" ? [`__pi_bound_string_${index}__`] : []);
  let sawRoot = false;
  for (const clause of topLevelDisjunction(raw)) {
    const owners = parameters.filter((parameter) => new RegExp(`\\b${escapeRegex(parameter)}\\b`).test(clause));
    if (owners.length !== 1 || !invalidContainerClause(clause, owners[0], objectTokens)) return false;
    if (owners[0] === root) sawRoot = true;
  }
  return sawRoot;
}
function parsedIfStatement(body, index) {
  if (!/^if\b/.test(body.slice(index))) return undefined;
  const open = body.indexOf("(", index), end = balancedEnd(body, open);
  if (open === -1 || end === -1) return undefined;
  let start = end; while (/\s/.test(body[start] ?? "")) start += 1;
  let finish;
  if (body[start] === "{") finish = balancedEnd(body, start, "{", "}");
  else {
    const semicolon = body.indexOf(";", start);
    finish = semicolon === -1 ? -1 : semicolon + 1;
  }
  return finish === -1 ? undefined : {
    condition: body.slice(open + 1, end - 1), consequent: body.slice(start, finish), end: finish
  };
}
function callablePrefixAllowsTag(body, offset, root, tag, strings, parameters) {
  let index = 0, priorDisjointTag = false;
  while (index < offset) {
    while (/\s/.test(body[index] ?? "")) index += 1;
    if (index >= offset) return true;
    if (priorDisjointTag && /^else\b/.test(body.slice(index))) {
      index += body.slice(index).match(/^else\b/)[0].length;
      while (/\s/.test(body[index] ?? "")) index += 1;
      return index === offset;
    }
    const statement = parsedIfStatement(body, index);
    if (!statement || statement.end > offset) return false;
    const priorTag = exactTagCondition(statement.condition, strings);
    if (priorTag?.root === root) {
      if (priorTag.tag === tag) return false;
      priorDisjointTag = true;
    } else if (!invalidEventContainerCondition(statement.condition, root, strings, parameters)
      || !directThrowStatement(statement.consequent)) return false;
    else priorDisjointTag = false;
    index = statement.end;
    if (body[index] === ";") index += 1;
  }
  return true;
}

function switchCaseTerminates(raw) {
  const value = unwrappedBranchBody(raw).trim();
  for (const match of value.matchAll(/\b(?:break|return|throw)\b/g)) {
    if (braceDepthAt(value, match.index) !== 0) continue;
    let boundary = 0, braces = 0, brackets = 0, parentheses = 0;
    for (let index = 0; index < match.index; index += 1) {
      const character = value[index];
      if (character === "{") braces += 1;
      else if (character === "}" && --braces === 0 && !brackets && !parentheses) boundary = index + 1;
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets -= 1;
      else if (character === "(") parentheses += 1;
      else if (character === ")") parentheses -= 1;
      else if (character === ";" && !braces && !brackets && !parentheses) boundary = index + 1;
    }
    if (value.slice(boundary, match.index).trim()) continue;
    braces = 0; brackets = 0; parentheses = 0;
    for (let index = match.index; index < value.length; index += 1) {
      const character = value[index];
      if (character === "{") braces += 1;
      else if (character === "}") braces -= 1;
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets -= 1;
      else if (character === "(") parentheses += 1;
      else if (character === ")") parentheses -= 1;
      else if (character === ";" && !braces && !brackets && !parentheses) {
        if (!value.slice(index + 1).trim()) return true;
        break;
      }
    }
  }
  return false;
}

function taggedBranches(callable, strings) {
  const branches = [];
  for (const match of callable.body.matchAll(/\bif\s*\(/g)) {
    if (braceDepthAt(callable.body, match.index) !== 0) continue;
    const open = callable.body.indexOf("(", match.index), end = balancedEnd(callable.body, open);
    if (end === -1) continue;
    const condition = callable.body.slice(open + 1, end - 1).trim(), tagged = exactTagCondition(condition, strings);
    if (!tagged) continue;
    const { root, tag } = tagged;
    if (!callable.parameters.includes(root)) continue;
    let start = end; while (/\s/.test(callable.body[start] ?? "")) start += 1;
    if (callable.body[start] !== "{") continue;
    const finish = balancedEnd(callable.body, start, "{", "}");
    if (finish !== -1 && callablePrefixAllowsTag(callable.body, match.index, root, tag, strings, callable.parameters)) {
      branches.push({ root, tag, body: callable.body.slice(start + 1, finish - 1) });
    }
  }
  for (const match of callable.body.matchAll(/\bswitch\s*\(/g)) {
    if (braceDepthAt(callable.body, match.index) !== 0) continue;
    const open = callable.body.indexOf("(", match.index), end = balancedEnd(callable.body, open);
    if (end === -1) continue;
    const subject = callable.body.slice(open + 1, end - 1).trim().match(/^([a-z_$][a-z0-9_$]*)\s*\.\s*(type|kind|eventtype|tag)$/);
    if (!subject || !callable.parameters.includes(subject[1])) continue;
    let start = end; while (/\s/.test(callable.body[start] ?? "")) start += 1;
    if (callable.body[start] !== "{") continue;
    const finish = balancedEnd(callable.body, start, "{", "}");
    if (finish === -1) continue;
    const body = callable.body.slice(start + 1, finish - 1);
    const labels = [...body.matchAll(/\b(?:case\s+(__pi_bound_string_\d+__)\s*:|default\s*:)/g)]
      .filter((label) => braceDepthAt(body, label.index) === 0);
    const caseBodies = labels.map((label, index) => body.slice(
      label.index + label[0].length, labels[index + 1]?.index ?? body.length
    ));
    if (caseBodies.slice(0, -1).some((branch) => !switchCaseTerminates(branch))) continue;
    for (let index = 0; index < labels.length; index += 1) {
      const token = labels[index][1], tag = token && boundString(token, strings);
      if (!tag || !callablePrefixAllowsTag(callable.body, match.index, subject[1], tag, strings, callable.parameters)) continue;
      branches.push({ root: subject[1], tag, body: unwrappedBranchBody(caseBodies[index]) });
    }
  }
  return branches.slice(0, 12);
}

function stringTypeTokens(strings) { return strings.flatMap((value, index) => value === "string" ? [`__pi_bound_string_${index}__`] : []); }
function taggedIdentifierCaseIsExact(exactCode, requirements) {
  const canonical = new Map([["type", "type"], ["kind", "kind"], ["eventtype", "eventType"], ["tag", "tag"]]);
  for (const requirement of requirements) {
    if (!requirement.field) continue;
    const folded = fieldKey(requirement.field), prior = canonical.get(folded);
    if (prior && prior !== requirement.field) return false;
    canonical.set(folded, requirement.field);
  }
  const spellings = new Map();
  for (const match of String(exactCode ?? "").matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
    const spelling = match[0], folded = spelling.toLowerCase(), prior = spellings.get(folded);
    if (prior && prior !== spelling) return false;
    spellings.set(folded, spelling);
    const expected = canonical.get(folded);
    if (expected && spelling !== expected) return false;
  }
  return true;
}
function expressionPattern(expression) {
  return String(expression).split(".").map(escapeRegex).join("\\s*\\.\\s*");
}
function stripOuterParentheses(raw) {
  let value = String(raw ?? "").trim();
  while (value.startsWith("(") && balancedEnd(value, 0) === value.length) value = value.slice(1, -1).trim();
  return value;
}
function callableBindingIsStable(code, name) {
  const escaped = escapeRegex(name);
  if (new RegExp(`\\basync\\s+function\\s+${escaped}\\s*\\(|\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*async\\b`, "g").test(code)) return false;
  const functions = [...code.matchAll(new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`, "g"))];
  const variables = [...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=`, "g"))];
  if (functions.length + variables.length !== 1) return false;
  const assignments = [...code.matchAll(new RegExp(`(?<![.$a-z0-9_])${escaped}\\s*(?:=(?!=|>)|\\+\\+|--|[+*/%&|^-]=|(?:&&|\\|\\||\\?\\?)=)`, "g"))];
  const destructuredWrite = new RegExp(`(?:\\{[^}\\n]{0,500}\\b${escaped}\\b[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${escaped}\\b[^\\]\\n]{0,500}\\])\\s*=`, "g").test(code);
  const loopWrite = new RegExp(`\\bfor(?:\\s+await)?\\s*\\(\\s*(?:(?:const|let|var)\\s+)?(?:${escaped}|\\{[^}\\n]{0,500}\\b${escaped}\\b[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${escaped}\\b[^\\]\\n]{0,500}\\])\\s+(?:of|in)\\b`, "g").test(code);
  if (destructuredWrite || loopWrite) return false;
  return functions.length === 1 ? assignments.length === 0
    : assignments.length === 1 && assignments[0].index >= variables[0].index && assignments[0].index < variables[0].index + variables[0][0].length;
}
function directStringPartitions(condition, expression, strings) {
  const partitions = new Set(), code = stripOuterParentheses(condition), value = expressionPattern(expression), typeTokens = stringTypeTokens(strings).map(escapeRegex).join("|");
  if (typeTokens && new RegExp(`^typeof\\s+${value}\\s*(?:!==|!=)\\s*(?:${typeTokens})$`).test(code)) { partitions.add("missing"); partitions.add("non-string"); }
  if (new RegExp(`^(?:${value}\\s*(?:===|==)\\s*(?:undefined|null)|(?:undefined|null)\\s*(?:===|==)\\s*${value})$`).test(code)) partitions.add("missing");
  if (new RegExp(`^!\\s*(?:\\(\\s*)?${value}(?![a-z0-9_$]|\\s*[.(])\\s*\\)?$`).test(code)) { partitions.add("missing"); partitions.add("empty-string"); }
  const empty = [
    `${value}\\s*(?:===|==)\\s*__pi_empty_string_literal__`,
    `__pi_empty_string_literal__\\s*(?:===|==)\\s*${value}`,
    `${value}\\s*\\.\\s*length\\s*(?:===|==|<=)\\s*0`,
    `${value}\\s*\\.\\s*length\\s*<\\s*1`
  ].join("|");
  if (new RegExp(`^(?:${empty})$`).test(code)) partitions.add("empty-string");
  return partitions;
}
function predicatePartitions(condition, expression, callable, strings) {
  const observed = new Set(), escaped = expressionPattern(expression), typeTokens = stringTypeTokens(strings).map(escapeRegex).join("|");
  const match = stripOuterParentheses(condition).match(new RegExp(`^!\\s*([a-z_$][a-z0-9_$]*)\\s*\\(\\s*${escaped}\\s*\\)$`));
  if (match) {
    const helper = callableBody(callable.source, match[1]);
    if (!helper || helper.parameters.length !== 1 || !callableBindingIsStable(callable.source, match[1])) return observed;
    const parameter = escapeRegex(helper.parameters[0]), returned = helper.body.trim().match(/^return\s+([^;\n]{1,1000})\s*;?$/)?.[1];
    if (!returned || !typeTokens) return observed;
    const expressionBody = stripOuterParentheses(returned);
    const stringOk = `typeof\\s+${parameter}\\s*(?:===|==)\\s*(?:${typeTokens})`;
    const nonEmpty = `(?:${parameter}\\s*\\.\\s*length\\s*>\\s*0|${parameter}\\s*(?:!==|!=)\\s*__pi_empty_string_literal__|__pi_empty_string_literal__\\s*(?:!==|!=)\\s*${parameter})`;
    if (new RegExp(`^(?:${stringOk})\\s*&&\\s*(?:${nonEmpty})$`).test(expressionBody)
      || new RegExp(`^(?:${nonEmpty})\\s*&&\\s*(?:${stringOk})$`).test(expressionBody)) {
      for (const item of ["missing", "non-string", "empty-string"]) observed.add(item);
    }
  }
  return observed;
}

function directPresenceField(raw, branch, strings) {
  const value = stripOuterParentheses(raw), member = escapeRegex(branch.root);
  const direct = value.match(new RegExp(`^object\\s*\\.\\s*hasown\\s*\\(\\s*${member}\\s*,\\s*(__pi_bound_string_\\d+__)\\s*\\)$`));
  if (direct) return boundString(direct[1], strings);
  const legacy = value.match(new RegExp(`^object\\s*\\.\\s*prototype\\s*\\.\\s*hasownproperty\\s*\\.\\s*call\\s*\\(\\s*${member}\\s*,\\s*(__pi_bound_string_\\d+__)\\s*\\)$`));
  return legacy ? boundString(legacy[1], strings) : undefined;
}
function presenceAliases(branch, field, strings) {
  const aliases = new Set();
  for (const match of branch.body.matchAll(/\bconst\s+([a-z_$][a-z0-9_$]*)\s*=\s*([^;]{1,400})\s*;/g)) {
    if (directPresenceField(match[2], branch, strings) === field) aliases.add(match[1]);
  }
  return aliases;
}
function intrinsicObjectHasOwnIsStable(code) {
  const withoutDirectCalls = String(code ?? "")
    .replace(/\bObject\s*\.\s*prototype\s*\.\s*hasOwnProperty\s*\.\s*call\s*\(/g, "__pi_intrinsic_object_hasown__(")
    .replace(/\bObject\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/g, "__pi_intrinsic_object_call__(");
  return !/\bObject\b/i.test(withoutDirectCalls);
}
function isPresenceExpression(raw, branch, field, strings, aliases) {
  const value = stripOuterParentheses(raw);
  if (aliases.has(value)) return true;
  return directPresenceField(value, branch, strings) === field;
}
function topLevelConjunction(raw) {
  const value = stripOuterParentheses(raw), parts = [];
  let start = 0, parentheses = 0, brackets = 0, braces = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === "(") parentheses += 1; else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1; else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1; else if (character === "}") braces -= 1;
    else if (value.slice(index, index + 2) === "&&" && !parentheses && !brackets && !braces) {
      parts.push(value.slice(start, index)); start = index + 2; index += 1;
    }
  }
  parts.push(value.slice(start)); return parts.map(stripOuterParentheses);
}
function topLevelDisjunction(raw) {
  const value = stripOuterParentheses(raw), parts = [];
  let start = 0, parentheses = 0, brackets = 0, braces = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character === "(") parentheses += 1; else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1; else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1; else if (character === "}") braces -= 1;
    else if (value.slice(index, index + 2) === "||" && !parentheses && !brackets && !braces) {
      parts.push(value.slice(start, index)); start = index + 2; index += 1;
    }
  }
  parts.push(value.slice(start)); return parts.map(stripOuterParentheses);
}
function conditionPartitions(condition, expression, lexical) {
  const observed = new Set();
  for (const clause of topLevelDisjunction(condition)) {
    for (const item of directStringPartitions(clause, expression, lexical.exactStrings)) observed.add(item);
    for (const item of predicatePartitions(clause, expression, lexical, lexical.exactStrings)) observed.add(item);
  }
  return observed;
}
function fieldDisjunctionIsQualified(condition, branch, lexical, requirements) {
  const disjuncts = topLevelDisjunction(condition);
  if (disjuncts.length <= 1) return true;
  const local = requirements.filter((item) => item.field && tagMatches(item.variant, branch.tag));
  return disjuncts.every((clause) => local.some((item) => conditionPartitions(
    clause, `${branch.root}.${fieldKey(item.field)}`, lexical
  ).size > 0));
}
function directThrowStatement(value) {
  let body = String(value ?? "").trim();
  if (body.startsWith("{") && balancedEnd(body, 0, "{", "}") === body.length) body = body.slice(1, -1).trim();
  const thrown = body.match(/^throw\s+(?:new\s+)?([a-z_$][a-z0-9_$]*)\s*\(/);
  if (!thrown) return undefined;
  const open = body.indexOf("(", thrown.index), end = balancedEnd(body, open);
  return end !== -1 && /^;?$/.test(body.slice(end).trim()) ? thrown[1] : undefined;
}
function priorPrefixIsSafe(body, offset, branch, lexical, requirements, requirement) {
  let index = 0;
  while (index < offset) {
    while (/\s/.test(body[index] ?? "")) index += 1;
    if (index >= offset) return true;
    const remaining = body.slice(index, offset);
    if (/^if\b/.test(remaining)) {
      const statement = parsedIfStatement(body, index);
      if (!statement || statement.end > offset || !directThrowStatement(statement.consequent)) return false;
      const priorTag = exactTagCondition(statement.condition, lexical.exactStrings);
      if (priorTag?.root === branch.root && priorTag.tag === branch.tag) return false;
      if (!fieldDisjunctionIsQualified(statement.condition, branch, lexical, requirements)) return false;
      const local = requirements.filter((item) => item.field && tagMatches(item.variant, branch.tag));
      const provesInvalidField = local.some((item) => conditionPartitions(
        statement.condition, `${branch.root}.${fieldKey(item.field)}`, lexical
      ).size > 0);
      if (!provesInvalidField) return false;
      if (requirement.optional && conditionPartitions(
        statement.condition, `${branch.root}.${fieldKey(requirement.field)}`, lexical
      ).has("missing")) return false;
      index = statement.end;
      if (body[index] === ";") index += 1;
      continue;
    }
    const alias = remaining.match(/^const\s+([a-z_$][a-z0-9_$]*)\s*=\s*([^;]{1,400})\s*;/);
    if (alias && lexical.objectHasOwnStable && directPresenceField(alias[2], branch, lexical.exactStrings) !== undefined) {
      index += alias[0].length;
      continue;
    }
    return false;
  }
  return true;
}
function branchFieldPartitions(branch, requirement, lexical, requestedErrors, requirements) {
  const observed = new Set(), expression = `${branch.root}.${fieldKey(requirement.field)}`;
  const objectHasOwnStable = lexical.objectHasOwnStable;
  const presence = objectHasOwnStable ? presenceAliases(branch, requirement.field, lexical.exactStrings) : new Set();
  for (const match of branch.body.matchAll(/\bif\s*\(/g)) {
    if (braceDepthAt(branch.body, match.index) !== 0) continue;
    if (!priorPrefixIsSafe(branch.body, match.index, branch, lexical, requirements, requirement)) continue;
    const open = branch.body.indexOf("(", match.index), end = balancedEnd(branch.body, open);
    if (end === -1) continue;
    let start = end; while (/\s/.test(branch.body[start] ?? "")) start += 1;
    const finish = branch.body[start] === "{" ? balancedEnd(branch.body, start, "{", "}") : (branch.body.indexOf(";", start) + 1 || branch.body.length);
    if (finish === -1) continue;
    const consequent = branch.body.slice(start, finish).trim();
    const thrown = directThrowStatement(consequent);
    if (!thrown || (requestedErrors.length > 0 ? !requestedErrors.includes(thrown) : !ERROR_NAMES.has(thrown))) continue;
    const condition = branch.body.slice(open + 1, end - 1);
    if (!fieldDisjunctionIsQualified(condition, branch, lexical, requirements)) continue;
    if (!requirement.optional) for (const item of conditionPartitions(condition, expression, lexical)) observed.add(item);
    else {
      if (!objectHasOwnStable) continue;
      const parts = topLevelConjunction(condition);
      if (parts.length !== 2) continue;
      const presenceIndex = parts.findIndex((part) => isPresenceExpression(part, branch, requirement.field, lexical.exactStrings, presence));
      if (presenceIndex === -1) continue;
      for (const item of conditionPartitions(parts[1 - presenceIndex], expression, lexical)) observed.add(item);
    }
  }
  return observed;
}

function sourceQualified(raw, target, requirements, requestedErrors, environmentObjectStable) {
  const lexical = lexicalEvidence(raw), callable = callableBody(lexical.code, target), observed = new Set();
  if (!callable || !taggedIdentifierCaseIsExact(lexical.exactCode, requirements)) return { observed, eventIndex: -1 };
  lexical.source = lexical.code;
  lexical.objectHasOwnStable = environmentObjectStable !== false && intrinsicObjectHasOwnIsStable(lexical.exactCode);
  const branches = taggedBranches(callable, lexical.exactStrings);
  const roots = new Set();
  for (const requirement of requirements) {
    if (!requirement.field) continue;
    const matches = branches.filter((branch) => tagMatches(branch.tag, requirement.variant));
    if (matches.length !== 1) continue;
    roots.add(matches[0].root);
    for (const partition of branchFieldPartitions(matches[0], requirement, lexical, requestedErrors, requirements)) {
      observed.add(qualifiedKey(requirement.variant, requirement.field, partition));
    }
  }
  const root = roots.size === 1 ? [...roots][0] : undefined;
  return { observed, eventIndex: root ? callable.parameters.indexOf(root) : -1 };
}

function topLevelParts(text, opening, closing) {
  const parts = []; let start = 1, parentheses = 0, brackets = 0, braces = 0;
  for (let index = 1; index < text.length - 1; index += 1) {
    const character = text[index];
    if (character === "(") parentheses += 1; else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1; else if (character === "]") brackets -= 1;
    else if (character === "{") braces += 1; else if (character === "}") braces -= 1;
    else if (character === "," && !parentheses && !brackets && !braces) { parts.push(text.slice(start, index)); start = index + 1; }
  }
  parts.push(text.slice(start, -1)); return parts;
}
function objectFact(text, strings) {
  const value = String(text ?? "").trim();
  if (!value.startsWith("{") || balancedEnd(value, 0, "{", "}") !== value.length) return undefined;
  const properties = new Map();
  for (const raw of topLevelParts(value, "{", "}")) {
    if (/^\s*\.\.\./.test(raw)) return undefined;
    const property = raw.match(/^\s*([a-z_$][a-z0-9_$]*)\s*:\s*([\s\S]+)$/i);
    if (!property || properties.has(property[1])) return undefined;
    properties.set(property[1], property[2].trim());
  }
  const discriminator = [...DISCRIMINATORS].find((name) => properties.has(name)), tag = discriminator && boundString(properties.get(discriminator), strings);
  return tag ? { tag, properties } : undefined;
}
function canonicalFreshLiteral(raw, strings, depth = 0) {
  const value = stripOuterParentheses(raw);
  if (depth > 4 || value.length > 2_000) return undefined;
  const resolved = boundString(value, strings);
  if (resolved !== undefined) return `string:${JSON.stringify(resolved)}`;
  if (value === "__pi_empty_string_literal__") return "string:\"\"";
  if (/^(?:undefined|null|true|false|-?(?:\d+(?:\.\d+)?|\.\d+))$/.test(value)) return `primitive:${value}`;
  if (value.startsWith("[") && balancedEnd(value, 0, "[", "]") === value.length) {
    const parts = topLevelParts(value, "[", "]").map((item) => item.trim());
    if (parts.length > 1 && parts.some((item) => !item)) return undefined;
    if (parts.length === 1 && !parts[0]) return "array:[]";
    const items = parts.map((item) => canonicalFreshLiteral(item, strings, depth + 1));
    return items.some((item) => item === undefined) ? undefined : `array:[${items.join(",")}]`;
  }
  if (value.startsWith("{") && balancedEnd(value, 0, "{", "}") === value.length) {
    const properties = [];
    for (const rawProperty of topLevelParts(value, "{", "}")) {
      if (!rawProperty.trim()) continue;
      const property = rawProperty.match(/^\s*([a-z_$][a-z0-9_$]*)\s*:\s*([\s\S]+)$/i);
      if (!property || properties.some(([name]) => name === property[1])) return undefined;
      const nested = canonicalFreshLiteral(property[2], strings, depth + 1);
      if (nested === undefined) return undefined;
      properties.push([property[1], nested]);
    }
    properties.sort(([left], [right]) => left.localeCompare(right));
    return `object:{${properties.map(([name, nested]) => `${name}:${nested}`).join(",")}}`;
  }
  return undefined;
}
function literalPartitions(value) {
  if (value === "undefined") return ["non-string"];
  if (value === "null" || /^(?:true|false|-?(?:\d+(?:\.\d+)?|\.\d+)|\[|\{)/.test(value)) return ["non-string"];
  if (value === "__pi_empty_string_literal__") return ["empty-string"];
  return [];
}
function operationInvocation(operation, target, eventIndex, strings, exactStrings) {
  let value = String(operation ?? "").trim();
  const arrow = value.indexOf("=>");
  if (arrow !== -1) value = value.slice(arrow + 2).trim();
  else if (/^function\b/.test(value)) value = value.slice(value.indexOf("{") + 1, value.lastIndexOf("}")).trim();
  value = value.replace(/^(?:return\s+)?(?:await\s+)?/, "").replace(/;\s*$/, "").trim();
  const call = value.match(/^([a-z_$][a-z0-9_$.]*)\s*\(/), structural = target.startsWith("*.");
  if (!call || (structural ? !call[1].endsWith(target.slice(1)) : call[1] !== target)) return undefined;
  const open = value.indexOf("(", call.index), end = balancedEnd(value, open);
  if (end !== value.length) return undefined;
  const args = evidenceTopLevelArguments(value, open, end);
  if (eventIndex < 0 || eventIndex >= args.length) return undefined;
  const event = objectFact(args[eventIndex], strings);
  const eventLiterals = event && [...event.properties.values()].map((item) => canonicalFreshLiteral(item, exactStrings));
  const nonEvent = args.filter((_, index) => index !== eventIndex).map((item) => canonicalFreshLiteral(item, exactStrings));
  return event && eventLiterals.every((item) => item !== undefined) && nonEvent.every((item) => item !== undefined)
    ? { target, event, nonEvent: nonEvent.join("\u0000") } : undefined;
}
function expandedAssertionInvocations(assertion, target, eventIndex, strings) {
  const direct = operationInvocation(assertion.operation, target, eventIndex, strings, strings);
  if (direct) return [direct];
  let value = String(assertion.operation ?? "").trim();
  const arrow = value.indexOf("=>");
  if (arrow !== -1) value = value.slice(arrow + 2).trim();
  else if (/^function\b/.test(value)) value = value.slice(value.indexOf("{") + 1, value.lastIndexOf("}")).trim();
  value = value.replace(/^(?:return\s+)?(?:await\s+)?/, "").replace(/;\s*$/, "").trim();
  const call = value.match(/^([a-z_$][a-z0-9_$.]*)\s*\(/), open = call ? value.indexOf("(", call.index) : -1;
  const end = open === -1 ? -1 : balancedEnd(value, open), args = end === value.length ? evidenceTopLevelArguments(value, open, end) : [];
  if (!call || !/^[a-z_$][a-z0-9_$]*$/.test(args[eventIndex] ?? "")) return [];
  const expanded = [];
  for (const literal of assertion.iterationLiterals ?? []) {
    if (!literal.startsWith("[") || balancedEnd(literal, 0, "[", "]") !== literal.length) continue;
    for (const item of topLevelParts(literal, "[", "]").slice(0, 24)) {
      const next = [...args]; next[eventIndex] = item.trim();
      const invocation = operationInvocation(`${call[1]}(${next.join(",")})`, target, eventIndex, strings, strings);
      if (invocation) expanded.push(invocation);
    }
  }
  return expanded;
}
function validStringLiteral(value, strings) {
  const resolved = boundString(value, strings);
  return typeof resolved === "string" && resolved.length > 0;
}
function validControl(invocation, requirements, strings) {
  const local = requirements.filter((item) => item.field && tagMatches(invocation.event.tag, item.variant));
  if (local.length === 0) return false;
  return local.every((item) => item.optional
    ? !invocation.event.properties.has(fieldKey(item.field)) || validStringLiteral(invocation.event.properties.get(fieldKey(item.field)), strings)
    : invocation.event.properties.has(fieldKey(item.field)) && validStringLiteral(invocation.event.properties.get(fieldKey(item.field)), strings));
}
function equivalentLiteral(left, right, strings) {
  if (left === right) return true;
  const leftString = boundString(left, strings), rightString = boundString(right, strings);
  return leftString !== undefined && rightString !== undefined && leftString === rightString;
}
function differsOnlyByField(candidate, control, field, strings) {
  if (candidate.target !== control.target || candidate.nonEvent !== control.nonEvent || candidate.event.tag !== control.event.tag) return false;
  const keys = new Set([...candidate.event.properties.keys(), ...control.event.properties.keys()]);
  const keyField = fieldKey(field);
  for (const key of keys) if (key !== keyField && !equivalentLiteral(candidate.event.properties.get(key), control.event.properties.get(key), strings)) return false;
  return !equivalentLiteral(candidate.event.properties.get(keyField), control.event.properties.get(keyField), strings);
}
function testQualified(raw, names, requirements, requestedErrors, eventIndex, literalIterationEnvironmentStable) {
  const lexical = lexicalEvidence(raw), observed = new Set();
  if (!taggedIdentifierCaseIsExact(lexical.exactCode, requirements)) return observed;
  const assertions = executableRejectionAssertions(
    lexical.code, names, false, true, literalIterationEnvironmentStable
  );
  const controls = [];
  for (const assertion of assertions.filter((item) => item.mode === "does-not-throw")) {
    for (const target of assertion.targets) {
      for (const invocation of expandedAssertionInvocations(assertion, target, eventIndex, lexical.exactStrings)) {
        if (validControl(invocation, requirements, lexical.exactStrings)) controls.push(invocation);
      }
    }
  }
  for (const assertion of assertions.filter((item) => item.mode !== "does-not-throw")) {
    if (requestedErrors.length > 0 && !requestedErrors.some((name) => assertion.errorClasses.includes(name))) continue;
    for (const target of assertion.targets) {
      for (const invocation of expandedAssertionInvocations(assertion, target, eventIndex, lexical.exactStrings)) {
        for (const requirement of requirements.filter((item) => item.field && tagMatches(invocation.event.tag, item.variant))) {
          const keyField = fieldKey(requirement.field);
          const partitions = invocation.event.properties.has(keyField)
            ? literalPartitions(invocation.event.properties.get(keyField)) : ["missing"];
          for (const partition of partitions.filter((item) => requirement.partitions.includes(item))) {
            const hasAbsentOptionalControl = !requirement.optional || controls.some((control) => (
              control.event.tag === requirement.variant && !control.event.properties.has(keyField)
            ));
            if (hasAbsentOptionalControl && controls.some((control) => (!requirement.optional || control.event.properties.has(keyField))
              && differsOnlyByField(invocation, control, requirement.field, lexical.exactStrings))) {
              observed.add(qualifiedKey(requirement.variant, requirement.field, partition));
            }
          }
        }
      }
    }
  }
  return observed;
}
function covers(requirements, observed) {
  return requirements.every((item) => item.field && item.partitions.every((partition) => observed.has(qualifiedKey(item.variant, item.field, partition))));
}

export function malformedTaggedEventEvidence(input = {}) {
  const requirements = Array.isArray(input.requirements) ? input.requirements : [];
  if (requirements.length === 0) return { sourceOk: true, testOk: true };
  const proofEnvironment = lexicalEvidence(`${input.sourceCorpus ?? ""}\n${input.testCorpus ?? ""}`).exactCode;
  const environmentObjectStable = intrinsicObjectHasOwnIsStable(proofEnvironment);
  const environmentArrayIterationStable = literalArrayIterationEnvironmentIsStable(
    proofEnvironment
  );
  const environmentTestProofStable = testProofIntrinsicsAreStable(proofEnvironment);
  const projections = input.sourceGroups.map((group) => sourceQualified(group.raw, group.name, requirements, input.requestedErrors, environmentObjectStable));
  const sourceOk = projections.length > 0 && projections.every((projection) => projection.eventIndex >= 0 && covers(requirements, projection.observed));
  const testOk = environmentTestProofStable && input.testGroups.length === projections.length && input.testGroups.every((group, index) => {
    const observed = new Set();
    for (const item of group) for (const key of testQualified(
      item.raw, item.names, requirements, input.requestedErrors, projections[index].eventIndex,
      environmentArrayIterationStable
    )) observed.add(key);
    return covers(requirements, observed);
  });
  return { sourceOk, testOk };
}

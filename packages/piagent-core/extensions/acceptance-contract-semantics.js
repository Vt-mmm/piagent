import path from "node:path";
import { acceptanceBoundaryProofGuidance } from "./acceptance-boundary-guidance.js";
import { evidenceTopLevelArguments, executableRejectionAssertions } from "./acceptance-executable-evidence.js";

const INTEGER_TARGET_STOPWORDS = new Set([
  "and", "basis", "cents", "input", "inputs", "items", "money", "number", "numbers", "or", "points", "typeerror", "value", "values"
]);

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function erasedLexeme(value) {
  return String(value ?? "").replace(/[^\r\n]/g, " ");
}

function stringLiteralSentinel(value) {
  if (value.length === 0) return "__pi_empty_string_literal__";
  if (/^(?:\s|\\[nrtvf0])+$/u.test(value)) return "__pi_whitespace_string_literal__";
  if (["assert", "assert/strict", "node:assert", "node:assert/strict"].includes(value.trim().toLowerCase())) {
    return "__pi_node_assert_module_literal__";
  }
  if (["node:vm", "vm"].includes(value.trim().toLowerCase())) return "__pi_code_generation_module_literal__";
  if (["module", "node:module"].includes(value.trim().toLowerCase())) return "__pi_module_loader_module_literal__";
  const errorName = value.trim().toLowerCase().match(/^(typeerror|rangeerror|syntaxerror|referenceerror|urierror|evalerror|aggregateerror|error)$/)?.[1];
  if (errorName) return `__pi_error_name_${errorName}_literal__`;
  return "__pi_string_literal__";
}

function regexCanStart(source, offset) {
  const prefix = source.slice(0, offset).replace(/\s+$/u, "");
  if (!prefix) return true;
  const previous = prefix.at(-1);
  if (/[([{,:;=!?&|+*%^~<>-]/u.test(previous)) return true;
  return /\b(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/u.test(prefix);
}

/**
 * Return a bounded lexical evidence view of JavaScript/TypeScript source.
 *
 * Comments and regular-expression payloads are erased. String/template
 * payloads are replaced by a closed set of literal-category sentinels, so a
 * quoted fragment such as "assert.throws(..., TypeError)" can never become
 * executable evidence while empty/whitespace string partitions remain
 * observable. This is deliberately a lexer, not a parser: malformed or
 * ambiguous input loses evidence and therefore fails closed.
 */
function lexJavaScriptEvidence(value, bindStrings = false) {
  const source = String(value ?? "");
  const output = [];
  const strings = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];

    if (current === "/" && next === "/") {
      let end = index + 2;
      while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
      output.push(erasedLexeme(source.slice(index, end)));
      index = end;
      continue;
    }
    if (current === "/" && next === "*") {
      const closing = source.indexOf("*/", index + 2);
      const end = closing === -1 ? source.length : closing + 2;
      output.push(erasedLexeme(source.slice(index, end)));
      index = end;
      continue;
    }
    if (current === "'" || current === '"') {
      const quote = current;
      let end = index + 1;
      let payload = "";
      let closed = false;
      while (end < source.length) {
        const character = source[end];
        if (character === "\\") {
          payload += source.slice(end, Math.min(source.length, end + 2));
          end += 2;
          continue;
        }
        if (character === quote) {
          end += 1;
          closed = true;
          break;
        }
        payload += character;
        end += 1;
      }
      if (!closed) output.push(erasedLexeme(source.slice(index, end)));
      else if (bindStrings) {
        output.push(`__pi_bound_string_${strings.length}__`);
        strings.push(payload);
      } else output.push(stringLiteralSentinel(payload));
      index = end;
      continue;
    }
    if (current === "`") {
      let end = index + 1;
      let closed = false;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === "`") {
          end += 1;
          closed = true;
          break;
        }
        end += 1;
      }
      output.push(closed ? "__pi_template_literal__" : erasedLexeme(source.slice(index, end)));
      index = end;
      continue;
    }
    if (current === "/" && next !== "=" && regexCanStart(source, index)) {
      let end = index + 1;
      let inClass = false;
      let closed = false;
      while (end < source.length) {
        const character = source[end];
        if (character === "\\") {
          end += 2;
          continue;
        }
        if (character === "[") inClass = true;
        else if (character === "]") inClass = false;
        else if (character === "/" && !inClass) {
          end += 1;
          while (/[a-z]/iu.test(source[end] ?? "")) end += 1;
          closed = true;
          break;
        } else if (character === "\n" || character === "\r") {
          break;
        }
        end += 1;
      }
      if (closed) {
        output.push("__pi_regex_literal__");
        index = end;
        continue;
      }
    }
    output.push(current);
    index += 1;
  }
  const code = output.join("");
  return bindStrings ? { code, strings } : code;
}

export function sanitizeJavaScriptEvidence(value) {
  return lexJavaScriptEvidence(value, false);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function integerGuardHelpers(sourceText) {
  const helpers = [];
  const declarations = /function\s+([a-z_$][a-z0-9_$]*)\s*\(([^)]*)\)\s*\{([\s\S]{0,800}?)\}/gi;
  for (const match of String(sourceText ?? "").matchAll(declarations)) {
    const parameter = match[2].split(",")[0]?.trim().match(/^([a-z_$][a-z0-9_$]*)/i)?.[1];
    if (!parameter) continue;
    const escaped = escapeRegex(parameter);
    if (new RegExp(`number\\.is(?:safe)?integer\\s*\\(\\s*${escaped}\\b`, "i").test(match[3])) helpers.push(match[1].toLowerCase());
  }
  return uniqueStrings(helpers).slice(0, 12);
}

function integerConstraintTargets(text, sourceText = "") {
  const value = normalizedText(text);
  const source = normalizedText(sourceText);
  const candidates = [];
  for (const match of value.matchAll(/\b(?:an?\s+)?(?:non-negative\s+|positive\s+)?integer\s+([a-z_$][a-z0-9_$]*)\b/g)) candidates.push(match[1]);
  for (const match of value.matchAll(/`([a-z_$][a-z0-9_$]*)`[^.\n]{0,120}\b(?:is|must be|must remain)\s+(?:an?\s+)?(?:non-negative\s+|positive\s+)?(?:safe\s+)?integer\b/g)) candidates.push(match[1]);
  return uniqueStrings(candidates)
    .map((item) => item.toLowerCase())
    .filter((item) => !INTEGER_TARGET_STOPWORDS.has(item))
    .filter((item) => !source || new RegExp(`\\b${escapeRegex(item)}\\b`).test(source));
}

function onlyUndefinedContract(text) {
  const value = normalizedText(text);
  return /\babsent\s+only\s+when[^.\n]{0,80}\bundefined\b/.test(value)
    || /\bonly\s+when[^.\n]{0,80}\bundefined\b/.test(value)
    || /\bvalid values?[^.\n]{0,120}\bnull\b[^.\n]{0,120}\bmust not fall through\b/.test(value);
}

function nullRejectingDefaultTargets(text, sourceText = "") {
  const value = normalizedText(text);
  const targets = [];
  for (const match of value.matchAll(/`([a-z_$][a-z0-9_$]*)`[^.\n]{0,160}\bdefaults?\s+to\b[^.\n]{0,160}\bmust be\s+(?:an?\s+)?(?:non-negative\s+|positive\s+)?(?:safe\s+)?integer\b/g)) targets.push(match[1]);
  for (const match of value.matchAll(/\bomitted\s+`?([a-z_$][a-z0-9_$]*)`?[^.\n]{0,120}\bdefaults?\b[^.\n]{0,160}\bwhen supplied\b[^.\n]{0,160}\bnon-null\b/g)) targets.push(match[1]);
  const source = normalizedText(sourceText);
  const uniqueTargets = uniqueStrings(targets);
  if (!source) return uniqueTargets;
  return uniqueTargets.filter((target) => new RegExp(`(?:\\.${escapeRegex(target)}\\b|\\b${escapeRegex(target)}\\b)\\s*\\?\\?`, "i").test(source));
}

const ERROR_CONSTRUCTORS = ["typeerror", "rangeerror", "syntaxerror", "referenceerror", "urierror", "evalerror", "aggregateerror", "error"];

function evidenceBalancedEnd(text, openIndex, opening = "(", closing = ")", ceiling = 8_000) {
  if (text[openIndex] !== opening) return -1;
  let depth = 0;
  for (let index = openIndex; index < Math.min(text.length, openIndex + ceiling); index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing && --depth === 0) return index + 1;
  }
  return -1;
}

function requestedErrorClasses(text) {
  const value = normalizedText(text);
  const specific = ERROR_CONSTRUCTORS.slice(0, -1).filter((name) => new RegExp(`\\b${name}\\b`).test(value));
  if (specific.length > 0) return specific;
  return /\b(?:throw(?:s|ing)?|reject(?:s|ed|ion)?)\b[^.\n]{0,80}\berror\b/.test(value) ? ["error"] : [];
}

function simpleConstantValue(raw) {
  let value = String(raw ?? "").trim();
  while (value.startsWith("(") && evidenceBalancedEnd(value, 0) === value.length) value = value.slice(1, -1).trim();
  const primitive = (token) => {
    const item = token.trim();
    if (item === "true") return { known: true, value: true };
    if (item === "false") return { known: true, value: false };
    if (item === "null") return { known: true, value: null };
    if (item === "undefined") return { known: true, value: undefined };
    if (/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(item)) return { known: true, value: Number(item) };
    return { known: false, value: undefined };
  };
  const direct = primitive(value);
  if (direct.known) return Boolean(direct.value);
  if (value.startsWith("!")) {
    const nested = simpleConstantValue(value.slice(1));
    return nested === undefined ? undefined : !nested;
  }
  const comparison = value.match(/^(.+?)\s*(===|!==|==|!=|<=|>=|<|>)\s*(.+)$/);
  if (!comparison) return undefined;
  const left = primitive(comparison[1]);
  const right = primitive(comparison[3]);
  if (!left.known || !right.known) return undefined;
  switch (comparison[2]) {
    case "===": return left.value === right.value;
    case "!==": return left.value !== right.value;
    case "==": return left.value == right.value; // bounded literal comparison mirrors JS test reachability
    case "!=": return left.value != right.value;
    case "<=": return left.value <= right.value;
    case ">=": return left.value >= right.value;
    case "<": return left.value < right.value;
    case ">": return left.value > right.value;
    default: return undefined;
  }
}

function entryPath(value) {
  return path.posix.normalize(String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, ""));
}

function sourceExports(entry) {
  const code = normalizedText(sanitizeJavaScriptEvidence(entry?.text ?? entry?.evidenceText));
  const exports = [];
  for (const match of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([a-z_$][a-z0-9_$]*)\b/g)) exports.push({ contractName: match[1], exportName: match[1], sourceName: match[1] });
  for (const match of code.matchAll(/\bexport\s+(?:const|let|var|class)\s+([a-z_$][a-z0-9_$]*)\b/g)) exports.push({ contractName: match[1], exportName: match[1], sourceName: match[1] });
  for (const match of code.matchAll(/\bexport\s+default\s+(?:async\s+)?function\s+([a-z_$][a-z0-9_$]*)\b/g)) exports.push({ contractName: match[1], exportName: "default", sourceName: match[1] });
  for (const match of code.matchAll(/\bexport\s*\{([^}]{1,800})\}/g)) {
    for (const item of match[1].split(",")) {
      const binding = item.trim().match(/^([a-z_$][a-z0-9_$]*)(?:\s+as\s+([a-z_$][a-z0-9_$]*))?$/);
      if (binding) exports.push({ contractName: binding[2] ?? binding[1], exportName: binding[2] ?? binding[1], sourceName: binding[1] });
    }
  }
  for (const match of code.matchAll(/\bmodule\.exports\s*=\s*\{([^}]{1,800})\}/g)) {
    for (const item of match[1].split(",")) {
      const binding = item.trim().match(/^([a-z_$][a-z0-9_$]*)(?:\s*:\s*([a-z_$][a-z0-9_$]*))?$/);
      if (binding) exports.push({ contractName: binding[1], exportName: binding[1], sourceName: binding[2] ?? binding[1] });
    }
  }
  for (const match of code.matchAll(/\b(?:module\.)?exports\.([a-z_$][a-z0-9_$]*)\s*=\s*([a-z_$][a-z0-9_$]*)\b/g)) {
    exports.push({ contractName: match[1], exportName: match[1], sourceName: match[2] });
  }
  for (const match of code.matchAll(/\bmodule\.exports\s*=\s*([a-z_$][a-z0-9_$]*)\b/g)) {
    exports.push({ contractName: match[1], exportName: "default", sourceName: match[1] });
  }
  const sourcePath = entryPath(entry?.path);
  return [...new Map(exports.map((item) => [`${item.contractName}:${item.exportName}:${item.sourceName}`, { ...item, sourcePath }])).values()];
}

function importClauseBindings(clause, moduleSpecifier, testPath) {
  const bindings = [];
  const value = clause.trim();
  const namespace = value.match(/\*\s+as\s+([a-z_$][a-z0-9_$]*)/i);
  if (namespace) bindings.push({ importName: "*", localName: namespace[1].toLowerCase() });
  const named = value.match(/\{([^}]*)\}/);
  if (named) {
    for (const item of named[1].split(",")) {
      const binding = item.trim().match(/^([a-z_$][a-z0-9_$]*)(?:\s+as\s+([a-z_$][a-z0-9_$]*))?$/i);
      if (binding) bindings.push({ importName: binding[1].toLowerCase(), localName: (binding[2] ?? binding[1]).toLowerCase() });
    }
  }
  const defaultBinding = value.replace(/\{[^}]*\}|\*\s+as\s+[a-z_$][a-z0-9_$]*/gi, "").split(",")[0].trim();
  if (/^[a-z_$][a-z0-9_$]*$/i.test(defaultBinding)) bindings.push({ importName: "default", localName: defaultBinding.toLowerCase() });
  return bindings.map((item) => ({ ...item, moduleSpecifier, testPath: entryPath(testPath) }));
}

function destructuredModuleBindings(clause, moduleSpecifier, testPath) {
  const bindings = [];
  for (const item of clause.split(",")) {
    const binding = item.trim().match(/^([a-z_$][a-z0-9_$]*)(?:\s*:\s*([a-z_$][a-z0-9_$]*))?$/i);
    if (binding) bindings.push({ importName: binding[1].toLowerCase(), localName: (binding[2] ?? binding[1]).toLowerCase(), moduleSpecifier, testPath: entryPath(testPath) });
  }
  return bindings;
}

function staticModuleBindings(entry) {
  const lexical = lexJavaScriptEvidence(entry?.text ?? "", true);
  const bindings = [];
  for (const match of lexical.code.matchAll(/\bimport\s+([\s\S]{1,800}?)\s+from\s+__pi_bound_string_(\d+)__/g)) {
    const moduleSpecifier = lexical.strings[Number(match[2])];
    if (typeof moduleSpecifier === "string" && !moduleSpecifier.includes("\\")) bindings.push(...importClauseBindings(match[1], moduleSpecifier, entry?.path));
  }
  const moduleCall = "(?:require\\s*\\(\\s*__pi_bound_string_(\\d+)__\\s*\\)|(?:await\\s+)?import\\s*\\(\\s*__pi_bound_string_(\\d+)__\\s*\\))";
  for (const match of lexical.code.matchAll(new RegExp(`\\bconst\\s*\\{([^}]{1,800})\\}\\s*=\\s*${moduleCall}`, "gi"))) {
    const index = Number(match[2] ?? match[3]);
    const moduleSpecifier = lexical.strings[index];
    if (typeof moduleSpecifier === "string" && !moduleSpecifier.includes("\\")) bindings.push(...destructuredModuleBindings(match[1], moduleSpecifier, entry?.path));
  }
  for (const match of lexical.code.matchAll(new RegExp(`\\bconst\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*${moduleCall}\\s*\\.\\s*([a-z_$][a-z0-9_$]*)`, "gi"))) {
    const index = Number(match[2] ?? match[3]);
    const moduleSpecifier = lexical.strings[index];
    if (typeof moduleSpecifier === "string" && !moduleSpecifier.includes("\\")) bindings.push({ importName: match[4].toLowerCase(), localName: match[1].toLowerCase(), moduleSpecifier, testPath: entryPath(entry?.path) });
  }
  for (const match of lexical.code.matchAll(new RegExp(`\\bconst\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*${moduleCall}`, "gi"))) {
    const index = Number(match[2] ?? match[3]);
    const moduleSpecifier = lexical.strings[index];
    if (typeof moduleSpecifier !== "string" || moduleSpecifier.includes("\\")) continue;
    bindings.push({ importName: "default", localName: match[1].toLowerCase(), moduleSpecifier, testPath: entryPath(entry?.path) });
    bindings.push({ importName: "*", localName: match[1].toLowerCase(), moduleSpecifier, testPath: entryPath(entry?.path) });
  }
  return bindings;
}

function importResolvesTo(binding, sourcePath) {
  if (!binding.moduleSpecifier.startsWith(".")) return false;
  const resolved = entryPath(path.posix.join(path.posix.dirname(binding.testPath), binding.moduleSpecifier));
  if (resolved === sourcePath) return true;
  if (!path.posix.extname(resolved) && [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx"].some((extension) => `${resolved}${extension}` === sourcePath)) return true;
  return ["index.js", "index.mjs", "index.cjs", "index.ts", "index.mts", "index.cts", "index.tsx", "index.jsx"].some((name) => entryPath(path.posix.join(resolved, name)) === sourcePath);
}

function bindingWrittenOutsideDeclaration(code, name) {
  const escaped = escapeRegex(name);
  for (const mutation of code.matchAll(new RegExp(`(?<![.$a-z0-9_])${escaped}\\b\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=|(?:&&|\\|\\||\\?\\?)=)`, "gi"))) {
    const prefix = code.slice(Math.max(0, mutation.index - 16), mutation.index);
    const declaration = code.slice(mutation.index).match(new RegExp(`^${escaped}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-z_$][a-z0-9_$]*)\\s*=>`, "i"));
    if (/\b(?:const|let|var)\s*$/i.test(prefix) && declaration) continue;
    return true;
  }
  return new RegExp(`(?:\\+\\+|--)\\s*\\b${escaped}\\b|(?:\\{[^}\\n]{0,500}\\b${escaped}\\b[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${escaped}\\b[^\\]\\n]{0,500}\\])\\s*=|\\bfor(?:\\s+await)?\\s*\\(\\s*(?:${escaped}|\\{[^}\\n]{0,500}\\b${escaped}\\b[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${escaped}\\b[^\\]\\n]{0,500}\\])\\s+(?:of|in)\\b`, "i").test(code);
}

function sourceCallableBindingIsStable(entry, name) {
  const code = normalizedText(sanitizeJavaScriptEvidence(entry?.text ?? entry?.evidenceText));
  const escaped = escapeRegex(name);
  const declarations = [
    ...code.matchAll(new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\s*\\(`, "gi")),
    ...code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[a-z_$][a-z0-9_$]*)\\s*=>`, "gi"))
  ];
  return declarations.length === 1
    && sourceBraceDepthAt(code, declarations[0].index) === 0
    && !bindingWrittenOutsideDeclaration(code, name)
    && !new RegExp(`\\bimport\\b[^;\\n]{0,500}\\b${escaped}\\b`, "i").test(code)
    && !/\b(?:eval|with)\s*\(|\bnew\s+function\s*\(/i.test(code);
}

function intrinsicErrorBindingsUntampered(code, errorNames) {
  return errorNames.every((name) => {
    const escaped = escapeRegex(name);
    const literal = `__pi_error_name_${escaped}_literal__`;
    if (/\b(?:globalthis|global)\b/i.test(code)) return false;
    if (new RegExp(`\\b(?:function|class)\\s+${escaped}\\b|\\b(?:const|let|var)\\s+(?:${escaped}\\b|\\{[^}\\n]{0,500}\\b${escaped}\\b|\\[[^\\]\\n]{0,500}\\b${escaped}\\b)|\\bimport\\b[^;\\n]{0,500}\\b${escaped}\\b`, "i").test(code)) return false;
    if (new RegExp(`\\bfunction\\b[^({]{0,200}\\([^)]*\\b${escaped}\\b|\\bcatch\\s*\\([^)]*\\b${escaped}\\b|(?:\\([^)]*\\b${escaped}\\b[^)]*\\)|\\b${escaped})\\s*=>`, "i").test(code)) return false;
    if (bindingWrittenOutsideDeclaration(code, name)) return false;
    if (new RegExp(`(?:\\{[^}\\n]{0,500}\\b${escaped}\\b[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${escaped}\\b[^\\]\\n]{0,500}\\])\\s*=`, "i").test(code)) return false;
    return !new RegExp(`\\b(?:object\\s*\\.\\s*(?:assign|definepropert(?:y|ies))|reflect\\s*\\.\\s*(?:set|defineproperty))\\s*\\([^;\\n]{0,800}(?:\\b${escaped}\\b|${literal})`, "i").test(code);
  });
}

function lexicalEvidenceIsNonReflective(code) {
  return !/\\|__pi_(?:code_generation|module_loader)_module_literal__|\b(?:eval|createrequire)\b|\b(?:process|globalthis|global|window|self|this)\b|\.\s*constructor\b|\bfunction\s*\(|(?:=|[,([])\s*function\b(?!\s+[a-z_$][a-z0-9_$]*\s*\()/i.test(code);
}

function resolvedExportTestBindings(sourceEntries, testEntries) {
  const entries = new Map(testEntries.map((entry) => [entryPath(entry?.path), entry]));
  const imports = testEntries.flatMap(staticModuleBindings);
  const resolved = [];
  for (const sourceEntry of sourceEntries) {
    for (const exported of sourceExports(sourceEntry)) {
      if (!sourceCallableBindingIsStable(sourceEntry, exported.sourceName)) continue;
      for (const binding of imports.filter((item) => importResolvesTo(item, exported.sourcePath)
        && (item.importName === exported.exportName || item.importName === "*"))) {
        const testName = binding.importName === "*" ? `${binding.localName}.${exported.exportName}` : binding.localName;
        if (importedBindingIsShadowed(entries.get(binding.testPath), testName)) continue;
        resolved.push({ ...exported, testName, testPath: binding.testPath });
      }
    }
  }
  return resolved;
}

function namedTargetBindings(sourceEntries, testEntries, namedTargets) {
  const exports = sourceEntries.flatMap(sourceExports);
  const imports = testEntries.flatMap(staticModuleBindings);
  const entries = new Map(testEntries.map((entry) => [entryPath(entry.path), entry]));
  return namedTargets.map((target) => {
    const matches = exports.filter((item) => item.contractName === target
      && sourceCallableBindingIsStable(sourceEntries.find((entry) => entryPath(entry?.path) === item.sourcePath), item.sourceName));
    if (matches.length !== 1) return { target, sourcePath: null, sourceName: null, testNames: [] };
    const exported = matches[0];
    const testNames = [];
    for (const binding of imports.filter((item) => importResolvesTo(item, exported.sourcePath))) {
      const testName = binding.importName === "*" ? `${binding.localName}.${exported.exportName}` : binding.localName;
      if ((binding.importName === exported.exportName || binding.importName === "*")
        && !importedBindingIsShadowed(entries.get(binding.testPath), testName)) testNames.push(testName);
    }
    return { target, sourcePath: exported.sourcePath, sourceName: exported.sourceName, testNames: uniqueStrings(testNames) };
  });
}

function formalParameterNames(parameters) {
  const wrapped = `(${String(parameters ?? "")})`;
  const names = [];
  for (const raw of evidenceTopLevelArguments(wrapped, 0, wrapped.length)) {
    const value = raw.trim().replace(/^(?:public|private|protected|readonly)\s+/, "").replace(/^\.\.\./, "");
    const direct = value.match(/^([a-z_$][a-z0-9_$]*)\s*(?:[?:=]|$)/i);
    if (direct) {
      names.push(direct[1]);
      continue;
    }
    const object = value.match(/^\{([^}]*)\}/)?.[1];
    if (object) {
      for (const item of object.split(",")) {
        const binding = item.trim().match(/^(?:[a-z_$][a-z0-9_$]*\s*:\s*)?([a-z_$][a-z0-9_$]*)/i);
        if (binding) names.push(binding[1]);
      }
      continue;
    }
    const array = value.match(/^\[([^\]]*)\]/)?.[1];
    if (array) names.push(...(array.match(/[a-z_$][a-z0-9_$]*/gi) ?? []));
  }
  return uniqueStrings(names).map((item) => item.toLowerCase()).slice(0, 16);
}

function callableBodies(code) {
  const bodies = new Map();
  const addBraced = (name, parameters, open) => {
    const end = evidenceBalancedEnd(code, open, "{", "}");
    if (end !== -1 && !bodies.has(name)) bodies.set(name, {
      body: code.slice(open + 1, end - 1),
      parameters: formalParameterNames(parameters),
      sourceCode: code
    });
  };
  for (const match of code.matchAll(/\bfunction\s+([a-z_$][a-z0-9_$]*)\s*\(([^)]*)\)\s*\{/gi)) addBraced(match[1].toLowerCase(), match[2], match.index + match[0].lastIndexOf("{"));
  for (const match of code.matchAll(/^\s*(?:async\s+)?([a-z_$][a-z0-9_$]*)\s*\(([^)]*)\)\s*\{/gim)) {
    if (!["catch", "for", "if", "switch", "while", "with"].includes(match[1].toLowerCase())) addBraced(match[1].toLowerCase(), match[2], match.index + match[0].lastIndexOf("{"));
  }
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([a-z_$][a-z0-9_$]*))\s*=>\s*/gi)) {
    const start = match.index + match[0].length;
    if (code[start] === "{") addBraced(match[1].toLowerCase(), match[2] ?? match[3], start);
    else bodies.set(match[1].toLowerCase(), {
      body: code.slice(start, [code.indexOf(";", start), code.indexOf("\n", start)].filter((item) => item >= 0).sort((a, b) => a - b)[0] ?? code.length),
      parameters: formalParameterNames(match[2] ?? match[3]),
      sourceCode: code
    });
  }
  return bodies;
}

function inputDerivedNames(callable) {
  const derived = new Set(callable.parameters);
  const declarations = [...callable.body.matchAll(/\bconst\s+([a-z_$][a-z0-9_$]*|\{[^}\n]{1,300}\}|\[[^\]\n]{1,300}\])\s*=\s*([^;\n]{1,1000})/gi)];
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const match of declarations) {
      const initializer = match[2];
      if (/\b(?:process|globalthis)\b|\bimport\.meta\b|\bdate\.now\s*\(|\bmath\.random\s*\(/.test(initializer)) continue;
      if (![...derived].some((name) => new RegExp(`\\b${escapeRegex(name)}\\b`).test(initializer))) continue;
      const bindings = match[1].startsWith("{")
        ? match[1].slice(1, -1).split(",").map((item) => item.trim().match(/^(?:[a-z_$][a-z0-9_$]*\s*:\s*)?([a-z_$][a-z0-9_$]*)/i)?.[1])
        : match[1].startsWith("[")
          ? (match[1].match(/[a-z_$][a-z0-9_$]*/gi) ?? [])
          : [match[1]];
      for (const binding of bindings.filter(Boolean)) {
        const normalized = binding.toLowerCase();
        if (!derived.has(normalized)) {
          derived.add(normalized);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return [...derived].slice(0, 24);
}

function mergeValidationProof(target, candidate) {
  target.generic ||= candidate.generic;
  for (const partition of candidate.partitions) target.partitions.add(partition);
  return target;
}

function positiveValidationConditionProof(condition, names, bodies, visited = new Set()) {
  const proof = { generic: false, partitions: new Set() };
  if (simpleConstantValue(condition) !== undefined
    || /\b(?:process|globalthis)\b|\bimport\.meta\b/.test(condition)) return proof;
  for (const name of names) {
    const escaped = escapeRegex(name);
    if (!new RegExp(`\\b${escaped}\\b`).test(condition)) continue;
    const integer = new RegExp(`number\\.is(integer|safeinteger)\\s*\\(\\s*${escaped}\\b`).exec(condition);
    if (integer) {
      proof.generic = true;
      proof.partitions.add("fractional");
      proof.partitions.add("non-finite");
      if (integer[1] === "safeinteger") proof.partitions.add("unsafe-integer");
    }
    if (new RegExp(`number\\.isfinite\\s*\\(\\s*${escaped}\\b`).test(condition)) {
      proof.generic = true;
      proof.partitions.add("non-finite");
    }
    if (new RegExp(`array\\.isarray\\s*\\(\\s*${escaped}\\b`).test(condition)) {
      proof.generic = true;
      proof.partitions.add("non-array");
    }
    if (new RegExp(`\\b${escaped}\\b\\s*(?:>=|>)\\s*0|0\\s*(?:<=|<)\\s*\\b${escaped}\\b`).test(condition)) {
      proof.generic = true;
      proof.partitions.add("negative");
      if (new RegExp(`\\b${escaped}\\b\\s*>\\s*0|0\\s*<\\s*\\b${escaped}\\b`).test(condition)) proof.partitions.add("zero");
    }
    if (new RegExp(`\\b${escaped}\\b\\s*!={1,2}\\s*null|null\\s*!={1,2}\\s*\\b${escaped}\\b`).test(condition)) {
      proof.generic = true;
      proof.partitions.add("null");
    }
    if (new RegExp(`\\b${escaped}\\b\\s*!={1,2}\\s*undefined|typeof\\s+${escaped}\\b\\s*!={1,2}`).test(condition)) {
      proof.generic = true;
      proof.partitions.add("missing");
    }
  }
  for (const match of condition.matchAll(/\b([a-z_$][a-z0-9_$]*)\s*\(/gi)) {
    const helper = match[1].toLowerCase();
    if (!bodies.has(helper) || visited.has(helper)) continue;
    const open = condition.indexOf("(", match.index);
    const end = evidenceBalancedEnd(condition, open);
    const argumentsText = end === -1 ? "" : condition.slice(open + 1, end - 1);
    if (!names.some((name) => new RegExp(`\\b${escapeRegex(name)}\\b`).test(argumentsText))) continue;
    mergeValidationProof(proof, predicateCallableProof(bodies, helper, new Set(visited).add(helper)));
  }
  return proof;
}

function predicateCallableProof(bodies, name, visited = new Set()) {
  const callable = bodies.get(name);
  if (!callable || visited.size > 12 || /\b(?:throw|process|globalthis)\b|\bimport\.meta\b/.test(callable.body)) {
    return { generic: false, partitions: new Set() };
  }
  const returns = [...callable.body.matchAll(/\breturn\s+([^;\n]{1,1000})/gi)].map((match) => match[1]);
  const expression = returns.length === 1
    ? returns[0]
    : returns.length === 0 && !/[;{}]/.test(callable.body) ? callable.body.trim() : "";
  if (!expression) return { generic: false, partitions: new Set() };
  return positiveValidationConditionProof(expression, callable.parameters, bodies, visited);
}

function outerNegatedCondition(condition) {
  const value = condition.trim();
  if (!value.startsWith("!")) return "";
  const rest = value.slice(1).trim();
  if (rest.startsWith("(") && evidenceBalancedEnd(rest, 0) === rest.length) return rest.slice(1, -1);
  return /^[a-z_$][a-z0-9_$]*\s*\([^)]{0,800}\)$/i.test(rest) ? rest : "";
}

function validationConditionProof(condition, names, bodies) {
  const proof = { generic: false, partitions: new Set() };
  if (simpleConstantValue(condition) === false
    || /\b(?:process|globalthis)\b|\bimport\.meta\b/.test(condition)
    || /(?:^|[({;&|])\s*(?:false|0|null|undefined)\s*&&/.test(condition)) return proof;
  const positiveInner = outerNegatedCondition(condition);
  if (positiveInner) mergeValidationProof(proof, positiveValidationConditionProof(positiveInner, names, bodies));
  for (const name of names) {
    const escaped = escapeRegex(name);
    if (!new RegExp(`\\b${escaped}\\b`).test(condition)) continue;
    const numberGuard = new RegExp(`number\\.(?:isfinite|isinteger|issafeinteger|isnan)\\s*\\(\\s*${escaped}\\b`);
    const arrayGuard = new RegExp(`array\\.isarray\\s*\\(\\s*${escaped}\\b`);
    const comparison = new RegExp(`(?:\\b${escaped}\\b\\s*(?:===|!==|==|!=|<=|>=|<|>)|(?:<=|>=|<|>)\\s*\\b${escaped}\\b)`);
    const validationShape = numberGuard.test(condition)
      || arrayGuard.test(condition)
      || new RegExp(`typeof\\s+${escaped}\\b|\\b${escaped}\\b\\s+instanceof\\b|!\\s*${escaped}\\b|\\b${escaped}\\.(?:length|trim|startswith|endswith|includes|match|search)\\b|\\bstring\\s*\\(\\s*${escaped}\\s*\\)\\s*\\.(?:startswith|endswith|includes|match|search)\\b`).test(condition)
      || comparison.test(condition);
    if (!validationShape) continue;
    proof.generic = true;
    if (new RegExp(`!\\s*number\\.is(?:safe)?integer\\s*\\(\\s*${escaped}\\b|number\\.is(?:safe)?integer\\s*\\(\\s*${escaped}[^)]*\\)\\s*(?:===|==)\\s*false|\\b${escaped}\\b\\s*%\\s*1`).test(condition)) {
      proof.partitions.add("fractional");
      proof.partitions.add("non-finite");
    }
    if (new RegExp(`!\\s*number\\.issafeinteger\\s*\\(\\s*${escaped}\\b`).test(condition)) proof.partitions.add("unsafe-integer");
    if (new RegExp(`!\\s*number\\.isfinite\\s*\\(\\s*${escaped}\\b`).test(condition)) proof.partitions.add("non-finite");
    if (new RegExp(`\\b${escaped}\\b\\s*(?:<\\s*[01]|<=\\s*0)|0\\s*>\\s*\\b${escaped}\\b|\\b${escaped}\\b\\s*<=\\s*-\\d|!\\s*\\(?\\s*\\b${escaped}\\b\\s*>=\\s*0`).test(condition)) proof.partitions.add("negative");
    if (new RegExp(`\\b${escaped}\\b\\s*(?:===|==|<=)\\s*0|\\b${escaped}\\b\\s*<\\s*1|!\\s*\\b${escaped}\\b`).test(condition)) proof.partitions.add("zero");
    if (new RegExp(`\\b${escaped}\\b\\s*(?:===|==)\\s*null|null\\s*(?:===|==)\\s*\\b${escaped}\\b|!\\s*\\b${escaped}\\b`).test(condition)) proof.partitions.add("null");
    if (new RegExp(`\\b${escaped}\\b\\s*(?:===|==)\\s*undefined|typeof\\s+${escaped}\\b\\s*(?:===|==)|!\\s*\\b${escaped}\\b`).test(condition)) proof.partitions.add("missing");
    if (arrayGuard.test(condition) && !new RegExp(`!\\s*array\\.isarray\\s*\\(\\s*${escaped}`).test(condition)) proof.partitions.add("array");
    if (new RegExp(`!\\s*array\\.isarray\\s*\\(\\s*${escaped}`).test(condition)) proof.partitions.add("non-array");
    if (new RegExp(`!\\s*\\b${escaped}\\b|\\b${escaped}\\.length\\s*(?:===|==|<=)\\s*0`).test(condition)) proof.partitions.add("empty-string");
    if (new RegExp(`!\\s*\\b${escaped}\\.trim\\s*\\(`).test(condition)) proof.partitions.add("whitespace-string");
  }
  return proof;
}

function rejectionStatementProves(text, requestedErrors) {
  return requestedErrors.length === 0
    ? /^\s*throw\s+(?:new\s+)?[a-z_$][a-z0-9_$]*(?:\s*\(|\b)/.test(text)
    : requestedErrors.some((name) => new RegExp(`^\\s*throw\\s+(?:new\\s+)?${escapeRegex(name)}\\s*\\(`).test(text));
}

function exactHelperCall(text) {
  let value = String(text ?? "").trim();
  if (value.startsWith("{") && evidenceBalancedEnd(value, 0, "{", "}") === value.length) {
    value = value.slice(1, -1).trim();
  }
  return value.match(/^([a-z_$][a-z0-9_$]*)\s*\(\s*\)\s*;?$/i)?.[1]?.toLowerCase();
}

function exactThrowingHelperProves(bodies, name, requestedErrors) {
  const callable = bodies.get(name);
  if (!callable || callable.parameters.length !== 0) return false;
  const escaped = escapeRegex(name);
  const declarations = [
    ...callable.sourceCode.matchAll(new RegExp(`\\b(?:async\\s+)?function\\s+${escaped}\\s*\\(`, "gi")),
    ...callable.sourceCode.matchAll(new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\(\\s*\\)|[a-z_$][a-z0-9_$]*)\\s*=>`, "gi"))
  ];
  if (declarations.length !== 1 || /\basync\b/i.test(declarations[0][0])
    || sourceBraceDepthAt(callable.sourceCode, declarations[0].index) !== 0
    || new RegExp(`\\bimport\\b[^;\\n]{0,500}\\b${escaped}\\b`, "i").test(callable.sourceCode)
    || /\bprocess\s*\.\s*(?:exit|abort)\s*\(/i.test(callable.sourceCode)
    || bindingWrittenOutsideDeclaration(callable.sourceCode, name)) return false;
  for (const mutation of callable.sourceCode.matchAll(new RegExp(`\\b${escaped}\\b\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=|(?:&&|\\|\\||\\?\\?)=)`, "gi"))) {
    const prefix = callable.sourceCode.slice(Math.max(0, mutation.index - 12), mutation.index);
    const declaration = callable.sourceCode.slice(mutation.index).match(new RegExp(`^${escaped}\\s*=\\s*(?:async\\s*)?(?:\\(\\s*\\)|[a-z_$][a-z0-9_$]*)\\s*=>`, "i"));
    if (/\bconst\s*$/i.test(prefix) && declaration) continue;
    return false;
  }
  if (new RegExp(`\\b(?:const|let|var)\\s+[a-z_$][a-z0-9_$]*\\s*=\\s*${escaped}\\b`, "i").test(callable.sourceCode)) return false;

  const body = callable.body.trim();
  const thrown = body.match(/^throw\s+(?:new\s+)?([a-z_$][a-z0-9_$]*)\s*\(\s*((?:__pi_(?:empty_string_literal|whitespace_string_literal|string_literal|error_name_[a-z]+_literal)__)?\s*)\)\s*;?$/i);
  if (!thrown) return false;
  const errorClass = thrown[1].toLowerCase();
  if (new RegExp(`\\b(?:function|class|const|let|var)\\s+${escapeRegex(errorClass)}\\b|\\bimport\\b[^;\\n]{0,500}\\b${escapeRegex(errorClass)}\\b`, "i").test(callable.sourceCode)) return false;
  if (new RegExp(`(?:\\b|\\.)${escapeRegex(errorClass)}\\b\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=|(?:&&|\\|\\||\\?\\?)=)`, "i").test(callable.sourceCode)) return false;
  if (!intrinsicErrorBindingsUntampered(callable.sourceCode, [errorClass])) return false;
  return requestedErrors.length === 0 ? ERROR_CONSTRUCTORS.includes(errorClass) : requestedErrors.includes(errorClass);
}

function helperBindingIsShadowedInCallable(callable, name) {
  if (callable.parameters.includes(name)) return true;
  const escaped = escapeRegex(name);
  return new RegExp(`\\b(?:function|class|const|let|var)\\s+${escaped}\\b|\\bcatch\\s*\\([^)]*\\b${escaped}\\b`, "i").test(callable.body);
}

function exactHelperGuardProof(condition, names, bodies) {
  // An unknown conjunct, conditional branch, comma expression, or bitwise
  // operand can suppress a rejection even when another token looks like a
  // valid input guard. Keep the accepted helper-call grammar deliberately
  // narrower than arbitrary JavaScript control flow.
  if (/&&|\?|,|(?<!\|)\|(?!\|)|(?<!&)\&(?!&)/.test(condition)) {
    return { generic: false, partitions: new Set() };
  }
  return validationConditionProof(condition, names, bodies);
}

function sourceBraceDepthAt(text, offset) {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function priorUnconditionalExit(text, offset) {
  for (const match of text.slice(0, offset).matchAll(/\b(?:return|throw)\b/g)) {
    if (sourceBraceDepthAt(text, match.index) !== 0) continue;
    const statementStart = Math.max(text.lastIndexOf(";", match.index - 1), text.lastIndexOf("}", match.index - 1)) + 1;
    if (!text.slice(statementStart, match.index).trim()) return true;
  }
  return false;
}

function directSourceCall(text, offset) {
  if (sourceBraceDepthAt(text, offset) !== 0 || priorUnconditionalExit(text, offset)) return false;
  const statementStart = Math.max(text.lastIndexOf(";", offset - 1), text.lastIndexOf("}", offset - 1)) + 1;
  return /^(?:await\s+)?$/.test(text.slice(statementStart, offset).trim());
}

function inputNameWrittenBefore(callable, name, offset) {
  const prefix = callable.body.slice(0, offset);
  const escaped = escapeRegex(name);
  for (const match of prefix.matchAll(new RegExp(`\\b${escaped}\\b(?:\\s*(?:\\.[a-z_$][a-z0-9_$]*|\\[[^\\]]+\\]))?\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=)`, "gi"))) {
    const declarationPrefix = prefix.slice(Math.max(0, match.index - 12), match.index);
    if (/\bconst\s*$/i.test(declarationPrefix) && !/[.[]/.test(match[0].slice(name.length))) continue;
    return true;
  }
  return new RegExp(`(?:\\+\\+|--)\\s*\\b${escaped}\\b`, "i").test(prefix);
}

function conditionalRejection(callable, requestedErrors, bodies) {
  const proof = { generic: false, partitions: new Set() };
  const names = inputDerivedNames(callable);
  for (const match of callable.body.matchAll(/\bif\s*\(/g)) {
    if (sourceBraceDepthAt(callable.body, match.index) !== 0 || priorUnconditionalExit(callable.body, match.index)) continue;
    const conditionOpen = callable.body.indexOf("(", match.index);
    const conditionEnd = evidenceBalancedEnd(callable.body, conditionOpen);
    if (conditionEnd === -1) continue;
    let consequentStart = conditionEnd;
    while (/\s/.test(callable.body[consequentStart] ?? "")) consequentStart += 1;
    const consequentEnd = callable.body[consequentStart] === "{"
      ? evidenceBalancedEnd(callable.body, consequentStart, "{", "}")
      : (callable.body.indexOf(";", consequentStart) + 1 || callable.body.length);
    const consequent = callable.body.slice(consequentStart, consequentEnd === -1 ? callable.body.length : consequentEnd);
    const condition = callable.body.slice(conditionOpen + 1, conditionEnd - 1);
    const liveNames = names.filter((name) => !inputNameWrittenBefore(callable, name, match.index));
    if (rejectionStatementProves(consequent.replace(/^\s*\{/, ""), requestedErrors)) {
      mergeValidationProof(proof, validationConditionProof(condition, liveNames, bodies));
      continue;
    }
    const throwingHelper = exactHelperCall(consequent);
    if (throwingHelper && !helperBindingIsShadowedInCallable(callable, throwingHelper)
      && exactThrowingHelperProves(bodies, throwingHelper, requestedErrors)) {
      mergeValidationProof(proof, exactHelperGuardProof(condition, liveNames, bodies));
      continue;
    }
    if (!/^\s*\{?\s*return\b/.test(consequent)) continue;
    const following = callable.body.slice(consequentEnd === -1 ? callable.body.length : consequentEnd);
    if (rejectionStatementProves(following, requestedErrors)) {
      mergeValidationProof(proof, positiveValidationConditionProof(condition, liveNames, bodies));
    }
  }
  return { ...proof, names };
}

function sourceCallableProof(bodies, name, requestedErrors, visited = new Set()) {
  if (visited.has(name) || visited.size >= 12) return { generic: false, partitions: new Set() };
  const callable = bodies.get(name);
  if (!callable) return { generic: false, partitions: new Set() };
  const proof = conditionalRejection(callable, requestedErrors, bodies);
  const nextVisited = new Set(visited).add(name);
  for (const match of callable.body.matchAll(/\b([a-z_$][a-z0-9_$]*)\s*\(/gi)) {
    const helper = match[1].toLowerCase();
    if (!bodies.has(helper) || !directSourceCall(callable.body, match.index)) continue;
    const open = callable.body.indexOf("(", match.index);
    const end = evidenceBalancedEnd(callable.body, open);
    const argumentsText = end === -1 ? "" : callable.body.slice(open + 1, end - 1);
    if (!proof.names.some((candidate) => !inputNameWrittenBefore(callable, candidate, match.index)
      && new RegExp(`\\b${escapeRegex(candidate)}\\b`).test(argumentsText))) continue;
    const helperProof = sourceCallableProof(bodies, helper, requestedErrors, nextVisited);
    proof.generic ||= helperProof.generic;
    for (const partition of helperProof.partitions) proof.partitions.add(partition);
  }
  return proof;
}

function sourceCallableProves(bodies, name, requestedErrors, requestedPartitions) {
  const proof = sourceCallableProof(bodies, name, requestedErrors);
  return proof.generic && requestedPartitions.every((partition) => partitionCovered(partition, proof.partitions));
}
function evidenceCallableNames(sourceText) {
  const names = new Set();
  const ignored = new Set(["catch", "for", "if", "switch", "while", "with"]);
  for (const match of sourceText.matchAll(/\bfunction\s+([a-z_$][a-z0-9_$]*)\s*\(/gi)) names.add(match[1].toLowerCase());
  for (const match of sourceText.matchAll(/^\s*(?:async\s+)?([a-z_$][a-z0-9_$]*)\s*\([^)]*\)\s*\{/gim)) {
    if (!ignored.has(match[1].toLowerCase())) names.add(match[1].toLowerCase());
  }
  for (const match of sourceText.matchAll(/\b(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[a-z_$][a-z0-9_$]*)\s*=>/gi)) names.add(match[1].toLowerCase());
  return names;
}

function requestedInvalidPartitions(text) {
  const invalid = normalizedText(text)
    .split(/(?<=[.!?;])\s+|\n+/)
    .filter((clause) => /\b(?:invalid|malformed|reject(?:s|ed|ion)?|throw(?:s|ing)?|typeerror|rangeerror|syntaxerror)\b/.test(clause))
    .join("\n");
  const partitions = new Set();
  if (/\bnegative\b/.test(invalid)) partitions.add("negative");
  if (/\bfractional\b/.test(invalid)) partitions.add("fractional");
  if (/\bzero\b/.test(invalid)) partitions.add("zero");
  if (/\bnull\b/.test(invalid)) partitions.add("null");
  if (/\b(?:empty[- ]string|whitespace-only|string[^.\n]{0,80}non-whitespace)\b/.test(invalid)) partitions.add("empty-string");
  if (/\bwhitespace-only\b/.test(invalid)) partitions.add("whitespace-string");
  if (/\bnon-finite\b/.test(invalid)) partitions.add("non-finite");
  if (/\bunsafe[- ]integer\b/.test(invalid)) partitions.add("unsafe-integer");
  if (/\b(?:missing|undefined)\b/.test(invalid)) partitions.add("missing");
  if (/\bnon-array\b/.test(invalid)) partitions.add("non-array");
  if (/\bnon-string\b/.test(invalid)) partitions.add("non-string");
  if (/\breject(?:s|ed|ing)?\s+(?:an?\s+)?arrays?\b|\barrays?\s+(?:values?\s+)?(?:are|is|must be)\s+(?:invalid|rejected|disallowed|not allowed)\b/.test(invalid)) partitions.add("array");
  if (/\breject(?:s|ed|ing)?\s+(?:an?\s+)?plain[- ]objects?\b|\bplain[- ]objects?\s+(?:values?\s+)?(?:are|is|must be)\s+(?:invalid|rejected|disallowed|not allowed)\b/.test(invalid)) partitions.add("plain-object");
  if (/\breject(?:s|ed|ing)?\s+(?:an?\s+)?primitives?\b|\bprimitives?\s+(?:values?\s+)?(?:are|is|must be)\s+(?:invalid|rejected|disallowed|not allowed)\b/.test(invalid)) partitions.add("primitive");
  return [...partitions];
}

function moduleBindingFreeCode(entry) {
  return normalizedText(sanitizeJavaScriptEvidence(entry?.text ?? ""))
    .replace(/\bimport\s+[\s\S]{1,800}?\s+from\s+__pi_(?:string|node_assert_module|code_generation_module|module_loader_module)_literal__\s*;?/g, " ")
    .replace(/\b(?:const|let|var)\s+[\s\S]{1,800}?=\s*(?:require|import)\s*\(\s*__pi_(?:string|node_assert_module|code_generation_module|module_loader_module)_literal__\s*\)(?:\s*\.\s*[a-z_$][a-z0-9_$]*)?\s*;?/g, " ");
}

function importedBindingIsShadowed(testEntry, testName) {
  const localName = String(testName ?? "").split(".")[0];
  if (!localName) return true;
  const code = moduleBindingFreeCode(testEntry);
  const escaped = escapeRegex(localName);
  const member = String(testName).split(".")[1];
  const reassigned = member
    ? new RegExp(`\\b${escaped}\\s*\\.\\s*${escapeRegex(member)}\\s*(?:=|\\+\\+|--|[+*/%&|^-]=)|\\bobject\\.(?:defineproperty|assign)\\s*\\(\\s*${escaped}\\b`, "i").test(code)
    : new RegExp(`\\b${escaped}\\s*(?:=|\\+\\+|--|[+*/%&|^-]=)`, "i").test(code);
  return reassigned || new RegExp(`\\b(?:function|class)\\s+${escaped}\\b|\\b(?:const|let|var)\\s+${escaped}\\b|\\b(?:function|catch)\\s*[^({]*\\([^)]*\\b${escaped}\\b|(?:\\(|,)\\s*${escaped}\\s*(?:[,)=:]|=>)`, "i").test(code);
}

/**
 * Link one changed source/test pair through an exported callable, a literal
 * static module binding, and a live rejection assertion. This pure projection
 * is shared with repair authorization so it cannot fall back to name-only
 * related-test matching. Ambiguous, unresolved, shadowed, skipped, or dead
 * evidence is deliberately omitted.
 */
export function acceptanceExecutableTestBinding(input = {}) {
  const sourceEntry = input.sourceEntry;
  const testEntry = input.testEntry;
  if (!sourceEntry || !testEntry || typeof sourceEntry.path !== "string" || typeof sourceEntry.text !== "string"
    || typeof testEntry.path !== "string" || typeof testEntry.text !== "string") {
    return { linked: false, sourceNames: [], testNames: [] };
  }
  const sourceCode = normalizedText(sanitizeJavaScriptEvidence(sourceEntry.text));
  const testCode = normalizedText(sanitizeJavaScriptEvidence(testEntry.text));
  const bodies = callableBodies(sourceCode);
  const imports = staticModuleBindings(testEntry);
  const linkedSourceNames = [];
  const linkedTestNames = [];
  for (const exported of sourceExports(sourceEntry)) {
    if (!bodies.has(exported.sourceName)) continue;
    const testNames = uniqueStrings(imports
      .filter((binding) => importResolvesTo(binding, exported.sourcePath)
        && (binding.importName === exported.exportName || binding.importName === "*"))
      .map((binding) => binding.importName === "*" ? `${binding.localName}.${exported.exportName}` : binding.localName)
      .filter((testName) => !importedBindingIsShadowed(testEntry, testName)));
    if (testNames.length === 0) continue;
    const assertions = executableRejectionAssertions(testCode, new Set(testNames));
    const liveNames = testNames.filter((testName) => assertions.some((assertion) => assertion.targets.includes(testName)));
    if (liveNames.length === 0) continue;
    linkedSourceNames.push(exported.sourceName);
    linkedTestNames.push(...liveNames);
  }
  return {
    linked: linkedSourceNames.length > 0,
    sourceNames: uniqueStrings(linkedSourceNames),
    testNames: uniqueStrings(linkedTestNames)
  };
}

function partitionCovered(partition, observed) {
  if (observed.has(partition)) return true;
  if (partition === "non-array") return ["null", "plain-object", "primitive"].some((item) => observed.has(item));
  if (partition === "non-string") return ["null", "array", "plain-object", "primitive"].some((item) => observed.has(item));
  return false;
}

/**
 * Decide whether final-tree JS/TS evidence contains an executable rejection
 * and executable focused assertions. The caller supplies task-derived named
 * entrypoints; no scenario identity or verifier output text is trusted.
 */
export function acceptanceInvalidInputEvidence(input = {}) {
  const taskText = String(input.taskText ?? "");
  const sourceText = normalizedText(sanitizeJavaScriptEvidence(input.sourceText));
  const testText = normalizedText(sanitizeJavaScriptEvidence(input.testText));
  const requestedErrors = requestedErrorClasses(taskText);
  const requestedPartitions = requestedInvalidPartitions(taskText);
  const namedTargets = uniqueStrings(input.namedTargets).map((item) => item.toLowerCase());
  const provenanceTargets = new Set(uniqueStrings(input.provenanceTargets).map((item) => item.toLowerCase()));
  const sourceEntries = (Array.isArray(input.sourceEntries) ? input.sourceEntries : [])
    .filter((entry) => entry && typeof entry.path === "string" && typeof entry.text === "string");
  const testEntries = (Array.isArray(input.testEntries) ? input.testEntries : [])
    .filter((entry) => entry && typeof entry.path === "string" && typeof entry.text === "string");
  const bodyMaps = new Map(sourceEntries.map((entry) => [entryPath(entry.path), callableBodies(normalizedText(sanitizeJavaScriptEvidence(entry.text)))]));
  if (sourceEntries.length === 0) bodyMaps.set("", callableBodies(sourceText));
  const sourceLexicalOk = sourceEntries.length > 0 ? sourceEntries.every((entry) => lexicalEvidenceIsNonReflective(normalizedText(sanitizeJavaScriptEvidence(entry.text)))) : lexicalEvidenceIsNonReflective(sourceText);
  const testLexicalOk = testEntries.length > 0 ? testEntries.every((entry) => lexicalEvidenceIsNonReflective(normalizedText(sanitizeJavaScriptEvidence(entry.text)))) : lexicalEvidenceIsNonReflective(testText);
  const sourceConstructorOk = requestedErrors.length === 0 || (sourceEntries.length > 0
    ? sourceEntries.every((entry) => intrinsicErrorBindingsUntampered(normalizedText(sanitizeJavaScriptEvidence(entry.text)), requestedErrors))
    : intrinsicErrorBindingsUntampered(sourceText, requestedErrors));
  const testConstructorOk = requestedErrors.length === 0 || (testEntries.length > 0
    ? testEntries.every((entry) => intrinsicErrorBindingsUntampered(normalizedText(sanitizeJavaScriptEvidence(entry.text)), requestedErrors))
    : intrinsicErrorBindingsUntampered(testText, requestedErrors));

  const strictTargets = namedTargets.filter((target) => provenanceTargets.has(target));
  const structuralTargets = namedTargets.filter((target) => !provenanceTargets.has(target));
  const bindings = strictTargets.length > 0 ? namedTargetBindings(sourceEntries, testEntries, strictTargets) : [];
  const inferred = namedTargets.length === 0 ? resolvedExportTestBindings(sourceEntries, testEntries) : [];
  const inferredAssertions = inferred.flatMap((binding) => {
    const entry = testEntries.find((candidate) => entryPath(candidate?.path) === binding.testPath);
    if (!entry) return [];
    const code = normalizedText(sanitizeJavaScriptEvidence(entry.text));
    return executableRejectionAssertions(code, new Set([binding.testName]))
      .filter((assertion) => assertion.targets.includes(binding.testName)
        && (requestedErrors.length === 0 || requestedErrors.some((name) => assertion.errorClasses.includes(name))))
      .map((assertion) => ({ assertion, binding }));
  });
  const testCallables = new Set([...bindings.flatMap((binding) => binding.testNames), ...structuralTargets.map((target) => `*.${target}`)]);
  const namedAssertions = namedTargets.length > 0
    ? executableRejectionAssertions(testText, testCallables).filter((assertion) => (
        requestedErrors.length === 0 || requestedErrors.some((name) => assertion.errorClasses.includes(name))
      ))
    : [];
  const assertions = namedTargets.length > 0 ? namedAssertions : inferredAssertions.map((item) => item.assertion);
  const targetOk = assertions.length > 0 && (namedTargets.length === 0 || (
    bindings.every((binding) => binding.testNames.length > 0 && binding.testNames.some((name) => assertions.some((assertion) => assertion.targets.includes(name))))
    && structuralTargets.every((target) => assertions.some((assertion) => assertion.targets.includes(`*.${target}`)))
  ));
  const sourceOk = sourceLexicalOk && sourceConstructorOk && (namedTargets.length > 0
    ? bindings.length === strictTargets.length
      && bindings.every((binding) => Boolean(binding.sourcePath) && Boolean(binding.sourceName) && sourceCallableProves(bodyMaps.get(binding.sourcePath) ?? new Map(), binding.sourceName, requestedErrors, requestedPartitions))
      && structuralTargets.every((target) => [...bodyMaps.values()].filter((bodies) => bodies.has(target)).length === 1
        && [...bodyMaps.values()].some((bodies) => sourceCallableProves(bodies, target, requestedErrors, requestedPartitions)))
    : inferredAssertions.length > 0 && inferredAssertions.every(({ binding }) => (
        sourceCallableProves(bodyMaps.get(binding.sourcePath) ?? new Map(), binding.sourceName, requestedErrors, requestedPartitions)
      )));
  const partitions = new Set(assertions.flatMap((assertion) => [...assertion.partitions]));
  const partitionOk = requestedPartitions.every((partition) => partitionCovered(partition, partitions));
  return { sourceOk, testOk: testLexicalOk && testConstructorOk && targetOk && partitionOk };
}

export function acceptanceContractProofGuidance(raw) {
  const value = normalizedText(raw);
  const guidance = [...acceptanceBoundaryProofGuidance(raw)];
  if (onlyUndefinedContract(raw)) guidance.push("Prove undefined falls through while null, false, 0, and empty string are each preserved at the highest-precedence position.");
  if (/\btypeerror\b/.test(value)) guidance.push("Assert TypeError for every rejected partition named by the request; a different error class is not equivalent.");
  const integerTargets = integerConstraintTargets(raw);
  if (integerTargets.length > 0) guidance.push(`Reject fractional values for every integer-constrained argument (${integerTargets.join(", ")}).`);
  const nullRejectingTargets = nullRejectingDefaultTargets(raw);
  if (nullRejectingTargets.length > 0) guidance.push(`Prove omitted or undefined defaults separately from supplied null for: ${nullRejectingTargets.join(", ")}.`);
  if (/\bpositive integer\b/.test(value)) guidance.push("Exercise zero and a negative value for every positive-integer constraint.");
  if (/\bnon-negative\b/.test(value)) guidance.push("Exercise zero as valid and a negative value as invalid for every non-negative constraint.");
  if (/\binclusive\b|\bthrough\b|\bfrom\b[^.\n]{0,80}\bto\b/.test(value)) guidance.push("Exercise both inclusive endpoints and the nearest value outside each endpoint.");
  if (/\bround(?:ing)?\b|\bceil(?:ing)?\b|\bclamp\b/.test(value)) guidance.push("Exercise zero, exact, partial/rounding, below-minimum, and above-maximum behavior where applicable.");
  return uniqueStrings(guidance).slice(0, 8);
}

export function acceptanceContractSemanticConflicts(obligation, taskText, sourceText) {
  const normalizedTask = normalizedText(taskText);
  const source = normalizedText(sanitizeJavaScriptEvidence(sourceText));
  const conflicts = [];
  if (obligation === "boundary-case" && onlyUndefinedContract(taskText) && /\?\?/.test(source)) conflicts.push("nullish-coalescing-conflicts-with-undefined-only-precedence");
  if (source && ["boundary-case", "invalid-input-rejection"].includes(obligation)) {
    for (const target of nullRejectingDefaultTargets(taskText, source)) conflicts.push(`nullish-default-conflicts-with-invalid-null:${target}`);
  }
  if (obligation === "invalid-input-rejection" && /\btypeerror\b/.test(normalizedTask) && !/\brangeerror\b/.test(normalizedTask) && /\brangeerror\b/.test(source)) {
    conflicts.push("rangeerror-conflicts-with-requested-typeerror");
  }
  if (obligation === "invalid-input-rejection") {
    const guardHelpers = integerGuardHelpers(source);
    for (const target of integerConstraintTargets(taskText, source)) {
      const escaped = escapeRegex(target);
      const guardedDirectly = new RegExp(`number\\.is(?:safe)?integer\\s*\\(\\s*${escaped}\\b`).test(source);
      const guardedByHelper = guardHelpers.some((helper) => new RegExp(`\\b${escapeRegex(helper)}\\s*\\(\\s*${escaped}\\b`).test(source));
      if (!guardedDirectly && !guardedByHelper) conflicts.push(`missing-integer-guard:${target}`);
    }
  }
  return conflicts;
}

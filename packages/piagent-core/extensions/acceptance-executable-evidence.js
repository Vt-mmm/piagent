const ERROR_CONSTRUCTORS = ["typeerror", "rangeerror", "syntaxerror", "referenceerror", "urierror", "evalerror", "aggregateerror", "error"];

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertionCarrierBindings(testText) {
  const bindings = [];
  const add = (name, start, end) => {
    if (name) bindings.push({ name: name.toLowerCase(), start, end });
  };
  for (const match of testText.matchAll(/\bimport\s+([a-z_$][a-z0-9_$]*)\s+from\s+__pi_node_assert_module_literal__\s*;?/gi)) {
    add(match[1], match.index, match.index + match[0].length);
  }
  for (const match of testText.matchAll(/\bimport\s+\*\s+as\s+([a-z_$][a-z0-9_$]*)\s+from\s+__pi_node_assert_module_literal__\s*;?/gi)) {
    add(match[1], match.index, match.index + match[0].length);
  }
  for (const match of testText.matchAll(/\bimport\s*\{([^}]{1,500})\}\s*from\s+__pi_node_assert_module_literal__\s*;?/gi)) {
    for (const item of match[1].split(",")) {
      const strict = item.trim().match(/^strict(?:\s+as\s+([a-z_$][a-z0-9_$]*))?$/i);
      if (strict) add(strict[1] ?? "strict", match.index, match.index + match[0].length);
    }
  }
  for (const match of testText.matchAll(/\bconst\s+([a-z_$][a-z0-9_$]*)\s*=\s*require\s*\(\s*__pi_node_assert_module_literal__\s*\)(?:\s*\.\s*strict)?\s*;?/gi)) {
    add(match[1], match.index, match.index + match[0].length);
  }
  for (const match of testText.matchAll(/\bconst\s*\{\s*strict\s*:\s*([a-z_$][a-z0-9_$]*)\s*\}\s*=\s*require\s*\(\s*__pi_node_assert_module_literal__\s*\)\s*;?/gi)) {
    add(match[1], match.index, match.index + match[0].length);
  }
  return bindings.slice(0, 8);
}

const TEST_RUNNER_EXPORT_KINDS = new Map([
  ["test", "test"], ["it", "test"], ["describe", "suite"], ["suite", "suite"]
]);

function testRunnerBindings(testText) {
  const bindings = [];
  const add = (name, kind, start, end) => {
    if (name && kind) bindings.push({ name: name.toLowerCase(), kind, start, end });
  };
  for (const match of testText.matchAll(/\bimport\s+([a-z_$][a-z0-9_$]*)(?:\s*,\s*\{[^}]{1,500}\})?\s+from\s+__pi_node_test_module_literal__\s*;?/gi)) {
    add(match[1], "test", match.index, match.index + match[0].length);
  }
  for (const match of testText.matchAll(/\bimport\s+(?:[a-z_$][a-z0-9_$]*\s*,\s*)?\{([^}]{1,500})\}\s+from\s+__pi_node_test_module_literal__\s*;?/gi)) {
    for (const raw of match[1].split(",")) {
      const item = raw.trim().match(/^(test|it|describe|suite)(?:\s+as\s+([a-z_$][a-z0-9_$]*))?$/i);
      if (item) add(item[2] ?? item[1], TEST_RUNNER_EXPORT_KINDS.get(item[1].toLowerCase()), match.index, match.index + match[0].length);
    }
  }
  for (const match of testText.matchAll(/\bconst\s+([a-z_$][a-z0-9_$]*)\s*=\s*require\s*\(\s*__pi_node_test_module_literal__\s*\)\s*;?/gi)) {
    add(match[1], "test", match.index, match.index + match[0].length);
  }
  for (const match of testText.matchAll(/\bconst\s+([a-z_$][a-z0-9_$]*)\s*=\s*require\s*\(\s*__pi_node_test_module_literal__\s*\)\s*\.\s*(test|it|describe|suite)\s*;?/gi)) {
    add(match[1], TEST_RUNNER_EXPORT_KINDS.get(match[2].toLowerCase()), match.index, match.index + match[0].length);
  }
  for (const match of testText.matchAll(/\bconst\s*\{([^}]{1,500})\}\s*=\s*require\s*\(\s*__pi_node_test_module_literal__\s*\)\s*;?/gi)) {
    for (const raw of match[1].split(",")) {
      const item = raw.trim().match(/^(test|it|describe|suite)(?:\s*:\s*([a-z_$][a-z0-9_$]*))?$/i);
      if (item) add(item[2] ?? item[1], TEST_RUNNER_EXPORT_KINDS.get(item[1].toLowerCase()), match.index, match.index + match[0].length);
    }
  }
  return bindings.slice(0, 16);
}

function importedCallableBindingIsStable(testText, binding, bindings) {
  const escaped = escapeRegex(binding.name);
  const withoutDeclaration = `${testText.slice(0, binding.start)}${" ".repeat(binding.end - binding.start)}${testText.slice(binding.end)}`;
  if (bindings.filter((candidate) => candidate.name === binding.name).length !== 1) return false;
  if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${escaped}\\b|\\bfunction\\b[^({]{0,200}\\([^)]*\\b${escaped}\\b|\\bcatch\\s*\\([^)]*\\b${escaped}\\b|(?:\\([^)]*\\b${escaped}\\b[^)]*\\)|\\b${escaped})\\s*=>`, "i").test(withoutDeclaration)) return false;
  if (new RegExp(`(?<![.$a-z0-9_])${escaped}\\b\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=)|(?:\\+\\+|--)\\s*\\b${escaped}\\b`, "i").test(withoutDeclaration)) return false;
  if (new RegExp(`\\b(?:const|let|var)\\s+[a-z_$][a-z0-9_$]*\\s*=\\s*${escaped}\\b|\\b(?:const|let|var)\\s*\\{[^}\\n]{0,500}\\}\\s*=\\s*${escaped}\\b`, "i").test(withoutDeclaration)) return false;
  if (new RegExp(`(?<![.$a-z0-9_])[a-z_$][a-z0-9_$]*\\s*(?<![=!<>])=(?!=|>)\\s*${escaped}\\b`, "i").test(withoutDeclaration)) return false;
  const member = `${escaped}\\s*(?:\\.\\s*[a-z_$][a-z0-9_$]*|\\[[^\\]]{1,300}\\])`;
  if (new RegExp(`\\b${member}\\s*(?:=|\\+\\+|--|[+*/%&|^-]=|(?:&&|\\|\\||\\?\\?)=)|(?:\\+\\+|--)\\s*\\b${member}|\\bdelete\\s+${escaped}\\s*(?:\\.|\\[)|\\b${escaped}\\s*\\.\\s*__(?:definegetter|definesetter)__\\s*\\(`, "i").test(withoutDeclaration)) return false;
  if (new RegExp(`(?:\\{[^}\\n]{0,500}\\b${member}[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${member}[^\\]\\n]{0,500}\\])\\s*=|\\bfor(?:\\s+await)?\\s*\\(\\s*(?:${member}|\\{[^}\\n]{0,500}\\b${member}[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${member}[^\\]\\n]{0,500}\\])\\s+(?:of|in)\\b`, "i").test(withoutDeclaration)) return false;
  if (new RegExp(`\\b(?:object|reflect)\\s*\\.\\s*[a-z_$][a-z0-9_$]*\\s*\\(\\s*${escaped}\\s*[,)]|\\b[a-z_$][a-z0-9_$.]*\\s*\\(\\s*${escaped}\\s*[,)]`, "i").test(withoutDeclaration)) return false;
  for (const match of withoutDeclaration.matchAll(new RegExp(`\\b${escaped}\\b`, "gi"))) {
    const suffix = withoutDeclaration.slice(match.index + match[0].length);
    if (/^\s*\(/.test(suffix) || /^\s*\.\s*[a-z_$][a-z0-9_$]*\s*\(/i.test(suffix)) continue;
    return false;
  }
  return true;
}

function assertionCarrierIsStable(testText, binding) {
  return importedCallableBindingIsStable(testText, binding, assertionCarrierBindings(testText));
}

function assertionEvidenceFileSupported(testText) {
  if (/\\|__pi_(?:code_generation|module_loader)_module_literal__|\b(?:eval|createrequire)\b|\b(?:process|globalthis|global|window|self|this)\b|\bmodule\s*\.\s*(?:require|constructor|_load)\b|\.\s*constructor\b|\bfunction\s*\(|(?:=|[,([])\s*function\b(?!\s+[a-z_$][a-z0-9_$]*\s*\()/i.test(testText)) return false;
  if (/\brequire\b(?!\s*\()/i.test(testText)) return false;
  for (const match of testText.matchAll(/\b(?:require|import)\s*\(/gi)) {
    const open = testText.indexOf("(", match.index);
    const end = balancedEnd(testText, open);
    const argument = end === -1 ? "" : testText.slice(open + 1, end - 1).trim();
    if (!/^__pi_(?:bound_string_\d+|string|node_assert_module|node_test_module)_literal__$/.test(argument)) return false;
  }
  return true;
}

function nodeAssertModuleReferenceCount(testText) {
  return [...testText.matchAll(/__pi_node_assert_module_literal__/g)].length;
}

export function literalArrayIterationEnvironmentIsStable(testText) {
  const code = String(testText ?? "");
  if (/\barray\s*\.\s*prototype\b|\bsymbol\b|\breflect\b|__proto__|\bobject\s*\.\s*(?:get|set|define|assign)/i.test(code)) return false;
  const intrinsic = "(?:array|symbol)";
  if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${intrinsic}\\b|\\bimport\\s+(?:\\*\\s+as\\s+)?${intrinsic}\\b|\\bimport\\s*\\{[^}\\n]{0,500}\\bas\\s+${intrinsic}\\b`, "i").test(code)) return false;
  if (new RegExp(`\\b(?:const|let|var)\\s+(?:\\{[^}\\n]{0,500}\\b${intrinsic}\\b|\\[[^\\]\\n]{0,500}\\b${intrinsic}\\b)|\\b(?:function|catch)\\b[^({]{0,200}\\([^)]*\\b${intrinsic}\\b`, "i").test(code)) return false;
  if (new RegExp(`(?:\\([^)]*\\b${intrinsic}\\b[^)]*\\)|\\b${intrinsic})\\s*=>|(?<![.$a-z0-9_])${intrinsic}\\s*(?:(?<![=!<>])=(?!=|>)|\\+\\+|--|[+*/%&|^-]=)`, "i").test(code)) return false;
  return true;
}

function moduleBackedBindings(code, moduleToken, exportedNames = []) {
  const names = new Set(), token = escapeRegex(moduleToken);
  const add = (name) => { if (/^[a-z_$][a-z0-9_$]*$/i.test(name ?? "")) names.add(name.toLowerCase()); };
  for (const match of code.matchAll(new RegExp(`\\bimport\\s+([a-z_$][a-z0-9_$]*)(?:\\s*,\\s*\\{[^}]{1,500}\\})?\\s+from\\s+${token}\\b`, "gi"))) add(match[1]);
  for (const match of code.matchAll(new RegExp(`\\bimport\\s+\\*\\s+as\\s+([a-z_$][a-z0-9_$]*)\\s+from\\s+${token}\\b`, "gi"))) add(match[1]);
  for (const match of code.matchAll(new RegExp(`\\bimport\\s+(?:[a-z_$][a-z0-9_$]*\\s*,\\s*)?\\{([^}]{1,500})\\}\\s*from\\s+${token}\\b`, "gi"))) {
    for (const raw of match[1].split(",")) {
      const item = raw.trim().match(/^([a-z_$][a-z0-9_$]*)(?:\s+as\s+([a-z_$][a-z0-9_$]*))?$/i);
      if (item && exportedNames.includes(item[1].toLowerCase())) add(item[2] ?? item[1]);
    }
  }
  for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*require\\s*\\(\\s*${token}\\s*\\)(?:\\s*\\.\\s*(?:strict|${exportedNames.join("|")}))?\\s*;?`, "gi"))) add(match[1]);
  for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]{1,500})\\}\\s*=\\s*require\\s*\\(\\s*${token}\\s*\\)`, "gi"))) {
    for (const raw of match[1].split(",")) {
      const item = raw.trim().match(/^([a-z_$][a-z0-9_$]*)(?:\s*:\s*([a-z_$][a-z0-9_$]*))?$/i);
      if (item && exportedNames.includes(item[1].toLowerCase())) add(item[2] ?? item[1]);
    }
  }
  for (let pass = 0; pass < 4; pass += 1) {
    const priorSize = names.size;
    for (const name of [...names]) {
      const backed = `${escapeRegex(name)}(?:\\s*\\.\\s*[a-z_$][a-z0-9_$]*|\\s*\\[[^\\]\\n]{1,300}\\])?`;
      for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*${backed}\\s*(?:;|\\n|$)`, "gi"))) add(match[1]);
      for (const match of code.matchAll(new RegExp(`(?<![.$a-z0-9_])([a-z_$][a-z0-9_$]*)\\s*=\\s*${backed}\\s*(?:;|\\n|$)`, "gi"))) add(match[1]);
      for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]{1,500})\\}\\s*=\\s*${escapeRegex(name)}\\b`, "gi"))) {
        for (const raw of match[1].split(",")) add(raw.trim().match(/^(?:[a-z_$][a-z0-9_$]*\s*:\s*)?([a-z_$][a-z0-9_$]*)$/i)?.[1]);
      }
    }
    if (names.size === priorSize) break;
  }
  return [...names];
}

function withoutModuleBindingDeclarations(code, moduleToken) {
  const token = escapeRegex(moduleToken), blank = (match) => " ".repeat(match.length);
  return String(code ?? "")
    .replace(new RegExp(`\\bimport\\s+[^;\\n]{1,800}?\\s+from\\s+${token}\\s*;?`, "gi"), blank)
    .replace(new RegExp(`\\b(?:const|let|var)\\s+[^;\\n]{1,800}?=\\s*require\\s*\\(\\s*${token}\\s*\\)[^;\\n]*;?`, "gi"), blank);
}

function moduleBindingEscapes(code, binding) {
  const name = `(?<![.$a-z0-9_])${escapeRegex(binding)}\\b`;
  if (new RegExp(`\\b(?:const|let|var)\\s+[a-z_$][a-z0-9_$]*\\s*=\\s*(?:${name}|\\{[^}\\n]{0,500}${name}|\\[[^\\]\\n]{0,500}${name})`, "i").test(code)) return true;
  if (new RegExp(`(?<![=!<>])=(?!=|>)\\s*${name}|\\breturn\\s+${name}|=>\\s*${name}|\\.\\.\\.\\s*${name}`, "i").test(code)) return true;
  if (new RegExp(`(?:\\(|\\{|\\[|,|:)\\s*(?:[a-z_$][a-z0-9_$]*\\s*:\\s*)?${name}\\s*(?:,|\\)|\\}|\\])`, "i").test(code)) return true;
  return new RegExp(`(?:\\(|,)\\s*${name}\\s*(?:,|\\))`, "i").test(code);
}

function moduleTargetIsMutated(code, target) {
  const member = "(?:\\s*\\.\\s*[a-z_$][a-z0-9_$]*|\\s*\\[[^\\]\\n]{1,300}\\])";
  const lvalue = `(?:${target})(?:${member}){1,4}`;
  if (new RegExp(`${lvalue}\\s*(?:=(?!=|>)|\\+\\+|--|[+*/%&|^-]=|(?:&&|\\|\\||\\?\\?)=)|(?:\\+\\+|--)\\s*${lvalue}|\\bdelete\\s+${lvalue}`, "i").test(code)) return true;
  if (new RegExp(`\\b(?:object\\s*\\.\\s*(?:assign|defineproperties|defineproperty|setprototypeof)|reflect\\s*\\.\\s*(?:defineproperty|set|setprototypeof))\\s*\\(\\s*(?:${target})\\s*[,)]`, "i").test(code)) return true;
  return new RegExp(`(?:${target})\\s*\\.\\s*__(?:definegetter|definesetter)__\\s*\\(`, "i").test(code);
}

/** Reject corpus-wide mutation of assertion carriers or test registration APIs. */
export function testProofIntrinsicsAreStable(testText) {
  const code = String(testText ?? "");
  if (/__pi_node_process_module_literal__|\bprocess\s*(?:\.|\[)/i.test(code)) return false;
  if (/\bimport\s+(?:__pi_bound_string_\d+__|__pi_template_literal__)\s*(?=;|\b(?:assert|with)\b|[\r\n]|$)/i.test(code)) return false;
  if (/__pi_template_literal__/.test(code)
    && /__pi_node_(?:assert|test)_module_literal__/.test(code)) return false;
  for (const match of code.matchAll(/\b(?:import|require)\s*\(/gi)) {
    const open = code.indexOf("(", match.index), end = balancedEnd(code, open);
    const argument = end === -1 ? "" : code.slice(open + 1, end - 1).trim();
    if (!/^__pi_(?:bound_string_\d+|node_assert_module|node_process_module|node_test_module)_literal__$/.test(argument)) return false;
    if (/^__pi_node_(?:assert|test)_module_literal__$/.test(argument) && /^import/i.test(match[0])) return false;
  }
  const modules = [
    { token: "__pi_node_assert_module_literal__", exports: ["default", "strict"] },
    { token: "__pi_node_test_module_literal__", exports: ["default", ...TEST_RUNNER_EXPORT_KINDS.keys()] }
  ];
  for (const module of modules) {
    const direct = `require\\s*\\(\\s*${module.token}\\s*\\)(?:\\s*\\.\\s*strict)?`;
    if (moduleTargetIsMutated(code, direct)) return false;
    const declarationFree = withoutModuleBindingDeclarations(code, module.token);
    for (const binding of moduleBackedBindings(code, module.token, module.exports)) {
      if (moduleBindingEscapes(declarationFree, binding)) return false;
      if (moduleTargetIsMutated(code, `(?<![.$a-z0-9_])${escapeRegex(binding)}\\b`)) return false;
    }
  }
  return true;
}

function balancedEnd(text, openIndex, opening = "(", closing = ")", ceiling = 8_000) {
  if (text[openIndex] !== opening) return -1;
  let depth = 0;
  for (let index = openIndex; index < Math.min(text.length, openIndex + ceiling); index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing && --depth === 0) return index + 1;
  }
  return -1;
}

function topLevelArgumentRanges(text, openIndex, endIndex) {
  const argumentsList = [];
  let start = openIndex + 1;
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let index = start; index < endIndex - 1; index += 1) {
    const character = text[index];
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses = Math.max(0, parentheses - 1);
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets = Math.max(0, brackets - 1);
    else if (character === "{") braces += 1;
    else if (character === "}") braces = Math.max(0, braces - 1);
    else if (character === "," && parentheses === 0 && brackets === 0 && braces === 0) {
      argumentsList.push({ start, end: index, text: text.slice(start, index).trim() });
      start = index + 1;
    }
  }
  argumentsList.push({ start, end: endIndex - 1, text: text.slice(start, endIndex - 1).trim() });
  return argumentsList;
}

export function evidenceTopLevelArguments(text, openIndex, endIndex) {
  return topLevelArgumentRanges(text, openIndex, endIndex).map((argument) => argument.text);
}

function evidenceErrorClasses(text) {
  return ERROR_CONSTRUCTORS.filter((name) => (
    new RegExp(`\\b${name}\\b`).test(text)
    || new RegExp(`\\{[^}]{0,300}\\bname\\s*:\\s*__pi_error_name_${name}_literal__\\b[^}]{0,300}\\}`).test(text)
  ));
}

function simpleConstantValue(raw) {
  let value = String(raw ?? "").trim();
  while (value.startsWith("(") && balancedEnd(value, 0) === value.length) value = value.slice(1, -1).trim();
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
    case "==": return left.value == right.value;
    case "!=": return left.value != right.value;
    case "<=": return left.value <= right.value;
    case ">=": return left.value >= right.value;
    case "<": return left.value < right.value;
    case ">": return left.value > right.value;
    default: return undefined;
  }
}

function operationTargets(raw, callableNames) {
  let operation = String(raw ?? "").trim();
  const arrow = operation.indexOf("=>");
  if (arrow !== -1) operation = operation.slice(arrow + 2).trim();
  else if (/^function\b/.test(operation)) operation = operation.slice(operation.indexOf("{")).trim();
  if (operation.startsWith("{") && balancedEnd(operation, 0, "{", "}") === operation.length) operation = operation.slice(1, -1).trim();
  operation = operation.replace(/^(?:return\s+)?(?:await\s+)?/, "").replace(/;\s*$/, "").trim();
  return [...callableNames].filter((target) => {
    const structural = target.startsWith("*.");
    const name = structural ? target.slice(2) : target;
    const callee = structural ? `[a-z_$][a-z0-9_$.]*\\.${escapeRegex(name)}` : escapeRegex(name);
    const match = operation.match(new RegExp(`^${callee}\\s*\\(`));
    if (!match) return false;
    const open = operation.indexOf("(", match.index);
    return balancedEnd(operation, open) === operation.length;
  });
}

function balancedStart(text, closeIndex, opening = "[", closing = "]", ceiling = 8_000) {
  if (text[closeIndex] !== closing) return -1;
  let depth = 0;
  for (let index = closeIndex; index >= Math.max(0, closeIndex - ceiling); index -= 1) {
    if (text[index] === closing) depth += 1;
    else if (text[index] === opening && --depth === 0) return index;
  }
  return -1;
}

function boundedNonEmptyArrayLiteral(raw) {
  const value = String(raw ?? "").trim();
  if (value[0] !== "[" || balancedEnd(value, 0, "[", "]") !== value.length) return undefined;
  if (!value.slice(1, -1).trim() || /\.\.\./.test(value)) return undefined;
  return value;
}

function evidencePartitionSignals(text) {
  const signals = new Set();
  if (/\bnull\b/.test(text)) signals.add("null");
  if (/\bundefined\b/.test(text)) signals.add("missing");
  if (/__pi_empty_string_literal__/.test(text)) signals.add("empty-string");
  if (/__pi_whitespace_string_literal__/.test(text)) signals.add("whitespace-string");
  if (/(?:^|[^\w.])-\s*(?:\d+(?:\.\d+)?|infinity)\b/.test(text)) signals.add("negative");
  if (/(?:^|[^\w.])(?:\d+\.\d+|\.\d+)(?:[^\w.]|$)/.test(text)) signals.add("fractional");
  if (/(?:^|[^\w.])0n?(?:[^\w.]|$)/.test(text)) signals.add("zero");
  if (/\b(?:nan|infinity)\b|number\.(?:positive_|negative_)?infinity/.test(text)) signals.add("non-finite");
  if (/number\.max_safe_integer\s*\+\s*1|9007199254740992/.test(text)) signals.add("unsafe-integer");
  if (/\[\s*\]/.test(text)) signals.add("array");
  if (/\{\s*\}/.test(text)) signals.add("plain-object");
  if (/\b(?:null|undefined|true|false|nan|infinity)\b|(?:^|[^\w.])-?\d|__pi_(?:empty_|whitespace_)?string_literal__/.test(text)) signals.add("primitive");
  return signals;
}

function literalArrayPartitionSignals(literal) {
  const signals = new Set();
  for (const { text } of topLevelArgumentRanges(literal, 0, literal.length)) {
    const value = text.trim();
    if (!value) continue;
    if (value[0] === "[" && balancedEnd(value, 0, "[", "]") === value.length) {
      signals.add("array");
      continue;
    }
    if (value[0] === "{" && balancedEnd(value, 0, "{", "}") === value.length) {
      signals.add("plain-object");
      continue;
    }
    if (/^(?:null|undefined|true|false|nan|(?:number\.)?(?:positive_|negative_)?infinity|-?(?:\d+(?:\.\d+)?|\.\d+)n?|__pi_(?:(?:empty_|whitespace_)?string|error_name_[a-z]+)_literal__)$/.test(value)) {
      for (const signal of evidencePartitionSignals(value)) signals.add(signal);
    }
  }
  return signals;
}

function assertionHelperDeclarations(testText) {
  const declarations = [];
  for (const match of testText.matchAll(/\bfunction\s+([a-z_$][a-z0-9_$]*)\s*\(([^)]*)\)\s*\{/gi)) {
    const open = match.index + match[0].lastIndexOf("{");
    const end = balancedEnd(testText, open, "{", "}");
    if (end !== -1) declarations.push({ name: match[1].toLowerCase(), parameters: match[2], start: match.index, end, body: testText.slice(open + 1, end - 1) });
  }
  for (const match of testText.matchAll(/\b(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\(([^)]*)\)|([a-z_$][a-z0-9_$]*))\s*=>\s*/gi)) {
    const start = match.index + match[0].length;
    const stops = [testText.indexOf(";", start), testText.indexOf("\n", start)].filter((item) => item >= 0).sort((a, b) => a - b);
    const end = testText[start] === "{" ? balancedEnd(testText, start, "{", "}") : (stops[0] ?? testText.length);
    if (end !== -1) declarations.push({ name: match[1].toLowerCase(), parameters: match[2] ?? match[3] ?? "", start: match.index, end, body: testText.slice(start, end) });
  }
  return declarations.slice(0, 24);
}

function rejectionAssertionHelpers(testText, assertionCarriers) {
  const helpers = [];
  for (const declaration of assertionHelperDeclarations(testText)) {
    if (/\b(?:if|for|while|switch|try|catch|return|throw|class|function)\b|\.(?:skip|todo)\b/.test(declaration.body)) continue;
    const parameters = [...declaration.parameters.matchAll(/[a-z_$][a-z0-9_$]*/gi)].map((match) => match[0].toLowerCase()).slice(0, 8);
    for (const match of declaration.body.matchAll(/\b([a-z_$][a-z0-9_$]*)\.(throws|rejects)\s*\(/gi)) {
      if (!assertionCarriers.has(match[1].toLowerCase())) continue;
      const open = declaration.body.indexOf("(", match.index);
      const end = balancedEnd(declaration.body, open);
      const assertion = end === -1 ? "" : declaration.body.slice(match.index, end);
      const errorClasses = evidenceErrorClasses(assertion);
      const argumentsList = end === -1 ? [] : topLevelArgumentRanges(declaration.body, open, end);
      const directParameter = parameters.some((parameter) => argumentsList[0]?.text === parameter);
      const before = declaration.body.slice(0, match.index).replace(/^\s*\{?\s*(?:return\s+|await\s+)?/, "");
      const after = declaration.body.slice(end).replace(/;?\s*\}?\s*$/, "");
      if (errorClasses.length > 0 && directParameter && !before && !after) {
        helpers.push({ ...declaration, errorClasses, mode: match[2].toLowerCase() });
        break;
      }
    }
  }
  return helpers.slice(0, 12);
}

function registrationArgumentsEnabled(argumentsList) {
  if (argumentsList.length <= 2) return true;
  if (argumentsList.length !== 3 || !/^\{[\s\S]{0,800}\}$/.test(argumentsList[1].text)) return false;
  const options = argumentsList[1].text;
  if (/\.\.\.|\[[^\]]+\]\s*:|__pi_(?:bound_string_\d+__|string_literal__)\s*:/.test(options)) return false;
  const withoutDisabledFlags = options.replace(/\b(?:skip|todo)\s*:\s*false\b/g, "");
  return !/\b(?:skip|todo)\b/.test(withoutDisabledFlags);
}

function callbackBodyRange(text, argument) {
  let expressionStart = argument.start, expressionEnd = argument.end;
  while (/\s/.test(text[expressionStart] ?? "")) expressionStart += 1;
  while (/\s/.test(text[expressionEnd - 1] ?? "")) expressionEnd -= 1;
  while (text[expressionStart] === "(" && balancedEnd(text, expressionStart) === expressionEnd) {
    expressionStart += 1; expressionEnd -= 1;
    while (/\s/.test(text[expressionStart] ?? "")) expressionStart += 1;
    while (/\s/.test(text[expressionEnd - 1] ?? "")) expressionEnd -= 1;
  }
  const value = text.slice(expressionStart, expressionEnd);
  const arrow = value.match(/^(?:async\s+)?(?:\([^)]*\)|[a-z_$][a-z0-9_$]*)\s*=>\s*/i);
  const callable = arrow ?? value.match(/^(?:async\s+)?function(?:\s+[a-z_$][a-z0-9_$]*)?\s*\([^)]*\)\s*/i);
  if (!callable) return undefined;
  let bodyStart = expressionStart + callable[0].length;
  while (/\s/.test(text[bodyStart] ?? "")) bodyStart += 1;
  if (text[bodyStart] !== "{") return arrow ? { start: bodyStart, end: expressionEnd, braced: false } : undefined;
  const end = balancedEnd(text, bodyStart, "{", "}");
  return end !== expressionEnd ? undefined : { start: bodyStart + 1, end: end - 1, braced: true };
}

export function executableRejectionAssertions(testText, callableNames, modeHintsOnly = false, includeSuccess = false,
  literalIterationEnvironmentStable = true) {
  const assertions = [];
  const carrierBindings = assertionCarrierBindings(testText);
  const assertionCarriers = new Set((assertionEvidenceFileSupported(testText)
    && carrierBindings.length === 1 && nodeAssertModuleReferenceCount(testText) === 1 ? carrierBindings : [])
    .filter((binding) => assertionCarrierIsStable(testText, binding))
    .map((binding) => binding.name));
  const runnerBindings = testRunnerBindings(testText);
  const liveRunnerBindings = new Map(runnerBindings
    .filter((binding) => importedCallableBindingIsStable(testText, binding, runnerBindings))
    .map((binding) => [binding.name, binding.kind]));
  const literalIterationStable = literalIterationEnvironmentStable
    && literalArrayIterationEnvironmentIsStable(testText);
  const registrationNames = (kind, fallbacks) => uniqueStrings([
    ...fallbacks, ...runnerBindings.filter((binding) => binding.kind === kind).map((binding) => binding.name)
  ]);
  const registrationPattern = (names, suffix) => new RegExp(
    `\\b(${names.map(escapeRegex).join("|")})${suffix}\\s*\\(`, "gi"
  );
  const suiteNames = registrationNames("suite", ["context", "describe", "suite"]);
  const testNames = registrationNames("test", ["it", "specify", "test"]);
  const declarationRanges = assertionHelperDeclarations(testText).map(({ start, end }) => ({ start, end }));
  const skippedRanges = [];
  const suiteRanges = [];
  const registeredRanges = [];
  for (const match of testText.matchAll(registrationPattern([...suiteNames, ...testNames], "\\.(?:skip|todo)"))) {
    const open = testText.indexOf("(", match.index);
    const end = balancedEnd(testText, open);
    if (end !== -1) skippedRanges.push({ start: match.index, end });
  }
  for (const match of testText.matchAll(registrationPattern(suiteNames, "(?:\\.only)?"))) {
    const open = testText.indexOf("(", match.index);
    const end = balancedEnd(testText, open);
    if (end === -1) continue;
    const argumentsList = topLevelArgumentRanges(testText, open, end);
    const callback = callbackBodyRange(testText, argumentsList.at(-1));
    if (liveRunnerBindings.get(match[1].toLowerCase()) !== "suite"
      || !registrationArgumentsEnabled(argumentsList) || !callback) skippedRanges.push({ start: match.index, end });
    else suiteRanges.push({ ...callback, callStart: match.index });
  }
  for (const match of testText.matchAll(registrationPattern(testNames, "(?:\\.(?:concurrent|only))?"))) {
    const open = testText.indexOf("(", match.index);
    const end = balancedEnd(testText, open);
    if (end === -1) continue;
    const argumentsList = topLevelArgumentRanges(testText, open, end);
    const callback = callbackBodyRange(testText, argumentsList.at(-1));
    if (liveRunnerBindings.get(match[1].toLowerCase()) !== "test"
      || !registrationArgumentsEnabled(argumentsList) || !callback) skippedRanges.push({ start: match.index, end });
    else registeredRanges.push({ ...callback, callStart: match.index });
  }
  const bracedDepthAt = (offset) => {
    let depth = 0;
    for (let index = 0; index < offset; index += 1) {
      if (testText[index] === "{") depth += 1;
      else if (testText[index] === "}") depth = Math.max(0, depth - 1);
    }
    return depth;
  };
  const rangeDirectlyContains = (range, start) => {
    if (start < range.start || start >= range.end
      || (range.braced && bracedDepthAt(start) !== bracedDepthAt(range.start))) return false;
    const prefix = testText.slice(range.start, start);
    const boundary = Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("}"));
    return !/=>|\bfunction\b/.test(prefix.slice(boundary + 1));
  };
  const topLevelCall = (start) => {
    if (bracedDepthAt(start) !== 0) return false;
    const prefix = testText.slice(Math.max(testText.lastIndexOf(";", start - 1) + 1, 0), start);
    return !/=>|\bfunction\b|\?|&&|\|\|/.test(prefix);
  };
  const statementRange = (start) => {
    let bodyStart = start;
    while (/\s/.test(testText[bodyStart] ?? "")) bodyStart += 1;
    if (testText[bodyStart] === "{") return { start: bodyStart, end: balancedEnd(testText, bodyStart, "{", "}") };
    const semicolon = testText.indexOf(";", bodyStart);
    return { start: bodyStart, end: semicolon === -1 ? testText.length : semicolon + 1 };
  };
  const statementAbruptlyExits = (raw) => {
    let body = String(raw ?? "").trim();
    if (body.startsWith("{") && balancedEnd(body, 0, "{", "}") === body.length) body = body.slice(1, -1).trim();
    return /^(?:(?:break|continue)\s*;?|return(?:[ \t]+[^;{}\r\n]*)?\s*;?|throw\s+[^;{}]+\s*;?|process\.exit\s*\([^;{}]*\)\s*;?)$/.test(body);
  };
  const directStatementAtDepth = (containerStart, offset, baseDepth) => {
    let boundary = containerStart, braces = baseDepth, brackets = 0, parentheses = 0;
    for (let index = containerStart; index < offset; index += 1) {
      const character = testText[index];
      if (character === "{") braces += 1;
      else if (character === "}") { braces = Math.max(0, braces - 1); if (braces === baseDepth) boundary = index + 1; }
      else if (braces === baseDepth && character === "[") brackets += 1;
      else if (braces === baseDepth && character === "]") brackets -= 1;
      else if (braces === baseDepth && character === "(") parentheses += 1;
      else if (braces === baseDepth && character === ")") parentheses -= 1;
      else if (braces === baseDepth && !brackets && !parentheses && character === ";") boundary = index + 1;
    }
    return !testText.slice(boundary, offset).trim();
  };
  const abruptBefore = (containerStart, start, baseDepth) => {
    const prefix = testText.slice(containerStart, start);
    for (const match of prefix.matchAll(/\b(?:break|continue|return|throw)\b|\bprocess\s*\.\s*exit\s*\(/g)) {
      const absolute = containerStart + match.index;
      if (bracedDepthAt(absolute) === baseDepth && directStatementAtDepth(containerStart, absolute, baseDepth)) return true;
    }
    for (const match of prefix.matchAll(/\bif\s*\(/g)) {
      const absolute = containerStart + match.index;
      if (bracedDepthAt(absolute) !== baseDepth || !directStatementAtDepth(containerStart, absolute, baseDepth)) continue;
      const open = testText.indexOf("(", absolute), conditionEnd = balancedEnd(testText, open);
      if (conditionEnd === -1 || conditionEnd > start
        || simpleConstantValue(testText.slice(open + 1, conditionEnd - 1)) === false) continue;
      const consequent = statementRange(conditionEnd);
      if (consequent.end !== -1 && consequent.end <= start
        && statementAbruptlyExits(testText.slice(consequent.start, consequent.end))) return true;
    }
    return false;
  };
  const topLevelAbruptBefore = (start) => abruptBefore(0, start, 0);
  const liveSuites = [];
  for (const suite of suiteRanges) {
    if (!topLevelAbruptBefore(suite.callStart)
      && (topLevelCall(suite.callStart) || liveSuites.some((range) => rangeDirectlyContains(range, suite.callStart)))) liveSuites.push(suite);
  }
  suiteRanges.splice(0, suiteRanges.length, ...liveSuites);
  const liveRegistrations = registeredRanges.filter((range) => !topLevelAbruptBefore(range.callStart)
    && (topLevelCall(range.callStart) || suiteRanges.some((suite) => rangeDirectlyContains(suite, range.callStart))));
  registeredRanges.splice(0, registeredRanges.length, ...liveRegistrations);
  const conditionalRanges = [];
  for (const match of testText.matchAll(/\bif\s*\(/g)) {
    const open = testText.indexOf("(", match.index);
    const conditionEnd = balancedEnd(testText, open);
    if (conditionEnd === -1) continue;
    const consequent = statementRange(conditionEnd);
    if (consequent.end === -1) continue;
    conditionalRanges.push(consequent);
    let after = consequent.end;
    while (/\s/.test(testText[after] ?? "")) after += 1;
    if (testText.slice(after, after + 4) === "else") {
      const alternate = statementRange(after + 4);
      if (alternate.end !== -1) conditionalRanges.push(alternate);
    }
  }
  const triviallyDisabled = (start) => {
    const prefix = testText.slice(Math.max(0, start - 600), start);
    if (prefix.match(/(?:^|[;{])\s*(?:\(([^()]{1,160})\)|([^;{}()]{1,160}))\s*(?:&&|\|\|)[\s\S]{0,400}$/)) return true;
    return Boolean(prefix.match(/(?:^|[;{])\s*(?:\(([^()]{1,160})\)|([^;{}()]{1,160}))\s*\?[\s\S]{0,400}$/));
  };
  const directlyInside = rangeDirectlyContains;
  const directBaseContext = (start) => {
    if (registeredRanges.some((range) => directlyInside(range, start))) return true;
    if (bracedDepthAt(start) !== 0) return false;
    const prefix = testText.slice(Math.max(testText.lastIndexOf(";", start - 1) + 1, 0), start);
    return !/=>|\bfunction\b/.test(prefix);
  };
  const structurallyConnected = (start) => directBaseContext(start)
    && ![...declarationRanges, ...skippedRanges, ...conditionalRanges].some((range) => start >= range.start && start < range.end)
    && !triviallyDisabled(start);
  const registrationAt = (start) => registeredRanges.find((range) => start >= range.start && start < range.end);
  const namedLiteralArray = (name, useStart) => {
    const escaped = escapeRegex(name);
    const declarations = [...testText.matchAll(new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*\\[`, "g"))];
    if (declarations.length !== 1 || declarations[0].index >= useStart || !structurallyConnected(declarations[0].index)) return undefined;
    const bindingDeclarations = [...testText.matchAll(new RegExp(`\\b(?:const|let|var|function|class)\\s+${escaped}\\b`, "g"))];
    if (bindingDeclarations.length !== 1 || bindingDeclarations[0].index !== declarations[0].index) return undefined;
    const open = testText.indexOf("[", declarations[0].index);
    const end = balancedEnd(testText, open, "[", "]");
    const literal = end === -1 ? undefined : boundedNonEmptyArrayLiteral(testText.slice(open, end));
    if (!literal || !/^\s*;/.test(testText.slice(end, end + 40))) return undefined;
    const declarationRegistration = registrationAt(declarations[0].index);
    const useRegistration = registrationAt(useStart);
    if (declarationRegistration && declarationRegistration !== useRegistration) return undefined;
    if (new RegExp(`\\b${escaped}\\b`).test(testText.slice(end, useStart))) return undefined;
    return literal;
  };
  const iterationLiteral = (expression, useStart) => {
    const value = String(expression ?? "").trim();
    const inline = boundedNonEmptyArrayLiteral(value);
    if (inline) return { literal: inline };
    const literal = /^[a-z_$][a-z0-9_$]*$/i.test(value) ? namedLiteralArray(value, useStart) : undefined;
    return literal ? { binding: value, literal } : undefined;
  };
  const iterationRanges = [];
  const unsupportedControlRanges = [];
  for (const match of testText.matchAll(/\bfor\s*\(/g)) {
    if (!structurallyConnected(match.index)) continue;
    const open = testText.indexOf("(", match.index);
    const headerEnd = balancedEnd(testText, open);
    if (headerEnd === -1) continue;
    const body = statementRange(headerEnd);
    if (body.end === -1) continue;
    const header = testText.slice(open + 1, headerEnd - 1);
    const iterationBody = testText[body.start] === "{" ? { start: body.start + 1, end: body.end - 1, braced: true } : { ...body, braced: false };
    const forOf = header.match(/^\s*(?:const|let)\s+([a-z_$][a-z0-9_$]*)\s+of\s+([\s\S]+?)\s*$/i);
    const iterable = forOf && literalIterationStable && iterationLiteral(forOf[2], match.index);
    if (iterable) iterationRanges.push({ ...iterationBody, ...iterable, kind: "for-of", variable: forOf[1] });
    else if (modeHintsOnly && forOf) iterationRanges.push({ ...iterationBody, kind: "for-of", variable: forOf[1] });
    else unsupportedControlRanges.push(body);
  }
  for (const match of testText.matchAll(/\.foreach\s*\(/g)) {
    if (!structurallyConnected(match.index)) continue;
    const open = testText.indexOf("(", match.index);
    const end = balancedEnd(testText, open);
    if (end === -1) continue;
    let receiverStart = match.index;
    while (/\s/.test(testText[receiverStart - 1] ?? "")) receiverStart -= 1;
    if (testText[receiverStart - 1] === "]") receiverStart = balancedStart(testText, receiverStart - 1);
    else {
      const receiver = testText.slice(Math.max(0, receiverStart - 200), receiverStart).match(/(?:^|[^.\w$])([a-z_$][a-z0-9_$]*)\s*$/i);
      receiverStart = receiver ? receiverStart - receiver[1].length : -1;
    }
    const receiverText = receiverStart < 0 ? "" : testText.slice(receiverStart, match.index).trim();
    const iterable = receiverStart < 0 || !literalIterationStable ? undefined : iterationLiteral(receiverText, receiverStart);
    const argumentsList = topLevelArgumentRanges(testText, open, end);
    const callback = callbackBodyRange(testText, argumentsList.at(-1));
    const callbackText = argumentsList.at(-1)?.text ?? "";
    const parameter = callbackText.match(/^\s*(?:\(\s*)?([a-z_$][a-z0-9_$]*)(?:\s*\))?\s*=>/i)?.[1];
    if (iterable && callback && parameter) iterationRanges.push({ ...callback, ...iterable, kind: "for-each", variable: parameter });
    else unsupportedControlRanges.push({ start: match.index, end });
  }
  for (const match of testText.matchAll(/\bwhile\s*\(/g)) {
    const open = testText.indexOf("(", match.index);
    const headerEnd = balancedEnd(testText, open);
    if (headerEnd !== -1) unsupportedControlRanges.push(statementRange(headerEnd));
  }
  const abruptlyUnreachable = (start) => {
    const containers = [...registeredRanges, ...iterationRanges]
      .filter((range) => start >= range.start && start < range.end)
      .sort((left, right) => right.start - left.start);
    const containerStart = containers[0]?.start ?? 0;
    return abruptBefore(containerStart, start, bracedDepthAt(containerStart));
  };
  const iterationVariableIsLive = (range, start) => {
    const escaped = escapeRegex(range.variable);
    const prefix = testText.slice(range.start, start);
    return !new RegExp(`\\b(?:const|let|var|function|class)\\s+${escaped}\\b|\\b${escaped}\\b\\s*(?:\\+\\+|--|[+*/%&|^-]=|=(?!=|>))|(?:\\+\\+|--)\\s*\\b${escaped}\\b`, "i").test(prefix);
  };
  const record = (start, end, errorClasses, operation, mode) => {
    if (end === -1) return;
    if ([...declarationRanges, ...skippedRanges, ...conditionalRanges, ...unsupportedControlRanges]
      .some((range) => start >= range.start && start < range.end)) return;
    if (triviallyDisabled(start) || abruptlyUnreachable(start)) return;
    if (!directBaseContext(start) && !iterationRanges.some((range) => directlyInside(range, start))) return;
    const assertion = testText.slice(start, end);
    const containingIterations = iterationRanges.filter((range) => directlyInside(range, start));
    if (containingIterations.some((range) => range.binding
      && new RegExp(`\\b${escapeRegex(range.binding)}\\b`, "i").test(assertion))) return;
    if (containingIterations.some((range) => {
      const prefix = testText.slice(range.start, start);
      const suffix = testText.slice(end, range.end);
      return /\b(?:break|catch|continue|for|if|return|switch|throw|try|while)\b|\bprocess\.exit\s*\(/.test(`${prefix}\n${suffix}`)
        || (range.binding && new RegExp(`\\b${escapeRegex(range.binding)}\\b`, "i").test(`${prefix}\n${suffix}`));
    })) return;
    if (/\.rejects\s*\(/.test(assertion)) {
      if (containingIterations.some((range) => range.kind === "for-each")) return;
      const containerStart = containingIterations.at(-1)?.start
        ?? registeredRanges.find((range) => start >= range.start && start < range.end)?.start
        ?? 0;
      const prefix = testText.slice(containerStart, start);
      const boundary = Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("{"), prefix.lastIndexOf("}"));
      const promisePrefix = prefix.slice(boundary + 1).trim();
      const returnedConciseCallback = registeredRanges.some((range) => !range.braced && start === range.start);
      if (!/^(?:await|return(?:\s+await)?)$/.test(promisePrefix) && !returnedConciseCallback) return;
    }
    const referencedIterations = containingIterations.filter((range) => (
      new RegExp(`\\b${escapeRegex(range.variable)}\\b`, "i").test(assertion)
    ));
    if (referencedIterations.some((range) => !iterationVariableIsLive(range, start))) return;
    const targets = operationTargets(operation, callableNames);
    if (targets.length === 0) return;
    const partitions = evidencePartitionSignals(assertion);
    for (const range of referencedIterations) {
      if (range.literal) for (const signal of literalArrayPartitionSignals(range.literal)) partitions.add(signal);
    }
    assertions.push({
      targets, errorClasses, partitions, mode, operation,
      iterationLiterals: referencedIterations.map((range) => range.literal).filter(Boolean).slice(0, 8)
    });
  };
  for (const match of testText.matchAll(/\b([a-z_$][a-z0-9_$]*)\.(?:throws|rejects)\s*\(/gi)) {
    if (!assertionCarriers.has(match[1].toLowerCase())) continue;
    const open = testText.indexOf("(", match.index);
    const end = balancedEnd(testText, open);
    const argumentsList = end === -1 ? [] : topLevelArgumentRanges(testText, open, end);
    record(match.index, end, evidenceErrorClasses(end === -1 ? "" : testText.slice(match.index, end)), argumentsList[0]?.text,
      /\.rejects\s*\(/i.test(match[0]) ? "rejects" : "throws");
  }
  if (includeSuccess) for (const match of testText.matchAll(/\b([a-z_$][a-z0-9_$]*)\.(doesnotthrow|deepequal|deepstrictequal|equal|strictequal|notequal|notstrictequal|ok)\s*\(/gi)) {
    if (!assertionCarriers.has(match[1].toLowerCase())) continue;
    const open = testText.indexOf("(", match.index);
    const end = balancedEnd(testText, open);
    const argumentsList = end === -1 ? [] : topLevelArgumentRanges(testText, open, end);
    if (match[2].toLowerCase() !== "doesnotthrow" && /^(?:async\s*)?(?:function\b|(?:\([^)]*\)|[a-z_$][a-z0-9_$]*)\s*=>)/i.test(argumentsList[0]?.text ?? "")) continue;
    record(match.index, end, [], argumentsList[0]?.text, "does-not-throw");
  }
  for (const helper of rejectionAssertionHelpers(testText, assertionCarriers)) {
    for (const match of testText.matchAll(new RegExp(`\\b${escapeRegex(helper.name)}\\s*\\(`, "g"))) {
      if (match.index >= helper.start && match.index < helper.end) continue;
      const open = testText.indexOf("(", match.index);
      const end = balancedEnd(testText, open);
      const argumentsList = end === -1 ? [] : topLevelArgumentRanges(testText, open, end);
      record(match.index, end, helper.errorClasses, argumentsList[0]?.text, helper.mode);
    }
  }
  for (const match of testText.matchAll(/\bexpect\s*\(/g)) {
    if (!assertionCarriers.has("expect")) continue;
    const open = testText.indexOf("(", match.index);
    const expectEnd = balancedEnd(testText, open);
    if (expectEnd === -1) continue;
    const chain = testText.slice(expectEnd, expectEnd + 300).match(/^\s*(?:\.rejects)?\.to(?:throw|throwerror)\s*\(/);
    if (!chain) continue;
    const throwOpen = testText.indexOf("(", expectEnd + chain.index);
    const end = balancedEnd(testText, throwOpen);
    const argumentsList = topLevelArgumentRanges(testText, open, expectEnd);
    record(match.index, end, evidenceErrorClasses(end === -1 ? "" : testText.slice(match.index, end)), argumentsList[0]?.text,
      /\.rejects/i.test(chain[0]) ? "rejects" : "throws");
  }
  return assertions.slice(0, 64);
}

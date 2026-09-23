function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assertionCarrierBindings(testText) {
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

export const TEST_RUNNER_EXPORT_KINDS = new Map([
  ["test", "test"], ["it", "test"], ["describe", "suite"], ["suite", "suite"]
]);

export function testRunnerBindings(testText) {
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

export function importedCallableBindingIsStable(testText, binding, bindings) {
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

export function assertionCarrierIsStable(testText, binding) {
  return importedCallableBindingIsStable(testText, binding, assertionCarrierBindings(testText));
}

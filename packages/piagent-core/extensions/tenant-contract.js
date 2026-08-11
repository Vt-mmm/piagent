function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function tenantAssertionSignals(testText) {
  const text = normalizedText(testText);
  const boundTenants = new Map();
  for (const match of text.matchAll(/(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*\{([^{}]{0,500})\}/g)) {
    const tenant = match[2].match(/\btenant(?:id)?\s*:\s*["']([^"']*)["']/)?.[1];
    if (tenant !== undefined) boundTenants.set(match[1], tenant);
  }
  const signals = { same: false, cross: false, missing: false };
  const assertions = /assert\.(?:equal|strictequal)\s*\(([\s\S]{0,1200}?),\s*(true|false)\s*\)/g;
  for (const match of text.matchAll(assertions)) {
    const expression = match[1];
    if (!/\b[a-z_$][a-z0-9_$]*\s*\(/.test(expression)) continue;
    const tenantValues = new Set();
    for (const tenantMatch of expression.matchAll(/\btenant(?:id)?\s*:\s*["']([^"']*)["']/g)) {
      if (tenantMatch[1]) tenantValues.add(tenantMatch[1]);
      else signals.missing = signals.missing || match[2] === "false";
    }
    for (const [name, tenant] of boundTenants) {
      if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(expression) && tenant) tenantValues.add(tenant);
    }
    if (/\btenant(?:id)?\s*:\s*(?:null|undefined)\b/.test(expression) && match[2] === "false") signals.missing = true;
    if (match[2] === "true" && tenantValues.size === 1) signals.same = true;
    if (match[2] === "false" && tenantValues.size >= 2) signals.cross = true;
  }

  const tableLoops = /for\s*\(\s*const\s*\[\s*([a-z_$][a-z0-9_$]*)\s*,\s*([a-z_$][a-z0-9_$]*)\s*\]\s*of\s*\[([\s\S]{0,5000}?)\]\s*\)\s*\{([\s\S]{0,1200}?)\}/g;
  for (const loop of text.matchAll(tableLoops)) {
    const [leftName, rightName, body] = [loop[1], loop[2], loop[4]];
    const assertedFalse = new RegExp(String.raw`assert\.(?:equal|strictequal)\s*\(\s*[a-z_$][a-z0-9_$]*\s*\(\s*${escapeRegex(leftName)}\s*,\s*${escapeRegex(rightName)}\s*\)\s*,\s*false\s*\)`).test(body);
    if (!assertedFalse) continue;
    const rows = /\[\s*(\{[^{}]{0,800}\}|undefined|null)\s*,\s*(\{[^{}]{0,800}\}|undefined|null)\s*\]/g;
    for (const row of loop[3].matchAll(rows)) {
      const leftTenant = row[1].match(/\btenant(?:id)?\s*:\s*["']([^"']*)["']/)?.[1];
      const rightTenant = row[2].match(/\btenant(?:id)?\s*:\s*["']([^"']*)["']/)?.[1];
      if (!leftTenant || !rightTenant) signals.missing = true;
      if (leftTenant && rightTenant && leftTenant !== rightTenant) signals.cross = true;
    }
  }
  return signals;
}

export function hasLengthPrefixedIdentityKey(sourceText) {
  const text = normalizedText(sourceText);
  const tuple = /\[\s*[a-z_$][a-z0-9_$]*(?:\s*,\s*[a-z_$][a-z0-9_$]*){1,7}\s*\]/.exec(text);
  if (!tuple) return false;
  const window = text.slice(tuple.index, tuple.index + 1_500);
  if (!/\.join\s*\(/.test(window)) return false;

  const firstMapped = /\.map\s*\(\s*\(?\s*([a-z_$][a-z0-9_$]*)\s*\)?\s*=>/.exec(window);
  if (firstMapped) {
    const component = firstMapped[1];
    const alias = new RegExp(String.raw`\b(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*string\s*\(\s*${escapeRegex(component)}\s*\)`).exec(window)?.[1];
    if (alias && new RegExp(String.raw`\`[^\`]{0,160}\$\{\s*${escapeRegex(alias)}\.length\s*\}[^\`]{0,160}\$\{\s*${escapeRegex(alias)}\s*\}[^\`]*\``).test(window)) return true;
  }

  const prefixedTemplate = /\`[^\`]{0,160}\$\{\s*([a-z_$][a-z0-9_$]*)\.length\s*\}[^\`]{0,160}\$\{\s*\1\s*\}[^\`]*\`/.exec(window);
  if (!prefixedTemplate) return false;
  const prefixComponent = prefixedTemplate[1];
  const beforeTemplate = window.slice(0, prefixedTemplate.index);
  const prefixMapStart = beforeTemplate.lastIndexOf(".map");
  if (prefixMapStart < 0) return false;
  const prefixMap = beforeTemplate.slice(prefixMapStart);
  if (!new RegExp(String.raw`^\.map\s*\(\s*\(?\s*${escapeRegex(prefixComponent)}\s*\)?\s*=>`).test(prefixMap)) return false;
  const beforePrefixMap = window.slice(0, prefixMapStart);
  if (/\.map\s*\(\s*string\s*\)\s*$/.test(beforePrefixMap)) return true;
  return /\.map\s*\(\s*\(?\s*([a-z_$][a-z0-9_$]*)\s*\)?\s*=>\s*string\s*\(\s*\1\s*\)\s*\)\s*$/.test(beforePrefixMap);
}

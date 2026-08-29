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
  if (!/\b(?:dates?|timestamps?|expiry|expires?)\b/i.test(String(selected ?? ""))) return [];
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

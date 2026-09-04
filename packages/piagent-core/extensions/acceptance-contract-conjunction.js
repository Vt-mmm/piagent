/** Split natural-language acceptance text only at top-level conjunction marks. */
export function acceptanceContractConjuncts(value, options = {}) {
  const text = String(value ?? "");
  const preserveSeparators = options.preserveSeparators === true;
  const conjuncts = [];
  let current = "";
  let quote = "";
  let round = 0;
  let square = 0;
  let curly = 0;
  const push = (separator = "") => {
    const item = current.trim();
    if (item) conjuncts.push(`${item}${preserveSeparators ? separator : ""}`);
    current = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const previous = text[index - 1] ?? "";
    const next = text[index + 1] ?? "";
    if (quote) {
      current += character;
      if (character === quote && previous !== "\\") quote = "";
      continue;
    }
    const apostropheInsideWord = character === "'" && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next);
    if ((character === "`" || character === '"' || character === "'") && !apostropheInsideWord) {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") round += 1;
    else if (character === ")") round = Math.max(0, round - 1);
    else if (character === "[") square += 1;
    else if (character === "]") square = Math.max(0, square - 1);
    else if (character === "{") curly += 1;
    else if (character === "}") curly = Math.max(0, curly - 1);
    const topLevel = round === 0 && square === 0 && curly === 0;
    if (topLevel && character === ";") {
      push(";");
      continue;
    }
    if (topLevel && (character === "\n" || character === "\r")) {
      push();
      if (character === "\r" && next === "\n") index += 1;
      continue;
    }
    current += character;
  }
  push();
  return conjuncts;
}

const INTEGER_TARGET_STOPWORDS = new Set([
  "and", "basis", "cents", "input", "inputs", "items", "money", "number", "numbers", "or", "points", "typeerror", "value", "values"
]);

function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function acceptanceIntegerConstraintTargets(text, sourceText = "") {
  const source = normalizedText(sourceText);
  const candidates = [];
  for (const clause of acceptanceContractConjuncts(normalizedText(text))) {
    for (const match of clause.matchAll(/\b(?:an?\s+)?(?:non-negative\s+|positive\s+)?integer\s+([a-z_$][a-z0-9_$]*)\b/g)) candidates.push(match[1]);
    for (const match of clause.matchAll(/\b(?:is|must be|must remain)\s+(?:an?\s+)?(?:non-negative\s+|positive\s+)?(?:safe\s+)?integers?\b/g)) {
      const subject = clause.slice(Math.max(0, match.index - 160), match.index);
      for (const name of subject.matchAll(/`([a-z_$][a-z0-9_$]*)`/g)) candidates.push(name[1]);
    }
  }
  return [...new Set(candidates)].map((item) => item.toLowerCase())
    .filter((item) => !INTEGER_TARGET_STOPWORDS.has(item))
    .filter((item) => !source || new RegExp(`\\b${escapeRegex(item)}\\b`).test(source));
}

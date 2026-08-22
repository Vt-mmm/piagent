import { rejectionStatementErrorClass } from "./acceptance-error-classes.js";

function escapeRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function braceDepthAt(text, offset) {
  let depth = 0;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}

function priorUnconditionalExit(text, offset) {
  for (const match of text.slice(0, offset).matchAll(/\b(?:return|throw)\b/g)) {
    if (braceDepthAt(text, match.index) !== 0) continue;
    const statementStart = Math.max(text.lastIndexOf(";", match.index - 1), text.lastIndexOf("}", match.index - 1)) + 1;
    if (!text.slice(statementStart, match.index).trim()) return true;
  }
  return false;
}

function topLevelParts(text, delimiter) {
  const parts = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") parentheses += 1;
    else if (text[index] === ")") parentheses = Math.max(0, parentheses - 1);
    else if (text[index] === "[") brackets += 1;
    else if (text[index] === "]") brackets = Math.max(0, brackets - 1);
    else if (text[index] === delimiter && parentheses === 0 && brackets === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function stripOuterParentheses(raw) {
  let value = String(raw ?? "").trim();
  while (value.startsWith("(") && balancedEnd(value, 0) === value.length) value = value.slice(1, -1).trim();
  return value;
}

function staticFalsyToken(raw) {
  const value = stripOuterParentheses(raw);
  return /^(?:false|null|undefined|0|__pi_(?:empty|whitespace)_string_literal__)$/i.test(value)
    || /^(?:true\s*={2,3}\s*false|false\s*={2,3}\s*true)$/i.test(value);
}

function staticPrimitiveComparison(raw) {
  const match = stripOuterParentheses(raw).match(/^(-?\d+(?:\.\d+)?|true|false)\s*(===|==|!==|!=|<=|>=|<|>)\s*(-?\d+(?:\.\d+)?|true|false)$/i);
  if (!match) return undefined;
  const value = (token) => /^(?:true|false)$/i.test(token) ? token.toLowerCase() === "true" : Number(token);
  const left = value(match[1]), right = value(match[3]);
  if (["===", "=="].includes(match[2])) return left === right;
  if (["!==", "!="].includes(match[2])) return left !== right;
  if (match[2] === "<") return left < right;
  if (match[2] === ">") return left > right;
  if (match[2] === "<=") return left <= right;
  return left >= right;
}

function staticallyFalseCondition(raw) {
  const value = stripOuterParentheses(raw);
  return staticFalsyToken(value) || staticPrimitiveComparison(value) === false
    || value.replace(/[()]/g, " ").split("&&").some((part) => staticFalsyToken(part) || staticPrimitiveComparison(part) === false);
}

function staticallyTrueCondition(raw) {
  const value = stripOuterParentheses(raw);
  return /^true$/i.test(value) || staticPrimitiveComparison(value) === true;
}

function sideEffectFreeCondition(raw) {
  const value = String(raw ?? "");
  return !staticallyFalseCondition(value)
    && !/(?<![=!<>])=(?!=|>)|\+\+|--|=>|[,;?]|\b(?:await|delete|new|yield)\b/i.test(value)
    && !/\b[a-z_$][a-z0-9_$]*\s*\(/i.test(value);
}

function previousSignificantCharacter(text, offset) {
  let index = offset - 1;
  while (index >= 0 && /\s/.test(text[index])) index -= 1;
  return text[index] ?? "";
}

function directBindingMutations(text, name) {
  const escaped = escapeRegex(name);
  const mutations = [];
  const suffix = new RegExp(`(?<![a-z0-9_$])${escaped}\\b\\s*(?:=(?!=|>)|\\+\\+|--|(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[+*/%&|^-])=)`, "gi");
  for (const match of text.matchAll(suffix)) {
    const previous = previousSignificantCharacter(text, match.index);
    if (match.index === undefined || previous && ".#".includes(previous)) continue;
    mutations.push(match.index);
  }
  const prefix = new RegExp(`(?:\\+\\+|--)\\s*(?<![a-z0-9_$.?])${escaped}\\b`, "gi");
  for (const match of text.matchAll(prefix)) mutations.push(match.index + match[0].toLowerCase().lastIndexOf(name.toLowerCase()));
  const destructured = new RegExp(`(?:\\{[^}\\n]{0,500}\\b${escaped}\\b[^}\\n]{0,500}\\}|\\[[^\\]\\n]{0,500}\\b${escaped}\\b[^\\]\\n]{0,500}\\])\\s*=(?!=|>)|\\bfor(?:\\s+await)?\\s*\\(\\s*${escaped}\\s+(?:of|in)\\b`, "gi");
  for (const match of text.matchAll(destructured)) mutations.push(match.index);
  return [...new Set(mutations)].sort((left, right) => left - right);
}

function declarationInitializesAt(text, offset) {
  return /\b(?:const|let|var)\s*$/i.test(text.slice(Math.max(0, offset - 120), offset));
}

function bindingWrittenBefore(text, name, offset) {
  return directBindingMutations(text.slice(0, offset), name)
    .some((mutation) => !declarationInitializesAt(text, mutation));
}

function bindingDeclared(text, name) {
  const escaped = escapeRegex(name);
  return new RegExp(`\\b(?:class|const|function|let|var)\\s+${escaped}\\b|\\b(?:const|let|var)\\s*[\\[{][^}\\]\\n]{0,500}\\b${escaped}\\b|\\bcatch\\s*\\([^)]*\\b${escaped}\\b|\\bimport\\b[^;\\n]{0,500}\\b${escaped}\\b`, "i").test(text);
}

function memberBindingMutation(text, name) {
  const escaped = escapeRegex(name);
  return new RegExp(`(?<![a-z0-9_$.?])${escaped}\\b\\s*(?:\\.[a-z_$][a-z0-9_$]*|\\[[^\\]]{1,300}\\])\\s*(?:=(?!=|>)|\\+\\+|--|(?:\\*\\*|<<|>>>?|&&|\\|\\||\\?\\?|[+*/%&|^-])=)`, "i").test(text);
}

function memberBindingCall(text, name) {
  return new RegExp(`(?<![a-z0-9_$.?])${escapeRegex(name)}\\b\\s*(?:\\.[a-z_$][a-z0-9_$]*|\\[[^\\]]{1,300}\\])\\s*\\(`, "i").test(text);
}

function liveInputNames(text, names, referenceText, offset) {
  return names.filter((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, "i").test(referenceText)
    && !bindingWrittenBefore(text, name, offset));
}

function topLevelControlBefore(text, offset) {
  for (const match of text.slice(0, offset).matchAll(/\b(?:do|for|if|return|switch|throw|try|while)\b/gi)) {
    if (braceDepthAt(text, match.index) === 0) return true;
  }
  return false;
}

function topLevelControlBetween(text, start, end) {
  const segment = text.slice(start, end);
  for (const match of segment.matchAll(/\b(?:do|for|if|return|switch|throw|try|while)\b/gi)) {
    if (braceDepthAt(segment, match.index) === 0) return true;
  }
  return false;
}

function preLoopStatementsProven(text, offset, carrier) {
  let prefix = text.slice(0, offset), escaped = escapeRegex(carrier);
  prefix = prefix.replace(new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*string\\s*\\(\\s*[a-z_$][a-z0-9_$]*\\s*\\)\\s*(?:;|(?=\\r?\\n))`, "gi"), " ");
  prefix = prefix.replace(/\b(?:let|var)\s+[a-z_$][a-z0-9_$]*(?:\s*:\s*(?:boolean|string))?\s*=\s*(?:false|__pi_empty_string_literal__)\s*(?:;|(?=\r?\n))/gi, " ");
  return /^[\s;]*$/.test(prefix);
}

function trustedCarrier(text, carrier, offset, parameters, sourceCode) {
  const normalized = carrier.toLowerCase();
  const prefix = text.slice(0, offset);
  if (parameters.includes(normalized)) return "";
  const escaped = escapeRegex(normalized);
  const declarations = [...prefix.matchAll(new RegExp(`\\bconst\\s+${escaped}\\s*=\\s*string\\s*\\(\\s*([a-z_$][a-z0-9_$]*)\\s*\\)\\s*(?:;|(?=\\r?\\n))`, "gi"))]
    .filter((match) => braceDepthAt(prefix, match.index) === 0);
  const input = declarations[0]?.[1]?.toLowerCase();
  if (declarations.length !== 1 || !parameters.includes(input) || bindingDeclared(prefix.slice(0, declarations[0].index), input)
    || memberBindingCall(prefix.slice(0, declarations[0].index), input) || memberBindingMutation(prefix, input)
    || parameters.includes("string") || bindingDeclared(sourceCode, "string") || bindingWrittenBefore(sourceCode, "string", sourceCode.length)) return "";
  return bindingWrittenBefore(prefix, normalized, prefix.length)
    || bindingWrittenBefore(prefix, input, prefix.length) || memberBindingMutation(prefix, normalized) ? "" : normalized;
}

function loopEvidence(text, header, offset, parameters, sourceCode) {
  const clauses = topLevelParts(header, ";");
  if (clauses.length !== 3) {
    const iterator = header.match(/^\s*(?:const|let)\s+([a-z_$][a-z0-9_$]*)(?:\s*:\s*[^=;]+)?\s+of\s+([a-z_$][a-z0-9_$]*)\s*$/i);
    const carrier = iterator && trustedCarrier(text, iterator[2], offset, parameters, sourceCode);
    return carrier ? { carrier, counter: "", item: iterator[1].toLowerCase() } : undefined;
  }
  const initializer = stripOuterParentheses(clauses[0]).match(/^(?:let|var)\s+([a-z_$][a-z0-9_$]*)(?:\s*:\s*number)?\s*=\s*0$/i);
  if (!initializer) return undefined;
  const counter = initializer[1].toLowerCase(), escapedCounter = escapeRegex(counter);
  const condition = stripOuterParentheses(clauses[1]);
  const bound = condition.match(new RegExp(`^${escapedCounter}\\s*<\\s*([a-z_$][a-z0-9_$]*)\\s*\\.\\s*length$`, "i"));
  const update = stripOuterParentheses(clauses[2]);
  if (!bound || !new RegExp(`^(?:${escapedCounter}\\s*\\+\\+|\\+\\+\\s*${escapedCounter}|${escapedCounter}\\s*\\+=\\s*1)$`, "i").test(update)) return undefined;
  const carrier = trustedCarrier(text, bound[1], offset, parameters, sourceCode);
  return carrier ? { carrier, counter, item: "" } : undefined;
}

function statementEnd(text, start, ceiling) {
  const candidates = [text.indexOf(";", start), text.indexOf("\n", start), text.indexOf("\r", start)]
    .filter((index) => index >= start && index < ceiling)
    .map((index) => index + 1);
  return candidates.length > 0 ? Math.min(...candidates) : ceiling;
}

function conditionalRanges(text, loop) {
  const ranges = [];
  for (const match of text.slice(loop.start, loop.end).matchAll(/\bif\s*\(/gi)) {
    const conditionStart = loop.start + match.index;
    const conditionOpen = text.indexOf("(", conditionStart);
    const conditionEnd = balancedEnd(text, conditionOpen);
    if (conditionEnd === -1 || conditionEnd > loop.end) continue;
    const condition = text.slice(conditionOpen + 1, conditionEnd - 1);
    let consequentStart = conditionEnd;
    while (/\s/.test(text[consequentStart] ?? "")) consequentStart += 1;
    const consequentEnd = text[consequentStart] === "{"
      ? balancedEnd(text, consequentStart, "{", "}")
      : statementEnd(text, consequentStart, loop.end + 1);
    if (consequentEnd > consequentStart && consequentEnd <= loop.end + 1) {
      ranges.push({ conditionStart, condition, start: consequentStart, end: consequentEnd });
    }
  }
  return ranges;
}

function exactBooleanWrite(text, offset, name) {
  const match = text.slice(offset).match(new RegExp(`^${escapeRegex(name)}\\s*=\\s*(true|false)\\s*(?:;|(?=\\r?\\n|}))`, "i"));
  return match ? { end: offset + match[0].length, value: match[1].toLowerCase() } : null;
}

function branchHasPriorExit(text, start, offset) {
  const branchStart = text[start] === "{" ? start + 1 : start;
  const prefix = text.slice(branchStart, offset);
  for (const match of prefix.matchAll(/\bif\s*\(/gi)) {
    if (braceDepthAt(prefix, match.index) !== 0) continue;
    const open = prefix.indexOf("(", match.index), end = balancedEnd(prefix, open);
    if (end === -1 || !staticallyTrueCondition(prefix.slice(open + 1, end - 1))) continue;
    const following = prefix.slice(end).match(/^\s*(?:\{\s*)?(?:break|continue|return|throw)\b/i);
    if (following) return true;
  }
  for (const match of prefix.matchAll(/\b(?:break|continue|return|throw)\b/g)) {
    if (braceDepthAt(prefix, match.index) !== 0) continue;
    const statementStart = Math.max(prefix.lastIndexOf(";", match.index - 1), prefix.lastIndexOf("}", match.index - 1)) + 1;
    if (!prefix.slice(statementStart, match.index).trim()) return true;
  }
  return false;
}

function affirmativeQuotedTerminalContract(contractText, targetName) {
  const normalized = String(contractText ?? "").normalize("NFD").replace(/[\u0300-\u036f`_*]/g, "").toLowerCase()
    .replace(/\b(is|are|was|were|do|does|did|should|would|could|must|will|shall)n['’]t\b/g, "$1 not").replace(/\bcan(?:not|['’]t)\b/g, "can not").replace(/\bwon['’]t\b/g, "will not").replace(/\bshan['’]t\b/g, "shall not");
  if (!targetName) return false;
  const target = new RegExp(`\\b${escapeRegex(targetName)}\\b`, "i"), clauses = normalized.split(/(?<=[.!?;])\s+|\n+/);
  const negated = (clause) => /\b(?:avoid|do\s+not|does\s+not|fails?\s+to|ignore|must\s+not|never|no|not|should\s+not|without|unchanged|unrelated|out\s+of\s+scope)\b/.test(clause);
  const uniquelyMentionsTarget = (clause) => {
    const calls = [...clause.matchAll(/\b([a-z_$][a-z0-9_$]*)\s*\(/gi)].map((match) => match[1].toLowerCase());
    const escaped = escapeRegex(targetName), other = `(?!${escaped}\\b)[a-z_$][a-z0-9_$]*`, connector = `(?:,|and|or|with|alongside|rather\\s+than|instead\\s+of|versus|vs\\.?)`, peer = new RegExp(`(?:\\b${escaped}\\b(?:\\s*\\([^)]{0,200}\\))?\\s*${connector}\\s*${other}\\b|\\b${other}\\b\\s*${connector}\\s*\\b${escaped}\\b)`, "i");
    return target.test(clause) && !peer.test(clause) && calls.every((name) => name === targetName.toLowerCase());
  };
  const directlyObligatesTarget = (clause) => uniquelyMentionsTarget(clause) && new RegExp(`\\b${escapeRegex(targetName)}\\b(?:\\s*\\([^)]{0,200}\\))?\\s+(?:(?:must|shall|should|will)\\s+)?(?:raise|reject|throw)s?\\b`, "i").test(clause);
  const linkedTargetDirective = (clause) => new RegExp(`^(?:implement|preserve|replace|update)\\s+(?:the\\s+)?(?:(?:function|entrypoint)\\s+)?${escapeRegex(targetName)}(?:\\s*\\([^)]{0,200}\\))?(?:\\s+(?:function|entrypoint))?[.!?;]*$`, "i").test(clause.trim());
  const linkedNeighbor = (index, affirmative) => {
    const neighbors = [clauses[index - 1], clauses[index + 1]].filter((clause) => /^\s*(?:implement|preserve|replace|update)\b/i.test(clause ?? ""));
    return /^\s*(?:(?:must|shall|should)\s+)?(?:raise|reject|throw)s?\b/i.test(affirmative)
      && neighbors.length === 1 && linkedTargetDirective(neighbors[0]) && !negated(neighbors[0]) && uniquelyMentionsTarget(neighbors[0]);
  };
  return clauses.some((clause, index) => (/\bunterminated\b[\s\S]{0,100}\bquoted?\s+field\b|\bquoted?\s+field\b[\s\S]{0,100}\bunterminated\b/.test(clause)
    && /\b(?:raise|reject|throw)s?\b[\s\S]{0,80}\bsyntaxerror\b|\bsyntaxerror\b[\s\S]{0,80}\b(?:raise|reject|throw)s?\b/.test(clause)
    && !negated(clause)
    && (directlyObligatesTarget(clause) || linkedNeighbor(index, clause))));
}

function quoteInputGuard(condition, loop) {
  const operands = [...loop.items.map((name) => `\\b${escapeRegex(name)}\\b`)];
  if (loop.counter) operands.push(`\\b${escapeRegex(loop.carrier)}\\b\\s*\\[\\s*${escapeRegex(loop.counter)}\\s*\\]`);
  let quoteComparisons = 0;
  for (const rawPart of topLevelParts(String(condition ?? "").replaceAll("&&", "\u0000"), "\u0000")) {
    const part = stripOuterParentheses(rawPart);
    const quote = operands.some((operand) => new RegExp(`^(?:${operand}\\s*={3}\\s*__pi_double_quote_string_literal__|__pi_double_quote_string_literal__\\s*={3}\\s*${operand})$`, "i").test(part));
    if (quote) { quoteComparisons += 1; continue; }
    const empty = part.match(/^(?:([a-z_$][a-z0-9_$]*)\s*={3}\s*__pi_empty_string_literal__|__pi_empty_string_literal__\s*={3}\s*([a-z_$][a-z0-9_$]*))$/i);
    if (!empty || !loop.emptyAccumulators.includes((empty[1] ?? empty[2]).toLowerCase())) return false;
  }
  return quoteComparisons === 1;
}

function transitionEvidence(text, loop, ranges, state, item) {
  const ancestors = ranges.filter((range) => item.offset >= range.start && item.write.end <= range.end);
  if (ancestors.length === 0 || ancestors.some((range) => !sideEffectFreeCondition(range.condition)
    || branchHasPriorExit(text, range.start, item.offset)) || branchHasPriorExit(text, loop.start, item.offset)) return undefined;
  if (!ancestors.some((range) => liveInputNames(text, loop.inputNames, range.condition, range.conditionStart).length > 0
    && quoteInputGuard(range.condition, loop))) return undefined;
  const stateGuard = ancestors.some((range) => new RegExp(`^${escapeRegex(state)}(?:\\s*={2,3}\\s*true)?$`, "i").test(stripOuterParentheses(range.condition)));
  const stateGuardBraced = ancestors.some((range) => text[range.start] === "{"
    && new RegExp(`^${escapeRegex(state)}(?:\\s*={2,3}\\s*true)?$`, "i").test(stripOuterParentheses(range.condition)));
  const immediate = [...ancestors].sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  return { ...item, immediate, stateGuard, stateGuardBraced };
}

function initiallyFalseAuxiliaryGuard(text, loop, ranges, ancestors, state) {
  for (const ancestor of ancestors) {
    const auxiliary = stripOuterParentheses(ancestor.condition).match(/^([a-z_$][a-z0-9_$]*)(?:\s*={2,3}\s*true)?$/i)?.[1]?.toLowerCase();
    if (!auxiliary || auxiliary === state || auxiliary === loop.counter || loop.inputNames.includes(auxiliary)) continue;
    const declarations = [...text.slice(0, loop.start).matchAll(new RegExp(`\\b(?:let|var)\\s+${escapeRegex(auxiliary)}(?:\\s*:\\s*boolean)?\\s*=\\s*false\\s*(?:;|(?=\\r?\\n))`, "gi"))]
      .filter((match) => braceDepthAt(text, match.index) === 0);
    if (declarations.length !== 1) continue;
    const mutations = directBindingMutations(text.slice(loop.start, ancestor.conditionStart), auxiliary);
    if (mutations.every((relativeOffset) => {
      const offset = loop.start + relativeOffset, write = exactBooleanWrite(text, offset, auxiliary);
      if (!write) return false;
      if (write.value === "false") return true;
      const guards = ranges.filter((range) => offset >= range.start && write.end <= range.end);
      return guards.some((range) => new RegExp(`^${escapeRegex(state)}(?:\\s*={2,3}\\s*true)?$`, "i").test(stripOuterParentheses(range.condition)))
        && guards.some((range) => quoteInputGuard(range.condition, loop));
    })) return true;
  }
  return false;
}

function counterFlowProven(text, loop, ranges, state, truthyOffset) {
  if (!loop.counter) return true;
  const bodyText = text.slice(loop.start, loop.end);
  for (const relativeOffset of directBindingMutations(bodyText, loop.counter)) {
    const offset = loop.start + relativeOffset;
    if (!new RegExp(`^${escapeRegex(loop.counter)}\\s*(?:\\+\\+|\\+=\\s*1)\\s*(?:;|(?=\\r?\\n|}))`, "i").test(text.slice(offset))) return false;
    if (offset >= truthyOffset) continue;
    const ancestors = ranges.filter((range) => offset >= range.start && offset < range.end);
    const stateGuard = ancestors.some((range) => new RegExp(`^${escapeRegex(state)}(?:\\s*={2,3}\\s*true)?$`, "i").test(stripOuterParentheses(range.condition)));
    const nextQuote = ancestors.some((range) => new RegExp(`\\b${escapeRegex(loop.carrier)}\\b\\s*\\[\\s*${escapeRegex(loop.counter)}\\s*\\+\\s*1\\s*\\]\\s*={3}\\s*__pi_double_quote_string_literal__`, "i").test(range.condition));
    if ((!stateGuard || !nextQuote) && !initiallyFalseAuxiliaryGuard(text, loop, ranges, ancestors, state)) return false;
  }
  return true;
}

function priorSiblingControlProven(text, loop, ranges, state, truthyOffset) {
  const loopText = text.slice(loop.start, loop.end), statePattern = new RegExp(`^${escapeRegex(state)}(?:\\s*={2,3}\\s*true)?$`, "i");
  for (const range of ranges.filter((item) => item.conditionStart < truthyOffset
    && braceDepthAt(loopText, item.conditionStart - loop.start) === 0)) {
    if (truthyOffset >= range.start && truthyOffset < range.end) continue;
    if (text[range.start] === "{" && statePattern.test(stripOuterParentheses(range.condition))
      && !/^\s*else\b/i.test(text.slice(range.end))) continue;
    return false;
  }
  return true;
}

function statementFragmentProven(raw, loop) {
  let value = String(raw ?? "").trim();
  if (!value) return true;
  if (/^else\b/i.test(value)) value = value.replace(/^else\b\s*/i, "");
  while (/^if\s*\(/i.test(value)) {
    const open = value.indexOf("("), end = balancedEnd(value, open);
    if (end === -1) return false;
    value = value.slice(end).trim();
  }
  const carrierItem = loop.counter ? `${escapeRegex(loop.carrier)}\\s*\\[\\s*${escapeRegex(loop.counter)}\\s*\\]` : "";
  const inputs = [...loop.items.map(escapeRegex), carrierItem].filter(Boolean).join("|");
  if (/^continue$/i.test(value)) return true;
  if (loop.counter && new RegExp(`^(?:${escapeRegex(loop.counter)}\\s*(?:\\+\\+|\\+=\\s*1)|\\+\\+\\s*${escapeRegex(loop.counter)})$`, "i").test(value)) return true;
  if (loop.booleanBindings.some((name) => new RegExp(`^${escapeRegex(name)}\\s*=\\s*(?:true|false)$`, "i").test(value))) return true;
  if (inputs && loop.emptyAccumulators.some((name) => new RegExp(`^${escapeRegex(name)}\\s*\\+=\\s*(?:${inputs})$`, "i").test(value))) return true;
  return Boolean(loop.counter && loop.items.some((name) => new RegExp(`^const\\s+${escapeRegex(name)}\\s*=\\s*${carrierItem}$`, "i").test(value)));
}

function loopStatementsProven(loopBody, loop) {
  if (/\b(?:break|delete|new|return|throw|typeof|void)\b/i.test(loopBody)) return false;
  if (/\b(?!if\b)[a-z_$][a-z0-9_$]*\s*(?:\?\.\s*)?\(|\b[a-z_$][a-z0-9_$]*\s*__pi_template_literal__|[\])]\s*(?:\?\.\s*)?\(/i.test(loopBody)) return false;
  for (const match of loopBody.matchAll(/;/g)) {
    const start = Math.max(loopBody.lastIndexOf(";", match.index - 1), loopBody.lastIndexOf("{", match.index - 1), loopBody.lastIndexOf("}", match.index - 1)) + 1;
    if (!statementFragmentProven(loopBody.slice(start, match.index), loop)) return false;
  }
  for (const line of loopBody.split(/\r?\n/)) {
    const tail = line.slice(line.lastIndexOf(";") + 1).trim();
    if (!tail || /^[{}]*\s*(?:else\s*)?[{}]*$/i.test(tail)) continue;
    if (/^(?:}\s*)?(?:else\s+)?if\s*\(/i.test(tail)) {
      const open = tail.indexOf("("), end = balancedEnd(tail, open);
      if (end !== -1 && /^[\s{}]*$/.test(tail.slice(end))) continue;
    }
    if (!statementFragmentProven(tail.replace(/^}\s*/, ""), loop)) return false;
  }
  for (const declaration of loopBody.matchAll(/\b(?:const|let|var)\b/gi)) {
    const exactItem = loop.counter && loopBody.slice(declaration.index).match(new RegExp(`^const\\s+[a-z_$][a-z0-9_$]*\\s*=\\s*${escapeRegex(loop.carrier)}\\s*\\[\\s*${escapeRegex(loop.counter)}\\s*\\]\\s*(?:;|(?=\\r?\\n))`, "i"));
    if (!exactItem || braceDepthAt(loopBody, declaration.index) !== 0) return false;
  }
  return true;
}

function loopConditionsProven(ranges, loop, state) {
  const statePattern = new RegExp(`^${escapeRegex(state)}(?:\\s*={2,3}\\s*true)?$`, "i");
  const quote = "__pi_double_quote_string_literal__";
  const next = loop.counter ? `${escapeRegex(loop.carrier)}\\s*\\[\\s*${escapeRegex(loop.counter)}\\s*\\+\\s*1\\s*\\]` : "";
  return ranges.every((range) => {
    const condition = stripOuterParentheses(range.condition);
    if (!sideEffectFreeCondition(condition)) return false;
    if (statePattern.test(condition) || quoteInputGuard(condition, loop)) return true;
    if (next && new RegExp(`^(?:${next}\\s*={3}\\s*${quote}|${quote}\\s*={3}\\s*${next})$`, "i").test(condition)) return true;
    return loop.booleanBindings.some((name) => name !== state && new RegExp(`^(?:!\\s*${escapeRegex(name)}|${escapeRegex(name)}(?:\\s*={2,3}\\s*(?:true|false))?)$`, "i").test(condition));
  });
}

function transitionShapeProven(text, transitions) {
  const truthy = transitions.find((item) => item.write.value === "true");
  const falsy = transitions.find((item) => item.write.value === "false");
  if (!truthy || !falsy) return false;
  if (falsy.offset < truthy.offset && falsy.stateGuardBraced && !truthy.stateGuard) return true;
  if (truthy.offset >= falsy.offset || truthy.stateGuard || falsy.stateGuard) return false;
  return /^\s*else\s*$/i.test(text.slice(truthy.immediate.end, falsy.immediate.conditionStart));
}

function statementConsequentEnd(text, start, ceiling) {
  let offset = start;
  while (/\s/.test(text[offset] ?? "")) offset += 1;
  return text[offset] === "{" ? balancedEnd(text, offset, "{", "}") : statementEnd(text, offset, ceiling);
}

function elseChainEnd(text, start, ceiling) {
  let offset = start;
  while (offset < ceiling) {
    while (/\s/.test(text[offset] ?? "")) offset += 1;
    if (!/^else\b/i.test(text.slice(offset))) return offset;
    offset += 4;
    while (/\s/.test(text[offset] ?? "")) offset += 1;
    if (/^if\b/i.test(text.slice(offset))) {
      const open = text.indexOf("(", offset), end = balancedEnd(text, open);
      if (open === -1 || end === -1 || end > ceiling) return -1;
      offset = statementConsequentEnd(text, end, ceiling);
    } else offset = statementConsequentEnd(text, offset, ceiling);
    if (offset === -1 || offset > ceiling) return -1;
  }
  return offset;
}

function truthyTransitionTailProven(text, loop, transition) {
  if (!/^[\s;}]*$/.test(text.slice(transition.write.end, transition.immediate.end))) return false;
  const chainEnd = elseChainEnd(text, transition.immediate.end, loop.end);
  return chainEnd !== -1 && /^[\s;]*$/.test(text.slice(chainEnd, loop.end));
}

// Prove only one narrow terminal state-machine rejection shape. Callers must
// still establish stable exports/imports, live assertions, error constructors,
// the exact current verifier, and a current-tree changed source/test corpus.
export function statefulTerminalRejectionEvidence(body, parameters, requestedErrors, contractText, targetName, sourceCode) {
  if (!affirmativeQuotedTerminalContract(contractText, targetName)) return false;
  const loops = [];
  for (const match of body.matchAll(/\bfor\s*\(/gi)) {
    if (braceDepthAt(body, match.index) !== 0 || priorUnconditionalExit(body, match.index) || topLevelControlBefore(body, match.index)) continue;
    const conditionOpen = body.indexOf("(", match.index), conditionEnd = balancedEnd(body, conditionOpen);
    if (conditionEnd === -1) continue;
    const header = body.slice(conditionOpen + 1, conditionEnd - 1);
    const evidence = loopEvidence(body, header, match.index, parameters, sourceCode);
    if (!evidence || !preLoopStatementsProven(body, match.index, evidence.carrier)) continue;
    let bodyStart = conditionEnd;
    while (/\s/.test(body[bodyStart] ?? "")) bodyStart += 1;
    if (body[bodyStart] !== "{") continue;
    const bodyEnd = balancedEnd(body, bodyStart, "{", "}");
    const loopBody = body.slice(bodyStart + 1, bodyEnd - 1);
    const nestedCallable = /=>|\b(?:catch|class|do|for|function|switch|try|while)\b|(?:^|[;{}]\s*)(?!(?:else|if)\b)[a-z_$][a-z0-9_$]*\s*\([^)]*\)\s*\{/im;
    if (bodyEnd === -1 || nestedCallable.test(loopBody) || memberBindingMutation(loopBody, evidence.carrier)
      || [evidence.carrier, evidence.counter, evidence.item].filter(Boolean).some((name) => bindingDeclared(loopBody, name))) continue;
    const items = [evidence.item].filter(Boolean), inputNames = [evidence.carrier, ...items];
    if (evidence.counter) {
      for (const declaration of loopBody.matchAll(new RegExp(`\\bconst\\s+([a-z_$][a-z0-9_$]*)\\s*=\\s*${escapeRegex(evidence.carrier)}\\s*\\[\\s*${escapeRegex(evidence.counter)}\\s*\\]\\s*(?:;|(?=\\r?\\n))`, "gi"))) {
        if (braceDepthAt(loopBody, declaration.index) === 0) items.push(declaration[1].toLowerCase());
      }
    }
    inputNames.push(...items);
    const emptyAccumulators = [...body.slice(0, match.index).matchAll(/\b(?:let|var)\s+([a-z_$][a-z0-9_$]*)(?:\s*:\s*string)?\s*=\s*__pi_empty_string_literal__\s*(?:;|(?=\r?\n))/gi)]
      .filter((item) => braceDepthAt(body, item.index) === 0).map((item) => item[1].toLowerCase());
    const booleanBindings = [...body.slice(0, match.index).matchAll(/\b(?:let|var)\s+([a-z_$][a-z0-9_$]*)(?:\s*:\s*boolean)?\s*=\s*false\s*(?:;|(?=\r?\n))/gi)]
      .filter((item) => braceDepthAt(body, item.index) === 0).map((item) => item[1].toLowerCase());
    const loop = { ...evidence, start: bodyStart + 1, end: bodyEnd - 1, items: [...new Set(items)], inputNames: [...new Set(inputNames)], emptyAccumulators, booleanBindings };
    if (loopStatementsProven(loopBody, loop)) loops.push(loop);
  }
  if (loops.length === 0) return false;

  for (const declaration of body.matchAll(/\b(?:let|var)\s+([a-z_$][a-z0-9_$]*)(?:\s*:\s*boolean)?\s*=\s*false\s*(?:;|(?=\r?\n))/gi)) {
    if (braceDepthAt(body, declaration.index) !== 0) continue;
    const state = declaration[1].toLowerCase(), escaped = escapeRegex(state);
    if (parameters.includes(state)
      || [...body.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\b`, "gi"))].length !== 1) continue;
    const mutations = directBindingMutations(body, state)
      .filter((offset) => offset < declaration.index || offset >= declaration.index + declaration[0].length);
    const writes = mutations.map((offset) => ({ offset, write: exactBooleanWrite(body, offset, state) }));
    if (writes.length !== 2 || writes.some((item) => !item.write)
      || !writes.some((item) => item.write.value === "true") || !writes.some((item) => item.write.value === "false")) continue;
    const loop = loops.find((candidate) => candidate.start > declaration.index + declaration[0].length
      && writes.every((item) => item.offset >= candidate.start && item.write.end <= candidate.end + 1));
    if (!loop) continue;
    const ranges = conditionalRanges(body, loop);
    const transitions = writes.map((item) => transitionEvidence(body, loop, ranges, state, item));
    const truthyOffset = writes.find((item) => item.write.value === "true").offset;
    const truthyTransition = transitions.find((item) => item?.write.value === "true");
    if (!loopConditionsProven(ranges, loop, state) || transitions.some((item) => !item) || !transitionShapeProven(body, transitions)
      || !counterFlowProven(body, loop, ranges, state, truthyOffset)
      || !priorSiblingControlProven(body, loop, ranges, state, truthyOffset)
      || !truthyTransitionTailProven(body, loop, truthyTransition)) continue;

    for (const terminal of body.matchAll(/\bif\s*\(/gi)) {
      if (terminal.index <= loop.end || braceDepthAt(body, terminal.index) !== 0 || priorUnconditionalExit(body, terminal.index)
        || topLevelControlBetween(body, loop.end + 1, terminal.index)
        || !/^[\s;]*$/.test(body.slice(loop.end + 1, terminal.index))) continue;
      const conditionOpen = body.indexOf("(", terminal.index), conditionEnd = balancedEnd(body, conditionOpen);
      if (conditionEnd === -1) continue;
      const condition = stripOuterParentheses(body.slice(conditionOpen + 1, conditionEnd - 1));
      if (!new RegExp(`^${escaped}(?:\\s*={2,3}\\s*true)?$`, "i").test(condition)) continue;
      let consequentStart = conditionEnd;
      while (/\s/.test(body[consequentStart] ?? "")) consequentStart += 1;
      const consequentEnd = body[consequentStart] === "{"
        ? balancedEnd(body, consequentStart, "{", "}")
        : statementEnd(body, consequentStart, body.length);
      if (consequentEnd !== -1 && rejectionStatementErrorClass(body.slice(consequentStart, consequentEnd).replace(/^\s*\{/, ""), requestedErrors)) return true;
    }
  }
  return false;
}

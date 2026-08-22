import {
  REDACTION,
  SENSITIVE_KEY_TERMS,
  SENSITIVE_PLURAL_KEYS,
  keyLooksSensitive,
  looksLikeKnownSecret,
  normalizeSecretKey,
  redactSensitiveTextInternal,
  valueLooksPlaceholder
} from "./sensitive-text.js";

const SOURCE_ASSIGNMENT_START_PATTERN = /(^|[\s{[(;,])((?:(?:const|let|var)\s+)?(#?[$@%]?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:>>>=|<<=|>>=|\|\|=|\?\?=|&&=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<-|:=|=)\s*)/g;
const SOURCE_TYPED_DECLARATION_START_PATTERN = /(^|[\s{[(;,])((?:const|var)\s+(#?[$@%]?[A-Za-z_$][A-Za-z0-9_$]*)\s+(?:\*|\[\])*[A-Za-z_$][A-Za-z0-9_$.[\]*]*\s*=\s*)/g;
const SOURCE_COMPOUND_ASSIGNMENT_START_PATTERN = /(^|[\s{[(;,])((#?[$@%]?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|\.|->|::)#?[A-Za-z_$][A-Za-z0-9_$]*|\[(?:"[^"\r\n]*"|'[^'\r\n]*'|[A-Za-z_$][A-Za-z0-9_$]*)\])+\s*(?:>>>=|<<=|>>=|\|\|=|\?\?=|&&=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<-|:=|=)\s*))/g;
const SOURCE_BRACE_INITIALIZER_START_PATTERN = /(^|[\s{[(;,])((?:(?:const\s+)?[A-Za-z_$][A-Za-z0-9_$:<>,*&[\]]*\s+)+(#?[$@%]?[A-Za-z_$][A-Za-z0-9_$]*)\s*\{\s*)/g;
const SOURCE_PREPROCESSOR_DEFINE_START_PATTERN = /(^|[\r\n])([ \t]*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+)/g;
const SOURCE_PROPERTY_START_PATTERN = /(^|[\s{[(;,])((?:["']?)([A-Za-z_$][A-Za-z0-9_$]*)(?:["']?)\s*:(?!=)\s*)/g;
const SOURCE_COMPUTED_PROPERTY_START_PATTERN = /(^|[\s{[(;,])(\[\s*["']([A-Za-z_$][A-Za-z0-9_$]*)["']\s*\]\s*:(?!=)\s*)/g;
const SOURCE_TEMPLATE_DOUBLE_BINDING_PATTERN = /((?::|v-bind:)([A-Za-z_$][A-Za-z0-9_$.-]*)\s*=\s*)"((?:\\.|[^"\\\r\n])*)"/g;
const SOURCE_TEMPLATE_SINGLE_BINDING_PATTERN = /((?::|v-bind:)([A-Za-z_$][A-Za-z0-9_$.-]*)\s*=\s*)'((?:\\.|[^'\\\r\n])*)'/g;
const SHELL_REFERENCE_PATTERN = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\}|\([A-Za-z0-9_./:-]+(?:\s+\$[A-Za-z_][A-Za-z0-9_]*)*\))$/;
const SOURCE_CALL_START_PATTERN = /(^|[^A-Za-z0-9_$])([$@%]?[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|->|::)[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g;

function balancedSourceExpression(value) {
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  for (const character of value) {
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") {
      if (stack.pop() !== pairs[character]) return false;
    }
  }
  return stack.length === 0;
}

function maskSourceLookupStrings(value) {
  let valid = true;
  const text = value.replace(/"((?:\\.|[^"\\\r\n])*)"|'((?:\\.|[^'\\\r\n])*)'/g, (match, doubleQuoted, singleQuoted, offset) => {
    const literal = doubleQuoted ?? singleQuoted ?? "";
    const normalized = normalizeSecretKey(literal);
    const exactLookupKey = SENSITIVE_KEY_TERMS.includes(normalized) || SENSITIVE_PLURAL_KEYS.has(normalized);
    const environmentLookupKey = /^[A-Z][A-Z0-9_]{1,79}$/.test(literal) && keyLooksSensitive(literal);
    const before = value.slice(0, offset).trimEnd();
    const after = value.slice(offset + match.length).trimStart();
    const bracketLookup = /\[@?$/.test(before) && after.startsWith("]");
    const accessorLookup = /(?:(?:\.|->|::)(?:get|lookup|valueForKey)|\b(?:getenv|lookup))\s*\($/i.test(before)
      && /^(?:,|\))/.test(after);
    const objectiveAccessorLookup = /(?:objectForKey|valueForKey|forKey)\s*:\s*@?$/i.test(before)
      && /^(?:\]|\s)/.test(after);
    if ((!exactLookupKey && !environmentLookupKey) || (!bracketLookup && !accessorLookup && !objectiveAccessorLookup)) valid = false;
    return "PIAGENT_LOOKUP_KEY";
  });
  if (!valid || /["'`]/.test(text)) return undefined;
  return text;
}

function hasStandaloneNumericSourceLiteral(value) {
  const pattern = /(^|[^A-Za-z0-9_$])(?:0[xX][0-9A-Fa-f]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?n?)(?=$|[^A-Za-z0-9_$])/g;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const literalStart = match.index + match[1].length;
    const literalEnd = pattern.lastIndex;
    const before = value.slice(0, literalStart).trimEnd();
    const after = value.slice(literalEnd).trimStart();
    const bracketIndex = before.endsWith("[") && after.startsWith("]")
      && /[A-Za-z0-9_$)\]]\s*\[$/.test(before);
    if (!bracketIndex) return true;
  }
  return false;
}

function hasStandaloneKeywordSourceLiteral(value) {
  const pattern = /(^|[^A-Za-z0-9_$])(?:null|undefined|true|false|nil|none|yes|no)(?=$|[^A-Za-z0-9_$])/gi;
  for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
    const literalStart = match.index + match[1].length;
    const before = value.slice(0, literalStart).trimEnd();
    if (!before.endsWith(".") && !before.endsWith("->") && !before.endsWith("::")) return true;
  }
  return false;
}

function sourceReference(value, shellOnly) {
  const clean = String(value ?? "").trim();
  if (!clean) return false;
  if (shellOnly) return !redactSensitiveTextInternal(clean).redacted && SHELL_REFERENCE_PATTERN.test(clean);
  if (looksLikeKnownSecret(clean)) return false;
  // Ruby percent literals and heredoc openers are literal syntax, not dynamic
  // references. Never shield their contents from the source redactor.
  if (/^%(?:q|Q|w|W|i|I|x|r|s)?[({[<]/.test(clean) || /^<<[-~]?/.test(clean)) return false;
  const masked = maskSourceLookupStrings(clean);
  if (!masked || !/^(?:await\s+)?[$@%]?[A-Za-z_]/.test(masked)
    || !/^[A-Za-z0-9_$@%?.()[\]{},!:\s|&+*/<>=-]+$/.test(masked)
    || !balancedSourceExpression(masked)
    || hasStandaloneNumericSourceLiteral(masked)
    || hasStandaloneKeywordSourceLiteral(masked)) return false;
  return true;
}

function sourceExpressionEnd(segment, start) {
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  let quote = "", escaped = false, sawValue = false;
  for (let index = start; index < segment.length; index += 1) {
    const character = segment[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      sawValue = true;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") {
      if (stack.length === 0) return index;
      if (stack.at(-1) === pairs[character]) stack.pop();
    } else if (stack.length === 0 && (character === ";" || character === ",")) {
      return index;
    } else if (stack.length === 0 && (character === "\r" || character === "\n")) {
      if (character === "\r" && segment[index + 1] === "\n") continue;
      const before = segment.slice(start, index).trimEnd();
      const after = segment.slice(index + 1).trimStart();
      const trailingContinuation = /(?:\b(?:await|return|yield|throw|new)|\?\.|\?\?|\|\||&&|[.?:+*/%&|=,<>{[(\\-])$/.test(before);
      const leadingContinuation = /^(?:\?\.|\?\?|\|\||&&|[([.'"`?:+*/%&|,<>=-])/.test(after);
      if (sawValue && !trailingContinuation && !leadingContinuation) return index;
    } else if (!/\s/.test(character)) {
      sawValue = true;
    }
  }
  return segment.length;
}

function rewriteSensitiveStarts(segment, pattern, { allowDynamic, shellOnly, placeholder, acceptMatch, reference = sourceReference }) {
  let output = "", cursor = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) {
    if (match.index < cursor || !keyLooksSensitive(match[3]) || (acceptMatch && !acceptMatch(match))) continue;
    const valueStart = pattern.lastIndex;
    const valueEnd = sourceExpressionEnd(segment, valueStart);
    const rawExpression = segment.slice(valueStart, valueEnd);
    const expression = rawExpression.trim();
    const complete = segment.slice(match.index, valueEnd);
    output += segment.slice(cursor, match.index);
    const trailingHorizontalWhitespace = rawExpression.match(/[ \t]+$/)?.[0] ?? "";
    const lineEndings = (rawExpression.match(/\r\n|\n|\r/g) ?? []).join("");
    output += allowDynamic && reference(expression, shellOnly)
      ? placeholder(complete)
      : `${match[1]}${match[2]}${REDACTION}${lineEndings}${trailingHorizontalWhitespace}`;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  return `${output}${segment.slice(cursor)}`;
}

function callCloseIndex(segment, openIndex) {
  let depth = 0, quote = "", escaped = false;
  for (let index = openIndex; index < segment.length; index += 1) {
    const character = segment[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function callArgumentRanges(segment, start, end) {
  const ranges = [];
  let cursor = start, quote = "", escaped = false;
  const stack = [];
  const pairs = { ")": "(", "]": "[", "}": "{" };
  for (let index = start; index <= end; index += 1) {
    const character = index === end ? "," : segment[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") quote = character;
    else if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character === ")" || character === "]" || character === "}") {
      if (stack.at(-1) === pairs[character]) stack.pop();
    } else if (character === "," && stack.length === 0) {
      ranges.push({ start: cursor, end: index });
      cursor = index + 1;
    }
  }
  return ranges;
}

function quotedSensitiveLookupKey(value) {
  const match = /^\s*(["'])((?:\\.|(?!\1)[\s\S])*)\1\s*$/.exec(value);
  if (!match) return false;
  const normalized = normalizeSecretKey(match[2]);
  return SENSITIVE_KEY_TERMS.includes(normalized) || SENSITIVE_PLURAL_KEYS.has(normalized)
    || (/^[A-Z][A-Z0-9_]{1,79}$/.test(match[2]) && keyLooksSensitive(match[2]));
}

function setterValueArgument(callee, argumentValues) {
  const name = callee.split(/\.|->|::/).at(-1) ?? "";
  const direct = /^(?:set|put|store|update|write|add|assign)(.+)$/i.exec(name);
  if (direct && keyLooksSensitive(direct[1]) && argumentValues.length >= 1) return 0;
  if (["set", "put", "store", "update", "write", "add", "assign"].includes(name.toLowerCase())
    && argumentValues.length >= 2 && quotedSensitiveLookupKey(argumentValues[0])) return 1;
  return -1;
}

function couldSetSensitiveValue(callee, segment, openIndex) {
  const name = callee.split(/\.|->|::/).at(-1) ?? "";
  const direct = /^(?:set|put|store|update|write|add|assign)(.+)$/i.exec(name);
  if (direct && keyLooksSensitive(direct[1])) return true;
  if (!["set", "put", "store", "update", "write", "add", "assign"].includes(name.toLowerCase())) return false;

  // Generic setters can only name a sensitive destination through their first
  // quoted argument. Check that argument before looking for the matching close.
  // This keeps deeply nested non-sensitive `set(...)` calls from each rescanning
  // the entire suffix of the source file.
  const firstArgument = /^\s*((?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'))\s*,/.exec(segment.slice(openIndex + 1));
  return Boolean(firstArgument && quotedSensitiveLookupKey(firstArgument[1]));
}

function rewriteSensitiveCalls(segment, { allowDynamic, placeholder }) {
  let output = "", cursor = 0;
  SOURCE_CALL_START_PATTERN.lastIndex = 0;
  for (let match = SOURCE_CALL_START_PATTERN.exec(segment); match; match = SOURCE_CALL_START_PATTERN.exec(segment)) {
    if (match.index < cursor) continue;
    const openIndex = SOURCE_CALL_START_PATTERN.lastIndex - 1;
    if (!couldSetSensitiveValue(match[2], segment, openIndex)) {
      // Resume on the opening delimiter so a nested setter in the first
      // argument remains discoverable. Avoiding a full matching-close scan for
      // every ordinary nested call keeps this pass linear for adversarially
      // deep call expressions.
      SOURCE_CALL_START_PATTERN.lastIndex = openIndex;
      continue;
    }
    const closeIndex = callCloseIndex(segment, openIndex);
    if (closeIndex < 0) continue;
    const ranges = callArgumentRanges(segment, openIndex + 1, closeIndex);
    const values = ranges.map((range) => segment.slice(range.start, range.end));
    const valueIndex = setterValueArgument(match[2], values);
    if (valueIndex < 0) {
      // Restart on the opening delimiter so the regex can consume it as the
      // prefix of a nested call in the first argument. Advancing past it skips
      // `setToken(...)` in `wrapper(setToken(...), ...)`.
      SOURCE_CALL_START_PATTERN.lastIndex = openIndex;
      continue;
    }
    const range = ranges[valueIndex];
    const expression = segment.slice(range.start, range.end);
    if (allowDynamic && sourceReference(expression, false)) {
      SOURCE_CALL_START_PATTERN.lastIndex = closeIndex + 1;
      continue;
    }
    output += segment.slice(cursor, range.start);
    output += `${REDACTION}${"\n".repeat((expression.match(/\n/g) ?? []).length)}`;
    cursor = range.end;
    SOURCE_CALL_START_PATTERN.lastIndex = closeIndex + 1;
  }
  return `${output}${segment.slice(cursor)}`;
}

function rewriteSensitiveValueDecorators(segment) {
  const rewrite = (pattern, quote) => segment.replace(pattern, (match, prefix, literal, suffix) => {
    const identifiers = suffix.match(/[$@%]?[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    const field = identifiers.at(-1) ?? "";
    const lookup = /^\$\{[A-Za-z_][A-Za-z0-9_.:-]*\}$/.test(literal);
    if (!keyLooksSensitive(field) || lookup || valueLooksPlaceholder(literal)) return match;
    return `${prefix}${quote}${REDACTION}${quote}${suffix}`;
  });
  let result = rewrite(/(@Value\s*\(\s*)"((?:\\.|[^"\\\r\n])*)"(\s*\)[^;\r\n]{0,160})/g, "\"");
  result = result.replace(/(@Value\s*\(\s*)'((?:\\.|[^'\\\r\n])*)'(\s*\)[^;\r\n]{0,160})/g, (match, prefix, literal, suffix) => {
    const identifiers = suffix.match(/[$@%]?[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
    const field = identifiers.at(-1) ?? "";
    const lookup = /^\$\{[A-Za-z_][A-Za-z0-9_.:-]*\}$/.test(literal);
    if (!keyLooksSensitive(field) || lookup || valueLooksPlaceholder(literal)) return match;
    return `${prefix}'${REDACTION}'${suffix}`;
  });
  return result;
}

function rewriteSensitiveSegment(segment, { allowDynamic, shellOnly, placeholder }) {
  let result = rewriteSensitiveStarts(segment, SOURCE_PREPROCESSOR_DEFINE_START_PATTERN, { allowDynamic, shellOnly, placeholder });
  result = rewriteSensitiveStarts(result, SOURCE_COMPOUND_ASSIGNMENT_START_PATTERN, { allowDynamic, shellOnly, placeholder });
  result = rewriteSensitiveStarts(result, SOURCE_TYPED_DECLARATION_START_PATTERN, { allowDynamic, shellOnly, placeholder });
  result = rewriteSensitiveStarts(result, SOURCE_ASSIGNMENT_START_PATTERN, { allowDynamic, shellOnly, placeholder });
  if (!shellOnly) {
    result = rewriteSensitiveStarts(result, SOURCE_BRACE_INITIALIZER_START_PATTERN, {
      allowDynamic,
      shellOnly: false,
      placeholder,
      acceptMatch: (match) => !/^\s*(?:(?:export|public|private|protected|abstract|final|sealed|static|partial)\s+)*(?:class|struct|interface|enum|union|namespace|record)\b/.test(match[2])
    });
    result = rewriteSensitiveStarts(result, SOURCE_COMPUTED_PROPERTY_START_PATTERN, { allowDynamic, shellOnly: false, placeholder });
    result = rewriteSensitiveStarts(result, SOURCE_PROPERTY_START_PATTERN, { allowDynamic, shellOnly: false, placeholder });
    result = rewriteSensitiveCalls(result, { allowDynamic, placeholder });
    result = rewriteSensitiveValueDecorators(result);
    const rewriteTemplate = (pattern, quote) => {
      result = result.replace(pattern, (match, prefix, key, value) => {
        if (!keyLooksSensitive(key)) return match;
        return allowDynamic && sourceReference(value, false)
          ? placeholder(match)
          : `${prefix}${quote}${REDACTION}${quote}`;
      });
    };
    rewriteTemplate(SOURCE_TEMPLATE_DOUBLE_BINDING_PATTERN, "\"");
    rewriteTemplate(SOURCE_TEMPLATE_SINGLE_BINDING_PATTERN, "'");
  }
  return result;
}

export {
  balancedSourceExpression,
  hasStandaloneKeywordSourceLiteral,
  hasStandaloneNumericSourceLiteral,
  maskSourceLookupStrings,
  rewriteSensitiveSegment,
  rewriteSensitiveStarts,
  sourceReference
};

export function stringLiteralSentinel(value) {
  const raw = String(value ?? ""), normalized = raw.toLowerCase();
  if (raw.length === 0) return "__pi_empty_string_literal__";
  if (raw === "00") return "__pi_two_digit_zero_string_literal__";
  if (raw === "000") return "__pi_millisecond_padding_string_literal__";
  if (raw === "+") return "__pi_positive_sign_string_literal__";
  if (raw === "-") return "__pi_negative_sign_string_literal__";
  if (raw === "Z") return "__pi_utc_z_string_literal__";
  if (raw === '"') return "__pi_double_quote_string_literal__";
  if (/^\s+$/u.test(raw)) return "__pi_whitespace_string_literal__";
  if (["assert", "assert/strict", "node:assert", "node:assert/strict"].includes(raw)) return "__pi_node_assert_module_literal__";
  if (raw === "node:test") return "__pi_node_test_module_literal__";
  if (["node:vm", "vm"].includes(raw)) return "__pi_code_generation_module_literal__";
  if (["module", "node:module"].includes(raw)) return "__pi_module_loader_module_literal__";
  if (["bigint", "boolean", "function", "number", "object", "string", "symbol", "undefined"].includes(raw)) {
    return `__pi_typeof_${raw}_literal__`;
  }
  const calendar = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:t|$)/i);
  if (calendar) {
    const [year, month, day] = calendar.slice(1).map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const limit = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
    if (day < 1 || day > limit) return "__pi_invalid_calendar_date_string_literal__";
  }
  if (/^\d{1,4}[/.]\d{1,2}[/.]\d{1,4}(?:\s|t|$)/i.test(normalized)) return "__pi_invalid_date_string_literal__";
  if (/^(?:invalid(?:[- ]date)?|not[- ]a[- ]date)$/i.test(normalized)) return "__pi_unparseable_date_string_literal__";
  const errorName = raw.match(/^(TypeError|RangeError|SyntaxError|ReferenceError|URIError|EvalError|AggregateError|Error)$/)?.[1]?.toLowerCase();
  return errorName ? `__pi_error_name_${errorName}_literal__` : "__pi_string_literal__";
}

export function isJavaScriptLineTerminator(value) {
  return value === "\n" || value === "\r" || value === "\u2028" || value === "\u2029";
}

export function normalizedJavaScriptLineTerminator(value) {
  return value === "\u2028" || value === "\u2029" ? "\n" : value;
}

export function eraseJavaScriptLexeme(value) {
  return String(value ?? "").replace(/[^\r\n\u2028\u2029]/gu, " ").replace(/[\u2028\u2029]/gu, "\n");
}

const SIMPLE_STRING_ESCAPES = new Map([
  ["'", "'"], ['"', '"'], ["\\", "\\"], ["b", "\b"], ["f", "\f"], ["n", "\n"],
  ["r", "\r"], ["t", "\t"], ["v", "\v"]
]);
const HEX_DIGIT = /^[0-9A-Fa-f]$/;

/**
 * Consume one strict/module JavaScript string escape without evaluating it.
 * Invalid legacy-octal and malformed hex/Unicode escapes fail closed so they
 * can never be promoted to an executable string-literal evidence sentinel.
 */
export function consumeJavaScriptStringEscape(sourceValue, slashIndex) {
  const source = String(sourceValue ?? "");
  const escape = source[slashIndex + 1];
  const invalid = (nextIndex = Math.min(source.length, slashIndex + 2)) => ({
    valid: false, nextIndex, cooked: ""
  });
  const valid = (nextIndex, cooked) => ({
    valid: true, nextIndex, cooked
  });
  if (source[slashIndex] !== "\\" || escape === undefined) return invalid(slashIndex + 1);
  if (isJavaScriptLineTerminator(escape)) {
    const nextIndex = escape === "\r" && source[slashIndex + 2] === "\n" ? slashIndex + 3 : slashIndex + 2;
    return valid(nextIndex, "");
  }
  if (SIMPLE_STRING_ESCAPES.has(escape)) return valid(slashIndex + 2, SIMPLE_STRING_ESCAPES.get(escape));
  if (escape === "0") {
    return /[0-9]/.test(source[slashIndex + 2] ?? "") ? invalid() : valid(slashIndex + 2, "\0");
  }
  if (/[1-9]/.test(escape)) return invalid();
  if (escape === "x") {
    const digits = source.slice(slashIndex + 2, slashIndex + 4);
    return digits.length === 2 && [...digits].every((item) => HEX_DIGIT.test(item))
      ? valid(slashIndex + 4, String.fromCharCode(Number.parseInt(digits, 16))) : invalid();
  }
  if (escape === "u") {
    if (source[slashIndex + 2] === "{") {
      let closing = slashIndex + 3;
      while (HEX_DIGIT.test(source[closing] ?? "")) closing += 1;
      const digits = source.slice(slashIndex + 3, closing);
      if (!digits || source[closing] !== "}") return invalid();
      const codePoint = Number.parseInt(digits, 16);
      return codePoint <= 0x10ffff ? valid(closing + 1, String.fromCodePoint(codePoint)) : invalid(closing + 1);
    }
    const digits = source.slice(slashIndex + 2, slashIndex + 6);
    return digits.length === 4 && [...digits].every((item) => HEX_DIGIT.test(item))
      ? valid(slashIndex + 6, String.fromCharCode(Number.parseInt(digits, 16))) : invalid();
  }
  return valid(slashIndex + 2, escape);
}

export function validJavaScriptRegexLiteral(pattern, flags = "") {
  try {
    new RegExp(String(pattern ?? ""), String(flags ?? ""));
    return true;
  } catch {
    return false;
  }
}

export function regexLiteralSentinel(value, flags = "") {
  const exactPattern = String(value ?? "");
  const pattern = exactPattern.toLowerCase();
  const expiryCalendar = String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$`;
  const strictTimestamp = String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$`;
  const strictTimestampNoncapturingFraction = String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$`;
  const strictTimestampOptionalSecondsCapturingFraction = String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})$`;
  const strictTimestampOptionalSecondsDotFraction = String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$`;
  const isoCalendarCaptures = new Set([
    String.raw`^(\d{4})-(\d{2})-(\d{2})t`,
    String.raw`^(\d{4})-(\d{2})-(\d{2})(?:t|$)`,
    String.raw`^(\d{4})-(\d{2})-(\d{2})(?:t(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(z|[+-]\d{2}:?\d{2}))?$`
  ]);
  if (String(flags ?? "") !== "") return "__pi_regex_literal__";
  if (exactPattern === expiryCalendar) return "__pi_iso_expiry_calendar_regex_literal__";
  if (exactPattern === strictTimestamp) return "__pi_strict_iso_timestamp_regex_literal__";
  if (exactPattern === strictTimestampNoncapturingFraction) {
    return "__pi_strict_iso_timestamp_noncapturing_fraction_regex_literal__";
  }
  if (exactPattern === strictTimestampOptionalSecondsCapturingFraction) {
    return "__pi_strict_iso_timestamp_optional_seconds_capturing_fraction_regex_literal__";
  }
  if (exactPattern === strictTimestampOptionalSecondsDotFraction) {
    return "__pi_strict_iso_timestamp_optional_seconds_dot_fraction_regex_literal__";
  }
  return isoCalendarCaptures.has(pattern)
    ? "__pi_iso_calendar_capture_regex_literal__" : "__pi_regex_literal__";
}

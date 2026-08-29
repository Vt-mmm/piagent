export function stringLiteralSentinel(value) {
  const raw = String(value ?? ""), normalized = raw.trim().toLowerCase();
  if (raw.length === 0) return "__pi_empty_string_literal__";
  if (raw === "00") return "__pi_two_digit_zero_string_literal__";
  if (raw === "Z") return "__pi_utc_z_string_literal__";
  if (raw === '"') return "__pi_double_quote_string_literal__";
  if (/^(?:\s|\\[nrtvf0])+$/u.test(raw)) return "__pi_whitespace_string_literal__";
  if (["assert", "assert/strict", "node:assert", "node:assert/strict"].includes(normalized)) return "__pi_node_assert_module_literal__";
  if (normalized === "node:test") return "__pi_node_test_module_literal__";
  if (["node:vm", "vm"].includes(normalized)) return "__pi_code_generation_module_literal__";
  if (["module", "node:module"].includes(normalized)) return "__pi_module_loader_module_literal__";
  if (["bigint", "boolean", "function", "number", "object", "string", "symbol", "undefined"].includes(normalized)) {
    return `__pi_typeof_${normalized}_literal__`;
  }
  const calendar = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:t|$)/i);
  if (calendar) {
    const [year, month, day] = calendar.slice(1).map(Number), leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const limit = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
    if (day < 1 || day > limit) return "__pi_invalid_calendar_date_string_literal__";
  }
  if (/^\d{1,4}[/.]\d{1,2}[/.]\d{1,4}(?:\s|t|$)/i.test(normalized)) return "__pi_invalid_date_string_literal__";
  if (/^(?:invalid(?:[- ]date)?|not[- ]a[- ]date)$/i.test(normalized)) return "__pi_invalid_date_string_literal__";
  const errorName = normalized.match(/^(typeerror|rangeerror|syntaxerror|referenceerror|urierror|evalerror|aggregateerror|error)$/)?.[1];
  return errorName ? `__pi_error_name_${errorName}_literal__` : "__pi_string_literal__";
}

export function regexLiteralSentinel(value, flags = "") {
  const exactPattern = String(value ?? "");
  const pattern = exactPattern.toLowerCase();
  const expiryCalendar = String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$`;
  const strictTimestamp = String.raw`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$`;
  const isoCalendarCaptures = new Set([
    String.raw`^(\d{4})-(\d{2})-(\d{2})t`,
    String.raw`^(\d{4})-(\d{2})-(\d{2})(?:t|$)`,
    String.raw`^(\d{4})-(\d{2})-(\d{2})(?:t(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(z|[+-]\d{2}:?\d{2}))?$`
  ]);
  if (String(flags ?? "") !== "") return "__pi_regex_literal__";
  if (exactPattern === expiryCalendar) return "__pi_iso_expiry_calendar_regex_literal__";
  if (exactPattern === strictTimestamp) return "__pi_strict_iso_timestamp_regex_literal__";
  return isoCalendarCaptures.has(pattern)
    ? "__pi_iso_calendar_capture_regex_literal__" : "__pi_regex_literal__";
}

import {
  REDACTION,
  keyLooksSensitive,
  redactSensitiveTextInternal
} from "./sensitive-text.js";
import {
  balancedSourceExpression,
  hasStandaloneKeywordSourceLiteral,
  hasStandaloneNumericSourceLiteral,
  maskSourceLookupStrings,
  rewriteSensitiveSegment,
  rewriteSensitiveStarts,
  sourceReference
} from "./sensitive-source-expression.js";

function nextSourceComment(source, cursor, { hashComments }) {
  let quote = "", escaped = false;
  for (let index = cursor; index < source.length; index += 1) {
    const character = source[index], next = source[index + 1] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "/" && next === "*") return { index, kind: "block" };
    if (character === "/" && next === "/") return { index, kind: "line" };
    if (((hashComments && character === "#") || (character === "-" && next === "-"))
      && (index === cursor || /\s/.test(source[index - 1] ?? ""))) return { index, kind: "line" };
  }
  return undefined;
}

function shieldExecutableSourceReferences(input, { shellOnly = false, hashComments = true } = {}) {
  const references = [];
  let nonce = 0;
  let markerPrefix;
  do {
    markerPrefix = `__PIAGENT_DSR_${nonce}_`;
    nonce += 1;
  } while (String(input ?? "").includes(markerPrefix));
  const placeholder = (value) => {
    const id = `${markerPrefix}${references.length}__`;
    references.push({ id, value });
    return id;
  };
  const rewriteCode = (segment) => rewriteSensitiveSegment(segment, {
    allowDynamic: true, shellOnly, placeholder
  });
  const rewriteComment = (segment) => rewriteSensitiveSegment(segment, {
    allowDynamic: false, shellOnly, placeholder
  });
  const source = String(input ?? "");
  let result = "", cursor = 0, blockComment = false;
  while (cursor < source.length) {
    if (blockComment) {
      const end = source.indexOf("*/", cursor);
      if (end < 0) {
        result += rewriteComment(source.slice(cursor));
        cursor = source.length;
      } else {
        const body = rewriteComment(source.slice(cursor, end));
        result += `${body}*/`;
        cursor = end + 2;
        blockComment = false;
      }
      continue;
    }
    const comment = nextSourceComment(source, cursor, { hashComments });
    if (!comment) {
      result += rewriteCode(source.slice(cursor));
      cursor = source.length;
      continue;
    }
    result += rewriteCode(source.slice(cursor, comment.index));
    if (comment.kind === "line") {
      const lineEnd = source.indexOf("\n", comment.index);
      const end = lineEnd < 0 ? source.length : lineEnd;
      result += rewriteComment(source.slice(comment.index, end));
      if (lineEnd >= 0) result += "\n";
      cursor = lineEnd < 0 ? source.length : lineEnd + 1;
    } else {
      result += "/*";
      cursor = comment.index + 2;
      blockComment = true;
    }
  }
  return {
    text: result,
    restore(value) {
      let restored = value;
      for (const reference of references) restored = restored.replaceAll(reference.id, reference.value);
      return restored;
    }
  };
}

const SENSITIVE_SOURCE_QUOTED_HEREDOC_PATTERN = /(^[ \t]*(?:(?:const|let|var)\s+)?([$@%]?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|<-|:=)\s*)<<[-~]?(["'])([A-Za-z_][A-Za-z0-9_]*)\3[^\r\n]*(?:\r\n|\n|\r)([\s\S]*?)(^[ \t]*\4[ \t]*$)/gm;
const SENSITIVE_SOURCE_BARE_HEREDOC_PATTERN = /(^[ \t]*(?:(?:const|let|var)\s+)?([$@%]?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=|<-|:=)\s*)<<[-~]?([A-Za-z_][A-Za-z0-9_]*)[^\r\n]*(?:\r\n|\n|\r)([\s\S]*?)(^[ \t]*\3[ \t]*$)/gm;

function redactSensitiveSourceHeredocs(input) {
  const redactMatch = (match, prefix, key) => {
    if (!keyLooksSensitive(key)) return match;
    const secretPayload = match.slice(prefix.length);
    const lineEndings = secretPayload.match(/\r\n|\n|\r/g) ?? [];
    return `${prefix}${REDACTION}${lineEndings.join("")}`;
  };
  const quoted = input.replace(SENSITIVE_SOURCE_QUOTED_HEREDOC_PATTERN, redactMatch);
  return quoted.replace(SENSITIVE_SOURCE_BARE_HEREDOC_PATTERN, redactMatch);
}

function redactSourceText(input, options) {
  if (typeof input !== "string") return { text: "", redacted: false };
  const heredocRedacted = options?.shellOnly ? input : redactSensitiveSourceHeredocs(input);
  const shielded = shieldExecutableSourceReferences(heredocRedacted, options);
  const redacted = redactSensitiveTextInternal(shielded.text);
  const text = shielded.restore(redacted.text);
  return { text, redacted: text !== input };
}

function restorableMarkers(input, domain) {
  const references = [];
  let nonce = 0;
  let prefix;
  do {
    prefix = `__PIAGENT_${domain}_${nonce}_`;
    nonce += 1;
  } while (input.includes(prefix));
  return {
    protect(value) {
      const id = `${prefix}${references.length}__`;
      references.push({ id, value });
      return id;
    },
    restore(value) {
      let restored = value;
      for (const reference of references) restored = restored.replaceAll(reference.id, reference.value);
      return restored;
    }
  };
}

function unquotedConfigurationValue(value) {
  const clean = String(value ?? "").trim();
  if (clean.length >= 2 && ((clean.startsWith("\"") && clean.endsWith("\""))
    || (clean.startsWith("'") && clean.endsWith("'")))) return clean.slice(1, -1).trim();
  return clean;
}

function pureConfigurationReference(value, { allowBareIdentifier = false } = {}) {
  const clean = unquotedConfigurationValue(value);
  if (!clean) return false;
  if (/^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|\*[A-Za-z_][A-Za-z0-9_.-]*|!Ref\s+[A-Za-z_][A-Za-z0-9_.:-]*)$/.test(clean)) return true;
  const template = /^(?:\$?\{\{)([\s\S]+)\}\}$/.exec(clean);
  if (template) return sourceReference(template[1], false);
  if (/^(?:var|env|attr)\(\s*(?:--)?[A-Za-z_$][A-Za-z0-9_$.-]*\s*\)$/i.test(clean)) return true;
  if (!sourceReference(clean, false)) return false;
  return allowBareIdentifier || /(?:\.|->|::|\?\.|\(|\[)/.test(clean)
    || /^(?:await\s+|this\b|self\b|super\b|[$@%])/.test(clean)
    || /_(?:REF|VAR|ENV)$/.test(clean);
}

function yamlValueParts(value) {
  let quote = "", escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return { value: value.slice(0, index).trimEnd(), comment: value.slice(index) };
    }
  }
  return { value: value.trimEnd(), comment: "" };
}

function redactSensitiveYamlText(input) {
  const markers = restorableMarkers(input, "YAML_REF");
  const parts = input.split(/(\r\n|\n|\r)/);
  let blockIndent = -1;
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const indentation = (line.match(/^[ \t]*/) ?? [""])[0].replaceAll("\t", "  ").length;
    if (blockIndent >= 0) {
      if (!line.trim() || indentation > blockIndent) {
        parts[index] = line.trim() ? (line.match(/^[ \t]*/) ?? [""])[0] : line;
        continue;
      }
      blockIndent = -1;
    }
    const match = /^([ \t]*(?:-[ \t]+)?((?:"(?:\\.|[^"])*"|'(?:''|[^'])*'|[A-Za-z_$][A-Za-z0-9_$.-]*))[ \t]*:[ \t]*)(.*)$/.exec(line);
    if (!match || !keyLooksSensitive(match[2])) continue;
    const rhs = yamlValueParts(match[3]);
    if (rhs.value && pureConfigurationReference(rhs.value)) {
      const comment = rhs.comment ? ` ${redactSensitiveTextInternal(rhs.comment.trimStart()).text}` : "";
      parts[index] = `${markers.protect(`${match[1]}${rhs.value}`)}${comment}`;
      continue;
    }
    parts[index] = `${match[1]}${REDACTION}${rhs.comment ? ` ${rhs.comment.trimStart()}` : ""}`;
    if (!rhs.value || /^[>|][+-]?(?:\d+)?$/.test(rhs.value.trim())) blockIndent = indentation;
  }
  const structured = parts.join("");
  const generic = redactSensitiveTextInternal(structured);
  const text = markers.restore(generic.text);
  return { text, redacted: text !== input };
}

function markupLookupKey(attributes) {
  const match = /\b(?:key|name)\s*=\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s>]+))/i.exec(attributes);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
}

function redactMarkupAttributes(tag, markers) {
  if (/^<\s*\//.test(tag)) return tag;
  const lookupKey = markupLookupKey(tag);
  return tag.replace(/(\s)([A-Za-z_:][A-Za-z0-9_.:-]*)(\s*=\s*)(?:(["'])((?:\\.|(?!\4)[\s\S])*?)\4|([^\s>]+))/g,
    (match, spacing, key, separator, quote, quotedValue, bareValue) => {
      const value = quotedValue ?? bareValue ?? "";
      const sensitive = keyLooksSensitive(key)
        || (keyLooksSensitive(lookupKey) && ["value", "content"].includes(key.toLowerCase()));
      if (!sensitive) return match;
      const expressionBinding = key.startsWith(":") || key.toLowerCase().startsWith("v-bind:");
      if (pureConfigurationReference(value, { allowBareIdentifier: expressionBinding })) {
        return `${spacing}${markers.protect(match.slice(spacing.length))}`;
      }
      return `${spacing}${key}${separator}${quote ? `${quote}${REDACTION}${quote}` : REDACTION}`;
    });
}

function markupTags(input) {
  const tags = [];
  for (let start = input.indexOf("<"); start >= 0; start = input.indexOf("<", start + 1)) {
    let quote = "", escaped = false, end = start + 1;
    for (; end < input.length; end += 1) {
      const character = input[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = "";
      } else if (character === "\"" || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end >= input.length) break;
    const text = input.slice(start, end + 1);
    const parsed = /^<\s*(\/)?\s*([A-Za-z_][A-Za-z0-9_.:-]*)\b([\s\S]*?)>$/.exec(text);
    if (parsed) tags.push({ start, end: end + 1, text, closing: Boolean(parsed[1]), name: parsed[2], attributes: parsed[3] });
    start = end;
  }
  return tags;
}

function rewriteMarkupTags(input, rewriter) {
  let result = "", cursor = 0;
  for (const tag of markupTags(input)) {
    result += `${input.slice(cursor, tag.start)}${rewriter(tag.text)}`;
    cursor = tag.end;
  }
  return `${result}${input.slice(cursor)}`;
}

function redactMarkupPairs(input, markers) {
  const stack = [];
  const replacements = [];
  for (const tag of markupTags(input)) {
    const tagName = tag.name.toLowerCase();
    if (!tag.closing && !/\/\s*>$/.test(tag.text)) {
      stack.push({
        tagName,
        contentStart: tag.end,
        sensitive: keyLooksSensitive(tagName.split(":").at(-1) ?? tagName)
          || keyLooksSensitive(markupLookupKey(tag.attributes))
      });
      continue;
    }
    if (!tag.closing) continue;
    let openIndex = stack.length - 1;
    while (openIndex >= 0 && stack[openIndex].tagName !== tagName) openIndex -= 1;
    if (openIndex < 0) continue;
    const open = stack[openIndex];
    stack.length = openIndex;
    if (!open.sensitive) continue;
    const content = input.slice(open.contentStart, tag.start);
    replacements.push({
      start: open.contentStart,
      end: tag.start,
      value: pureConfigurationReference(content)
        ? markers.protect(content)
        : `${REDACTION}${(content.match(/\r\n|\n|\r/g) ?? []).join("")}`
    });
  }

  // An outer sensitive element supersedes any replacement wholly inside it.
  const selected = replacements.filter((candidate) => !replacements.some((other) => other !== candidate
    && other.start <= candidate.start && other.end >= candidate.end));
  let result = input;
  for (const replacement of selected.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, replacement.start)}${replacement.value}${result.slice(replacement.end)}`;
  }
  return result;
}

function redactSensitiveMarkupText(input) {
  const markers = restorableMarkers(input, "MARKUP_REF");
  const paired = redactMarkupPairs(input, markers);
  const structured = rewriteMarkupTags(paired, (tag) => redactMarkupAttributes(tag, markers));
  const generic = redactSensitiveTextInternal(structured);
  const text = markers.restore(generic.text);
  return { text, redacted: text !== input };
}

function redactSensitiveCssText(input) {
  const markers = restorableMarkers(input, "CSS_REF");
  const structured = input.replace(/(^|[;{}\r\n])([ \t]*(--)?([A-Za-z_$][A-Za-z0-9_$-]*)[ \t]*:[ \t\r\n]*)([^;}]*)(?=;|}|$)/g,
    (match, boundary, prefix, _custom, key, value) => {
      if (!keyLooksSensitive(key)) return match;
      if (pureConfigurationReference(value)) return `${boundary}${markers.protect(`${prefix}${value}`)}`;
      return `${boundary}${prefix}${REDACTION}${(value.match(/\r\n|\n|\r/g) ?? []).join("")}`;
    });
  const generic = redactSensitiveTextInternal(structured);
  const text = markers.restore(generic.text);
  return { text, redacted: text !== input };
}

const SOURCE_OBJECTIVE_C_TYPED_ASSIGNMENT_START_PATTERN = /(^|[\r\n;{])([ \t]*(?:(?:const|static|extern|volatile|__strong|__weak|nullable|nonnull|unsigned|signed|long|short)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>\r\n;=]+>)?\s+)*[A-Za-z_$][A-Za-z0-9_$]*(?:\s*<[^>\r\n;=]+>)?\s*\*+\s*(#?[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*)/g;
const SOURCE_OBJECTIVE_C_DICTIONARY_START_PATTERN = /(^|[\s{[(;,])((?:@")([A-Za-z_$][A-Za-z0-9_$.-]*)(?:"\s*:\s*))/g;

function objectiveCReference(value) {
  if (sourceReference(value, false)) return true;
  const clean = String(value ?? "").trim();
  const masked = maskSourceLookupStrings(clean);
  return Boolean(masked && /^\[[A-Za-z_$]/.test(masked)
    && /^[A-Za-z0-9_$@%?.()[\]{},!:\s|&+*/<>=-]+$/.test(masked)
    && balancedSourceExpression(masked)
    && !hasStandaloneNumericSourceLiteral(masked)
    && !hasStandaloneKeywordSourceLiteral(masked));
}

function redactSensitiveObjectiveCText(input) {
  let source = rewriteSensitiveStarts(input, SOURCE_OBJECTIVE_C_TYPED_ASSIGNMENT_START_PATTERN, {
    allowDynamic: true,
    shellOnly: false,
    placeholder: (value) => value,
    reference: objectiveCReference
  });
  source = rewriteSensitiveStarts(source, SOURCE_OBJECTIVE_C_DICTIONARY_START_PATTERN, {
    allowDynamic: true,
    shellOnly: false,
    placeholder: (value) => value,
    reference: objectiveCReference
  });
  source = source.replace(/(^|[^A-Za-z0-9_$])((#?[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*)@"((?:\\.|[^"\\\r\n])*)"/g,
    (match, boundary, prefix, key) => keyLooksSensitive(key)
      ? `${boundary}${prefix}@"${REDACTION}"`
      : match);
  source = source.replace(/(^|[^A-Za-z0-9_$])((#?[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*)(@?(?:0[xX][0-9A-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|YES|NO|nil|NULL))(?=[\s;,)])/g,
    (match, boundary, prefix, key) => keyLooksSensitive(key)
      ? `${boundary}${prefix}${REDACTION}`
      : match);
  source = source.replace(/(@"((?:\\.|[^"\\\r\n])*)"\s*:\s*)@"((?:\\.|[^"\\\r\n])*)"/g,
    (match, prefix, key) => keyLooksSensitive(key)
      ? `${prefix}@"${REDACTION}"`
      : match);
  source = source.replace(/(@"((?:\\.|[^"\\\r\n])*)"\s*:\s*)(@?(?:0[xX][0-9A-Fa-f]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|YES|NO|nil|NULL))(?=[\s,}])/g,
    (match, prefix, key) => keyLooksSensitive(key)
      ? `${prefix}${REDACTION}`
      : match);
  const result = redactSourceText(source, { shellOnly: false, hashComments: false });
  return { text: result.text, redacted: result.text !== input };
}

export function redactSensitiveSourceText(input) {
  return redactSourceText(input, { shellOnly: false, hashComments: true });
}

export function redactSensitiveShellSourceText(input) {
  return redactSourceText(input, { shellOnly: true });
}


export {
  redactSensitiveCssText,
  redactSensitiveMarkupText,
  redactSensitiveObjectiveCText,
  redactSensitiveYamlText,
  redactSourceText
};

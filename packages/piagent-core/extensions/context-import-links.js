import { regexCanStartAfterLexicalChunks } from "./javascript-regex-evidence.js";

function erasedLexeme(value) {
  return String(value ?? "").replace(/[^\r\n]/g, " ");
}

const BOUND_IMPORT_PREFIX = "\u0001pi_import_string_";
const BOUND_IMPORT_SUFFIX = "\u0002";

function boundImportString(index) {
  return `${BOUND_IMPORT_PREFIX}${index}${BOUND_IMPORT_SUFFIX}`;
}

function lexicalJavaScriptImportView(value) {
  const source = String(value ?? "");
  const output = [];
  const strings = [];
  let index = 0;
  let scanCode;

  const scanTemplate = () => {
    const start = index;
    const outputStart = output.length;
    const stringsStart = strings.length;
    output.push("__pi_template_literal__");
    index += 1;
    let rawStart = index;
    while (index < source.length) {
      if (source[index] === "\\") {
        index = Math.min(source.length, index + 2);
        continue;
      }
      if (source[index] === "`") {
        output.push(erasedLexeme(source.slice(rawStart, index + 1)));
        index += 1;
        return true;
      }
      if (source[index] === "$" && source[index + 1] === "{") {
        output.push(erasedLexeme(source.slice(rawStart, index + 2)));
        output.push("(");
        index += 2;
        if (!scanCode(true) || source[index] !== "}") break;
        output.push(")");
        index += 1;
        rawStart = index;
        continue;
      }
      index += 1;
    }
    output.splice(outputStart);
    strings.splice(stringsStart);
    output.push(erasedLexeme(source.slice(start, index)));
    return false;
  };

  scanCode = (stopAtTemplateExpression = false) => {
    let braceDepth = 0;
    while (index < source.length) {
      const current = source[index], next = source[index + 1];
      if (stopAtTemplateExpression && current === "}" && braceDepth === 0) return true;
      if (current === "/" && next === "/") {
        let end = index + 2;
        while (end < source.length && !"\r\n".includes(source[end])) end += 1;
        output.push(erasedLexeme(source.slice(index, end)));
        index = end;
        continue;
      }
      if (current === "/" && next === "*") {
        const closing = source.indexOf("*/", index + 2);
        const end = closing === -1 ? source.length : closing + 2;
        output.push(erasedLexeme(source.slice(index, end)));
        index = end;
        continue;
      }
      if (current === "'" || current === '"') {
        const quote = current;
        let end = index + 1, payload = "", closed = false;
        while (end < source.length) {
          const character = source[end];
          if (character === "\\") {
            payload += source.slice(end, Math.min(source.length, end + 2));
            end += 2;
            continue;
          }
          if (character === quote) {
            end += 1;
            closed = true;
            break;
          }
          if (character === "\r" || character === "\n") break;
          payload += character;
          end += 1;
        }
        if (!closed) output.push(erasedLexeme(source.slice(index, end)));
        else {
          output.push(boundImportString(strings.length));
          strings.push(payload);
        }
        index = end;
        continue;
      }
      if (current === "`") {
        const closed = scanTemplate();
        if (!closed && stopAtTemplateExpression) return false;
        continue;
      }
      if (current === "/" && next !== "=" && regexCanStartAfterLexicalChunks(output)) {
        let end = index + 1, inClass = false, closed = false;
        while (end < source.length) {
          const character = source[end];
          if (character === "\\") {
            end += 2;
            continue;
          }
          if (character === "[") inClass = true;
          else if (character === "]") inClass = false;
          else if (character === "/" && !inClass) {
            end += 1;
            while (/[a-z]/iu.test(source[end] ?? "")) end += 1;
            closed = true;
            break;
          } else if (character === "\r" || character === "\n") break;
          end += 1;
        }
        if (closed) {
          output.push(erasedLexeme(source.slice(index, end)));
          index = end;
          continue;
        }
      }
      if (current === "{") braceDepth += 1;
      else if (current === "}" && braceDepth > 0) braceDepth -= 1;
      output.push(current);
      index += 1;
    }
    return !stopAtTemplateExpression;
  };

  scanCode(false);
  return { code: output.join(""), strings };
}

const BOUND_IMPORT_STRING = `${BOUND_IMPORT_PREFIX}(\\d+)${BOUND_IMPORT_SUFFIX}`;
const JAVASCRIPT_IMPORT_PATTERNS = [
  new RegExp(String.raw`(?<![.$\w])(?:import|export)\s+(?:type\s+)?[\w$*{},\s]+?\s+from\s+(${BOUND_IMPORT_STRING})`, "gu"),
  new RegExp(String.raw`(?<![.$\w])import\s+(${BOUND_IMPORT_STRING})`, "gu"),
  new RegExp(String.raw`(?<![.$\w])require\s*\(\s*(${BOUND_IMPORT_STRING})\s*\)`, "gu"),
  new RegExp(String.raw`(?<![.$\w])import\s*\(\s*(${BOUND_IMPORT_STRING})\s*\)`, "gu")
];

function tagEnd(code, start) {
  let braces = 0;
  for (let index = start + 1; index < code.length; index += 1) {
    if (code[index] === "{") braces += 1;
    else if (code[index] === "}") braces = Math.max(0, braces - 1);
    else if (code[index] === ">" && braces === 0) return index + 1;
  }
  return -1;
}

function jsxTagAt(code, start) {
  if (code[start] !== "<") return undefined;
  const end = tagEnd(code, start);
  if (end === -1) return undefined;
  const raw = code.slice(start, end);
  if (/^<\s*>$/u.test(raw)) return code.slice(end).includes("</>") ? { kind: "open", name: "", end } : undefined;
  if (/^<\/\s*>$/u.test(raw)) return { kind: "close", name: "", end };
  const closing = raw.match(/^<\/\s*([A-Za-z][\w.$:-]*)\s*>$/u);
  if (closing) return { kind: "close", name: closing[1], end };
  const opening = raw.match(/^<\s*([A-Za-z][\w.$:-]*)(?:\s|\/?>)/u);
  if (!opening) return undefined;
  if (/\/\s*>$/u.test(raw)) return { kind: "self", name: opening[1], end };
  const escaped = opening[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<\\/\\s*${escaped}\\s*>`, "u").test(code.slice(end))
    ? { kind: "open", name: opening[1], end }
    : undefined;
}

function jsxTextOffsets(code, offsets) {
  const orderedOffsets = [...new Set(offsets)].sort((left, right) => left - right);
  const textOffsets = new Set();
  const stack = [];
  let braces = 0, index = 0;
  for (const offset of orderedOffsets) {
    while (index < offset) {
      if (code[index] === "<") {
        const tag = jsxTagAt(code, index);
        if (tag && tag.end <= offset) {
          if (tag.kind === "open") stack.push({ name: tag.name, braces });
          else if (tag.kind === "close" && stack.at(-1)?.name === tag.name) stack.pop();
          index = tag.end;
          continue;
        }
      }
      if (code[index] === "{") braces += 1;
      else if (code[index] === "}") braces = Math.max(0, braces - 1);
      index += 1;
    }
    if (stack.length > 0 && braces === stack.at(-1).braces) textOffsets.add(offset);
  }
  return textOffsets;
}

function shadowsCommonJsRequire(code) {
  return /\b(?:class|function|let|const|var)\s+require\b/u.test(code)
    || /(?<![.$\w])import\s+(?:type\s+)?(?:require\b|\*\s+as\s+require\b|(?:[\w$]+\s*,\s*)?\{[^}\n]*\brequire\b[^}\n]*\})/u.test(code)
    || /\b(?:function\s*[\w$]*|catch)\s*\([^)]*\brequire\b[^)]*\)/u.test(code)
    || /(?:\([^)]*\brequire\b[^)]*\)|(?<![.$\w])require)\s*=>/u.test(code)
    || /\b(?:let|const|var)\s*\{[^}\n]*\brequire\b[^}\n]*\}/u.test(code)
    || /(?<![.$\w])require\s*(?:=(?!=)|\|\|=|&&=|\?\?=|\*\*=|[+*/%&|^-]=)/u.test(code);
}

function executableJavaScriptImports(source, lineOffset = 0, { jsx = false } = {}) {
  const { code, strings } = lexicalJavaScriptImportView(source);
  const imports = [];
  const requireShadowed = shadowsCommonJsRequire(code);
  const candidates = [];
  for (const [patternIndex, pattern] of JAVASCRIPT_IMPORT_PATTERNS.entries()) {
    if (patternIndex === 2 && requireShadowed) continue;
    for (const match of code.matchAll(pattern)) {
      candidates.push(match);
    }
  }
  const jsxText = jsx ? jsxTextOffsets(code, candidates.map((match) => match.index)) : new Set();
  const pending = [];
  for (const match of candidates) {
    if (jsxText.has(match.index)) continue;
    const stringIndex = Number(match.at(-1));
    const specifier = strings[stringIndex];
    if (typeof specifier !== "string" || !specifier || specifier.length > 300) continue;
    const sentinelOffset = match.index + match[0].lastIndexOf(boundImportString(stringIndex));
    pending.push({ specifier, offset: sentinelOffset });
  }
  const newlines = [];
  for (let offset = code.indexOf("\n"); offset !== -1; offset = code.indexOf("\n", offset + 1)) newlines.push(offset);
  const lineAt = (offset) => {
    let low = 0, high = newlines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (newlines[middle] < offset) low = middle + 1;
      else high = middle;
    }
    return lineOffset + low + 1;
  };
  for (const candidate of pending) {
    imports.push({ ...candidate, line: lineAt(candidate.offset) });
  }
  return imports;
}

/**
 * Extract executable JS/TS module edges without treating comments, examples,
 * string documentation, templates, or regular expressions as live imports.
 */
export function extractJavaScriptModuleImports(value, { embedded = false, jsx = false } = {}) {
  const source = String(value ?? "");
  const imports = [];
  if (!embedded) imports.push(...executableJavaScriptImports(source, 0, { jsx }));
  else {
    const visible = source.replace(/<!--[\s\S]*?-->/gu, (comment) => erasedLexeme(comment));
    // HTML end tags may carry whitespace, a self-closing slash, or ignored
    // attributes. Stop at the first complete `script` end tag instead of
    // letting its body absorb later template markup or another script block.
    const script = /^[\t ]*<script(?:>|[\t\n\f\r /][^>]*>)([\s\S]*?)<\/script(?:>|[\t\n\f\r /][^>]*>)/gimu;
    for (const match of visible.matchAll(script)) {
      const content = match[1];
      const contentOffset = match.index + match[0].indexOf(content);
      const lineOffset = visible.slice(0, contentOffset).split(/\r?\n/).length - 1;
      imports.push(...executableJavaScriptImports(content, lineOffset));
    }
  }
  return imports
    .sort((left, right) => left.line - right.line || left.offset - right.offset)
    .slice(0, 300)
    .map(({ specifier, line }) => ({ specifier, line }));
}

export function directExplicitImportLinks(importRows, explicitRows) {
  const explicitPaths = new Set(explicitRows.map((row) => row.path));
  const byPath = new Map();
  const rankingRows = [];
  const add = (candidatePath, kind, explicitPath) => {
    const links = byPath.get(candidatePath) ?? [];
    if (!links.some((link) => link.kind === kind && link.path === explicitPath)) {
      links.push({ kind, path: explicitPath });
      rankingRows.push({ path: candidatePath });
    }
    byPath.set(candidatePath, links);
  };
  for (const row of importRows) {
    if (typeof row.specifier !== "string" || !/^\.{1,2}\//.test(row.specifier)) continue;
    if (explicitPaths.has(row.file_path)) add(row.target_path, "explicit-imports-candidate", row.file_path);
    if (explicitPaths.has(row.target_path)) add(row.file_path, "candidate-imports-explicit", row.target_path);
  }
  return { byPath, rankingRows };
}

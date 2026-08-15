export type DiffSyntaxKind = "plain" | "keyword" | "string" | "number" | "comment" | "literal" | "property";
export type DiffSyntaxToken = { kind: DiffSyntaxKind; text: string };

const KEYWORDS = new Set(["as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "delete", "do",
  "else", "enum", "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "in", "interface",
  "let", "new", "of", "package", "private", "protected", "public", "return", "static", "struct", "switch", "throw", "try", "type",
  "var", "while", "with", "yield"]);
const LITERALS = new Set(["false", "nil", "null", "None", "true", "undefined"]);
const HASH_COMMENT_EXTENSIONS = new Set(["py", "rb", "sh", "bash", "zsh", "yaml", "yml", "toml"]);

function extension(path: string): string {
  const name = path.split("/").pop() ?? path;
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

function identifierStart(value: string): boolean { return /[A-Za-z_$]/.test(value); }
function identifierPart(value: string): boolean { return /[A-Za-z0-9_$-]/.test(value); }
function digit(value: string): boolean { return value >= "0" && value <= "9"; }

function push(tokens: DiffSyntaxToken[], kind: DiffSyntaxKind, text: string): void {
  if (!text) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.kind === kind) previous.text += text;
  else tokens.push({ kind, text });
}

export function tokenizeDiffLine(text: string, path: string): DiffSyntaxToken[] {
  const tokens: DiffSyntaxToken[] = [], ext = extension(path);
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("//", index) || text.startsWith("/*", index) || (text[index] === "#" && HASH_COMMENT_EXTENSIONS.has(ext))) {
      push(tokens, "comment", text.slice(index)); break;
    }
    const value = text[index] ?? "";
    if (value === "\"" || value === "'" || value === "`") {
      const quote = value; let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") { end += 2; continue; }
        if (text[end] === quote) { end += 1; break; }
        end += 1;
      }
      const stringValue = text.slice(index, end);
      const next = text.slice(end).match(/^\s*:/);
      push(tokens, next && quote === "\"" ? "property" : "string", stringValue); index = end; continue;
    }
    if (digit(value) || (value === "." && digit(text[index + 1] ?? ""))) {
      let end = index + 1;
      while (end < text.length && /[0-9A-Fa-f_xXob.+-]/.test(text[end] ?? "")) end += 1;
      push(tokens, "number", text.slice(index, end)); index = end; continue;
    }
    if (identifierStart(value)) {
      let end = index + 1;
      while (end < text.length && identifierPart(text[end] ?? "")) end += 1;
      const word = text.slice(index, end);
      push(tokens, KEYWORDS.has(word) ? "keyword" : LITERALS.has(word) ? "literal" : "plain", word); index = end; continue;
    }
    push(tokens, "plain", value); index += 1;
  }
  return tokens;
}

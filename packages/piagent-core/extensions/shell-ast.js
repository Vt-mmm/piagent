// The simple commands a shell line runs, read from a real shell syntax tree.
//
// policy-core.js splits a line into segments with its own scanner; this reads
// the same line through a POSIX/Bash parser and walks every place a command
// can sit: pipelines, && and ||, if/while/for/case bodies, functions, ( … ),
// { … }, $( … ), backticks and <( … ). `bash -c '…'`, `sh -c` and `eval` are
// parsed again, so the text they run is read as commands too. A check that
// reads both lists sees a command whichever reader finds it.
//
// Words come back as text. A word built from an expansion the shell decides
// at run time ($VAR, $(…), `…`) keeps it as written and is flagged dynamic;
// nothing is evaluated here. A line the parser rejects gives null: callers
// keep the scanner's answer, which is never weakened by this module.
import { parse } from "@aliou/sh";

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh"]);
const MAX_DEPTH = 8;

function wordText(word) {
  let text = "", dynamic = false;
  const visit = (parts) => {
    for (const part of parts ?? []) {
      if (part.type === "Literal" || part.type === "SglQuoted") text += part.value;
      else if (part.type === "DblQuoted") visit(part.parts);
      else if (part.type === "ParamExp") { text += `$${part.param?.value ?? ""}`; dynamic = true; }
      else { text += "$(…)"; dynamic = true; }
    }
  };
  visit(word?.parts);
  return { text, dynamic };
}

// The $( … ) and ` … ` an unquoted heredoc body runs: the parser keeps the
// body as text, and the shell expands it.
function substitutions(text) {
  const found = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close < 0) break;
      found.push(text.slice(index + 1, close)); index = close;
    } else if (text.startsWith("$(", index) && text[index + 2] !== "(") {
      let depth = 0, close = -1;
      for (let at = index + 1; at < text.length; at += 1) {
        if (text[at] === "(") depth += 1;
        else if (text[at] === ")" && --depth === 0) { close = at; break; }
      }
      if (close < 0) break;
      found.push(text.slice(index + 2, close)); index = close;
    }
  }
  return found;
}

function collect(node, found, depth) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const item of node) collect(item, found, depth); return; }
  if (node.type === "Redirect" && node.heredoc && node.target?.parts?.every((part) => part.type === "Literal") && depth < MAX_DEPTH) {
    for (const source of substitutions(wordText(node.heredoc).text)) collectSource(source, found, depth + 1);
  }
  if (node.type === "SimpleCommand" && node.words?.length) {
    const words = node.words.map(wordText);
    found.push({ words: words.map((word) => word.text), dynamic: words.some((word) => word.dynamic) });
    const name = String(words[0]?.text ?? "").split("/").pop();
    const inline = SHELLS.has(name) ? words.findIndex((word, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(word.text)) + 1 : name === "eval" ? 1 : 0;
    if (inline > 0 && depth < MAX_DEPTH) {
      const source = name === "eval" ? words.slice(1).map((word) => word.text).join(" ") : words[inline]?.text;
      if (source) collectSource(source, found, depth + 1);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== "pos" && key !== "end" && value && typeof value === "object") collect(value, found, depth);
  }
}

function collectSource(source, found, depth) {
  try { collect(parse(String(source), { dialect: "bash" }).ast, found, depth); } catch { /* the scanner still reads it */ }
}

// [{ words, dynamic }] for every simple command, or null when the line does not parse.
export function astCommands(command) {
  const found = [];
  try { collect(parse(String(command), { dialect: "bash" }).ast, found, 0); } catch { return null; }
  return found;
}

import fs from "node:fs";
import path from "node:path";

import { externalExecutableIndex } from "./guard-shell-analysis.ts";
import { shellHasFileWriteRedirection } from "./shell-write-targets.js";

// Inline interpreters are treated as ordinary mutation-capable executables
// unless this module can prove both read-only authority and bounded termination.
const READ_ONLY_INLINE_INTERPRETERS = new Set(["node", "nodejs", "python", "python3"]);
const MAX_INLINE_INSPECTION_FILE_BYTES = 8 * 1024 * 1024;

function simpleQuotedLiteral(value: string): string | undefined {
  const match = value.trim().match(/^(['"])([^'"\\\r\n]+)\1$/);
  return match?.[2];
}

function projectLocalInspectionPath(cwd: string, value: string): string | undefined {
  const target = path.resolve(cwd, value);
  const relative = path.relative(cwd, target);
  if (relative === "" || relative === ".") return target;
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  return target;
}

function isBoundedInspectionFile(cwd: string, value: string): boolean {
  const target = projectLocalInspectionPath(cwd, value);
  if (!target) return false;
  try {
    const relative = path.relative(cwd, target);
    let current = cwd;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    const stats = fs.lstatSync(target);
    if (!stats.isFile() || stats.size > MAX_INLINE_INSPECTION_FILE_BYTES) return false;
    const realCwd = fs.realpathSync(cwd);
    const realTarget = fs.realpathSync(target);
    const realRelative = path.relative(realCwd, realTarget);
    return realRelative !== ".." && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative);
  } catch {
    return false;
  }
}

function wordsWithoutShellRedirections(words: string[]): string[] | undefined {
  const result: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    // Here-documents carry executable source outside the token Pi gives the
    // policy. They cannot be proved read-only from this word list.
    if (/^\d*<<</.test(word) || /^\d*<</.test(word)) return undefined;
    const redirect = word.match(/^(?:\d*(?:<>|>>|>\||>|<)|&>>?)(.*)$/);
    if (!redirect) {
      result.push(word);
      continue;
    }
    if (!redirect[1]) {
      if (!words[index + 1]) return undefined;
      index += 1;
    }
  }
  return result;
}

function maskInlineScriptLiteralsAndComments(source: string, language: "javascript" | "python"): string {
  let result = "";
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") { lineComment = false; result += "\n"; }
      else result += " ";
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { result += "  "; index += 1; blockComment = false; }
      else result += char === "\n" ? "\n" : " ";
      continue;
    }
    if (quote) {
      result += char === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      result += " ";
      continue;
    }
    if (language === "javascript" && char === "/" && next === "/") {
      result += "  "; index += 1; lineComment = true; continue;
    }
    if (language === "javascript" && char === "/" && next === "*") {
      result += "  "; index += 1; blockComment = true; continue;
    }
    if (language === "python" && char === "#") {
      result += " "; lineComment = true; continue;
    }
    result += char;
  }
  return quote || blockComment ? "" : result;
}

function isReadOnlyNodeInlineScript(source: string, cwd: string): boolean {
  // Template interpolation and dynamic module loading make the effective code
  // different from the literal source inspected here. Keep them fail closed.
  if (!source.trim() || source.includes("`")) return false;
  let rewritten = source;
  let invalidRequire = false;
  rewritten = rewritten.replace(/\brequire\s*\(\s*(['"])([^'"\\\r\n]+)\1\s*\)/g, (_match, _quote, request) => {
    if (request === "fs" || request === "node:fs") return "PIAGENT_FS_CAPABILITY";
    if (request === "path" || request === "node:path") return "PIAGENT_PATH_CAPABILITY";
    if (/^(?:\.\.?\/|\/)[^\0]*\.json$/i.test(request) && isBoundedInspectionFile(cwd, request)) return "PIAGENT_JSON_VALUE";
    invalidRequire = true;
    return "PIAGENT_INVALID_REQUIRE";
  });
  const rawFsAliases = new Set<string>(["PIAGENT_FS_CAPABILITY"]);
  for (const match of rewritten.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*PIAGENT_FS_CAPABILITY\b/g)) {
    rawFsAliases.add(match[1]);
  }
  if (!nodeReadCallsAreBounded(rewritten, rawFsAliases, cwd)) return false;
  let code = maskInlineScriptLiteralsAndComments(rewritten, "javascript");
  if (!code || invalidRequire || /\brequire\b/.test(code) || /\\(?:u\{?[0-9a-f]|x[0-9a-f])/i.test(code)) return false;

  const fsAliases = new Set<string>(["PIAGENT_FS_CAPABILITY"]);
  code = code.replace(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*PIAGENT_FS_CAPABILITY\b/g, (_match, alias) => {
    fsAliases.add(alias);
    return "const PIAGENT_FS_ALIAS_DECLARATION = 0";
  });
  const syncReads = "accessSync|existsSync|lstatSync|readFileSync|readlinkSync|realpathSync|statSync";
  const asyncReads = "access|lstat|readFile|readlink|realpath|stat";
  for (const alias of fsAliases) {
    const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    code = code
      .replace(new RegExp(`\\b${escapedAlias}\\s*\\.\\s*promises\\s*\\.\\s*(?:${asyncReads})\\s*\\(`, "g"), "PIAGENT_READ_OPERATION(")
      .replace(new RegExp(`\\b${escapedAlias}\\s*\\.\\s*(?:${syncReads})\\s*\\(`, "g"), "PIAGENT_READ_OPERATION(")
      .replace(new RegExp(`\\b${escapedAlias}\\s*\\.\\s*constants\\s*\\.\\s*(?:F_OK|R_OK)\\b`, "g"), "PIAGENT_READ_CONSTANT");
    if (new RegExp(`\\b${escapedAlias}\\b`).test(code)) return false;
  }

  code = code
    .replace(/\bprocess\s*\.\s*(?:cwd|memoryUsage|resourceUsage|uptime)\s*\(\s*\)/g, "PIAGENT_PROCESS_READ")
    .replace(/\bprocess\s*\.\s*(?:arch|argv|platform|version|versions)\b/g, "PIAGENT_PROCESS_READ")
    .replace(/\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\b/g, "PIAGENT_OUTPUT_OPERATION");
  if (/\bprocess\b/.test(code)) return false;

  if (
    /=>|[*]{2}|<<|>>|\b(?:Array|Atomics|Buffer|Promise|SharedArrayBuffer|Worker|class|do|for|function|get|new|queueMicrotask|set|setImmediate|setInterval|setTimeout|while)\b/.test(code)
    || /\.\s*(?:apply|bind|call|copyWithin|fill|padEnd|padStart|repeat)\b/.test(code)
    || /\/(?![/*])/.test(code)
    || /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\([^)]*\)\s*\{/.test(code)
  ) return false;

  // With module access reduced to JSON, path helpers, and the fs read methods
  // above, these remaining escape hatches are the ways arbitrary inline code
  // could regain mutation or external-process authority.
  return !/\b(?:Bun|Deno|EventSource|Function|Proxy|Reflect|WebAssembly|WebSocket|XMLHttpRequest|child_process|cluster|constructor|eval|exports|fetch|global|globalThis|import|module|process|getBuiltinModule|prototype|this|__proto__|vm|worker_threads)\b/.test(code);
}

function splitTopLevelArguments(value: string): string[] | undefined {
  const parts: string[] = [];
  let current = "", quote = "", escaped = false, depth = 0;
  for (const char of value) {
    if (quote) {
      current += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if ("([{".includes(char)) { depth += 1; current += char; continue; }
    if (")]}".includes(char)) { depth -= 1; if (depth < 0) return undefined; current += char; continue; }
    if (char === "," && depth === 0) { parts.push(current.trim()); current = ""; continue; }
    current += char;
  }
  if (quote || depth !== 0) return undefined;
  parts.push(current.trim());
  return parts;
}

function callArgumentsAt(source: string, start: number): string[] | undefined {
  let quote = "", escaped = false, depth = 1;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return splitTopLevelArguments(source.slice(start, index));
  }
  return undefined;
}

function nodeReadCallsAreBounded(source: string, aliases: Set<string>, cwd: string): boolean {
  const aliasPattern = [...aliases]
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!aliasPattern) return true;
  const calls = new RegExp(`\\b(?:${aliasPattern})\\s*\\.\\s*(?:(promises)\\s*\\.\\s*)?(access|accessSync|existsSync|lstat|lstatSync|readFile|readFileSync|readlink|readlinkSync|realpath|realpathSync|stat|statSync)\\s*\\(`, "g");
  for (const match of source.matchAll(calls)) {
    const args = callArgumentsAt(source, (match.index ?? 0) + match[0].length);
    const target = args?.[0] ? simpleQuotedLiteral(args[0]) : undefined;
    if (!target || !projectLocalInspectionPath(cwd, target)) return false;
    if (/^readFile/.test(match[2]) && !isBoundedInspectionFile(cwd, target)) return false;
  }
  return true;
}

function pythonOpenCallsAreReadOnly(source: string, cwd: string): boolean {
  const matches = [...source.matchAll(/\bopen\s*\(/g)];
  for (const match of matches) {
    const start = (match.index ?? 0) + match[0].length;
    const args = callArgumentsAt(source, start);
    if (!args || !args[0]) return false;
    const target = simpleQuotedLiteral(args[0]);
    if (!target || !isBoundedInspectionFile(cwd, target)) return false;
    const positionalMode = args[1] && !args[1].includes("=") ? args[1] : undefined;
    const keywordMode = args.slice(1).find((arg) => /^mode\s*=/.test(arg))?.replace(/^mode\s*=\s*/, "");
    for (const mode of [positionalMode, keywordMode].filter((entry): entry is string => Boolean(entry))) {
      if (!/^(['"])(?:r|rt|tr|rb|br)\1$/.test(mode.trim())) return false;
    }
    for (const arg of args.slice(positionalMode ? 2 : 1)) {
      const key = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
      if (key && !["buffering", "encoding", "errors", "mode", "newline"].includes(key)) return false;
    }
  }
  return true;
}

function pythonPathCallsAreBounded(source: string, cwd: string): boolean {
  for (const match of source.matchAll(/\bPath\s*\(/g)) {
    const args = callArgumentsAt(source, (match.index ?? 0) + match[0].length);
    const target = args?.length === 1 ? simpleQuotedLiteral(args[0]) : undefined;
    if (!target || !projectLocalInspectionPath(cwd, target)) return false;
  }
  const allReads = [...source.matchAll(/\.\s*(?:read_bytes|read_text)\s*\(/g)].length;
  const boundedReads = [...source.matchAll(/\bPath\s*\(\s*(['"])([^'"\\\r\n]+)\1\s*\)\s*\.\s*(?:read_bytes|read_text)\s*\(/g)]
    .filter((match) => isBoundedInspectionFile(cwd, match[2])).length;
  return allReads === boundedReads;
}

function isReadOnlyPythonInlineScript(source: string, cwd: string): boolean {
  if (
    !source.trim()
    || source.includes("\n")
    || !pythonOpenCallsAreReadOnly(source, cwd)
    || !pythonPathCallsAreBounded(source, cwd)
  ) return false;
  let code = maskInlineScriptLiteralsAndComments(source, "python");
  if (!code) return false;
  code = code
    .replace(/(?:^|;)\s*import\s+json\s*(?=;|$)/g, ";")
    .replace(/(?:^|;)\s*from\s+pathlib\s+import\s+Path\s*(?=;|$)/g, ";");
  // No reflection/dynamic import, process or network modules, or filesystem
  // write primitives. File handles are accepted only when every open() mode is
  // read-only, as checked above.
  return !/(?:=>|[*]|<<|>>|__|\b(?:async|await|breakpoint|bytearray|class|compile|ctypes|def|delattr|eval|exec|for|getattr|globals|help|import|importlib|input|iter|lambda|locals|next|openers?|os|pow|range|requests|resource|setattr|shutil|sleep|socket|subprocess|sys|threading|time|urllib|while|yield)\b|\.\s*(?:center|chmod|glob|hardlink_to|iterdir|lchmod|link|ljust|mkdir|open|remove|rename|replace|rglob|rjust|rmdir|symlink_to|touch|truncate|unlink|walk|write|write_bytes|write_text|writelines|zfill)\b)/.test(code);
}

function isProvablyReadOnlyInlineInterpreter(words: string[], cwd: string): boolean {
  const commandWords = wordsWithoutShellRedirections(words);
  if (!commandWords || commandWords.length < 3) return false;
  const executable = path.basename(commandWords[0] ?? "").toLowerCase();
  if (!READ_ONLY_INLINE_INTERPRETERS.has(executable)) return false;
  const args = commandWords.slice(1);
  if (executable === "node" || executable === "nodejs") {
    let index = 0;
    while (index < args.length && (
      ["--no-deprecation", "--no-warnings", "--trace-warnings"].includes(args[index])
      || /^--disable-warning=[A-Za-z0-9_-]+$/.test(args[index])
      || /^--input-type=(?:commonjs|module)$/.test(args[index])
    )) index += 1;
    const flag = args[index];
    let source: string | undefined;
    if (["-e", "--eval", "-p", "--print"].includes(flag)) source = args[index + 1];
    else source = flag?.match(/^--(?:eval|print)=(.*)$/s)?.[1];
    const consumed = ["-e", "--eval", "-p", "--print"].includes(flag) ? 2 : 1;
    return Boolean(source && index + consumed === args.length && isReadOnlyNodeInlineScript(source, cwd));
  }
  return args.length === 2 && args[0] === "-c" && isReadOnlyPythonInlineScript(args[1], cwd);
}


type ReadOnlyShellSegmentInspection = {
  commandWords: string[];
  boundedInlineInterpreter: boolean;
};

function inspectReadOnlyShellSegment(
  words: string[],
  cwd: string
): ReadOnlyShellSegmentInspection | undefined {
  const commandWords = wordsWithoutShellRedirections(words);
  if (!commandWords || commandWords.length === 0) return undefined;
  return {
    commandWords,
    boundedInlineInterpreter: isProvablyReadOnlyInlineInterpreter(words, cwd)
  };
}

export function isReadOnlyTaskShellCommand(
  command: string,
  segments: Array<{ words: string[] }>,
  cwd: string
): boolean {
  if (/`|\$\(/.test(command) || shellHasFileWriteRedirection(command)) return false;
  const safeCommands = new Set(["pwd", "ls", "find", "rg", "grep", "cat", "sed", "head", "tail", "wc", "stat", "file", "test", "[", "which", "printf", "sort"]);
  const safeGitSubcommands = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse"]);
  return segments.length > 0 && segments.every((segment) => {
    const inspection = inspectReadOnlyShellSegment(segment.words.filter(Boolean), cwd);
    if (!inspection) return false;
    if (inspection.boundedInlineInterpreter) return true;
    const words = inspection.commandWords;
    const executable = path.basename(words[0] ?? "");
    if (executable === "sed" && words.some((word) => /^-.*i/.test(word))) return false;
    if (executable === "find" && words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(word))) return false;
    if (executable === "sort" && words.slice(1).some((word) => (
      word === "--output"
      || word.startsWith("--output=")
      || /^-[^-]*o/.test(word)
    ))) return false;
    if (safeCommands.has(executable)) return true;
    if (executable === "git") return safeGitSubcommands.has(words[1] ?? "");
    if (executable === "command") return words[1] === "-v";
    return false;
  });
}

const PROJECT_MUTATING_EXECUTABLES = new Set([
  "apply_patch", "bash", "bun", "chmod", "chown", "cp", "dd", "deno", "install", "ln", "make", "mkdir", "mv", "prename", "rename",
  "node", "nodejs", "patch", "perl", "php", "python", "python3", "rm", "rmdir", "rsync", "ruby", "scp", "sh",
  "tee", "touch", "truncate", "zsh"
]);

export function isProjectMutatingShellCommand(
  command: string,
  segments: Array<{ words: string[] }>,
  cwd: string
): boolean {
  if (shellHasFileWriteRedirection(command)) return true;
  const noAliases = new Map<string, string>();
  for (const segment of segments) {
    const words = segment.words.filter(Boolean);
    if (words.length === 0) continue;
    const mutatingExecutable = externalExecutableIndex(words, PROJECT_MUTATING_EXECUTABLES, noAliases);
    if (mutatingExecutable !== undefined) {
      const inspection = inspectReadOnlyShellSegment(words, cwd);
      if (mutatingExecutable !== 0 || !inspection?.boundedInlineInterpreter) return true;
    }
    const executable = path.basename(words[0] ?? "").toLowerCase();
    if (executable === "find" && words.some((word) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(word))) return true;
    if (executable === "sed" && words.some((word) => /^-[^-]*i/.test(word) || word === "--in-place" || word.startsWith("--in-place="))) return true;
    if (executable === "git") {
      const subcommand = words.slice(1).find((word, index, values) => {
        if (!word.startsWith("-")) return index === 0 || !["-C", "-c", "--git-dir", "--work-tree"].includes(values[index - 1]);
        return false;
      });
      if (["apply", "checkout", "clean", "mv", "reset", "restore", "rm", "switch"].includes(subcommand ?? "")) return true;
    }
    if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
      const subcommand = words.find((word, index) => index > 0 && !word.startsWith("-"));
      if (["add", "ci", "install", "link", "remove", "uninstall", "update", "upgrade"].includes(subcommand ?? "")) return true;
    }
  }
  return false;
}

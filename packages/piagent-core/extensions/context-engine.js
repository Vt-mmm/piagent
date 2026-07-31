import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  contextIndexExcludeDigest,
  contextIndexExcludePolicyVersion,
  normalizeContextIndexExcludePatterns
} from "./context-index-policy.js";
import { matchesProtectedPath } from "./policy-core.js";

const INDEX_SCHEMA_VERSION = 2;
const TELEMETRY_SCHEMA_VERSION = 1;
const RRF_K = 60;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 8_000;
const DEFAULT_PACK_TOKENS = 6_000;
const MAX_TELEMETRY_EVENTS = 50_000;
const MAX_TELEMETRY_READ_BYTES = 32 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".cs", ".css", ".dart", ".ex", ".exs", ".go", ".h", ".hpp",
  ".html", ".java", ".js", ".jsx", ".kt", ".kts", ".lua", ".m", ".md", ".mdx",
  ".php", ".proto", ".py", ".rb", ".rs", ".scala", ".scss", ".sh", ".sql", ".svelte",
  ".swift", ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml"
]);
const SOURCE_NAMES = new Set([
  "AGENTS.md", "Dockerfile", "Makefile", "Procfile", "README", "README.md", "go.mod",
  "package.json", "pyproject.toml", "requirements.txt", "tsconfig.json"
]);
const IGNORED_SEGMENTS = new Set([
  ".git", ".next", ".nuxt", ".output", ".turbo", ".venv", "build", "coverage", "dist",
  "node_modules", "out", "target", "vendor"
]);
const SECRET_FILE_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)auth\.json$/i,
  /(^|\/)(?:credentials?|secrets?|tokens?)\.json$/i,
  /(^|\/)\.pi\/settings\.json$/i,
  /(^|\/)\.pi\/piagent-profile(?:\.lock)?\.json$/i,
  /(^|\/)\.pi\/piagent-state(?:\/|$)/i
];
const CONTROL_WORDS = new Set([
  "catch", "else", "for", "if", "return", "switch", "while", "with"
]);
const STOP_TERMS = new Set([
  "about", "after", "agent", "before", "build", "change", "check", "code", "could", "file",
  "from", "have", "into", "just", "make", "need", "please", "project", "should", "task",
  "that", "them", "then", "there", "these", "this", "through", "update", "using", "want",
  "what", "when", "where", "which", "with", "would"
]);

let sqliteModulePromise;
const retrievalFeedbackCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeRelative(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function requireExplicitExcludePatterns(options, operation) {
  if (!Array.isArray(options?.excludePatterns)) {
    throw new TypeError(`${operation} requires an explicit excludePatterns array`);
  }
  return normalizeContextIndexExcludePatterns(options.excludePatterns);
}

export function estimateContextTokens(value) {
  return Math.max(0, Math.ceil(String(value ?? "").length / 4));
}

export function contextEnginePaths(cwd) {
  const root = path.join(cwd, ".pi", "piagent-state", "context-engine");
  return {
    root,
    database: path.join(root, "context-v2.sqlite"),
    telemetry: path.join(root, "events.jsonl"),
    report: path.join(root, "efficiency-report.json")
  };
}

async function loadSqlite() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = (async () => {
      // Node 22 labels node:sqlite experimental even though its API is stable
      // enough for this local cache. Avoid leaking that one import notice into
      // the Pi TUI while preserving every other process warning.
      const emitWarning = process.emitWarning;
      process.emitWarning = function filteredWarning(warning, ...args) {
        const message = warning instanceof Error ? warning.message : String(warning);
        if (message.includes("SQLite is an experimental feature")) return;
        return emitWarning.call(process, warning, ...args);
      };
      try {
        return await import("node:sqlite");
      } finally {
        process.emitWarning = emitWarning;
      }
    })();
  }
  return sqliteModulePromise;
}

async function openDatabase(cwd, { create = true } = {}) {
  const paths = contextEnginePaths(cwd);
  if (!create && !fs.existsSync(paths.database)) return undefined;
  fs.mkdirSync(paths.root, { recursive: true });
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(paths.database);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      language TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS symbols_name_idx ON symbols(name);
    CREATE INDEX IF NOT EXISTS symbols_file_idx ON symbols(file_path);
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      specifier TEXT NOT NULL,
      target_path TEXT,
      line INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS imports_file_idx ON imports(file_path);
    CREATE INDEX IF NOT EXISTS imports_target_idx ON imports(target_path);
    CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
      path UNINDEXED,
      body,
      symbol_names,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  return db;
}

function metadataMap(db) {
  const result = {};
  for (const row of db.prepare("SELECT key, value FROM metadata").all()) {
    result[row.key] = row.value;
  }
  return result;
}

function setMetadata(db, values) {
  const statement = db.prepare(`
    INSERT INTO metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}

function isTextBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return sample.length === 0 || suspicious / sample.length < 0.02;
}

function shouldIndexPath(relativePath, options) {
  const rel = normalizeRelative(relativePath);
  if (!rel || path.isAbsolute(rel) || rel.startsWith("../")) return false;
  const segments = rel.split("/");
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false;
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(rel))) return false;
  if (matchesProtectedPath(rel, options.excludePatterns ?? [])) return false;
  const name = path.posix.basename(rel);
  return SOURCE_NAMES.has(name) || SOURCE_EXTENSIONS.has(path.posix.extname(name).toLowerCase());
}

function projectFileInfo(cwd, relativePath, root = fs.realpathSync.native(cwd), directoryCache = new Map()) {
  const expected = path.resolve(root, relativePath);
  if (expected !== root && !expected.startsWith(`${root}${path.sep}`)) return undefined;
  try {
    const directPath = path.resolve(cwd, relativePath);
    const directParent = path.dirname(directPath);
    let canonicalParent = directoryCache.get(directParent);
    if (canonicalParent === undefined) {
      canonicalParent = fs.realpathSync.native(directParent);
      directoryCache.set(directParent, canonicalParent);
    }
    if (canonicalParent !== path.dirname(expected)) return undefined;
    const direct = fs.lstatSync(directPath);
    if (direct.isSymbolicLink() || !direct.isFile()) return undefined;
    return { absolute: expected, stat: direct };
  } catch {
    return undefined;
  }
}

function gitFileList(cwd) {
  try {
    const output = execFileSync("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split("\0").filter(Boolean).map(normalizeRelative);
  } catch {
    return undefined;
  }
}

function walkedFileList(cwd, maxFiles) {
  const files = [];
  const pending = [cwd];
  while (pending.length > 0 && files.length < maxFiles) {
    const directory = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelative(path.relative(cwd, absolute));
      if (entry.isDirectory()) {
        if (!IGNORED_SEGMENTS.has(entry.name) && !relative.startsWith(".pi/piagent-state")) pending.push(absolute);
      } else if (entry.isFile()) {
        files.push(relative);
        if (files.length >= maxFiles) break;
      }
    }
  }
  return files;
}

function languageForPath(filePath) {
  const extension = path.posix.extname(filePath).toLowerCase();
  const names = {
    ".c": "c", ".cc": "cpp", ".cpp": "cpp", ".cs": "csharp", ".dart": "dart",
    ".ex": "elixir", ".exs": "elixir", ".go": "go", ".h": "c", ".hpp": "cpp",
    ".java": "java", ".js": "javascript", ".jsx": "javascript", ".kt": "kotlin",
    ".kts": "kotlin", ".lua": "lua", ".m": "objective-c", ".php": "php", ".py": "python",
    ".rb": "ruby", ".rs": "rust", ".scala": "scala", ".sh": "shell", ".sql": "sql",
    ".svelte": "svelte", ".swift": "swift", ".ts": "typescript", ".tsx": "typescript",
    ".vue": "vue"
  };
  return names[extension] ?? ([".md", ".mdx"].includes(extension) ? "markdown" : "text");
}

function symbolMatchers(language) {
  const common = [
    { kind: 1, regex: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(class|interface|type|enum|function|namespace)\s+([A-Za-z_$][\w$]*)/ },
    { kind: 1, regex: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ }
  ];
  if (["typescript", "javascript", "svelte", "vue"].includes(language)) return common;
  if (language === "python") return [
    { kind: 1, regex: /^\s*(class|def|async\s+def)\s+([A-Za-z_]\w*)/ }
  ];
  if (language === "go") return [
    { kind: 1, regex: /^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/ }
  ];
  if (language === "rust") return [
    { kind: 1, regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(fn|struct|enum|trait|type|mod)\s+([A-Za-z_]\w*)/ }
  ];
  if (["java", "kotlin", "csharp", "cpp", "c", "swift", "dart", "scala"].includes(language)) return [
    { kind: 1, regex: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|async|virtual|override)\s+)*(class|interface|enum|struct|record|trait|protocol|func|fun)\s+([A-Za-z_]\w*)/ },
    { kind: 2, regex: /^\s*(?:(?:public|private|protected|internal|static|final|async|virtual|override|inline|extern)\s+)*(?:[A-Za-z_][\w:<>,?[\].]*\s+)+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:\{|=>|$)/ }
  ];
  if (language === "ruby") return [
    { kind: 1, regex: /^\s*(class|module|def)\s+(?:self\.)?([A-Za-z_]\w*[!?=]?)/ }
  ];
  if (language === "php") return [
    { kind: 1, regex: /^\s*(?:(?:public|private|protected|abstract|final|static)\s+)*(class|interface|trait|enum|function)\s+([A-Za-z_]\w*)/ }
  ];
  if (language === "elixir") return [
    { kind: 1, regex: /^\s*(defmodule|defprotocol|def|defp|defmacro)\s+([A-Za-z_][\w.!?]*)/ }
  ];
  if (language === "lua") return [
    { kind: 1, regex: /^\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)/ }
  ];
  if (language === "sql") return [
    { kind: 1, regex: /^\s*create\s+(?:or\s+replace\s+)?(table|view|function|procedure|trigger)\s+(?:if\s+not\s+exists\s+)?([A-Za-z_][\w.]*)/i }
  ];
  if (language === "markdown") return [
    { kind: 1, regex: /^(#{1,4})\s+(.{1,120})$/ }
  ];
  return [];
}

function kindAndName(match, matcher, language) {
  if (language === "markdown") return { kind: `heading-${match[1].length}`, name: match[2].trim() };
  if (matcher.kind === 2) return { kind: "function", name: match[1] };
  if (match.length >= 3) return { kind: String(match[1]).replace(/\s+/g, "-"), name: match[2] };
  return { kind: "symbol", name: match[1] };
}

function extractSymbols(text, language) {
  const lines = text.split(/\r?\n/);
  const matchers = symbolMatchers(language);
  const symbols = [];
  for (let index = 0; index < lines.length && symbols.length < 400; index += 1) {
    const line = lines[index];
    for (const matcher of matchers) {
      const match = line.match(matcher.regex);
      if (!match) continue;
      const parsed = kindAndName(match, matcher, language);
      if (!parsed.name || CONTROL_WORDS.has(parsed.name)) continue;
      symbols.push({
        name: parsed.name.slice(0, 160),
        kind: parsed.kind.slice(0, 40),
        line: index + 1,
        endLine: index + 1,
        signature: line.trim().slice(0, 300)
      });
      break;
    }
  }
  for (let index = 0; index < symbols.length; index += 1) {
    symbols[index].endLine = Math.max(symbols[index].line, (symbols[index + 1]?.line ?? lines.length + 1) - 1);
  }
  return symbols;
}

function extractImports(text, language) {
  const lines = text.split(/\r?\n/);
  const imports = [];
  const patterns = [];
  if (["typescript", "javascript", "svelte", "vue"].includes(language)) {
    patterns.push(/\bfrom\s+["']([^"']+)["']/, /\brequire\(\s*["']([^"']+)["']\s*\)/, /\bimport\(\s*["']([^"']+)["']\s*\)/);
  } else if (language === "python") {
    patterns.push(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/, /^\s*import\s+([A-Za-z_][\w.]*)/);
  } else if (["java", "kotlin", "scala"].includes(language)) {
    patterns.push(/^\s*import\s+([A-Za-z_][\w.]*)/);
  } else if (language === "go") {
    patterns.push(/^\s*(?:import\s+)?["']([^"']+)["']/);
  } else if (language === "rust") {
    patterns.push(/^\s*use\s+([A-Za-z_][\w:]*)/);
  } else if (language === "csharp") {
    patterns.push(/^\s*using\s+([A-Za-z_][\w.]*)/);
  } else if (language === "ruby") {
    patterns.push(/^\s*require(?:_relative)?\s+["']([^"']+)["']/);
  }
  for (let index = 0; index < lines.length && imports.length < 300; index += 1) {
    for (const pattern of patterns) {
      const match = lines[index].match(pattern);
      if (!match) continue;
      imports.push({ specifier: match[1].slice(0, 300), line: index + 1 });
      break;
    }
  }
  return imports;
}

function resolveImportTarget(sourcePath, specifier, files) {
  const sourceDir = path.posix.dirname(sourcePath);
  const extension = path.posix.extname(sourcePath);
  const candidates = [];
  if (specifier.startsWith(".")) {
    const base = path.posix.normalize(path.posix.join(sourceDir, specifier));
    const specifierExtension = path.posix.extname(base);
    const bases = [base];
    if ([".js", ".mjs", ".cjs"].includes(specifierExtension)) bases.push(base.slice(0, -specifierExtension.length));
    for (const candidateBase of bases) {
      candidates.push(candidateBase, `${candidateBase}${extension}`);
      for (const suffix of [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".swift"]) {
        candidates.push(`${candidateBase}${suffix}`, path.posix.join(candidateBase, `index${suffix}`));
      }
    }
  } else {
    const modulePath = specifier.replaceAll(".", "/").replaceAll("::", "/");
    candidates.push(modulePath, `${modulePath}${extension}`);
    for (const file of files) {
      if (file.endsWith(`/${modulePath}${path.posix.extname(file)}`) || file.endsWith(`/${modulePath}/index${path.posix.extname(file)}`)) {
        candidates.push(file);
      }
    }
  }
  return candidates.map(normalizeRelative).find((candidate) => files.has(candidate));
}

function tokenizeQuery(query) {
  const expanded = String(query ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ")
    .replaceAll("-", " ");
  const terms = expanded.match(/[A-Za-z][A-Za-z0-9]{1,63}/g) ?? [];
  return [...new Set(terms.map((term) => term.toLowerCase()).filter((term) => !STOP_TERMS.has(term)))].slice(0, 16);
}

function queryPathCandidates(query) {
  const values = String(query ?? "").match(/(?:^|[\s"'`(])((?:\.{0,2}\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+|[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),:])/g) ?? [];
  return values.map((value) => normalizeRelative(value.trim().replace(/^["'`(]+|["'`),:]+$/g, ""))).filter(Boolean);
}

function ftsQuery(terms) {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function gitChangedFiles(cwd) {
  try {
    const output = execFileSync("git", ["-C", cwd, "diff", "--name-only", "--diff-filter=ACMR", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split(/\r?\n/).map(normalizeRelative).filter(Boolean);
  } catch {
    return [];
  }
}

export function classifyContextTask(prompt) {
  const text = String(prompt ?? "").trim();
  const lower = text.toLowerCase();
  const paths = queryPathCandidates(text);
  const terms = tokenizeQuery(text);
  let workflow = "task";
  if (/^\/?(?:scout|review|plan|discuss)\b/.test(lower)) workflow = lower.match(/^\/?([a-z-]+)/)?.[1] ?? "task";
  if (/\b(onboard|profile setup|first-read)\b/.test(lower)) workflow = "onboard";
  if (/\b(commit|pull request|\bpr\b|release|publish|deploy)\b/.test(lower)) workflow = "release";
  const usageIntent = /^\/?(?:usage|session)\b/.test(lower)
    || /\b(?:show|check|view|report|current|session|how many)\b.{0,48}\b(?:usage|tokens?|cost|context stats|efficiency)\b/.test(lower)
    || /\b(?:usage|tokens?|cost|context stats|efficiency)\b.{0,48}\b(?:show|check|view|report|current|session)\b/.test(lower);
  if (usageIntent) workflow = "usage";
  const highRisk = /\b(auth|authorization|credential|database|deploy|encryption|migration|payment|permission|production|release|secret|security|token)\b/.test(lower);
  const tiny = text.length < 220 && (paths.length > 0 || /\b(rename|typo|label|copy|one line|small)\b/.test(lower));
  return {
    workflow,
    lane: highRisk ? "high-risk" : tiny ? "tiny" : "normal",
    terms,
    paths,
    promptHash: sha256(text),
    promptChars: text.length
  };
}

export async function buildContextIndexV2(cwd, options = {}) {
  const excludePatterns = requireExplicitExcludePatterns(options, "buildContextIndexV2");
  const startedAt = Date.now();
  const projectRoot = fs.realpathSync.native(cwd);
  const directoryCache = new Map();
  const maxFiles = clampInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, 50_000);
  const maxFileBytes = clampInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1_024, 2 * 1024 * 1024);
  const listed = gitFileList(cwd) ?? walkedFileList(cwd, maxFiles);
  const candidates = listed.filter((file) => shouldIndexPath(file, { ...options, excludePatterns })).slice(0, maxFiles).sort();
  const db = await openDatabase(cwd);
  const existing = new Map(db.prepare("SELECT path, hash, bytes, mtime_ms FROM files").all().map((row) => [row.path, row]));
  const current = new Set();
  const currentHashes = new Map();
  const changed = [];
  const restatted = [];
  let reused = 0;
  let skippedLarge = 0;
  let skippedBinary = 0;
  const skippedPaths = [];

  for (const relativePath of candidates) {
    const file = projectFileInfo(cwd, relativePath, projectRoot, directoryCache);
    if (!file) continue;
    const { absolute, stat } = file;
    if (stat.size > maxFileBytes) {
      skippedLarge += 1;
      skippedPaths.push(relativePath);
      continue;
    }
    const previous = existing.get(relativePath);
    if (
      previous
      && Number(previous.bytes) === stat.size
      && Math.abs(Number(previous.mtime_ms) - stat.mtimeMs) < 0.5
    ) {
      current.add(relativePath);
      currentHashes.set(relativePath, previous.hash);
      reused += 1;
      continue;
    }
    let buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    if (!isTextBuffer(buffer)) {
      skippedBinary += 1;
      skippedPaths.push(relativePath);
      continue;
    }
    const contentHash = sha256(buffer);
    current.add(relativePath);
    currentHashes.set(relativePath, contentHash);
    if (previous?.hash !== contentHash) {
      changed.push({ relativePath, contentHash, stat, text: buffer.toString("utf8") });
    } else if (previous) {
      restatted.push({ relativePath, stat });
    }
  }

  const removed = [...existing.keys()].filter((file) => !current.has(file));
  db.exec("BEGIN IMMEDIATE");
  try {
    const deleteFile = db.prepare("DELETE FROM files WHERE path = ?");
    const deleteFts = db.prepare("DELETE FROM file_fts WHERE path = ?");
    for (const relativePath of [...removed, ...changed.map((item) => item.relativePath)]) {
      deleteFts.run(relativePath);
      deleteFile.run(relativePath);
    }
    const updateStat = db.prepare("UPDATE files SET bytes = ?, mtime_ms = ? WHERE path = ?");
    for (const item of restatted) updateStat.run(item.stat.size, item.stat.mtimeMs, item.relativePath);

    const insertFile = db.prepare("INSERT INTO files(path, hash, bytes, mtime_ms, language, indexed_at) VALUES (?, ?, ?, ?, ?, ?)");
    const insertFts = db.prepare("INSERT INTO file_fts(path, body, symbol_names) VALUES (?, ?, ?)");
    const insertSymbol = db.prepare("INSERT INTO symbols(file_path, name, kind, line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?)");
    const insertImport = db.prepare("INSERT INTO imports(file_path, specifier, target_path, line) VALUES (?, ?, NULL, ?)");
    const indexedAt = nowIso();
    for (const item of changed) {
      const language = languageForPath(item.relativePath);
      const symbols = extractSymbols(item.text, language);
      const imports = extractImports(item.text, language);
      insertFile.run(item.relativePath, item.contentHash, item.stat.size, item.stat.mtimeMs, language, indexedAt);
      insertFts.run(item.relativePath, item.text, symbols.map((symbol) => symbol.name).join(" "));
      for (const symbol of symbols) {
        insertSymbol.run(item.relativePath, symbol.name, symbol.kind, symbol.line, symbol.endLine, symbol.signature);
      }
      for (const imported of imports) insertImport.run(item.relativePath, imported.specifier, imported.line);
    }

    const allFiles = new Set(db.prepare("SELECT path FROM files").all().map((row) => row.path));
    const unresolved = db.prepare("SELECT id, file_path, specifier FROM imports").all();
    const updateImport = db.prepare("UPDATE imports SET target_path = ? WHERE id = ?");
    for (const imported of unresolved) {
      updateImport.run(resolveImportTarget(imported.file_path, imported.specifier, allFiles) ?? null, imported.id);
    }

    const counts = {
      files: Number(db.prepare("SELECT COUNT(*) count FROM files").get().count),
      symbols: Number(db.prepare("SELECT COUNT(*) count FROM symbols").get().count),
      imports: Number(db.prepare("SELECT COUNT(*) count FROM imports").get().count)
    };
    setMetadata(db, {
      schemaVersion: INDEX_SCHEMA_VERSION,
      rootHash: sha256([...current].sort().map((file) => `${file}:${currentHashes.get(file) ?? ""}`).join("\n")),
      builtAt: indexedAt,
      fileCount: counts.files,
      symbolCount: counts.symbols,
      importCount: counts.imports,
      maxFileBytes,
      excludePatterns: JSON.stringify(excludePatterns),
      excludeDigest: contextIndexExcludeDigest(excludePatterns),
      excludePolicyVersion: contextIndexExcludePolicyVersion(),
      skippedPaths: JSON.stringify(skippedPaths)
    });
    db.exec("COMMIT");
    db.close();
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      builtAt: indexedAt,
      durationMs: Date.now() - startedAt,
      scanned: candidates.length,
      changed: changed.length,
      reused,
      removed: removed.length,
      skippedLarge,
      skippedBinary,
      ...counts
    };
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
}

export async function contextIndexV2Status(cwd, options = {}) {
  const paths = contextEnginePaths(cwd);
  const projectRoot = fs.realpathSync.native(cwd);
  const directoryCache = new Map();
  const expectedExcludePatterns = options.excludePatterns === undefined
    ? undefined
    : normalizeContextIndexExcludePatterns(options.excludePatterns);
  const expectedExcludeDigest = expectedExcludePatterns
    ? contextIndexExcludeDigest(expectedExcludePatterns)
    : undefined;
  if (!fs.existsSync(paths.database)) {
    return {
      schemaVersion: INDEX_SCHEMA_VERSION,
      exists: false,
      path: normalizeRelative(path.relative(cwd, paths.database)),
      stale: false,
      policyStale: false,
      expectedExcludeDigest,
      warnings: ["index-v2 missing"]
    };
  }
  const db = await openDatabase(cwd, { create: false });
  try {
    const metadata = metadataMap(db);
    const fileRows = db.prepare("SELECT path, bytes, mtime_ms FROM files").all();
    const files = fileRows.length;
    const symbols = Number(db.prepare("SELECT COUNT(*) count FROM symbols").get().count);
    const imports = Number(db.prepare("SELECT COUNT(*) count FROM imports").get().count);
    const indexedPaths = new Set(fileRows.map((row) => row.path));
    let storedExcludePatterns = [];
    try {
      const parsed = JSON.parse(metadata.excludePatterns ?? "[]");
      if (Array.isArray(parsed)) storedExcludePatterns = normalizeContextIndexExcludePatterns(parsed);
    } catch {
      storedExcludePatterns = [];
    }
    const activeExcludePatterns = expectedExcludePatterns ?? storedExcludePatterns;
    const storedExcludeDigest = metadata.excludeDigest;
    const policyStale = expectedExcludeDigest !== undefined
      && (typeof storedExcludeDigest !== "string" || storedExcludeDigest !== expectedExcludeDigest);
    const statChanged = [];
    for (const row of fileRows) {
      if (!shouldIndexPath(row.path, { excludePatterns: activeExcludePatterns })) continue;
      const file = projectFileInfo(cwd, row.path, projectRoot, directoryCache);
      if (
        !file
        || file.stat.size !== Number(row.bytes)
        || Math.abs(file.stat.mtimeMs - Number(row.mtime_ms)) >= 0.5
      ) {
        statChanged.push(row.path);
      }
    }
    let skippedPaths = new Set();
    try {
      const parsed = JSON.parse(metadata.skippedPaths ?? "[]");
      if (Array.isArray(parsed)) skippedPaths = new Set(parsed.filter((value) => typeof value === "string"));
    } catch {
      skippedPaths = new Set();
    }
    const listed = gitFileList(cwd);
    const newlyVisible = listed
      ? listed.filter((file) => !indexedPaths.has(file) && !skippedPaths.has(file) && shouldIndexPath(file, { excludePatterns: activeExcludePatterns }))
      : [];
    const stalePaths = [...new Set([...statChanged, ...newlyVisible])];
    const warnings = [];
    if (policyStale) warnings.push("context index exclusion policy changed");
    if (stalePaths.length > 0) warnings.push(`${stalePaths.length} changed file(s) since the last index build`);
    return {
      schemaVersion: Number(metadata.schemaVersion ?? INDEX_SCHEMA_VERSION),
      exists: true,
      path: normalizeRelative(path.relative(cwd, paths.database)),
      builtAt: metadata.builtAt,
      files,
      symbols,
      imports,
      stale: policyStale || stalePaths.length > 0,
      policyStale,
      excludePolicyVersion: metadata.excludePolicyVersion,
      excludeDigest: storedExcludeDigest,
      expectedExcludeDigest,
      stalePaths: stalePaths.slice(0, 20),
      warnings
    };
  } finally {
    db.close();
  }
}

export async function ensureContextIndexV2(cwd, options = {}) {
  const excludePatterns = requireExplicitExcludePatterns(options, "ensureContextIndexV2");
  let status = await contextIndexV2Status(cwd, { excludePatterns });
  const reason = options.refresh
    ? "refresh"
    : status.policyStale
      ? "exclusion-policy"
      : !status.exists && options.rebuildMissing
        ? "missing"
        : undefined;
  let build;
  if (reason) {
    build = await buildContextIndexV2(cwd, { ...options, excludePatterns });
    status = await contextIndexV2Status(cwd, { excludePatterns });
  }
  return { status, rebuilt: Boolean(reason), reason, build, excludePatterns };
}

function addRankedList(scores, rows, source, weight = 1) {
  rows.forEach((row, index) => {
    const filePath = row.path ?? row.file_path;
    if (!filePath) return;
    const current = scores.get(filePath) ?? { path: filePath, score: 0, sources: new Set(), rows: [] };
    current.score += weight / (RRF_K + index + 1);
    current.sources.add(source);
    current.rows.push({ source, ...row });
    scores.set(filePath, current);
  });
}

function personalizedPageRank(importRows, seeds, iterations = 8) {
  const nodes = new Set();
  const outgoing = new Map();
  for (const row of importRows) {
    if (!row.target_path) continue;
    nodes.add(row.file_path);
    nodes.add(row.target_path);
    const targets = outgoing.get(row.file_path) ?? new Set();
    targets.add(row.target_path);
    outgoing.set(row.file_path, targets);
  }
  for (const seed of seeds.keys()) nodes.add(seed);
  if (nodes.size === 0) return [];
  const seedTotal = [...seeds.values()].reduce((sum, value) => sum + Math.max(value, 0), 0) || 1;
  const teleport = new Map([...nodes].map((node) => [node, (seeds.get(node) ?? 0) / seedTotal]));
  let rank = new Map(teleport);
  const alpha = 0.85;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map([...nodes].map((node) => [node, (1 - alpha) * (teleport.get(node) ?? 0)]));
    let dangling = 0;
    for (const node of nodes) {
      const targets = outgoing.get(node);
      if (!targets?.size) {
        dangling += rank.get(node) ?? 0;
        continue;
      }
      const share = alpha * (rank.get(node) ?? 0) / targets.size;
      for (const target of targets) next.set(target, (next.get(target) ?? 0) + share);
    }
    for (const node of nodes) {
      next.set(node, (next.get(node) ?? 0) + alpha * dangling * (teleport.get(node) ?? 1 / nodes.size));
    }
    rank = next;
  }
  return [...rank.entries()].sort((left, right) => right[1] - left[1]).map(([filePath, score]) => ({ path: filePath, graphScore: score }));
}

function retrievalFeedback(cwd) {
  const target = contextEnginePaths(cwd).telemetry;
  let signature = "missing";
  try {
    const stat = fs.statSync(target);
    signature = `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return {
      rows: [],
      selected: 0,
      used: 0,
      unused: 0,
      utilizationRate: 0
    };
  }
  const cached = retrievalFeedbackCache.get(cwd);
  if (cached?.signature === signature) return cached.value;

  const events = readContextTelemetry(cwd, { limit: 12_000, maxBytes: 12 * 1024 * 1024 });
  const selectedCounts = new Map();
  const usedCounts = new Map();
  const latestPackBySession = new Map();
  let selected = 0;
  let used = 0;

  for (const event of events) {
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    if (event.event === "context_pack" && sessionId) {
      const selectedPaths = [...new Set(
        (Array.isArray(event.selectedPaths) ? event.selectedPaths : [])
          .map(normalizeRelative)
          .filter((filePath) => shouldIndexPath(filePath, {}))
      )];
      const pack = { selectedPaths: new Set(selectedPaths), usedPaths: new Set() };
      latestPackBySession.set(sessionId, pack);
      for (const filePath of selectedPaths) {
        selectedCounts.set(filePath, (selectedCounts.get(filePath) ?? 0) + 1);
        selected += 1;
      }
      continue;
    }
    if (event.event !== "tool_call" || !sessionId) continue;
    const targetPath = normalizeRelative(event.targetPath);
    const pack = latestPackBySession.get(sessionId);
    if (!targetPath || !pack?.selectedPaths.has(targetPath) || pack.usedPaths.has(targetPath)) continue;
    pack.usedPaths.add(targetPath);
    usedCounts.set(targetPath, (usedCounts.get(targetPath) ?? 0) + 1);
    used += 1;
  }

  const rows = [...usedCounts.entries()]
    .map(([filePath, usedCount]) => {
      const selectedCount = selectedCounts.get(filePath) ?? usedCount;
      const utilization = ratio(usedCount, selectedCount);
      const evidence = Math.min(1, selectedCount / 3);
      return {
        path: filePath,
        selectedCount,
        usedCount,
        feedbackScore: utilization * evidence
      };
    })
    .sort((left, right) => right.feedbackScore - left.feedbackScore || right.usedCount - left.usedCount || left.path.localeCompare(right.path));
  const value = {
    rows,
    selected,
    used,
    unused: Math.max(0, selected - used),
    utilizationRate: ratio(used, selected)
  };
  retrievalFeedbackCache.set(cwd, { signature, value });
  return value;
}

export async function searchContextIndexV2(cwd, query, options = {}) {
  const excludePatterns = requireExplicitExcludePatterns(options, "searchContextIndexV2");
  const limit = clampInteger(options.limit, 12, 1, 50);
  const projectRoot = fs.realpathSync.native(cwd);
  const directoryCache = new Map();
  const status = await contextIndexV2Status(cwd, { excludePatterns });
  if (!status.exists) return { query, terms: [], confidence: "none", results: [], status };
  const terms = tokenizeQuery(query);
  const explicitPaths = queryPathCandidates(query);
  if (terms.length === 0 && explicitPaths.length === 0) return { query, terms, confidence: "none", results: [], status };
  const db = await openDatabase(cwd, { create: false });
  try {
    const scores = new Map();
    const pathAllowed = (filePath) => shouldIndexPath(filePath, { excludePatterns });
    const allFiles = db.prepare("SELECT path, mtime_ms FROM files").all().filter((file) => pathAllowed(file.path));
    const explicitRows = [];
    for (const file of allFiles) {
      const basename = path.posix.basename(file.path).toLowerCase();
      const matched = explicitPaths.some((candidate) => {
        const normalized = candidate.toLowerCase();
        return file.path.toLowerCase() === normalized || file.path.toLowerCase().endsWith(`/${normalized}`) || basename === path.posix.basename(normalized);
      });
      if (matched) explicitRows.push({ path: file.path, exact: true });
    }
    addRankedList(scores, explicitRows, "explicit", 3);

    let lexicalRows = [];
    if (terms.length > 0) {
      lexicalRows = db.prepare(`
        SELECT path, bm25(file_fts, 0.0, 1.0, 2.2) lexical_score
        FROM file_fts WHERE file_fts MATCH ? ORDER BY lexical_score LIMIT ?
      `).all(ftsQuery(terms), Math.max(limit * 4, 30)).filter((row) => pathAllowed(row.path));
      addRankedList(scores, lexicalRows, "lexical", 1.5);
    }

    const symbolRows = [];
    const symbolStatement = db.prepare(`
      SELECT file_path, name, kind, line, end_line, signature
      FROM symbols WHERE lower(name) = ? OR lower(name) LIKE ?
      ORDER BY CASE WHEN lower(name) = ? THEN 0 ELSE 1 END, length(name) LIMIT ?
    `);
    for (const term of terms.slice(0, 8)) {
      symbolRows.push(...symbolStatement.all(term, `%${term}%`, term, Math.max(limit * 2, 20)).filter((row) => pathAllowed(row.file_path)));
    }
    const dedupedSymbols = [...new Map(symbolRows.map((row) => [`${row.file_path}:${row.line}`, row])).values()];
    addRankedList(scores, dedupedSymbols, "symbol", 2.2);

    const changedRows = gitChangedFiles(cwd).map((filePath) => ({ path: filePath })).filter((row) => scores.has(row.path));
    addRankedList(scores, changedRows, "git-change", 0.8);

    const testRows = allFiles
      .filter((file) => /(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test|\.spec|_test)\./i.test(file.path))
      .filter((file) => terms.some((term) => file.path.toLowerCase().includes(term)))
      .map((file) => ({ path: file.path }));
    addRankedList(scores, testRows, "test", 1.1);

    // Feedback is deliberately positive-only and weak. A file is boosted only
    // after a prior context pack selected it and the same session actually used
    // it. New files and unused historical candidates are never penalized.
    const feedbackRows = retrievalFeedback(cwd).rows.filter((row) => scores.has(row.path));
    addRankedList(scores, feedbackRows, "feedback", 0.45);

    const graphSeeds = new Map([...scores.entries()].map(([filePath, value]) => [filePath, value.score]));
    const importRows = db.prepare("SELECT file_path, target_path FROM imports WHERE target_path IS NOT NULL")
      .all()
      .filter((row) => pathAllowed(row.file_path) && pathAllowed(row.target_path));
    const graphRows = personalizedPageRank(importRows, graphSeeds).slice(0, Math.max(limit * 3, 30));
    addRankedList(scores, graphRows, "graph", 1);

    const ranked = [...scores.values()]
      .filter((candidate) => (
        shouldIndexPath(candidate.path, { excludePatterns })
        && projectFileInfo(cwd, candidate.path, projectRoot, directoryCache)
      ))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    const symbolLookup = db.prepare("SELECT name, kind, line, end_line, signature FROM symbols WHERE file_path = ? ORDER BY line LIMIT 12");
    const results = ranked.map((candidate) => {
      const matchingSymbols = candidate.rows
        .filter((row) => row.source === "symbol")
        .map((row) => ({ name: row.name, kind: row.kind, line: row.line, endLine: row.end_line, signature: row.signature }));
      const symbols = matchingSymbols.length > 0 ? matchingSymbols : symbolLookup.all(candidate.path).slice(0, 6).map((row) => ({
        name: row.name, kind: row.kind, line: row.line, endLine: row.end_line, signature: row.signature
      }));
      return {
        path: candidate.path,
        score: Number(candidate.score.toFixed(6)),
        sources: [...candidate.sources],
        symbols
      };
    });
    const top = results[0];
    const exact = Boolean(top?.sources.includes("explicit")) || Boolean(top?.sources.includes("symbol") && top.sources.length >= 2);
    const confidence = !top ? "none" : exact ? "high" : top.sources.length >= 2 ? "medium" : "low";
    return { query, terms, confidence, results, status };
  } finally {
    db.close();
  }
}

function lineRangesForFile(text, result, terms, includeCode) {
  if (!includeCode) return [];
  const lines = text.split(/\r?\n/);
  const centers = new Set();
  for (const symbol of result.symbols ?? []) centers.add(symbol.line);
  for (let index = 0; index < lines.length && centers.size < 8; index += 1) {
    const lower = lines[index].toLowerCase();
    if (terms.some((term) => lower.includes(term))) centers.add(index + 1);
  }
  const ranges = [...centers].sort((left, right) => left - right).map((line) => ({
    start: Math.max(1, line - 3),
    end: Math.min(lines.length, line + 5)
  }));
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 2) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
    if (merged.length >= 3) break;
  }
  return merged.map((range) => ({
    ...range,
    text: lines.slice(range.start - 1, range.end).map((line, index) => `${range.start + index}: ${line}`).join("\n")
  }));
}

export async function buildContextPack(cwd, query, options = {}) {
  const excludePatterns = requireExplicitExcludePatterns(options, "buildContextPack");
  const budgetTokens = clampInteger(options.budgetTokens, DEFAULT_PACK_TOKENS, 200, 50_000);
  const includeCode = options.includeCode !== false;
  const projectRoot = fs.realpathSync.native(cwd);
  const directoryCache = new Map();
  const search = await searchContextIndexV2(cwd, query, {
    limit: clampInteger(options.limit, 16, 1, 50),
    excludePatterns
  });
  const selected = [];
  const mapBudget = Math.min(1_200, Math.max(40, Math.trunc(budgetTokens * 0.2)));
  const mapLines = [];
  for (const result of search.results) {
    const symbolNames = result.symbols.slice(0, 5).map((symbol) => `${symbol.kind} ${symbol.name}`).join(", ");
    const line = `- ${result.path}${symbolNames ? `: ${symbolNames}` : ""} [${result.sources.join("+")}]`;
    const cost = estimateContextTokens(line);
    if (estimateContextTokens(mapLines.join("\n")) + cost > mapBudget) break;
    mapLines.push(line);
  }
  const footer = "Use this as navigation evidence. Re-read current files before editing; index hits are advisory.";
  const renderHeader = () => [
      "Pi Context Pack v2",
      `queryHash: ${sha256(String(query)).slice(0, 12)}`,
      `confidence: ${search.confidence}`,
      `index: ${search.status.files ?? 0} files / ${search.status.symbols ?? 0} symbols${search.status.stale ? " / stale" : ""}`,
      "",
      "Repository map:",
      ...(mapLines.length > 0 ? mapLines : ["- no ranked matches"])
    ].join("\n");
  let header = renderHeader();
  const renderPack = (items) => [
    header,
    ...(items.length > 0 ? ["", ...items.map((item) => item.text)] : []),
    "",
    footer
  ].join("\n");
  while (mapLines.length > 0 && estimateContextTokens(renderPack([])) > budgetTokens) {
    mapLines.pop();
    header = renderHeader();
  }

  for (const result of search.results) {
    let text;
    try {
      const file = projectFileInfo(cwd, result.path, projectRoot, directoryCache);
      if (!file) continue;
      text = fs.readFileSync(file.absolute, "utf8");
    } catch {
      continue;
    }
    const snippets = lineRangesForFile(text, result, search.terms, includeCode);
    const body = snippets.length > 0
      ? snippets.map((snippet) => `lines ${snippet.start}-${snippet.end}\n${snippet.text}`).join("\n\n")
      : result.symbols.slice(0, 8).map((symbol) => `line ${symbol.line}: ${symbol.signature}`).join("\n");
    const itemText = [`### ${result.path}`, `why: ${result.sources.join(", ")}`, body].filter(Boolean).join("\n");
    const tokens = estimateContextTokens(itemText);
    const item = { ...result, text: itemText, estimatedTokens: tokens, truncated: false };
    if (estimateContextTokens(renderPack([...selected, item])) > budgetTokens) {
      if (selected.length === 0) {
        const remaining = budgetTokens - estimateContextTokens(renderPack([]));
        let chars = Math.max(0, remaining * 4 - 16);
        let truncated = { ...result, text: itemText.slice(0, chars), estimatedTokens: remaining, truncated: true };
        while (chars > 0 && estimateContextTokens(renderPack([truncated])) > budgetTokens) {
          chars = Math.max(0, chars - 16);
          truncated = { ...truncated, text: itemText.slice(0, chars) };
        }
        if (chars > 0) selected.push(truncated);
      }
      continue;
    }
    selected.push(item);
  }

  const text = renderPack(selected);
  return {
    queryHash: sha256(String(query)),
    confidence: search.confidence,
    status: search.status,
    candidates: search.results.length,
    selected: selected.map(({ text: _text, ...item }) => item),
    estimatedTokens: estimateContextTokens(text),
    finderRecommended: search.confidence === "none" || search.confidence === "low",
    finderRequest: search.confidence === "none" || search.confidence === "low"
      ? `Run one bounded read-only finder pass for: ${String(query).slice(0, 600)}. Return only paths, symbols, line ranges, evidence, and unknowns.`
      : undefined,
    text
  };
}

export async function buildTestImpact(cwd, changedFiles = [], options = {}) {
  const excludePatterns = requireExplicitExcludePatterns(options, "buildTestImpact");
  const projectRoot = fs.realpathSync.native(cwd);
  const directoryCache = new Map();
  const status = await contextIndexV2Status(cwd, { excludePatterns });
  const normalizedChanged = [...new Set((changedFiles.length > 0 ? changedFiles : gitChangedFiles(cwd)).map(normalizeRelative).filter(Boolean))];
  if (!status.exists) return { changedFiles: normalizedChanged, impactedFiles: [], tests: [], status };
  const db = await openDatabase(cwd, { create: false });
  try {
    const reverseStatement = db.prepare("SELECT file_path FROM imports WHERE target_path = ?");
    const queue = normalizedChanged.map((filePath) => ({ filePath, depth: 0 }));
    const seen = new Set(normalizedChanged);
    const impacted = [];
    const maxDepth = clampInteger(options.maxDepth, 3, 0, 8);
    while (queue.length > 0 && seen.size < 500) {
      const current = queue.shift();
      if (current.depth >= maxDepth) continue;
      for (const row of reverseStatement.all(current.filePath)) {
        if (
          !shouldIndexPath(row.file_path, { excludePatterns })
          || !projectFileInfo(cwd, row.file_path, projectRoot, directoryCache)
        ) continue;
        if (seen.has(row.file_path)) continue;
        seen.add(row.file_path);
        impacted.push({ path: row.file_path, via: current.filePath, depth: current.depth + 1 });
        queue.push({ filePath: row.file_path, depth: current.depth + 1 });
      }
    }
    const allFiles = db.prepare("SELECT path FROM files").all()
      .map((row) => row.path)
      .filter((filePath) => (
        shouldIndexPath(filePath, { excludePatterns })
        && projectFileInfo(cwd, filePath, projectRoot, directoryCache)
      ));
    const stemTerms = normalizedChanged.flatMap((filePath) => {
      const basename = path.posix.basename(filePath, path.posix.extname(filePath)).replace(/\.(?:test|spec)$/, "");
      return basename.split(/[-_.]/).filter((term) => term.length >= 3);
    });
    const tests = allFiles
      .filter((filePath) => /(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test|\.spec|_test)\./i.test(filePath))
      .filter((filePath) => stemTerms.some((term) => filePath.toLowerCase().includes(term.toLowerCase())) || seen.has(filePath))
      .slice(0, 80);
    return { changedFiles: normalizedChanged, impactedFiles: impacted, tests, status };
  } finally {
    db.close();
  }
}

export function appendContextTelemetry(cwd, event) {
  const paths = contextEnginePaths(cwd);
  fs.mkdirSync(paths.root, { recursive: true });
  const record = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    source: "piagent",
    recordedAt: nowIso(),
    ...event
  };
  fs.appendFileSync(paths.telemetry, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

export function readContextTelemetry(cwd, options = {}) {
  const target = contextEnginePaths(cwd).telemetry;
  if (!fs.existsSync(target)) return [];
  const limit = clampInteger(options.limit, MAX_TELEMETRY_EVENTS, 1, MAX_TELEMETRY_EVENTS);
  const maxBytes = clampInteger(options.maxBytes, MAX_TELEMETRY_READ_BYTES, 64 * 1024, 256 * 1024 * 1024);
  const stat = fs.statSync(target);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = fs.openSync(target, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, start);
  } finally {
    fs.closeSync(descriptor);
  }
  let text = buffer.toString("utf8");
  if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
  const lines = text.split(/\r?\n/).filter(Boolean);
  const events = [];
  for (const line of lines.slice(-limit)) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Ignore one incomplete tail record after an interrupted append.
    }
  }
  return events;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

export function buildContextEfficiencyReport(cwd, options = {}) {
  const events = readContextTelemetry(cwd, options);
  const prompts = events.filter((event) => event.event === "agent_prompt");
  const toolCalls = events.filter((event) => event.event === "tool_call");
  const toolResults = events.filter((event) => event.event === "tool_result");
  const packs = events.filter((event) => event.event === "context_pack");
  const compactions = events.filter((event) => event.event === "session_compact");
  const seenReads = new Set();
  let duplicateReads = 0;
  let readCalls = 0;
  for (const event of toolCalls) {
    if (!["read", "grep", "find", "ls"].includes(event.toolName)) continue;
    readCalls += 1;
    const key = `${event.toolName}:${event.targetHash ?? event.inputHash ?? ""}`;
    if (seenReads.has(key)) duplicateReads += 1;
    else seenReads.add(key);
  }
  const outputChars = toolResults.reduce((sum, event) => sum + Number(event.outputChars ?? 0), 0);
  const duplicateOutputChars = toolResults.reduce((sum, event) => sum + (event.repeated ? Number(event.outputChars ?? 0) : 0), 0);
  const averageActiveTools = prompts.length > 0
    ? prompts.reduce((sum, event) => sum + Number(event.activeTools ?? 0), 0) / prompts.length
    : 0;
  const averageSystemPromptTokens = prompts.length > 0
    ? prompts.reduce((sum, event) => sum + Number(event.systemPromptTokens ?? 0), 0) / prompts.length
    : 0;
  const averageToolSchemaTokens = prompts.length > 0
    ? prompts.reduce((sum, event) => sum + Number(event.toolSchemaTokens ?? 0), 0) / prompts.length
    : 0;
  const lowConfidencePacks = packs.filter((event) => ["none", "low"].includes(event.confidence)).length;
  const feedback = retrievalFeedback(cwd);
  const duplicateReadRate = ratio(duplicateReads, readCalls);
  const duplicateOutputRate = ratio(duplicateOutputChars, outputChars);
  const schemaShare = ratio(averageToolSchemaTokens, averageSystemPromptTokens);
  const lowConfidenceRate = ratio(lowConfidencePacks, packs.length);
  const activeToolPenalty = Math.max(0, Math.min(1, (averageActiveTools - 12) / 24));
  const wasteScore = Math.round(100 * (
    duplicateReadRate * 0.3
    + duplicateOutputRate * 0.25
    + Math.min(1, schemaShare * 3) * 0.2
    + lowConfidenceRate * 0.15
    + activeToolPenalty * 0.1
  ));
  const recommendations = [];
  if (duplicateReadRate > 0.2) recommendations.push("Repeated reads are high; reuse the current working set before searching again.");
  if (duplicateOutputRate > 0.15) recommendations.push("Repeated tool output is high; prefer delta results and narrower verification.");
  if (schemaShare > 0.15 || averageActiveTools > 20) recommendations.push("Tool surface is large; activate only the workflow groups needed for the next turn.");
  if (lowConfidenceRate > 0.4) recommendations.push("Retrieval confidence is low; rebuild the index or run one bounded finder pass.");
  if (feedback.selected >= 4 && feedback.utilizationRate < 0.45) recommendations.push("Context-pack utilization is low; reduce pack breadth or improve task-specific ranking signals.");
  if (recommendations.length === 0) recommendations.push("No dominant context waste signal was detected in the sampled events.");
  const report = {
    schemaVersion: 1,
    source: "piagent",
    generatedAt: nowIso(),
    sample: {
      events: events.length,
      prompts: prompts.length,
      toolCalls: toolCalls.length,
      toolResults: toolResults.length,
      contextPacks: packs.length,
      compactions: compactions.length
    },
    metrics: {
      averageActiveTools: Number(averageActiveTools.toFixed(2)),
      averageSystemPromptTokens: Math.round(averageSystemPromptTokens),
      averageToolSchemaTokens: Math.round(averageToolSchemaTokens),
      toolSchemaShare: Number(schemaShare.toFixed(4)),
      readCalls,
      duplicateReads,
      duplicateReadRate: Number(duplicateReadRate.toFixed(4)),
      outputChars,
      duplicateOutputChars,
      duplicateOutputRate: Number(duplicateOutputRate.toFixed(4)),
      lowConfidencePacks,
      lowConfidenceRate: Number(lowConfidenceRate.toFixed(4)),
      contextSelections: feedback.selected,
      contextSelectionsUsed: feedback.used,
      contextSelectionsUnused: feedback.unused,
      contextUtilizationRate: Number(feedback.utilizationRate.toFixed(4)),
      contextWasteScore: wasteScore
    },
    methodology: {
      scoreRange: "0-100; lower is better",
      weights: {
        duplicateReads: 0.3,
        duplicateOutput: 0.25,
        toolSchemaShare: 0.2,
        lowConfidenceRetrieval: 0.15,
        activeToolExcess: 0.1
      },
      retrievalFeedback: "Positive-only reranking: a path receives a weak boost only when a prior pack selected it and the same session later used it. Unseen and unused paths are not penalized.",
      note: "This is an operational signal, not a quality verdict. Compare it with task acceptance and verification results."
    },
    recommendations
  };
  const paths = contextEnginePaths(cwd);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

export function toolResultFingerprint(toolName, input, content) {
  const inputHash = sha256(JSON.stringify(input ?? {}));
  const text = Array.isArray(content)
    ? content.filter((block) => block && typeof block === "object" && block.type === "text").map((block) => block.text ?? "").join("\n")
    : String(content ?? "");
  return {
    key: `${toolName}:${inputHash}`,
    inputHash,
    outputHash: sha256(text),
    outputChars: text.length,
    outputLines: text ? text.split(/\r?\n/).length : 0
  };
}

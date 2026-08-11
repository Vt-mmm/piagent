import fs from "node:fs";
import path from "node:path";

import { sanitizeJavaScriptEvidence } from "./acceptance-contract-semantics.js";

export const ACCEPTANCE_LANGUAGE_ADAPTER_VERSION = "acceptance-language-adapters-v1";

const MAX_FILE_BYTES = 256 * 1024;
const JAVASCRIPT_TYPESCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"]);
const NEUTRAL_EXTENSIONS = new Set([
  ".json", ".jsonl", ".md", ".mdx", ".txt", ".yaml", ".yml", ".toml", ".lock", ".snap", ".css", ".scss", ".html", ".svg"
]);
const KNOWN_UNSUPPORTED_CODE_EXTENSIONS = new Set([
  ".py", ".pyi", ".go", ".rs", ".java", ".kt", ".kts", ".rb", ".php", ".cs", ".fs", ".fsx", ".swift", ".scala", ".sh", ".bash", ".zsh", ".fish", ".lua", ".r", ".dart", ".ex", ".exs", ".erl", ".hrl", ".clj", ".cljs", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".m", ".mm", ".vue", ".svelte"
]);

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function isAcceptanceTestPath(file) {
  return /(^|\/)(?:test|tests|spec|__tests__)(\/|$)|[._-](?:test|spec)\.[cm]?[jt]sx?$/i.test(String(file ?? ""));
}

export function acceptanceLanguageAdapterForPath(file) {
  const normalized = String(file ?? "").trim().replaceAll("\\", "/");
  if (!normalized || /[?*\[\]{}]/.test(normalized)) return { path: normalized, disposition: "unresolved", adapterId: null };
  const extension = path.posix.extname(normalized).toLowerCase();
  if (JAVASCRIPT_TYPESCRIPT_EXTENSIONS.has(extension)) {
    return { path: normalized, disposition: "supported", adapterId: "javascript-typescript-v1" };
  }
  if (NEUTRAL_EXTENSIONS.has(extension) || /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(normalized)) {
    return { path: normalized, disposition: "neutral", adapterId: null };
  }
  return {
    path: normalized,
    disposition: KNOWN_UNSUPPORTED_CODE_EXTENSIONS.has(extension) ? "unsupported" : "unresolved",
    adapterId: null
  };
}

export function acceptanceLanguageAdapterStatus(files) {
  const classified = uniqueStrings(files).map(acceptanceLanguageAdapterForPath);
  const supportedPaths = classified.filter((item) => item.disposition === "supported").map((item) => item.path);
  const neutralPaths = classified.filter((item) => item.disposition === "neutral").map((item) => item.path);
  const unsupportedPaths = classified.filter((item) => item.disposition === "unsupported").map((item) => item.path);
  const unresolvedPaths = classified.filter((item) => item.disposition === "unresolved").map((item) => item.path);
  const proofCapable = supportedPaths.length > 0 && unsupportedPaths.length === 0 && unresolvedPaths.length === 0;
  return {
    policyVersion: ACCEPTANCE_LANGUAGE_ADAPTER_VERSION,
    status: proofCapable ? "supported" : unsupportedPaths.length > 0 ? "unsupported" : unresolvedPaths.length > 0 ? "unresolved" : "neutral",
    proofCapable,
    adapterIds: proofCapable ? ["javascript-typescript-v1"] : [],
    supportedPaths,
    neutralPaths,
    unsupportedPaths,
    unresolvedPaths
  };
}

function readTextIfSmall(cwd, file) {
  try {
    const target = path.resolve(cwd, file);
    const relative = path.relative(cwd, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(target, "utf8");
  } catch {
    return "";
  }
}

export function emptyAcceptanceCorpus(files = []) {
  const normalizedFiles = uniqueStrings(files);
  return {
    files: normalizedFiles, testFiles: [], sourceFiles: [], testEntries: [], sourceEntries: [],
    testText: "", sourceText: "", allText: "", adapter: acceptanceLanguageAdapterStatus(normalizedFiles)
  };
}

export function changedFileAcceptanceCorpus(cwd, changedFiles) {
  const files = uniqueStrings(changedFiles);
  const corpus = emptyAcceptanceCorpus(files);
  const allText = [];
  for (const file of files) {
    const text = readTextIfSmall(cwd, file);
    if (!text) continue;
    allText.push(text);
    if (acceptanceLanguageAdapterForPath(file).disposition !== "supported") continue;
    const evidenceText = sanitizeJavaScriptEvidence(text);
    if (isAcceptanceTestPath(file)) {
      corpus.testFiles.push(file); corpus.testEntries.push({ path: file, text, evidenceText });
      corpus.testText += `${evidenceText}\n`;
    } else {
      corpus.sourceFiles.push(file); corpus.sourceEntries.push({ path: file, text, evidenceText });
      corpus.sourceText += `${evidenceText}\n`;
    }
  }
  corpus.testText = normalizedText(corpus.testText);
  corpus.sourceText = normalizedText(corpus.sourceText);
  corpus.allText = normalizedText(allText.join("\n"));
  return corpus;
}

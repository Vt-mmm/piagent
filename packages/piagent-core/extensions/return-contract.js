import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { normalizePathCandidate } from "./policy-core.js";

const MAX_FILE_BYTES = 256 * 1024;

function normalizedText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values) {
  return [...new Set(values.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
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

function gitBaselineText(cwd, file) {
  const normalized = normalizePathCandidate(file);
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) return "";
  try {
    const text = execFileSync("git", ["-C", cwd, "show", `HEAD:${normalized}`], {
      encoding: "utf8",
      maxBuffer: MAX_FILE_BYTES + 1,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000
    });
    return Buffer.byteLength(text, "utf8") <= MAX_FILE_BYTES ? text : "";
  } catch {
    return "";
  }
}

function matchingBrace(text, opening) {
  let depth = 0;
  for (let index = opening; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

function helperParameterComesFromProperty(text, resultVariable, identifier) {
  const declarations = /\bfunction\s+([a-z_$][a-z0-9_$]*)\s*\(([^)]*)\)\s*\{/g;
  for (const declaration of text.matchAll(declarations)) {
    const parameters = declaration[2].split(",").map((value) => value.trim());
    if (!parameters.includes(identifier)) continue;
    const opening = declaration.index + declaration[0].lastIndexOf("{");
    const closing = matchingBrace(text, opening);
    if (closing < 0) continue;
    const body = text.slice(opening + 1, closing);
    const pushesParameter = new RegExp(`\\b${escapeRegex(resultVariable)}\\.push\\s*\\(\\s*${escapeRegex(identifier)}\\s*\\)`).test(body);
    if (!pushesParameter) continue;
    const outside = `${text.slice(0, declaration.index)} ${text.slice(closing + 1)}`;
    const propertySeed = new RegExp(`\\b${escapeRegex(declaration[1])}\\s*\\(\\s*[a-z_$][a-z0-9_$]*\\.[a-z_$][a-z0-9_$]*\\s*\\)`).test(outside);
    if (propertySeed) return true;
  }
  return false;
}

export function returnedElementRepresentation(sourceText) {
  const text = normalizedText(sourceText);
  const returnedVariables = uniqueStrings([...text.matchAll(/\breturn\s+([a-z_$][a-z0-9_$]*)\s*;?/g)].map((match) => match[1]));
  const objectValuedMaps = new Set();
  const objectMapPattern = /\b(?:const|let|var)\s+([a-z_$][a-z0-9_$]*)\s*=\s*new\s+map\s*\(\s*[a-z_$][a-z0-9_$]*\.map\s*\(\s*\(?\s*([a-z_$][a-z0-9_$]*)\s*\)?\s*=>\s*\[\s*\2\.[a-z_$][a-z0-9_$]*\s*,\s*\2\s*\]\s*\)\s*\)/g;
  for (const match of text.matchAll(objectMapPattern)) objectValuedMaps.add(match[1]);
  const kinds = new Set();
  for (const variable of returnedVariables) {
    const pushPattern = new RegExp(`\\b${escapeRegex(variable)}\\.push\\s*\\(\\s*([^);\\n]{1,240})`, "g");
    for (const match of text.matchAll(pushPattern)) {
      const expression = match[1].trim();
      if ([...objectValuedMaps].some((mapName) => new RegExp(`^${escapeRegex(mapName)}\\.get\\s*\\(`).test(expression))) kinds.add("object");
      else if (/^[a-z_$][a-z0-9_$]*\.[a-z_$][a-z0-9_$]*\b/.test(expression)) kinds.add("name");
      else if (/^(?:[a-z_$][a-z0-9_$]*\s*\[|\{)/.test(expression)) kinds.add("object");
      else if (/^[a-z_$][a-z0-9_$]*$/.test(expression) && helperParameterComesFromProperty(text, variable, expression)) kinds.add("name");
    }
  }
  if (/\breturn\s+[a-z_$][a-z0-9_$]*\.map\s*\([^)]*=>\s*[a-z_$][a-z0-9_$]*\.[a-z_$][a-z0-9_$]*\b/.test(text)) kinds.add("name");
  if (/\breturn\s+[a-z_$][a-z0-9_$]*\.map\s*\([^)]*=>\s*[a-z_$][a-z0-9_$]*\s*\)/.test(text)) kinds.add("object");
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

function explicitlyChangesReturnRepresentation(taskText) {
  return /\b(?:change|replace)\b[^.\n]{0,80}\breturn (?:shape|representation)\b/.test(normalizedText(taskText));
}

export function baselineReturnRepresentationConflicts(taskText, cwd, sourceFiles) {
  if (explicitlyChangesReturnRepresentation(taskText)) return [];
  const conflicts = [];
  for (const file of sourceFiles) {
    const before = returnedElementRepresentation(gitBaselineText(cwd, file));
    const after = returnedElementRepresentation(readTextIfSmall(cwd, file));
    if (before && after && before !== after) {
      conflicts.push(`public-return-representation-changed:${before}-to-${after}:${normalizePathCandidate(file)}`);
    }
  }
  return conflicts;
}

export function returnRepresentationGuidance(taskText, cwd, sourceFiles) {
  if (explicitlyChangesReturnRepresentation(taskText)) return [];
  const guidance = [];
  for (const file of sourceFiles.slice(0, 12)) {
    const representation = returnedElementRepresentation(readTextIfSmall(cwd, file));
    if (!representation) continue;
    guidance.push(representation === "name"
      ? `Existing public return elements in ${normalizePathCandidate(file)} are names/identifiers, not object values; preserve that representation unless the request explicitly changes it.`
      : `Existing public return elements in ${normalizePathCandidate(file)} are object values, not names/identifiers; preserve that representation unless the request explicitly changes it.`);
  }
  return uniqueStrings(guidance).slice(0, 4);
}

import { protocolShape } from "./values.mjs";
import { NODE_PROFILE_IMPORTS, NODE_PROFILE_MODULE_SOURCES } from "./node-profile.mjs";

export const MAX_SOURCE_BYTES = 128 * 1024;
export const MAX_MODULE_FILES = 32;
const RESERVED = new Set([".", "..", ".git", ".pi", "node_modules"]);

export function isModulePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
    && !/[\\\u0000-\u001f\u007f:%?#]/.test(value)
    && value.split("/").every((part) => part && !RESERVED.has(part));
}

/** An explicit host-owned file allowlist, not import discovery or authority. */
export function validateModulePaths(entry, paths) {
  if (!isModulePath(entry) || !Array.isArray(paths) || paths.length >= MAX_MODULE_FILES
    || Object.keys(paths).length !== paths.length
    || !paths.every(isModulePath) || new Set([entry, ...paths]).size !== paths.length + 1) {
    throw new TypeError("Invalid approved module paths");
  }
  return [...paths].sort();
}

export function validateModuleGraph(source, graph, { nodeProfile = false } = {}) {
  protocolShape(graph, ["entry", "dependencies"]);
  if (!Array.isArray(graph.dependencies) || graph.dependencies.length >= MAX_MODULE_FILES) throw new TypeError("Invalid module graph");
  for (const file of graph.dependencies) {
    protocolShape(file, ["path", "source"]);
    if (typeof file.source !== "string") throw new TypeError("Invalid module source");
  }
  validateModulePaths(graph.entry, graph.dependencies.map((file) => file.path));
  if (nodeProfile && [graph.entry, ...graph.dependencies.map(file => file.path)].some(file => NODE_PROFILE_IMPORTS.includes(file))) {
    throw new TypeError("Candidate module shadows a profile import");
  }
  if (Buffer.byteLength(source) + graph.dependencies.reduce((size, file) => size + Buffer.byteLength(file.source), 0) > MAX_SOURCE_BYTES) {
    throw new TypeError("Module source budget exceeded");
  }
}

/** Hash this exact payload on both sides of the host snapshot/executor bridge. */
export function executionSourceText({ source, moduleGraph }) {
  if (!moduleGraph) return source;
  const files = [{ path: moduleGraph.entry, source }, ...moduleGraph.dependencies]
    .map(({ path, source }) => ({ path, source })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return `\u0000approved-module-graph-v1\u0000${JSON.stringify({ entry: moduleGraph.entry, files })}`;
}

/** Resolve only explicit relative ESM imports inside an in-memory allowlist. */
export function approvedModuleLoader({ source, moduleGraph, schemaVersion }, denied) {
  const files = new Map(moduleGraph ? [[moduleGraph.entry, source], ...moduleGraph.dependencies.map((file) => [file.path, file.source])] : []);
  const synthetic = schemaVersion === 2 ? NODE_PROFILE_MODULE_SOURCES : {};
  const refuse = () => { denied(); throw new Error("Module import is outside the approved graph"); };
  return {
    load(name) { return Object.hasOwn(synthetic, name) ? synthetic[name] : files.has(name) ? files.get(name) : refuse(); },
    normalize(base, requested) {
      if (typeof requested === "string" && Object.hasOwn(synthetic, requested)) return requested;
      if (!files.has(base) || typeof requested !== "string" || requested.length > 1024
        || !/^(?:\.\/|\.\.\/)/.test(requested) || /[\\\u0000-\u001f\u007f:%?#]/.test(requested)) return refuse();
      const parts = base.split("/"); parts.pop();
      for (const part of requested.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") { if (!parts.length) return refuse(); parts.pop(); }
        else parts.push(part);
      }
      const normalized = parts.join("/");
      if (requested.endsWith("/") || !isModulePath(normalized) || !files.has(normalized)) return refuse();
      return normalized;
    }
  };
}

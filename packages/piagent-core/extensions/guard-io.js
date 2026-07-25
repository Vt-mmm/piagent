// Filesystem helpers shared by the guard and its domain modules.
// Deliberately dependency-free apart from node builtins so any domain module
// can import it without creating a cycle back through the guard.
import fs from "node:fs";
import path from "node:path";

/**
 * @template T
 * @param {string} filePath
 * @returns {T | undefined}
 */
export function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

// The package root carries the runtime policy; the platform root carries the
// adapter catalogue. They are usually the same directory but not always, so
// each is located by the marker that actually matters to the caller.
/** @param {string} startDir @returns {string} */
export function findPackageRoot(startDir) {
  return findRootWithMarker(startDir, "policies");
}

/** @param {string} startDir @returns {string} */
export function findPlatformRoot(startDir) {
  return findRootWithMarker(startDir, "adapters");
}

/** @param {string} startDir @param {string} marker @returns {string} */
function findRootWithMarker(startDir, marker) {
  let current = startDir;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json")) && fs.existsSync(path.join(current, marker))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractShellPathCandidates, normalizePathCandidate } from "./policy-core.js";
import { normalizeRelative } from "./shell-reach.ts";

// Where a path lands relative to the external source checkouts granted to this
// session (read-only roots under the shared cache).

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function grantedSourceCheckoutRootForPath(cwd: string, candidate: string, roots: string[]): string | undefined {
  if (roots.length === 0) return undefined;
  const absolute = path.resolve(cwd, normalizePathCandidate(candidate));
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(absolute);
  } catch {
    return undefined;
  }
  return roots.find((root) => inside(root, canonical));
}

// Folders a member points the agent to for reference (an @ mention, "read
// ~/Documents/old-shop"): their own files, external drives and the shared
// folder, read with read, grep, find or ls. Hidden entries of the home folder
// (shell files, histories, tool configs) and ~/Library (app data, mail,
// browser profiles) stay closed, as does AppData on Windows; a link is judged
// by where it leads.
export function referenceReadRootForPath(cwd: string, candidate: string): string | undefined {
  let target: string, home: string;
  try {
    target = fs.realpathSync.native(path.resolve(cwd, normalizePathCandidate(candidate)));
    home = fs.realpathSync.native(os.homedir());
  } catch {
    return undefined;
  }
  if (inside(home, target)) {
    const first = path.relative(home, target).split(path.sep)[0];
    return first.startsWith(".") || first === "Library" || first === "AppData" ? undefined : home;
  }
  return ["/Volumes", "/Users/Shared", "/private/tmp"].find((root) => inside(root, target));
}

// Pi's own file tools drop a leading @ (an @path mention) and expand ~ to the
// home folder before they open a path: check the path they will open.
export function piToolPathInput(input: Record<string, unknown>): Record<string, unknown> {
  const value = input.path;
  if (typeof value !== "string") return input;
  const bare = value.startsWith("@") ? value.slice(1) : value;
  const opened = bare === "~" ? os.homedir() : /^~[/\\]/.test(bare) ? path.join(os.homedir(), bare.slice(2)) : bare;
  return opened === value ? input : { ...input, path: opened };
}

// A shell command can name a file it is about to create. realpath fails for that
// file, so resolve its nearest existing parent instead; otherwise a new file in
// the cache, spelled through an alias such as /var for /private/var, escapes
// both the text match and the realpath match.
function shellTargetInsideGrantedSourceCheckout(cwd: string, candidate: string, roots: string[]): boolean {
  if (grantedSourceCheckoutRootForPath(cwd, candidate, roots)) return true;
  let parent = path.resolve(cwd, normalizePathCandidate(candidate));
  const rest: string[] = [];
  while (path.dirname(parent) !== parent) {
    rest.unshift(path.basename(parent));
    parent = path.dirname(parent);
    let canonical: string;
    try { canonical = fs.realpathSync.native(parent); } catch { continue; }
    const target = path.join(canonical, ...rest);
    return roots.some((root) => inside(root, target));
  }
  return false;
}

export function shellTouchesGrantedSourceCheckout(cwd: string, command: string, roots: string[]): boolean {
  if (roots.length === 0) return false;
  for (const root of roots) {
    const relative = path.relative(cwd, root).split(path.sep).join("/");
    if (command.includes(root) || (relative && command.includes(relative))) return true;
  }
  return extractShellPathCandidates(command)
    .some((candidate) => shellTargetInsideGrantedSourceCheckout(cwd, normalizeRelative(cwd, candidate) ?? candidate, roots));
}

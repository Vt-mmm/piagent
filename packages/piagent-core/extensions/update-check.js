import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Telling someone a new release exists is only useful if it costs them nothing.
// A session start that waits on the registry pays a network round trip every
// time Pi opens, for information that changes a few times a month, so the check
// never runs in the session's path: the session reads a cache file and, when
// that cache is old, leaves a detached process behind to refresh it. The notice
// lands on this session if the cache already knew, and on the next one if it did
// not.
//
// Everything read here comes from outside the process — a registry response and
// a file any local process can write — so the only value that ever reaches the
// terminal is a version string that matched RELEASE_VERSION. A registry that
// answers with a sentence, or a cache someone edited to carry one, produces no
// notice rather than a line of attacker-chosen text in the operator's terminal.

const HELPER_PACKAGE = "@piagent/platform";
const CACHE_FILE = "piagent-update-check.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 10_000;
const MAX_CACHE_BYTES = 4096;
const RELEASE_VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

/**
 * Whether this platform tree is an install rather than somebody's working copy.
 *
 * Identified by where it sits, not by what it contains. `pi install git:...`
 * clones the repository, so an install made the ordinary way carries a `.git`
 * directory and every other file a maintainer's checkout carries — there is no
 * mark inside the tree that separates them. What does separate them is that Pi
 * puts packages it installed under its own agent directory, and npm puts the
 * global helper under node_modules. A tree anywhere else is a working copy, and
 * telling its owner to install over it is worse than saying nothing.
 *
 * @param {string} platformRoot
 * @param {{home?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {boolean}
 */
export function isInstalledPlatform(platformRoot, options = {}) {
  if (typeof platformRoot !== "string" || platformRoot.length === 0) return false;
  if (platformRoot.split(path.sep).includes("node_modules")) return true;
  const env = options.env ?? process.env;
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  const base = options.home ?? os.homedir();
  const agentDir = configured || (typeof base === "string" && base.length > 0 ? path.join(base, ".pi", "agent") : undefined);
  if (!agentDir) return false;
  // Both sides are resolved before comparing. A home reached through a symlink
  // is ordinary — macOS reaches /var that way — and comparing one real path
  // against one symlinked path makes an install look like it is somewhere else.
  const relative = path.relative(realPath(agentDir), realPath(platformRoot));
  // Empty means the same directory, which is not a package inside it; a leading
  // `..` or an absolute result means the tree is somewhere else entirely.
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** @param {string} value @returns {string} */
function realPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/** @param {string} [home] @returns {string|undefined} */
export function updateCacheFile(home) {
  const base = home ?? os.homedir();
  if (typeof base !== "string" || base.length === 0) return undefined;
  return path.join(base, ".pi", CACHE_FILE);
}

/**
 * A release version and nothing else. Prereleases and build metadata are
 * rejected rather than parsed: this decides what to tell someone to install, and
 * nudging an operator onto a prerelease is not what the notice is for.
 * @param {unknown} value @returns {string|undefined}
 */
export function releaseVersion(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return RELEASE_VERSION.test(trimmed) ? trimmed : undefined;
}

/**
 * Compare two release versions numerically. `1.1.10` is after `1.1.9`, which
 * string ordering gets backwards.
 * @param {string} left @param {string} right @returns {number}
 */
export function compareReleaseVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return 0;
}

/** @param {string} [home] @returns {{latest?: string, checkedAt?: number}} */
export function readUpdateCache(home) {
  const file = updateCacheFile(home);
  if (!file) return {};
  try {
    // A cache larger than this is not something this code wrote.
    if (fs.statSync(file).size > MAX_CACHE_BYTES) return {};
    const document = JSON.parse(fs.readFileSync(file, "utf8"));
    const checkedAt = Date.parse(document?.checkedAt);
    return {
      latest: releaseVersion(document?.latest),
      checkedAt: Number.isFinite(checkedAt) ? checkedAt : undefined
    };
  } catch {
    return {};
  }
}

/** @param {string|undefined} home @param {string} latest @param {number} now @returns {boolean} */
export function writeUpdateCache(home, latest, now) {
  const file = updateCacheFile(home);
  const version = releaseVersion(latest);
  if (!file || !version) return false;
  const document = {
    schemaVersion: 1,
    package: HELPER_PACKAGE,
    latest: version,
    checkedAt: new Date(now).toISOString()
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the session should do about updates, decided from state alone so it can
 * be tested without a registry or a clock.
 * @param {{installed?: string, cache?: {latest?: string, checkedAt?: number}, now: number, env?: Record<string, string|undefined>}} options
 * @returns {{notice?: string, probe: boolean}}
 */
export function evaluateUpdateCheck(options) {
  const env = options.env ?? process.env;
  if (env.PIAGENT_NO_UPDATE_CHECK?.trim()) return { probe: false };

  const installed = releaseVersion(options.installed);
  const cache = options.cache ?? {};
  const latest = releaseVersion(cache.latest);
  const probe = !(typeof cache.checkedAt === "number" && options.now - cache.checkedAt < CACHE_TTL_MS);

  if (!installed || !latest || compareReleaseVersions(latest, installed) <= 0) return { probe };
  return {
    probe,
    notice: `Piagent update available: ${installed} -> ${latest}. Run \`piagent-update\` to move this machine to it.`
  };
}

/**
 * Leave the refresh behind and return. The child is detached with no inherited
 * stdio, so nothing it does can hold the session open or write into the
 * terminal.
 * @param {string} moduleFile @param {{spawn?: typeof spawn}} [options]
 * @returns {boolean}
 */
export function startUpdateProbe(moduleFile, options = {}) {
  try {
    const child = (options.spawn ?? spawn)(process.execPath, [moduleFile, "--probe"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** @returns {string|undefined} */
function fetchLatestVersion() {
  const result = spawnSync("npm", ["view", HELPER_PACKAGE, "version", "--json"], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  try {
    return releaseVersion(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

/** @param {{now?: number, home?: string, fetch?: () => string|undefined}} [options] @returns {boolean} */
export function runUpdateProbe(options = {}) {
  const latest = (options.fetch ?? fetchLatestVersion)();
  // A registry that could not be reached leaves the cache alone, so the next
  // session retries instead of recording "no update" as if it had been checked.
  if (!latest) return false;
  return writeUpdateCache(options.home, latest, options.now ?? Date.now());
}

if (process.argv[2] === "--probe" && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runUpdateProbe();
}

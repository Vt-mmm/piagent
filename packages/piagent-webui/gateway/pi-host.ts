import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function packageRootFrom(start: string): string | null {
  let current = path.dirname(start);
  while (current !== path.dirname(current)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === "@earendil-works/pi-coding-agent") return current;
    } catch {
      // Keep walking toward the package root.
    }
    current = path.dirname(current);
  }
  return null;
}

export function installedPiHostRoot(): string {
  try {
    const local = packageRootFrom(require.resolve("@earendil-works/pi-coding-agent"));
    if (local) return local;
  } catch {
    // The operator installation is normally global.
  }
  try {
    const executable = execFileSync("which", ["pi"], { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const found = packageRootFrom(fs.realpathSync(executable));
    if (found) return found;
  } catch {
    // A launcher with a short PATH (Agent Watch, launchd) cannot see `pi`.
  }
  // Then the host the installed CLI recorded, and the usual global prefixes.
  const home = os.homedir(), hostPackage = path.join("lib", "node_modules", "@earendil-works", "pi-coding-agent");
  let recorded: string | null = null;
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent");
    recorded = JSON.parse(fs.readFileSync(path.join(agentDir, "piagent-runtime.json"), "utf8")).pi_sdk_root ?? null;
  } catch { /* no record yet */ }
  // npm on Windows keeps global packages in %APPDATA%\npm\node_modules, or
  // beside node.exe, with no lib folder.
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
  const windowsHosts = process.platform !== "win32" ? []
    : [path.join(appData, "npm"), path.dirname(process.execPath)].map((prefix) => path.join(prefix, "node_modules", "@earendil-works", "pi-coding-agent"));
  for (const candidate of [recorded, path.join(home, ".pi", "npm-global", hostPackage), path.join(home, ".local", hostPackage),
    path.join("/opt/homebrew", hostPackage), path.join("/usr/local", hostPackage), ...windowsHosts]) {
    if (!candidate) continue;
    const found = packageRootFrom(path.join(candidate, "package.json"));
    if (found) return found;
  }
  throw new Error("pi-host-unavailable");
}

export async function loadPinnedPiHost(expectedVersion: string): Promise<any> {
  const root = installedPiHostRoot();
  const actual = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
  if (actual.version !== expectedVersion) throw new Error("pi-host-version-mismatch");
  return await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
}

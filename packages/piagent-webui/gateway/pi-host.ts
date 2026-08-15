import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
  const executable = execFileSync("which", ["pi"], { encoding: "utf8", timeout: 2_000 }).trim();
  const found = packageRootFrom(fs.realpathSync(executable));
  if (!found) throw new Error("pi-host-unavailable");
  return found;
}

export async function loadPinnedPiHost(expectedVersion: string): Promise<any> {
  const root = installedPiHostRoot();
  const actual = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: string };
  if (actual.version !== expectedVersion) throw new Error("pi-host-version-mismatch");
  return await import(pathToFileURL(path.join(root, "dist", "index.js")).href);
}

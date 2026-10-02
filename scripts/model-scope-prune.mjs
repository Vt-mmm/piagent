#!/usr/bin/env node
// Patterns in Pi's enabledModels that match no model Pi knows. Pi prints
// "Warning: No models match pattern" for each one on every start, and a model
// that left the catalog never comes back by itself. Matching uses Pi's own
// resolver over every model Pi knows (built-in and models.json), signed in or
// not, so a provider that is only signed out keeps its patterns.
//
// Usage: model-scope-prune.mjs [--settings <path>] [--fix] [--json]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// The Pi install `pi` runs from.
export function piPackageRoot(environment = process.env) {
  try {
    const bin = execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8", env: environment }).trim();
    let dir = path.dirname(fs.realpathSync(bin));
    for (let depth = 0; depth < 4; depth += 1, dir = path.dirname(dir)) {
      const manifest = path.join(dir, "package.json");
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@earendil-works/pi-coding-agent") return dir;
    }
  } catch { /* no pi on PATH */ }
  return null;
}

// Every model Pi knows, without network or credentials.
export async function knownModels(piRoot, agentDir) {
  const { ModelRuntime } = await import(pathToFileURL(path.join(piRoot, "dist/core/model-runtime.js")).href);
  const { InMemoryCredentialStore } = await import(pathToFileURL(path.join(piRoot, "dist/index.js")).href).catch(() => ({}));
  const previous = process.env.PI_OFFLINE; process.env.PI_OFFLINE = "1";
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: path.join(agentDir, "models.json"),
      ...(InMemoryCredentialStore ? { credentials: new InMemoryCredentialStore() } : {}) });
    return runtime.getProviders().flatMap((provider) => runtime.getModels(provider.id ?? provider));
  } finally { if (previous === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previous; }
}

export async function stalePatterns(patterns, models, piRoot) {
  const { resolveModelScopeFromModels } = await import(pathToFileURL(path.join(piRoot, "dist/core/model-resolver.js")).href);
  const { diagnostics } = resolveModelScopeFromModels(patterns, models);
  return [...new Set(diagnostics.filter((item) => item.code === "no-match").map((item) => item.pattern))];
}

// Removes only the stale patterns; everything else in the file stays as written.
export function pruneSettings(settingsPath, stale) {
  const text = fs.readFileSync(settingsPath, "utf8"), settings = JSON.parse(text);
  const kept = settings.enabledModels.filter((pattern) => !stale.includes(pattern));
  const next = `${JSON.stringify({ ...settings, enabledModels: kept }, null, 2)}\n`;
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, next, { mode: fs.statSync(settingsPath).mode & 0o777 });
  fs.renameSync(temporary, settingsPath);
  return kept.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2), at = args.indexOf("--settings");
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME ?? "", ".pi", "agent");
  const settingsPath = at >= 0 && args[at + 1] ? path.resolve(args[at + 1]) : path.join(agentDir, "settings.json");
  const json = args.includes("--json"), fix = args.includes("--fix");
  const out = (value, text) => process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${text}\n`);
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
  const patterns = Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((item) => typeof item === "string") : [];
  const piRoot = piPackageRoot();
  if (!piRoot) { out({ status: "unavailable", reason: "pi-not-found" }, "Pi is not on PATH; nothing checked."); process.exit(0); }
  if (patterns.length === 0) { out({ status: "ok", stale: [] }, "enabledModels is empty; nothing to prune."); process.exit(0); }
  const stale = await stalePatterns(patterns, await knownModels(piRoot, path.dirname(settingsPath)), piRoot);
  if (stale.length === 0) { out({ status: "ok", stale: [] }, `All ${patterns.length} enabledModels patterns match a model Pi knows.`); process.exit(0); }
  if (!fix) {
    out({ status: "stale", stale }, `${stale.length} enabledModels pattern(s) match no model Pi knows:\n${stale.map((item) => `  - ${item}`).join("\n")}\nRun with --fix to remove only these.`);
    process.exit(0);
  }
  const kept = pruneSettings(settingsPath, stale);
  out({ status: "pruned", stale, kept }, `Removed ${stale.length} pattern(s) from ${settingsPath}; ${kept} kept.`);
}

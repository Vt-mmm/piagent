#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptByCommand = {
  "piagent-setup": "scripts/setup.sh",
  "piagent-install": "scripts/install-global.sh",
  "piagent-update": "scripts/update-global.mjs",
  "piagent-uninstall": "scripts/uninstall-global.sh",
  "piagent-init": "scripts/init-project.sh",
  "piagent-doctor": "scripts/team-doctor.sh",
  "piagent-benchmark": "scripts/benchmark-runner.mjs",
  "piagent-usage": "scripts/pi-session-stats.sh",
  "piagent-models": "scripts/pi-model-catalog.sh",
  "piagent-route": "scripts/pi-model-route.mjs",
  "piagent-model-scope": "scripts/configure-model-scope.sh",
  "piagent-mcp": "scripts/mcp-manage.mjs",
  "piagent-subagents": "scripts/configure-subagents.sh",
  "piagent-capabilities": "scripts/capability-catalog.mjs",
  "piagent-migrate": "scripts/migrate-project-state.mjs",
  "piagent-import-instructions": "scripts/import-agent-instructions.mjs",
  "piagent-auto": "scripts/pi-auto.sh",
  "piagent-context": "scripts/context-engine.mjs",
  "piagent-webui": "scripts/piagent-webui-launcher.mjs",
  "piagent-dashboard": "scripts/piagent-dashboard.mjs"
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const invokedAs = path.basename(process.argv[1] ?? "");
let forwardedArgs = process.argv.slice(2);
let script = scriptByCommand[invokedAs];

if (invokedAs === "piagent") {
  const subcommand = forwardedArgs[0];
  if (subcommand === "dashboard") {
    script = "scripts/piagent-dashboard.mjs";
    forwardedArgs = forwardedArgs.slice(1);
  } else if ([undefined, "help", "--help", "-h"].includes(subcommand)) {
    console.log("Usage: piagent dashboard [open|status|stop|restart|doctor] [--no-open] [--json]");
    process.exit(0);
  }
}

if (!script) {
  console.error(`Unknown Pi Agent command: ${invokedAs || "(unknown)"}`);
  console.error(`Expected one of: ${Object.keys(scriptByCommand).sort().join(", ")}`);
  process.exit(2);
}

function benchmarkSourceRoot() {
  if (fs.existsSync(path.join(packageRoot, ".git"))) return packageRoot;
  if (process.argv.slice(2).some((value) => value === "--help" || value === "-h")) return packageRoot;
  const agentRoot = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  const installed = path.join(agentRoot, "git", "github.com", "Vt-mmm", "piagent");
  try {
    const helperVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
    const installedVersion = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version;
    if (helperVersion === installedVersion && fs.existsSync(path.join(installed, ".git"))) return installed;
  } catch {
    // The controlled error below explains how to materialize the exact source.
  }
  console.error("piagent-benchmark requires the matching exact Pi package source. Run piagent-install --stable first.");
  process.exit(1);
}

const sourceRoot = invokedAs === "piagent-benchmark" ? benchmarkSourceRoot() : packageRoot;
const target = path.join(sourceRoot, script);
const runner = target.endsWith(".mjs") ? process.execPath : "bash";
const runnerArgs = target.endsWith(".mjs")
  ? ["--disable-warning=ExperimentalWarning", "--import", path.join(sourceRoot, "scripts", "register-typescript-loader.mjs"), target]
  : [target];
const child = spawn(runner, [...runnerArgs, ...forwardedArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.once("error", (error) => {
  const code = error && typeof error === "object" && "code" in error ? ` (${error.code})` : "";
  console.error(`Pi Agent command could not start ${runner}${code}. Ensure it is installed and available on PATH.`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

#!/usr/bin/env node
import { spawn } from "node:child_process";
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
  "piagent-model-scope": "scripts/configure-model-scope.sh",
  "piagent-mcp": "scripts/mcp-manage.mjs",
  "piagent-subagents": "scripts/configure-subagents.sh",
  "piagent-capabilities": "scripts/capability-catalog.mjs",
  "piagent-migrate": "scripts/migrate-project-state.mjs",
  "piagent-import-instructions": "scripts/import-agent-instructions.mjs",
  "piagent-auto": "scripts/pi-auto.sh",
  "piagent-context": "scripts/context-engine.mjs"
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const invokedAs = path.basename(process.argv[1] ?? "");
const script = scriptByCommand[invokedAs];

if (!script) {
  console.error(`Unknown Pi Agent command: ${invokedAs || "(unknown)"}`);
  console.error(`Expected one of: ${Object.keys(scriptByCommand).sort().join(", ")}`);
  process.exit(2);
}

const target = path.join(packageRoot, script);
const runner = target.endsWith(".mjs") ? process.execPath : "bash";
const child = spawn(runner, [target, ...process.argv.slice(2)], {
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

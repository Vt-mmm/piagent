#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "piagent-explain": "scripts/explain-command.mjs",
  "piagent-webui": "scripts/piagent-webui-launcher.mjs",
  "piagent-dashboard": "scripts/piagent-dashboard.mjs"
};

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const invokedAs = path.basename(process.argv[1] ?? "");
let forwardedArgs = process.argv.slice(2);
let script = scriptByCommand[invokedAs];

if (invokedAs === "piagent") {
  const subcommand = forwardedArgs[0];
  if (subcommand === "studio") {
    script = "scripts/piagent-studio.mjs";
    forwardedArgs = forwardedArgs.slice(1);
  } else if (subcommand === "dashboard") {
    script = "scripts/piagent-dashboard.mjs";
    forwardedArgs = forwardedArgs.slice(1);
  } else if (subcommand === "explain") {
    script = "scripts/explain-command.mjs";
    forwardedArgs = forwardedArgs.slice(1);
  } else if (subcommand === "approve-verification") {
    script = "scripts/approve-independent-verification.mjs";
    forwardedArgs = forwardedArgs.slice(1);
  } else if (subcommand === "select-verification") {
    script = "scripts/select-independent-verification.mjs";
    forwardedArgs = forwardedArgs.slice(1);
  } else if (subcommand && Object.hasOwn(scriptByCommand, `piagent-${subcommand}`)) {
    // `piagent doctor` is `piagent-doctor`: members type it both ways.
    script = scriptByCommand[`piagent-${subcommand}`];
    forwardedArgs = forwardedArgs.slice(1);
  } else if ([undefined, "help", "--help", "-h"].includes(subcommand)) {
    // Subcommands are listed, their flags are not. Restating them here meant a
    // second copy that drifts: this line still advertised the dashboard without
    // `--repair` after that flag shipped. Each command states its own surface.
    console.log("Usage: piagent <command> [options]");
    console.log("");
    console.log("Commands:");
    console.log("  dashboard   Open and manage the local session hub");
    console.log("  studio      Open the managed company agent imported by Agent Watch");
    console.log("  explain     Say why the guard would allow or block a shell command");
    console.log("  approve-verification  Preview or approve an independent verification plan");
    console.log("  select-verification   Preview reusable contracts for exact task criteria");
    console.log("");
    console.log("Run `piagent <command> --help` for that command's options.");
    process.exit(0);
  }
}

if (!script) {
  console.error(`Unknown Pi Agent command: ${[invokedAs || "(unknown)", invokedAs === "piagent" ? forwardedArgs[0] : ""].filter(Boolean).join(" ")}`);
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

// The Pi host this member runs: the `pi` found on PATH, as its package root.
function piHost() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    let root;
    try { root = path.dirname(fs.realpathSync(path.join(dir, "pi"))); } catch { continue; }
    for (let depth = 0; depth < 4; depth += 1, root = path.dirname(root)) {
      try { if (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return root; } catch { /* keep walking up */ }
    }
  }
  return null;
}

// Agent Watch binds the company runtime to the Piagent this member actually
// runs (nvm, Volta, Homebrew, a custom npm prefix…): record the installed
// entrypoint, the Node running it and the Pi host. Source checkouts never
// register, and a failure here never blocks the command. Asking for help or the
// version changes nothing in the operator's agent directory.
function recordRuntime() {
  try {
    if (forwardedArgs.some((value) => ["--help", "-h", "--version", "-v"].includes(value))) return;
    if (!packageRoot.split(path.sep).includes("node_modules")) return;
    // An install under the OS temporary directory (a packaging test, a scratch
    // prefix) is about to disappear; recording it would point Agent Watch at
    // an entrypoint that no longer exists.
    const osTemp = fs.realpathSync.native(os.tmpdir()), installRoot = fs.realpathSync.native(packageRoot);
    if (installRoot === osTemp || installRoot.startsWith(`${osTemp}${path.sep}`)) return;
    const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
    if (!fs.statSync(agentDir).isDirectory()) return;
    const body = `${JSON.stringify({
      schema_version: 1,
      version: JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version,
      entrypoint: fs.realpathSync(path.join(packageRoot, "scripts", "piagent-studio.mjs")),
      node: fs.realpathSync(process.execPath),
      pi_sdk_root: piHost()
    }, null, 2)}\n`;
    const file = path.join(agentDir, "piagent-runtime.json");
    try { if (fs.readFileSync(file, "utf8") === body) return; } catch { /* first run */ }
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, body, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch { /* optional: Agent Watch falls back to known install locations */ }
}
recordRuntime();

const sourceRoot = invokedAs === "piagent-benchmark" ? benchmarkSourceRoot() : packageRoot;
const target = path.join(sourceRoot, script);
const runner = target.endsWith(".mjs") ? process.execPath : "bash";
const runnerArgs = target.endsWith(".mjs")
  ? ["--disable-warning=ExperimentalWarning", "--import", pathToFileURL(path.join(sourceRoot, "scripts", "register-typescript-loader.mjs")).href, target]
  : [target];
const child = spawn(runner, [...runnerArgs, ...forwardedArgs], {
  cwd: process.cwd(),
  env: script === "scripts/piagent-studio.mjs" ? { PATH: "/usr/bin:/bin", HOME: os.homedir(), TERM: process.env.TERM || "xterm-256color", LANG: "en_US.UTF-8" } : process.env,
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

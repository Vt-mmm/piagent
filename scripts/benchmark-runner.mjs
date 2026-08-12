#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  benchmarkBootstrapEnvironment,
  cleanupBenchmarkExecutionSnapshot,
  createBenchmarkExecutionSnapshot
} from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { assertBenchmarkLaunchEnvironmentSafe } from "../packages/piagent-core/benchmark/benchmark-runtime.js";

const liveRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function legacyInvocation(argv) {
  return argv.includes("--record") || argv.includes("--init");
}

function terminate(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The child may have already completed between the signal and forwarding.
  }
}

function runChild(script, argv, env, cleanup) {
  return new Promise((resolve, reject) => {
    const loader = path.join(path.dirname(script), "register-typescript-loader.mjs");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", loader, script, ...argv], {
      cwd: process.cwd(),
      env,
      detached: process.platform !== "win32",
      stdio: "inherit"
    });
    const handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => terminate(child, signal);
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const finish = () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      cleanup?.();
    };
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", (code, signal) => {
      try { finish(); }
      catch (error) { reject(error); return; }
      if (spawnError) { reject(spawnError); return; }
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (legacyInvocation(argv) || argv.includes("--help") || argv.includes("-h")) {
    return runChild(path.join(liveRoot, "scripts", "benchmark-runner-core.mjs"), argv, process.env);
  }
  assertBenchmarkLaunchEnvironmentSafe();
  const snapshot = createBenchmarkExecutionSnapshot({ liveRoot, argv, cwd: process.cwd() });
  const script = path.join(snapshot.candidateRoot, "scripts", "benchmark-runner-core.mjs");
  return runChild(
    script,
    argv,
    benchmarkBootstrapEnvironment(snapshot.metadata),
    () => cleanupBenchmarkExecutionSnapshot(snapshot.temporaryRoot, snapshot.runtimeParent, snapshot.metadata.piAgentHome)
  );
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });

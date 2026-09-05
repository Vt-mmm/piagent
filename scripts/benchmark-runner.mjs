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
import fs from "node:fs";
import os from "node:os";
import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { readBenchmarkBudgetControl } from "./benchmark-budget-runtime.mjs";
import { startBenchmarkBudgetLaunch } from "./benchmark-budget-launcher.mjs";
import { assertBenchmarkBudgetParentReceipts, finalizeBenchmarkBudgetPublication } from "./benchmark-budget-publication.mjs";

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

export function runBenchmarkChild(script, argv, env, cleanup, budgetLaunch) {
  return new Promise((resolve, reject) => {
    const loader = path.join(path.dirname(script), "register-typescript-loader.mjs");
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", loader, script, ...argv], {
      cwd: process.cwd(),
      env,
      detached: process.platform !== "win32",
      stdio: budgetLaunch ? ["inherit", "inherit", "inherit", "ipc"] : "inherit"
    });
    const handlers = new Map();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = () => { if (budgetLaunch) budgetLaunch.terminate(signal); else terminate(child, signal); };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    const finish = (cleanupAllowed = true) => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      if (cleanupAllowed) cleanup?.();
    };
    let spawnError;
    child.once("error", (error) => { spawnError = error; });
    child.once("close", async (code, signal) => {
      try {
        let drained, cleanupAllowed = false;
        try { drained = await budgetLaunch?.drain(); cleanupAllowed = !drained || drained.cleanupConfirmed === true; }
        catch (error) { error.preserveBenchmarkSnapshot = true; throw error; }
        finally { finish(cleanupAllowed); }
        if (drained && !drained.cleanupConfirmed) {
          throw Object.assign(new Error("Benchmark child process cleanup could not be confirmed; private snapshot retained"),
            { preserveBenchmarkSnapshot: true });
        }
      }
      catch (error) { reject(error); return; }
      if (spawnError) { reject(spawnError); return; }
      if (signal) {
        resolve(128 + (os.constants.signals[signal] ?? 1));
        return;
      }
      resolve(code ?? 1);
    });
    try { budgetLaunch?.supervise(child); }
    catch (error) { spawnError = error; terminate(child, "SIGTERM"); }
  });
}

// No cleanup/finalizer error may replace an earlier child error. A budgeted
// report remains provisional unless every outer step and the durable receipt
// succeed; a valid quality-failure exit code is not itself an outer failure.
export async function completeBenchmarkOuterStage({ snapshot, preserveSnapshot = false, launch, control,
  childExitCode, primaryError, cleanupSnapshot = cleanupBenchmarkExecutionSnapshot,
  finalizePublication = finalizeBenchmarkBudgetPublication,
  writeAccounting = accounting => process.stdout.write(`Budget stage accounting: ${JSON.stringify(accounting)}\n`) }) {
  const outerErrorCodes = primaryError ? ["child-execution-error"] : [];
  const remember = (error, code) => { primaryError ??= error; outerErrorCodes.push(code); };
  let cleanupSucceeded = !snapshot, accounting = null, publication = null;
  if (snapshot && !preserveSnapshot) {
    try { await cleanupSnapshot(snapshot.temporaryRoot, snapshot.runtimeParent, snapshot.metadata.piAgentHome); cleanupSucceeded = true; }
    catch (error) { remember(error, "snapshot-cleanup-failed"); }
  } else if (snapshot) {
    remember(new Error("Private benchmark snapshot retained because process cleanup is unconfirmed"), "snapshot-cleanup-unconfirmed");
  }
  if (launch) {
    try {
      accounting = launch.finish();
      if (!accounting.launcherSucceeded) remember(Object.assign(
        new Error(`Benchmark launcher stopped: ${accounting.launcherErrors.join(", ")}`), { exitCode: 1 }), "launcher-failed");
    } catch (error) { remember(error, "budget-finalizer-failed"); }
    if (accounting) {
      try { await writeAccounting(accounting); } catch (error) { remember(error, "accounting-output-failed"); }
    }
    try {
      publication = await finalizePublication({ control, stageId: JSON.parse(launch.context).stageId,
        launcherReceipt: accounting, childExitCode: childExitCode ?? null,
        outerSucceeded: !primaryError && cleanupSucceeded && accounting?.launcherSucceeded === true,
        outerErrorCodes: [...outerErrorCodes] });
      if (publication?.closureAllowed !== true) remember(Object.assign(
        new Error("Benchmark parent receipt did not authorize stage closure"), { exitCode: 1 }), "budget-publication-denied");
    } catch (error) { remember(error, "budget-publication-failed"); }
  }
  if (primaryError) {
    primaryError.benchmarkOuterErrorCodes = outerErrorCodes;
    throw primaryError;
  }
  return { code: childExitCode ?? 1, accounting, publication };
}

async function main() {
  const argv = process.argv.slice(2);
  if (legacyInvocation(argv) || argv.includes("--help") || argv.includes("-h")) {
    return runBenchmarkChild(path.join(liveRoot, "scripts", "benchmark-runner-core.mjs"), argv, process.env);
  }
  assertBenchmarkLaunchEnvironmentSafe();
  const options = parseBenchmarkArgs(argv);
  const resumeManifest = options.resume
    ? JSON.parse(fs.readFileSync(path.join(options.resume, "run-manifest.json"), "utf8")) : undefined;
  const control = readBenchmarkBudgetControl({ options, resumeManifest, sourceRoot: liveRoot });
  if (control && !options.dryRun && !options.preflightOnly) assertBenchmarkBudgetParentReceipts(control);
  const launch = !options.dryRun && !options.preflightOnly
    ? startBenchmarkBudgetLaunch(control, { resume: Boolean(options.resume) }) : null;
  let snapshot, preserveSnapshot = false, childExitCode, primaryError;
  try {
    launch?.assertReady();
    snapshot = createBenchmarkExecutionSnapshot({ liveRoot, argv, cwd: process.cwd() });
    const script = path.join(snapshot.candidateRoot, "scripts", "benchmark-runner-core.mjs");
    const environment = benchmarkBootstrapEnvironment(snapshot.metadata);
    if (launch) environment[launch.environmentKey] = launch.context;
    launch?.assertReady();
    childExitCode = await runBenchmarkChild(script, argv, environment, undefined, launch);
  } catch (error) {
    preserveSnapshot = error.preserveBenchmarkSnapshot === true;
    primaryError = error;
  }
  const completion = await completeBenchmarkOuterStage({ snapshot, preserveSnapshot, launch, control, childExitCode, primaryError });
  return completion.code;
}

if (process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = error.exitCode ?? 1;
  });

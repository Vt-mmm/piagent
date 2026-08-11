import crypto from "node:crypto";
import { spawn } from "node:child_process";

const outputLimit = 4 * 1024 * 1024;

function terminateGroup(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // The process group may already have exited.
  }
}

function groupAlive(child) {
  if (process.platform === "win32" || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createBenchmarkProcessController(interrupted) {
  const active = new Set();
  const killTimers = new Map();
  const scheduleKill = (child, delay) => {
    const prior = killTimers.get(child);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => { killTimers.delete(child); terminateGroup(child, "SIGKILL"); }, delay);
    timer.unref();
    killTimers.set(child, timer);
  };
  const terminateAll = (signal) => {
    for (const child of active) {
      terminateGroup(child, signal);
      scheduleKill(child, 2_000);
    }
  };
  const run = (command, args, options = {}) => new Promise((resolve, reject) => {
    if (interrupted()) {
      reject(new Error("Benchmark was interrupted before the child process started"));
      return;
    }
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    active.add(child);
    const cleanup = () => {
      active.delete(child);
      const killTimer = killTimers.get(child);
      if (killTimer) clearTimeout(killTimer);
      killTimers.delete(child);
    };
    if (!options.inherit && options.input !== undefined) {
      child.stdin.on("error", () => { /* Child exit is reported by the process result. */ });
      child.stdin.end(String(options.input));
    }
    let stdout = "";
    let stderr = "";
    const stdoutDigest = crypto.createHash("sha256");
    const forbidden = [...new Set(options.forbiddenSubstrings ?? [])].filter((value) => typeof value === "string" && value);
    const required = [...new Set(options.requiredSubstrings ?? [])].filter((value) => typeof value === "string" && value);
    const forbiddenHits = new Set();
    const requiredHits = new Set();
    const scanTails = { stdout: "", stderr: "" };
    const scanWindow = Math.max(0, ...[...forbidden, ...required].map((value) => value.length - 1));
    const append = (current, chunk) => `${current}${chunk}`.slice(-outputLimit);
    const inspect = (stream, chunk) => {
      const text = `${scanTails[stream]}${chunk}`;
      for (const value of forbidden) if (text.includes(value)) forbiddenHits.add(value);
      if (stream === "stdout") for (const value of required) if (text.includes(value)) requiredHits.add(value);
      scanTails[stream] = scanWindow > 0 ? text.slice(-scanWindow) : "";
    };
    if (!options.inherit) {
      child.stdout.on("data", (chunk) => {
        stdoutDigest.update(chunk);
        options.onStdoutChunk?.(chunk);
        inspect("stdout", chunk);
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        inspect("stderr", chunk);
        stderr = append(stderr, chunk);
      });
    }
    let timedOut = false;
    const timer = options.timeoutMs ? setTimeout(() => {
      timedOut = true;
      terminateGroup(child, "SIGTERM");
      scheduleKill(child, 2_000);
    }, options.timeoutMs) : undefined;
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanup();
      terminateGroup(child, "SIGTERM");
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      terminateGroup(child, "SIGTERM");
      scheduleKill(child, 500);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ code: code ?? 1, signal, timedOut, stdout, stdoutHash: options.inherit ? undefined : stdoutDigest.digest("hex"), stderr, forbiddenHits: [...forbiddenHits], requiredHits: [...requiredHits], durationSeconds: (Date.now() - started) / 1000 });
      };
      if (!groupAlive(child)) {
        finish();
        return;
      }
      // A detached descendant can close its inherited stdio before exiting. Keep
      // the process group owned until TERM has had time to work and the bounded
      // KILL escalation has run, rather than treating stream close as cleanup.
      const deadline = Date.now() + 1_000;
      const drain = () => {
        if (!groupAlive(child)) finish();
        else if (Date.now() >= deadline) {
          settled = true;
          cleanup();
          reject(new Error(`Benchmark child process group ${child.pid} survived bounded SIGKILL cleanup`));
        } else setTimeout(drain, 20);
      };
      setTimeout(drain, 20);
    });
  });
  return { run, terminateAll };
}

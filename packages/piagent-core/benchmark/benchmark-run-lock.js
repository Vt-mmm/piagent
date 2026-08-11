import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function fail(message) {
  const error = new Error(message);
  error.code = "BENCHMARK_RUN_LOCKED";
  error.exitCode = 1;
  throw error;
}

function recoveryClaim(file) {
  const claim = `${file}.recovery`;
  let descriptor;
  for (let attempt = 0; attempt < 4 && descriptor === undefined; attempt += 1) {
    try {
      descriptor = fs.openSync(claim, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, hostname: os.hostname() })}\n`);
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
      descriptor = undefined;
      if (error?.code !== "EEXIST") throw error;
      let owner;
      let acquired;
      try {
        const current = fs.openSync(claim, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try { acquired = fs.fstatSync(current); owner = JSON.parse(fs.readFileSync(current, "utf8")); }
        finally { fs.closeSync(current); }
      } catch { fail(`Benchmark recovery claim is malformed or was replaced: ${claim}`); }
      if (owner?.schemaVersion !== 1 || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) {
        fail(`Benchmark recovery claim has no provably local owner: ${claim}`);
      }
      try { process.kill(owner.pid, 0); fail(`Benchmark lock recovery is already in progress: ${claim}`); }
      catch (cause) { if (cause?.code !== "ESRCH") throw cause; }
      const current = fs.lstatSync(claim);
      if (current.dev !== acquired.dev || current.ino !== acquired.ino) fail(`Benchmark recovery claim changed during stale-owner recovery: ${claim}`);
      const stale = `${claim}.stale-${owner.pid}-${Date.now()}-${process.pid}`;
      fs.renameSync(claim, stale);
      const moved = fs.lstatSync(stale);
      if (moved.dev !== acquired.dev || moved.ino !== acquired.ino) fail(`Benchmark recovery claim replacement race detected: ${claim}`);
    }
  }
  if (descriptor === undefined) fail(`Cannot acquire benchmark recovery claim: ${claim}`);
  const acquired = fs.fstatSync(descriptor);
  const assertOwned = () => {
    const current = fs.lstatSync(claim);
    if (current.dev !== acquired.dev || current.ino !== acquired.ino) fail(`Benchmark recovery claim changed while held: ${claim}`);
  };
  const release = () => {
    try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
    try {
      const current = fs.lstatSync(claim);
      if (current.dev === acquired.dev && current.ino === acquired.ino) fs.unlinkSync(claim);
    } catch { /* Preserve a replaced recovery claim. */ }
  };
  return { assertOwned, release };
}

export function acquireBenchmarkRunLock(runRoot, runId) {
  const file = path.join(runRoot, ".benchmark-run.lock");
  let descriptor;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify({ schemaVersion: 1, runId, pid: process.pid, hostname: os.hostname(), acquiredAt: new Date().toISOString() })}\n`);
      fs.fsyncSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
      descriptor = undefined;
      if (error?.code !== "EEXIST") throw error;
      const recovery = recoveryClaim(file);
      try {
        let owner;
        const noFollow = fs.constants.O_NOFOLLOW ?? 0;
        const current = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
        let acquired;
        try {
          acquired = fs.fstatSync(current);
          owner = JSON.parse(fs.readFileSync(current, "utf8"));
        } finally { fs.closeSync(current); }
        let active = true;
        if ((owner.hostname === undefined || owner.hostname === os.hostname()) && Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (cause) { if (cause?.code === "ESRCH") active = false; }
        }
        if (active || attempt > 0) fail(`Benchmark run is locked by another process: ${file}`);
        const pathStat = fs.lstatSync(file);
        if (pathStat.dev !== acquired.dev || pathStat.ino !== acquired.ino) fail(`Benchmark run lock changed during stale-owner recovery: ${file}`);
        recovery.assertOwned();
        fs.renameSync(file, `${file}.stale-${owner.pid}-${Date.now()}`);
        recovery.assertOwned();
      } catch (cause) {
        if (cause?.code !== "ENOENT") {
          if (cause?.exitCode) throw cause;
          fail(`Benchmark run lock is malformed or was replaced: ${file}`);
        }
      } finally { recovery.release(); }
    }
  }
  if (descriptor === undefined) fail(`Cannot acquire benchmark run lock: ${file}`);
  const acquired = fs.fstatSync(descriptor);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", release);
    try { fs.closeSync(descriptor); } catch { /* Best effort. */ }
    try {
      const current = fs.lstatSync(file);
      if (current.dev === acquired.dev && current.ino === acquired.ino) fs.unlinkSync(file);
    } catch { /* Preserve a replaced lock or tolerate prior cleanup. */ }
  };
  process.once("exit", release);
  return release;
}

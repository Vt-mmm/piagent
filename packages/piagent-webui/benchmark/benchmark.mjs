#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { CoreInspectionProvider } from "../server/core-inspection-provider.ts";

function option(name, fallback) {
  const raw = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.split("=")[1];
  return raw && /^\d+$/.test(raw) ? Number(raw) : fallback;
}
function percentile(values, ratio) { return [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]; }
async function measured(action) { const started = performance.now(); await action(); return performance.now() - started; }
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const fileCount = Math.max(1, Math.min(20_000, option("files", 10_000)));
const changedCount = Math.max(1, Math.min(fileCount, option("changed", 1_000)));
const samples = Math.max(3, Math.min(20, option("samples", 5)));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-benchmark-"));

try {
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "benchmark@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Benchmark"]);
  for (let index = 0; index < fileCount; index += 1) {
    const directory = path.join(cwd, "src", String(Math.floor(index / 250)).padStart(3, "0"));
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `file-${String(index).padStart(5, "0")}.ts`), `export const value${index} = ${index};\n`);
  }
  execFileSync("git", ["-C", cwd, "add", "src"]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "benchmark baseline"]);
  for (let index = 0; index < changedCount; index += 1) {
    const directory = path.join(cwd, "src", String(Math.floor(index / 250)).padStart(3, "0"));
    fs.writeFileSync(path.join(directory, `file-${String(index).padStart(5, "0")}.ts`), `export const value${index} = ${index + 1};\n`);
  }
  const store = {
    retention: () => ({ eventRetentionCount: 0, eventRetentionSeconds: 0 }),
    currentCursor: () => "cursor.benchmark",
    resyncRequired: () => false,
    replay: () => ({ state: "current", events: [], nextCursor: "cursor.benchmark", latestCursor: "cursor.benchmark", reasonCode: null })
  };
  const provider = new CoreInspectionProvider({ cwd, sessionId: "benchmark-session", runtimeInstanceId: "runtime.benchmark", eventStore: store });
  await provider.snapshot();
  const snapshotSamples = [];
  for (let index = 0; index < samples; index += 1) snapshotSamples.push(await measured(() => provider.snapshot()));
  const sourceSamples = [];
  let source;
  for (let index = 0; index < samples; index += 1) {
    await wait(210);
    sourceSamples.push(await measured(async () => { source = await provider.sourceChanges("working-tree"); }));
  }
  const fileRef = source?.files?.[0]?.fileRef;
  if (!fileRef) throw new Error("benchmark-source-file-missing");
  const diffSamples = [];
  for (let index = 0; index < samples; index += 1) diffSamples.push(await measured(() => provider.diff("working-tree", fileRef)));
  const metrics = {
    fixture: { files: fileCount, changed: changedCount, samples },
    cachedSnapshotP95Ms: Number(percentile(snapshotSamples, 0.95).toFixed(2)),
    exactSourceP95Ms: Number(percentile(sourceSamples, 0.95).toFixed(2)),
    smallDiffP95Ms: Number(percentile(diffSamples, 0.95).toFixed(2)),
    rssMiB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(2))
  };
  const budgets = { cachedSnapshotP95Ms: 250, exactSourceP95Ms: 1_250, smallDiffP95Ms: 300, rssMiB: 200 };
  const gates = {
    cachedSnapshot: metrics.cachedSnapshotP95Ms < budgets.cachedSnapshotP95Ms,
    exactSource: metrics.exactSourceP95Ms < budgets.exactSourceP95Ms,
    smallDiff: metrics.smallDiffP95Ms < budgets.smallDiffP95Ms,
    rss: metrics.rssMiB < budgets.rssMiB
  };
  process.stdout.write(`${JSON.stringify({ metrics, budgets, gates }, null, 2)}\n`);
  if (Object.values(gates).some((value) => !value)) process.exitCode = 1;
} finally {
  fs.rmSync(cwd, { recursive: true, force: true });
}

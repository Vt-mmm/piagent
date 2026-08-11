#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateModelRouteCorpus } from "./model-route-evaluation-core.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/model-routing-v1/route-corpus.json"), "utf8"));
const report = evaluateModelRouteCorpus(corpus);
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0) {
  const value = process.argv[outputIndex + 1];
  if (!value) throw new Error("--output requires a path");
  const target = path.resolve(value);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(path.dirname(target), 0o700); fs.chmodSync(target, 0o600); } catch {}
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (Object.values(report.gates).some((passed) => !passed)) process.exitCode = 1;

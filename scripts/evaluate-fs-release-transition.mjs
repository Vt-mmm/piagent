#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateFsReleaseTransition } from "../packages/piagent-core/benchmark/fs-release-transition.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = path.join(root, "evals", "fs-release-transition.v1.json");
const inputBytes = fs.readFileSync(inputPath);
const input = JSON.parse(inputBytes);
const result = evaluateFsReleaseTransition(input);
const evidencePath = path.join(root, input.fs5Closure.risk.evidencePath);
const evidenceSha256 = fs.existsSync(evidencePath) ? crypto.createHash("sha256").update(fs.readFileSync(evidencePath)).digest("hex") : null;
if (evidenceSha256 !== input.fs5Closure.risk.evidenceSha256) {
  result.status = "failed";
  result.errors.push("FS5 terminal evidence is missing or has drifted");
  result.rcAssemblyAllowed = false;
  result.nextWorkItem = null;
}
process.stdout.write(`${JSON.stringify({
  transitionVersion: input.transitionVersion,
  transitionDigest: crypto.createHash("sha256").update(inputBytes).digest("hex"),
  evidenceSha256,
  ...result
}, null, 2)}\n`);
if (result.status !== "passed") process.exitCode = 1;

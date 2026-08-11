#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRoutedModelRoutingProtocol } from "./model-routing-protocol-core.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const value = (name, fallback) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : fallback; };
if (argv.includes("--help")) {
  process.stdout.write("Usage: node scripts/model-routing-benchmark.mjs --dry-run [--seed value] [--revision hex] [--output file]\nAuthenticated execution is intentionally unavailable until separately authorized.\n");
  process.exit(0);
}
if (!argv.includes("--dry-run")) throw new Error("Adaptive routing model execution requires separate operator authorization; run --dry-run to validate the pinned 144-session protocol.");
const corpus = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/model-routing-v1/route-corpus.json"), "utf8"));
const catalog = {
  schemaVersion: 1, capturedAt: "2026-08-08T00:00:00.000Z", source: "authenticated-catalog", availability: "authenticated",
  models: [
    { provider: "openai-codex", modelId: "gpt-5.6-luna", contextWindow: null, reasoning: true, imageInput: null, supportedThinkingLevels: ["medium"] },
    { provider: "openai-codex", modelId: "gpt-5.6-terra", contextWindow: null, reasoning: true, imageInput: null, supportedThinkingLevels: ["medium"] },
    { provider: "openai-codex", modelId: "gpt-5.6-sol", contextWindow: null, reasoning: true, imageInput: null, supportedThinkingLevels: ["high", "xhigh"] }
  ], warnings: []
};
const manifest = buildRoutedModelRoutingProtocol({ corpus, catalog, repositoryRevision: value("--revision", "0000000"), seed: value("--seed", "model-routing-v1-seed") });
const target = value("--output");
if (target) {
  const output = path.resolve(target); fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 }); fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
} else process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

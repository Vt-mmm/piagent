import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { developmentCorpus } from "./development-corpus.mjs";
import { selectedDevelopmentCorpus } from "./selected-development-corpus.mjs";
import { compileIndependentContract, runIndependentContract } from "../../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { installedContractVerifierDigest } from "../../packages/piagent-core/extensions/acceptance-host-configuration.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = path.resolve(import.meta.dirname, "../..");

/** Diagnostic calibration, not a benchmark or completion authority. */
export async function calibrate({ imageId, dockerSocket, corpus = developmentCorpus(), execute = runIndependentContract } = {}) {
  const corpusText = JSON.stringify(corpus), verifierDigest = installedContractVerifierDigest(repositoryRoot);
  const fixed = JSON.parse(corpusText);
  if (fixed.split !== "development" || fixed.heldOut !== false || fixed.claimEligible !== false || !Array.isArray(fixed.rows)
    || fixed.rows.length < 1 || fixed.rows.length > 128) throw new Error("Explicit nonempty development corpus required");
  const ids = new Set();
  for (const item of fixed.rows) {
    if (typeof item.id !== "string" || ids.has(item.id) || !["pass", "fail", "unknown"].includes(item.expectedVerdict)) throw new Error("Invalid calibration row");
    ids.add(item.id); compileIndependentContract(JSON.stringify(item.plan));
  }
  const rows = [];
  for (const item of fixed.rows) {
    let result;
    try { result = await execute({ planText: JSON.stringify(item.plan), imageId, dockerSocket }); }
    catch { result = { verdict: "error", reason: "calibration-execution-threw", checks: [], counterexamples: [] }; }
    const matched = result.verdict === item.expectedVerdict && result.execution?.status === "completed" && result.execution.cleanupConfirmed === true
      && (item.expectedVerdict !== "fail" || result.counterexamples?.length > 0);
    rows.push({ id: item.id, domain: item.domain, expectedVerdict: item.expectedVerdict, rationale: item.rationale,
      ...(item.selection ? { selection: item.selection } : {}), matched, result });
  }
  const count = (predicate) => rows.filter(predicate).length;
  const summary = { total: rows.length, matched: count((r) => r.matched),
    falseAcceptance: count((r) => r.expectedVerdict === "fail" && r.result.verdict === "pass"),
    falseRejection: count((r) => r.expectedVerdict === "pass" && r.result.verdict === "fail"),
    unexpectedAbstention: count((r) => r.expectedVerdict !== "unknown" && r.result.verdict === "unknown"),
    unknown: count((r) => r.result.verdict === "unknown"), executorError: count((r) => r.result.verdict === "error"),
    correctImplementationsPassed: count((r) => r.expectedVerdict === "pass" && r.matched),
    defectsRejectedWithCounterexamples: count((r) => r.expectedVerdict === "fail" && r.matched) };
  const verifierCurrent = installedContractVerifierDigest(repositoryRoot) === verifierDigest;
  return { schemaVersion: 1, kind: "development-calibration", corpusId: fixed.id, corpusDigest: hash(corpusText), verifierDigest,
    verifierCurrent, imageId, heldOut: false, claimEligible: false, summary, expectationsMatched: verifierCurrent && rows.every((row) => row.matched), rows };
}

async function main(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = { "--image-id": "imageId", "--docker-socket": "dockerSocket", "--output": "output", "--families": "families" }[argv[index]];
    if (!key || options[key] || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error("Expected unique --image-id, --docker-socket, --output and optional --families arguments");
    options[key] = argv[index + 1];
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(options.imageId ?? "") || !path.isAbsolute(options.dockerSocket ?? "") || !path.isAbsolute(options.output ?? "")
    || options.families && !path.isAbsolute(options.families)) {
    throw new Error("Pinned local image, absolute socket and new absolute output path are required");
  }
  // Reserve output before execution; reruns never overwrite diagnostic history.
  const fd = fs.openSync(options.output, "wx", 0o600);
  try {
    let libraryText;
    if (options.families) {
      const input = fs.openSync(options.families, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(input);
        if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 * 1024) throw new Error("Invalid calibration family library");
        const bytes = fs.readFileSync(input); libraryText = bytes.toString("utf8");
        if (bytes.length !== stat.size || !Buffer.from(libraryText).equals(bytes)) throw new Error("Invalid calibration family bytes");
      } finally { fs.closeSync(input); }
    }
    const corpus = options.families ? selectedDevelopmentCorpus(libraryText, {
      imageId: options.imageId, dockerSocket: options.dockerSocket, timeoutMs: 10000
    }) : undefined;
    const report = await calibrate({ ...options, ...(corpus ? { corpus } : {}) });
    fs.writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`); fs.fsyncSync(fd);
    process.stdout.write(`${JSON.stringify({ output: options.output, expectationsMatched: report.expectationsMatched, summary: report.summary, heldOut: false, claimEligible: false })}\n`);
    if (!report.expectationsMatched) process.exitCode = 1;
  } finally { fs.closeSync(fd); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validBenchmarkCandidateProvenance } from "../../piagent-core/benchmark/benchmark-candidate.js";
import { benchmarkCandidateProvenance } from "../../piagent-core/benchmark/benchmark-forensics.js";
import { assertBenchmarkLedgerBinding, inspectBenchmarkLedger, validateBenchmarkLedgerPrefix } from "../../piagent-core/benchmark/benchmark-ledger.js";
import { completedBenchmarkRecord } from "../../piagent-core/benchmark/benchmark-record-validation.js";
import { benchmarkGitEnvironment } from "../../piagent-core/benchmark/benchmark-runtime.js";
import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";

const MAX_RUNS = 20, MAX_DIRECTORIES = 100, MAX_DIRECTORY_ENTRIES = 5_000, MAX_JSON_BYTES = 32 * 1024 * 1024;
type Identity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string | null; taskRunId: string | null;
  agentOperationId: null; toolCallId: null };

function opaque(prefix: string, value: string): string {
  return `${prefix}.${createHash("sha256").update(`piagent-webui-release-monitor-v1\0${value}`).digest("hex").slice(0, 48)}`;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function text(value: unknown, maximum = 160): string | null {
  const result = redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return result ? result.slice(0, maximum) : null;
}
function number(value: unknown): number | null { return Number.isFinite(value) ? Number(value) : null; }
function stableBytes(file: string, maximum = MAX_JSON_BYTES): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maximum)) throw new Error("monitor-file-invalid");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd, { bigint: true });
    const stableFields = ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const;
    if (stableFields.some((field) => before[field] !== after[field])) throw new Error("monitor-file-changed");
    return bytes;
  } finally { fs.closeSync(fd); }
}
function json(file: string, maximum = MAX_JSON_BYTES): any { return JSON.parse(stableBytes(file, maximum).toString("utf8")); }
function safeDirectory(file: string): boolean { try { const stat = fs.lstatSync(file); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; } }
function boundedDirectories(root: string) {
  const handle = fs.opendirSync(root), values: string[] = []; let truncated = false;
  try {
    while (values.length <= MAX_DIRECTORY_ENTRIES) {
      const entry = handle.readSync(); if (!entry) break;
      if (entry.isDirectory() && !entry.isSymbolicLink()) values.push(path.join(root, entry.name));
    }
    truncated = values.length > MAX_DIRECTORY_ENTRIES;
  } finally { handle.closeSync(); }
  return { values: values.slice(0, MAX_DIRECTORY_ENTRIES), truncated };
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: benchmarkGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function repository(cwd: string) {
  const head = git(cwd, ["rev-parse", "HEAD"]), membership = new Map<string, boolean>();
  const hasCommit = (commit: unknown) => {
    if (typeof commit !== "string" || !/^[a-f0-9]{40,64}$/.test(commit)) return false;
    const cached = membership.get(commit); if (cached !== undefined) return cached;
    try { git(cwd, ["cat-file", "-e", `${commit}^{commit}`]); membership.set(commit, true); return true; }
    catch { membership.set(commit, false); return false; }
  };
  return { head, hasCommit };
}
function rcCandidateDigest(cwd: string): string {
  const raw = execFileSync("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "buffer", maxBuffer: 64 * 1024 * 1024, env: benchmarkGitEnvironment(), stdio: ["ignore", "pipe", "pipe"]
  });
  const files = raw.toString("utf8").split("\0").filter(Boolean).sort();
  if (files.length > 50_000) throw new Error("release-candidate-too-large");
  const digest = createHash("sha256"); let total = 0;
  for (const relative of files) {
    if (!relative || relative.startsWith("/") || relative.split("/").includes("..")) throw new Error("release-candidate-path-invalid");
    const absolute = path.join(cwd, relative), stat = fs.lstatSync(absolute);
    const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : stableBytes(absolute, 16 * 1024 * 1024);
    total += bytes.length; if (total > 512 * 1024 * 1024) throw new Error("release-candidate-too-large");
    digest.update(relative).update("\0").update(bytes).update("\0");
  }
  return digest.digest("hex");
}

function sourceBinding(cwd: string, provenance: any, commit: unknown, repo: ReturnType<typeof repository>, cache: { benchmark?: any }) {
  if (validBenchmarkCandidateProvenance(provenance)) {
    cache.benchmark ??= benchmarkCandidateProvenance(cwd);
    if (cache.benchmark.contentDigest === provenance.contentDigest) return "current";
  }
  return repo.hasCommit(commit) ? "stale" : "unbound";
}
function ledger(runRoot: string, expected: any, records?: any[]): { records: any[]; binding: any } {
  const inspected = inspectBenchmarkLedger(path.join(runRoot, "runs.jsonl"));
  assertBenchmarkLedgerBinding(expected, inspected.binding, "WebUI benchmark ledger");
  if (records && JSON.stringify(records) !== JSON.stringify(inspected.records)) throw new Error("benchmark-report-ledger-mismatch");
  return inspected;
}
function scores(report: any) {
  const value = report.surfaces?.piagent?.scores ?? {};
  return { quality: number(value.quality), safety: number(value.safety), reliability: number(value.reliability),
    workflow: number(value.workflow), efficiency: number(value.efficiency), overall: number(value.overall) };
}
function completeRun(cwd: string, runRoot: string, report: any, repo: ReturnType<typeof repository>, cache: { benchmark?: any }) {
  if (report?.schemaVersion !== 2 || typeof report.runId !== "string" || report.runId.length > 160 || !timestamp(report.startedAt)
    || !timestamp(report.completedAt) || typeof report.suite?.id !== "string" || !Array.isArray(report.runs)
    || report.runs.length > 1_000 || report.runCount !== report.runs.length) throw new Error("benchmark-report-invalid");
  const binding = sourceBinding(cwd, report.environment?.candidateProvenance, report.environment?.source?.commit, repo, cache);
  if (binding === "unbound") return null;
  if (report.runs.some((item: any) => !completedBenchmarkRecord(item) || item.runId !== report.runId)) throw new Error("benchmark-report-invalid");
  ledger(runRoot, report.ledger, report.runs);
  const gate = report.comparison?.productionGate ?? report.comparison?.suiteGate;
  return { runRef: opaque("benchmark", report.runId), suiteId: text(report.suite.id, 80) ?? "unknown", lifecycle: "completed",
    evidenceState: "complete", sourceState: binding, startedAt: report.startedAt, updatedAt: report.completedAt,
    completedRuns: report.runCount, expectedRuns: report.runCount, verdict: text(report.verdict?.status, 100),
    releaseGate: gate?.passed === true ? "passed" : gate?.passed === false ? "failed" : "not-applicable",
    tokenClaimAllowed: typeof report.comparison?.tokenClaimAllowed === "boolean" ? report.comparison.tokenClaimAllowed : null,
    claimTier: ["smoke", "public-regression", "capability", "private-holdout", "production-shadow"].includes(report.comparison?.claimEligibility?.achievedTier)
      ? report.comparison.claimEligibility.achievedTier : "unknown", scores: scores(report) };
}
const MARKERS = [
  ["paused.json", "paused", "pausedAt"], ["interrupted.json", "interrupted", "interruptedAt"],
  ["stopped.json", "stopped", "stoppedAt"], ["aborted.json", "aborted", "abortedAt"]
] as const;
function partialRun(cwd: string, runRoot: string, manifest: any, repo: ReturnType<typeof repository>, cache: { benchmark?: any }) {
  if (manifest?.schemaVersion !== 1 || typeof manifest.runId !== "string" || !timestamp(manifest.startedAt)
    || !Array.isArray(manifest.order) || manifest.order.length > 1_000) throw new Error("benchmark-manifest-invalid");
  const binding = sourceBinding(cwd, manifest.candidateProvenance, manifest.sourceIdentity?.commit, repo, cache);
  if (binding === "unbound") return null;
  for (const [name, lifecycle, timeField] of MARKERS) {
    const file = path.join(runRoot, name); if (!fs.existsSync(file)) continue;
    const marker = json(file, 2 * 1024 * 1024);
    if (marker?.schemaVersion !== 1 || marker.runId !== manifest.runId || !timestamp(marker[timeField])
      || !Number.isInteger(marker.completedRuns) || !Number.isInteger(marker.expectedRuns) || marker.completedRuns < 0
      || marker.expectedRuns < marker.completedRuns) throw new Error("benchmark-marker-invalid");
    const inspected = ledger(runRoot, marker.ledger);
    validateBenchmarkLedgerPrefix(inspected.records, manifest.order, completedBenchmarkRecord);
    if (inspected.records.length !== marker.completedRuns || manifest.order.length !== marker.expectedRuns) throw new Error("benchmark-marker-count-mismatch");
    return { runRef: opaque("benchmark", manifest.runId), suiteId: text(manifest.suite?.id, 80) ?? "unknown", lifecycle,
      evidenceState: "partial", sourceState: binding, startedAt: manifest.startedAt, updatedAt: marker[timeField],
      completedRuns: marker.completedRuns, expectedRuns: marker.expectedRuns, verdict: null, releaseGate: "unknown",
      tokenClaimAllowed: null, claimTier: "unknown", scores: { quality: null, safety: null, reliability: null, workflow: null, efficiency: null, overall: null } };
  }
  const inspected = ledger(runRoot, manifest.ledger);
  validateBenchmarkLedgerPrefix(inspected.records, manifest.order, completedBenchmarkRecord);
  const lockPath = path.join(runRoot, ".benchmark-run.lock"); let live = false, updatedAt = manifest.startedAt;
  if (fs.existsSync(lockPath)) {
    const lock = json(lockPath, 16 * 1024);
    if (lock?.schemaVersion !== 1 || lock.runId !== manifest.runId || !Number.isInteger(lock.pid) || lock.pid < 1
      || lock.hostname !== os.hostname() || !timestamp(lock.acquiredAt)) throw new Error("benchmark-lock-invalid");
    try { process.kill(lock.pid, 0); live = true; } catch { live = false; }
    updatedAt = lock.acquiredAt;
  }
  return { runRef: opaque("benchmark", manifest.runId), suiteId: text(manifest.suite?.id, 80) ?? "unknown",
    lifecycle: live ? "in-progress" : "incomplete", evidenceState: "partial", sourceState: binding,
    startedAt: manifest.startedAt, updatedAt, completedRuns: inspected.records.length, expectedRuns: manifest.order.length,
    verdict: null, releaseGate: "unknown", tokenClaimAllowed: null, claimTier: "unknown",
    scores: { quality: null, safety: null, reliability: null, workflow: null, efficiency: null, overall: null } };
}
function benchmarkRuns(cwd: string, root: string, repo: ReturnType<typeof repository>) {
  const warnings: Array<{ code: string; count: number; message: string }> = [], cache: { benchmark?: any } = {};
  if (!safeDirectory(root)) return { state: "missing", runs: [], warnings, page: { total: 0, returned: 0, truncated: false } };
  const bounded = boundedDirectories(root);
  const allDirectories = bounded.values.filter(safeDirectory)
    .map((directory) => ({ directory, modifiedAt: fs.statSync(directory).mtimeMs }))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  const directories = allDirectories.slice(0, MAX_DIRECTORIES).map((item) => item.directory);
  const runs: any[] = [], seenRuns = new Set<string>(); let corrupt = 0;
  for (const runRoot of directories) {
    if (runs.length >= MAX_RUNS) break;
    try {
      const reportPath = path.join(runRoot, "report.json"), manifestPath = path.join(runRoot, "run-manifest.json");
      const value = fs.existsSync(reportPath) ? completeRun(cwd, runRoot, json(reportPath), repo, cache)
        : fs.existsSync(manifestPath) ? partialRun(cwd, runRoot, json(manifestPath, 4 * 1024 * 1024), repo, cache) : null;
      if (value) {
        if (seenRuns.has(value.runRef)) corrupt += 1;
        else { seenRuns.add(value.runRef); runs.push(value); }
      }
    } catch { corrupt += 1; }
  }
  if (corrupt) warnings.push({ code: "benchmark-evidence-corrupt", count: corrupt, message: `${corrupt} benchmark run(s) could not be validated.` });
  if (allDirectories.length > MAX_DIRECTORIES || bounded.truncated) warnings.push({ code: "benchmark-directory-truncated",
    count: Math.max(1, allDirectories.length - MAX_DIRECTORIES), message: "Older benchmark directories are outside the bounded inspection window." });
  return { state: runs.length ? "ready" : corrupt ? "unavailable" : "missing", runs, warnings,
    page: { total: allDirectories.length, returned: runs.length,
      truncated: bounded.truncated || allDirectories.length > MAX_DIRECTORIES || runs.length >= MAX_RUNS } };
}

function releaseReadiness(cwd: string, file: string, repo: ReturnType<typeof repository>) {
  if (!fs.existsSync(file)) return { state: "missing", reportRef: null, generatedAt: null, sourceState: "unknown", localSafeGate: "unknown",
    rcAssembly: "unknown", beta: "unknown", gaRelease: "unknown", blockerCount: 0, blockers: [], authorization: { releaseCommit: false, tag: false, publish: false, push: false } };
  try {
    const report = json(file, 4 * 1024 * 1024), repository = report?.matrix?.repository, readiness = report?.readiness, authorization = report?.authorization;
    if (report?.schemaVersion !== 1 || report.reportVersion !== "rc-local-readiness-v1" || !timestamp(report.generatedAt)
      || !/^[a-f0-9]{40,64}$/.test(String(repository?.head ?? "")) || !/^[a-f0-9]{64}$/.test(String(repository?.candidateContentDigest ?? ""))
      || !Array.isArray(readiness?.blockers) || readiness.blockers.length > 100
      || ["releaseCommit", "tag", "publish", "push"].some((key) => authorization?.[key] !== false)) throw new Error("release-readiness-invalid");
    const sourceState = repo.head === repository.head && rcCandidateDigest(cwd) === repository.candidateContentDigest ? "current" : "stale";
    const blockers = readiness.blockers.slice(0, 8).map((item: unknown) => text(item, 240)).filter(Boolean);
    return { state: sourceState === "current" ? "ready" : "stale", reportRef: opaque("release", `${report.generatedAt}\0${repository.candidateContentDigest}`),
      generatedAt: report.generatedAt, sourceState, localSafeGate: ["passed", "failed"].includes(readiness.localSafeGate) ? readiness.localSafeGate : "unknown",
      rcAssembly: text(readiness.rcAssembly, 100) ?? "unknown", beta: text(readiness.beta, 100) ?? "unknown", gaRelease: text(readiness.gaRelease, 100) ?? "unknown",
      blockerCount: readiness.blockers.length, blockers,
      authorization: { releaseCommit: false, tag: false, publish: false, push: false } };
  } catch {
    return { state: "unavailable", reportRef: null, generatedAt: null, sourceState: "unknown", localSafeGate: "unknown",
      rcAssembly: "unknown", beta: "unknown", gaRelease: "unknown", blockerCount: 0, blockers: [], authorization: { releaseCommit: false, tag: false, publish: false, push: false } };
  }
}

export function projectBenchmarkReleaseMonitor(input: { cwd: string; identity: Identity; generatedAt?: string; benchmarkRoot?: string; releaseReportPath?: string }) {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  try {
    const repo = repository(input.cwd), root = input.benchmarkRoot ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "benchmarks", "piagent");
    const releasePath = input.releaseReportPath ?? path.join(input.cwd, "plans", "codex-first-product", "evidence", "p7-local-readiness", "report.json");
    const benchmark = benchmarkRuns(input.cwd, root, repo), release = releaseReadiness(input.cwd, releasePath, repo);
    const revision = `release-monitor.${createHash("sha256").update(JSON.stringify({ benchmark, release })).digest("hex")}`;
    const degraded = benchmark.state === "unavailable" || ["unavailable", "stale"].includes(release.state) || benchmark.warnings.length > 0;
    return { schemaVersion: 1, version: "piagent-webui-release-monitor-v1", generatedAt, identity: structuredClone(input.identity),
      state: "ready", monitorRevision: revision, benchmark, release,
      actions: { runBenchmark: false, resumeBenchmark: false, releaseCommit: false, tag: false, publish: false, push: false },
      health: degraded ? { state: "degraded", reasonCode: "monitor-evidence-incomplete", message: "Some local benchmark or release evidence is unavailable." }
        : { state: "ok", reasonCode: null, message: null } };
  } catch {
    return { schemaVersion: 1, version: "piagent-webui-release-monitor-v1", generatedAt, identity: structuredClone(input.identity),
      state: "unavailable", monitorRevision: null, benchmark: { state: "unavailable", runs: [], warnings: [], page: { total: 0, returned: 0, truncated: false } },
      release: { state: "unavailable", reportRef: null, generatedAt: null, sourceState: "unknown", localSafeGate: "unknown", rcAssembly: "unknown", beta: "unknown", gaRelease: "unknown", blockerCount: 0, blockers: [], authorization: { releaseCommit: false, tag: false, publish: false, push: false } },
      actions: { runBenchmark: false, resumeBenchmark: false, releaseCommit: false, tag: false, publish: false, push: false },
      health: { state: "error", reasonCode: "release-monitor-unavailable", message: "Local benchmark and release evidence is unavailable." } };
  }
}

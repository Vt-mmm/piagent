import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writePrivateAtomic } from "./benchmark-forensics.js";
import { acquireBenchmarkRunLock } from "./benchmark-run-lock.js";
import { exactBenchmarkAttemptUsage, exactBenchmarkMeasuredUsage } from "./benchmark-usage.js";

const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"];
const ATTEMPT_FIELDS = ["attemptId", "orderIndex", "scenarioId", "surface", "repeat", "infrastructureAttempt"];
const COORDINATE_FIELDS = ["orderIndex", "scenarioId", "surface", "repeat", "infrastructureAttempt"];
const POLICY_FIELDS = ["semantics", "maxProviderAttempts", "freshTokenThreshold", "activeWallTimeMsThreshold"];
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identifier = (value) => typeof value === "string" && /^[a-z0-9:._-]{1,240}$/i.test(value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function fail(message) {
  const error = new Error(`Benchmark budget ${message}`);
  error.code = "BENCHMARK_BUDGET_STOPPED";
  error.exitCode = 1;
  throw error;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  fail("identity must contain only finite JSON values");
}

export function benchmarkBudgetDigest(value) {
  return crypto.createHash("sha256").update(canonical(value)).digest("hex");
}

function validatePolicy(policy) {
  if (policy?.semantics !== "management-thresholds"
    || Object.keys(policy).length !== POLICY_FIELDS.length
    || !POLICY_FIELDS.every((field) => Object.hasOwn(policy, field))
    || !POLICY_FIELDS.slice(1).every((field) => integer(policy[field]) && policy[field] > 0)) {
    fail("policy requires positive integer session, fresh-token and active-wall management thresholds");
  }
}

function attemptIdentity(value) {
  if (!ATTEMPT_FIELDS.filter((field) => !["orderIndex", "repeat", "infrastructureAttempt"].includes(field)).every((field) => identifier(value?.[field]))
    || !["orderIndex", "repeat", "infrastructureAttempt"].every((field) => integer(value?.[field]) && value[field] > 0)) {
    fail("attempt identity is invalid");
  }
  return Object.fromEntries(ATTEMPT_FIELDS.map((field) => [field, value[field]]));
}

function sameAttempt(left, right) {
  return ATTEMPT_FIELDS.every((field) => left[field] === right[field]);
}

function readState(file) {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile()) fail("state is not a regular file");
      const raw = fs.readFileSync(fd, "utf8");
      const envelope = JSON.parse(raw);
      if (envelope.schemaVersion !== 1 || envelope.stateDigest !== benchmarkBudgetDigest(envelope.state)) fail("state integrity mismatch");
      return { raw, state: envelope.state };
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code === "BENCHMARK_BUDGET_STOPPED") throw error;
    fail(`state missing or corrupt: ${error.code ?? "invalid-json"}`);
  }
}

function validateState(state, policy, binding) {
  if (state?.schemaVersion !== 1 || !Array.isArray(state.attempts) || !Array.isArray(state.stages)
    || !Array.isArray(state.stopReasons) || !state.stopReasons.every(identifier)
    || !integer(state.lastObservedAtMs) || typeof state.activeWallTimeExact !== "boolean") fail("state schema is invalid");
  if (canonical(state.policy) !== canonical(policy) || state.policyDigest !== benchmarkBudgetDigest(policy)) fail("policy changed on resume");
  if (canonical(state.binding) !== canonical(binding) || state.bindingDigest !== benchmarkBudgetDigest(binding)) fail("binding changed on resume");
  const ids = new Set();
  for (const [index, attempt] of state.attempts.entries()) {
    attemptIdentity(attempt);
    if (attempt.orderIndex !== index + 1 || attempt.infrastructureAttempt !== 1 || ids.has(attempt.attemptId)
      || !["active", "exact", "unknown"].includes(attempt.status)) fail("state attempt sequence is invalid");
    if (attempt.status === "exact" && !exactBenchmarkMeasuredUsage(attempt.usage)) fail("state measured usage is invalid");
    if (attempt.status !== "exact" && attempt.usage !== null) fail("state unknown usage cannot be a number");
    ids.add(attempt.attemptId);
  }
  if (state.attempts.length > policy.maxProviderAttempts
    || state.attempts.filter((attempt) => attempt.status === "active").length > 1) fail("state attempt cap or concurrency is invalid");
  const stages = new Set();
  for (const stage of state.stages) {
    if (!identifier(stage.stageId) || stages.has(stage.stageId) || !integer(stage.startedAtMs)
      || !integer(stage.lastCheckpointAtMs) || stage.lastCheckpointAtMs < stage.startedAtMs
      || !integer(stage.elapsedMs) || stage.elapsedMs !== stage.lastCheckpointAtMs - stage.startedAtMs
      || !["active", "closed", "abandoned"].includes(stage.status) || typeof stage.attachmentUsed !== "boolean") fail("state stage timing is invalid");
    stages.add(stage.stageId);
  }
  if (state.stages.filter((stage) => stage.status === "active").length > 1
    || state.attempts.some((attempt) => !stages.has(attempt.stageId))) fail("state stage ownership is invalid");
}

/**
 * Durable admission governor, NOT a provider-side token cap. One running attempt
 * may overshoot a fresh threshold; launcher cancellation and cleanup can exceed
 * wall thresholds. The caller must watchdog the entire active stage lifetime.
 * attachStageId/finalizeStageId are trusted, one-use launcher handoff capabilities;
 * ordinary resume never forgives a pending stage or interrupted provider usage.
 */
export function openBenchmarkBudgetGovernor({ statePath, policy, binding, resume, now = Date.now, attachStageId, finalizeStageId }) {
  validatePolicy(policy);
  if (!binding || Object.getPrototypeOf(binding) !== Object.prototype || Object.keys(binding).length === 0) fail("binding is required");
  canonical(binding);
  policy = clone(policy);
  binding = clone(binding);
  if (typeof resume !== "boolean" || typeof now !== "function" || !path.isAbsolute(statePath ?? "")) fail("explicit init/resume and absolute state path are required");
  if ((attachStageId && finalizeStageId) || ((!resume) && (attachStageId || finalizeStageId))) fail("stage handoff requires one explicit resume mode");
  const file = path.resolve(statePath);
  const lockRoot = `${file}.guard`;
  if (!resume) {
    if (fs.existsSync(file) || fs.existsSync(lockRoot)) fail("state already exists; refusing reset");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.mkdirSync(lockRoot, { mode: 0o700 });
  } else if (!fs.existsSync(lockRoot)) fail("state initialization marker is missing");
  const release = acquireBenchmarkRunLock(lockRoot, benchmarkBudgetDigest(binding));
  let state;
  let raw = null;
  let closed = false;
  let poisoned = false;
  const mode = finalizeStageId ? "finalize" : "admit";
  const activeStage = () => state.stages.find((stage) => stage.status === "active");
  const activeAttempt = () => state.attempts.find((attempt) => attempt.status === "active");
  const addStop = (reason) => { if (!state.stopReasons.includes(reason)) state.stopReasons.push(reason); };
  const verifyOwnedState = () => {
    try { if (raw !== null && readState(file).raw !== raw) fail("state changed while owned"); }
    catch (error) { poisoned = true; throw error; }
  };
  const persist = () => {
    verifyOwnedState();
    raw = `${JSON.stringify({ schemaVersion: 1, stateDigest: benchmarkBudgetDigest(state), state }, null, 2)}\n`;
    try { writePrivateAtomic(file, raw); }
    catch (error) { poisoned = true; throw error; }
  };
  const ensureOpen = () => {
    if (closed || poisoned) fail("governor is closed or has failed persistence");
    verifyOwnedState();
  };
  const time = () => {
    const value = now();
    if (!integer(value) || value < state.lastObservedAtMs) {
      addStop("clock-regression-or-invalid"); state.activeWallTimeExact = false; persist(); fail("clock regressed or is invalid");
    }
    state.lastObservedAtMs = value;
    return value;
  };
  const totals = () => {
    const exact = state.attempts.filter((attempt) => attempt.status === "exact");
    const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, exact.reduce((sum, attempt) => sum + attempt.usage[field], 0)]));
    if (!Object.values(tokens).every(integer)) fail("token accounting exceeds safe integer range");
    return { tokens, unknown: state.attempts.filter((attempt) => attempt.status === "unknown").length, active: activeAttempt() };
  };
  const thresholds = () => {
    if (totals().tokens.fresh >= policy.freshTokenThreshold) addStop("fresh-token-threshold");
    if (state.stages.reduce((sum, stage) => sum + stage.elapsedMs, 0) >= policy.activeWallTimeMsThreshold) addStop("active-wall-threshold");
    if (state.attempts.length >= policy.maxProviderAttempts) addStop("session-cap");
  };
  const observe = () => {
    ensureOpen();
    const timestamp = time();
    const stage = activeStage();
    if (stage) { stage.lastCheckpointAtMs = timestamp; stage.elapsedMs = timestamp - stage.startedAtMs; }
    thresholds(); persist();
    return timestamp;
  };
  const view = () => {
    const { tokens, unknown, active } = totals();
    const wall = state.stages.reduce((sum, stage) => sum + stage.elapsedMs, 0);
    const exact = unknown === 0 && !active;
    return clone({
      schemaVersion: 1, policy, policyDigest: state.policyDigest, bindingDigest: state.bindingDigest,
      hardCapProven: false, sessionCapEnforced: true, tokenThresholdMayOvershootByInFlightAttempt: true,
      tokenOvershootMaximumProven: false, wallThresholdRequiresLauncherWatchdog: true,
      providerStartedAttempts: state.attempts.length, exactAttempts: state.attempts.filter((attempt) => attempt.status === "exact").length,
      unknownAttempts: unknown, inFlightAttempts: active ? 1 : 0, usageComplete: exact,
      knownExactFreshTokens: tokens.fresh, knownExactTokens: tokens, freshTokens: exact ? tokens.fresh : null,
      activeWallTimeMs: wall, activeWallTimeExact: state.activeWallTimeExact,
      remainingActiveWallTimeMs: Math.max(0, policy.activeWallTimeMsThreshold - wall),
      remainingProviderAttempts: Math.max(0, policy.maxProviderAttempts - state.attempts.length),
      overshoot: { freshTokens: exact ? Math.max(0, tokens.fresh - policy.freshTokenThreshold) : null, activeWallTimeMs: state.activeWallTimeExact ? Math.max(0, wall - policy.activeWallTimeMsThreshold) : null },
      stopped: state.stopReasons.length > 0, stopReasons: state.stopReasons,
      canStartAttempt: mode === "admit" && Boolean(activeStage()) && !active && state.stopReasons.length === 0,
      activeStageId: activeStage()?.stageId ?? null, stages: state.stages
    });
  };
  const refuseStopped = () => { if (state.stopReasons.length) fail(`stopped: ${state.stopReasons.join(", ")}`); };
  const unknownActive = () => {
    const attempt = activeAttempt();
    if (attempt) { attempt.status = "unknown"; attempt.usageStatus = "unknown-after-provider-start"; addStop("unknown-usage"); }
  };
  try {
    if (resume) {
      ({ raw, state } = readState(file));
      validateState(state, policy, binding);
      const stage = activeStage();
      if (attachStageId) {
        if (!stage || stage.stageId !== attachStageId || stage.attachmentUsed || activeAttempt()) fail("stage attach identity is absent, duplicate or has active attempt");
        stage.attachmentUsed = true;
      } else if (finalizeStageId) {
        if (!stage || stage.stageId !== finalizeStageId) fail("stage finalization identity does not match");
        unknownActive();
      } else if (stage || activeAttempt()) {
        unknownActive();
        if (stage) { stage.status = "abandoned"; state.activeWallTimeExact = false; addStop("unclosed-stage-on-resume"); }
      }
      thresholds(); persist();
    } else {
      const timestamp = now();
      if (!integer(timestamp)) fail("initial clock is invalid");
      state = { schemaVersion: 1, policy: clone(policy), policyDigest: benchmarkBudgetDigest(policy), binding: clone(binding), bindingDigest: benchmarkBudgetDigest(binding),
        lastObservedAtMs: timestamp, activeWallTimeExact: true, attempts: [], stages: [], stopReasons: [] };
      persist();
    }
  } catch (error) { release(); throw error; }
  return {
    startStage(stageId, { startedAtMs } = {}) {
      const timestamp = observe(); refuseStopped();
      if (mode !== "admit" || activeStage() || !identifier(stageId) || state.stages.some((stage) => stage.stageId === stageId)) fail("stage is active, duplicate or invalid");
      const started = startedAtMs ?? timestamp;
      if (!integer(started) || started > timestamp || started < (state.stages.at(-1)?.lastCheckpointAtMs ?? 0)) fail("stage start timestamp is invalid");
      state.stages.push({ stageId, startedAtMs: started, lastCheckpointAtMs: timestamp, elapsedMs: timestamp - started, status: "active", attachmentUsed: false });
      thresholds(); persist(); return view();
    },
    checkpointStage(stageId) {
      observe(); if (activeStage()?.stageId !== stageId) fail("checkpoint stage identity does not match"); return view();
    },
    endStage(stageId) {
      observe();
      if (activeStage()?.stageId !== stageId || activeAttempt()) fail("stage cannot end with wrong identity or active attempt");
      activeStage().status = "closed"; persist(); return view();
    },
    startAttempt(value) {
      observe(); refuseStopped();
      if (mode !== "admit") fail("finalization-only mode cannot admit attempts");
      if (!activeStage()) fail("attempt requires active stage");
      if (activeAttempt()) fail("active attempt must settle first");
      const identity = attemptIdentity(value);
      if (state.attempts.some((attempt) => attempt.attemptId === identity.attemptId)) fail("duplicate attempt identity");
      if (identity.orderIndex !== state.attempts.length + 1) fail("attempt order must be sequential");
      if (identity.infrastructureAttempt !== 1) fail("retry attempts are prohibited");
      const planned = binding.plannedAttempts?.[identity.orderIndex - 1];
      if (binding.plannedAttempts && (!planned || !COORDINATE_FIELDS.every((field) => (planned[field] ?? (field === "infrastructureAttempt" ? 1 : undefined)) === identity[field]))) fail("attempt differs from planned workload");
      state.attempts.push({ ...identity, stageId: activeStage().stageId, status: "active", usage: null, usageStatus: "pending" });
      thresholds(); persist(); return view();
    },
    settleAttempt(value, { usage, usageStatus } = {}) {
      observe();
      if (mode !== "admit" || !activeAttempt()) fail("settlement requires an active attempt");
      if (!sameAttempt(activeAttempt(), attemptIdentity(value))) fail("settlement identity does not match active attempt");
      const attempt = activeAttempt();
      const exact = exactBenchmarkMeasuredUsage(usage) && exactBenchmarkAttemptUsage(usage, usageStatus);
      attempt.status = exact ? "exact" : "unknown";
      attempt.usageStatus = exact ? usageStatus ?? "measured" : "unknown-after-provider-start";
      attempt.usage = exact ? { sessions: usage.sessions, usageCompleteness: "exact", ...Object.fromEntries(TOKEN_FIELDS.map((field) => [field, usage[field]])) } : null;
      if (!exact) addStop("unknown-usage");
      thresholds(); persist(); return view();
    },
    stop(reason) { observe(); if (!identifier(reason)) fail("stop reason is invalid"); addStop(reason); persist(); return view(); },
    snapshot() { observe(); return view(); },
    close() { if (!closed) { closed = true; release(); } }
  };
}

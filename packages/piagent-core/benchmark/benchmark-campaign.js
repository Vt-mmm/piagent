import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  appendBenchmarkLedger,
  benchmarkLedgerCheckpoint,
  emptyBenchmarkLedgerBinding,
  inspectBenchmarkLedger
} from "./benchmark-ledger.js";
import { acquireBenchmarkRunLock } from "./benchmark-run-lock.js";
import { exactBenchmarkAttemptUsage } from "./benchmark-usage.js";
import { writePrivateAtomic } from "./benchmark-forensics.js";

const TOKEN_FIELDS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"]);
const CAMPAIGN_STATUSES = new Set([
  "active", "claim-sealed", "claim-passed", "no-claim", "superseded-before-provider-start",
  "superseded-changed-lineage-no-claim", "complete"
]);
const CLAIM_READY_STATUSES = new Set(["claim-sealed", "claim-passed"]);
const PUBLIC_SURFACES = new Set(["raw-pi", "piagent", "codex-cli"]);
const MAX_RETAINED_CAMPAIGNS = 1_000;

function fail(message) {
  const error = new Error(message);
  error.code = "BENCHMARK_CAMPAIGN_INVALID";
  error.exitCode = 1;
  throw error;
}

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(target, 0o700); } catch { /* Non-POSIX filesystem. */ }
  return target;
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Cannot read ${label} ${file}: ${error.message}`); }
}

function canonicalPath(target) {
  const suffix = [];
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    suffix.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) fail(`Cannot resolve campaign path ${target}`);
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...suffix);
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function campaignId(suiteId) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${suiteId}-${timestamp}-${crypto.randomBytes(6).toString("hex")}`;
}

function validIdentity(value) {
  const validClaimOutcome = value?.claimOutcome == null
    || (typeof value.claimOutcome === "object"
      && typeof value.claimOutcome.allowed === "boolean"
      && typeof value.claimOutcome.reason === "string"
      && typeof value.claimOutcome.finalizedAt === "string");
  return value?.schemaVersion === 1
    && typeof value.campaignId === "string" && value.campaignId.length > 0
    && typeof value.suiteId === "string" && value.suiteId.length > 0
    && typeof value.runId === "string" && value.runId.length > 0
    && typeof value.runRoot === "string" && path.isAbsolute(value.runRoot)
    && typeof value.campaignRoot === "string" && path.isAbsolute(value.campaignRoot)
    && CAMPAIGN_STATUSES.has(value.status)
    && validClaimOutcome
    && (value.status !== "claim-passed" || value.claimOutcome?.allowed === true)
    && (!["no-claim", "superseded-changed-lineage-no-claim"].includes(value.status) || value.claimOutcome?.allowed === false)
    && ["configurationDigest", "candidateDigest", "suiteDigest"].every((field) => /^[a-f0-9]{64}$/.test(String(value[field] ?? "")));
}

function sameClaimLineage(left, right) {
  return ["suiteId", "configurationDigest", "candidateDigest", "suiteDigest"]
    .every((field) => left?.[field] === right?.[field]);
}

function identityMatches(left, right) {
  return ["campaignId", "suiteId", "runId", "runRoot", "campaignRoot", "configurationDigest", "candidateDigest", "suiteDigest"]
    .every((field) => left?.[field] === right?.[field]);
}

function eventIdentity(event) {
  return {
    attemptId: event?.attemptId,
    orderIndex: event?.orderIndex,
    scenarioId: event?.scenarioId,
    surface: event?.surface,
    repeat: event?.repeat,
    infrastructureAttempt: event?.infrastructureAttempt
  };
}

function comparableAttempt(value) {
  return [value?.attemptId, value?.orderIndex, value?.scenarioId, value?.surface, value?.repeat, value?.infrastructureAttempt];
}

function attemptCoordinate(value) {
  return JSON.stringify(comparableAttempt({ ...value, attemptId: undefined }).slice(1));
}

function validAttemptIdentity(event) {
  return typeof event?.attemptId === "string" && event.attemptId.length > 0
    && Number.isSafeInteger(event.orderIndex) && event.orderIndex > 0
    && typeof event.scenarioId === "string" && event.scenarioId.length > 0
    && typeof event.surface === "string" && event.surface.length > 0
    && Number.isSafeInteger(event.repeat) && event.repeat > 0
    && Number.isSafeInteger(event.infrastructureAttempt) && event.infrastructureAttempt > 0;
}

function emptyTokens() {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0]));
}

function addTokens(target, source) {
  for (const field of TOKEN_FIELDS) target[field] += Number(source?.[field] ?? 0);
}

function publicClaimOutcome(value) {
  if (!value || typeof value !== "object" || typeof value.allowed !== "boolean") return null;
  const reason = /^[a-z0-9:._-]{1,240}$/i.test(String(value.reason ?? ""))
    ? value.reason
    : "private-or-invalid-reason-withheld";
  const finalizedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(String(value.finalizedAt ?? ""))
    ? value.finalizedAt
    : null;
  return {
    allowed: value.allowed,
    reason,
    finalizedAt
  };
}

function publicPriorCampaignHistory(value) {
  if (!value || typeof value !== "object") return emptyPriorHistory();
  const number = (field) => Number.isSafeInteger(value[field]) && value[field] >= 0 ? value[field] : 0;
  const tokens = Object.fromEntries(TOKEN_FIELDS.map((field) => [field,
    Number.isFinite(value.knownExactTokens?.[field]) && value.knownExactTokens[field] >= 0
      ? value.knownExactTokens[field]
      : 0]));
  const bySurface = {};
  for (const [surface, bucket] of Object.entries(value.bySurface ?? {})) {
    if (!PUBLIC_SURFACES.has(surface)) continue;
    bySurface[surface] = {
      attempts: Number.isSafeInteger(bucket?.attempts) && bucket.attempts >= 0 ? bucket.attempts : 0,
      tokens: Object.fromEntries(TOKEN_FIELDS.map((field) => [field,
        Number.isFinite(bucket?.tokens?.[field]) && bucket.tokens[field] >= 0 ? bucket.tokens[field] : 0]))
    };
  }
  const entries = Array.isArray(value.entries) ? value.entries.slice(0, MAX_RETAINED_CAMPAIGNS).map((entry) => ({
    campaignId: /^[a-z0-9._-]{1,240}$/i.test(String(entry?.campaignId ?? "")) ? entry.campaignId : "withheld",
    candidateDigest: /^[a-f0-9]{64}$/.test(String(entry?.candidateDigest ?? "")) ? entry.candidateDigest : null,
    configurationDigest: /^[a-f0-9]{64}$/.test(String(entry?.configurationDigest ?? "")) ? entry.configurationDigest : null,
    suiteDigest: /^[a-f0-9]{64}$/.test(String(entry?.suiteDigest ?? "")) ? entry.suiteDigest : null,
    status: CAMPAIGN_STATUSES.has(entry?.status) ? entry.status : "no-claim",
    claimOutcome: publicClaimOutcome(entry?.claimOutcome),
    providerStartedAttempts: Number.isSafeInteger(entry?.providerStartedAttempts) && entry.providerStartedAttempts >= 0 ? entry.providerStartedAttempts : 0,
    exactAttempts: Number.isSafeInteger(entry?.exactAttempts) && entry.exactAttempts >= 0 ? entry.exactAttempts : 0,
    unknownAttempts: Number.isSafeInteger(entry?.unknownAttempts) && entry.unknownAttempts >= 0 ? entry.unknownAttempts : 0,
    knownExactFreshTokens: Number.isFinite(entry?.knownExactFreshTokens) && entry.knownExactFreshTokens >= 0 ? entry.knownExactFreshTokens : 0,
    exactUsageComplete: entry?.exactUsageComplete === true
  })) : [];
  return {
    schemaVersion: 1,
    campaigns: number("campaigns"),
    paidCampaigns: number("paidCampaigns"),
    claimPassedCampaigns: number("claimPassedCampaigns"),
    noClaimCampaigns: number("noClaimCampaigns"),
    providerStartedAttempts: number("providerStartedAttempts"),
    exactAttempts: number("exactAttempts"),
    unknownAttempts: number("unknownAttempts"),
    exactUsageComplete: value.exactUsageComplete === true,
    knownExactTokens: tokens,
    bySurface,
    entries
  };
}

function emptyPriorHistory() {
  return {
    schemaVersion: 1,
    campaigns: 0,
    paidCampaigns: 0,
    claimPassedCampaigns: 0,
    noClaimCampaigns: 0,
    providerStartedAttempts: 0,
    exactAttempts: 0,
    unknownAttempts: 0,
    exactUsageComplete: true,
    knownExactTokens: emptyTokens(),
    bySurface: {},
    entries: []
  };
}

function appendHistoryEvidence(history, evidence) {
  history.campaigns += 1;
  if (evidence.providerStartedAttempts > 0) history.paidCampaigns += 1;
  if (evidence.status === "claim-passed") history.claimPassedCampaigns += 1;
  if (["no-claim", "superseded-changed-lineage-no-claim", "complete"].includes(evidence.status)) {
    history.noClaimCampaigns += 1;
  }
  history.providerStartedAttempts += evidence.providerStartedAttempts;
  history.exactAttempts += evidence.allAttempts.exactAttempts;
  history.unknownAttempts += evidence.allAttempts.unknownAttempts;
  history.exactUsageComplete &&= evidence.allAttempts.complete === true;
  addTokens(history.knownExactTokens, evidence.allAttempts.tokens);
  for (const [surface, bucket] of Object.entries(evidence.allAttempts.bySurface ?? {})) {
    const target = history.bySurface[surface] ?? { attempts: 0, tokens: emptyTokens() };
    target.attempts += Number(bucket?.attempts ?? 0);
    addTokens(target.tokens, bucket?.tokens);
    history.bySurface[surface] = target;
  }
  history.entries.push({
    campaignId: evidence.campaignId,
    candidateDigest: evidence.candidateDigest,
    configurationDigest: evidence.configurationDigest,
    suiteDigest: evidence.suiteDigest,
    status: evidence.status,
    claimOutcome: publicClaimOutcome(evidence.claimOutcome),
    providerStartedAttempts: evidence.providerStartedAttempts,
    exactAttempts: evidence.allAttempts.exactAttempts,
    unknownAttempts: evidence.allAttempts.unknownAttempts,
    knownExactFreshTokens: evidence.allAttempts.tokens.fresh,
    exactUsageComplete: evidence.allAttempts.complete === true
  });
}

/** Exact provider attempts represented by the accepted run ledger, including failed attempts. */
export function productionCampaignExpectedAttempts(runs) {
  return (runs ?? []).flatMap((run) => [
    ...(run.infrastructureFailures ?? []).map((failure) => ({
      attemptId: failure.attemptId, orderIndex: run.orderIndex, scenarioId: run.scenarioId,
      surface: run.surface, repeat: run.repeat, infrastructureAttempt: failure.attempt
    })),
    { attemptId: run.attemptId, orderIndex: run.orderIndex, scenarioId: run.scenarioId,
      surface: run.surface, repeat: run.repeat, infrastructureAttempt: run.infrastructureAttempt }
  ]);
}

export function productionCampaignAttemptCoverage(expected, evidence) {
  return Array.isArray(expected) && expected.length > 0
    && Array.isArray(evidence?.attempts) && evidence.attempts.length === expected.length
    && expected.every((attempt, index) => JSON.stringify(comparableAttempt(attempt)) === JSON.stringify(comparableAttempt(evidence.attempts[index]))
      && evidence.attempts[index].returned === true && evidence.attempts[index].exactUsage === true);
}

/** Strip private filesystem lineage while retaining public claim-verification evidence. */
export function publicProductionBenchmarkCampaignEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") return evidence;
  const publicEvidence = {
    ...evidence,
    claimOutcome: publicClaimOutcome(evidence.claimOutcome),
    priorCampaignHistory: publicPriorCampaignHistory(evidence.priorCampaignHistory)
  };
  delete publicEvidence.runRoot;
  delete publicEvidence.campaignRoot;
  return publicEvidence;
}

/** Validate the append-only start/settlement ledger and build claim accounting. */
export function inspectProductionBenchmarkCampaign({ manifest, ledger }) {
  const issues = [];
  const starts = new Map();
  const startCoordinates = new Map();
  const settled = new Map();
  const tokens = emptyTokens();
  const bySurface = {};
  let exactAttempts = 0;
  for (const [index, event] of ledger.records.entries()) {
    if (event?.schemaVersion !== 1 || event.campaignId !== manifest.campaignId || event.runId !== manifest.runId
      || !validAttemptIdentity(event) || !["provider-started", "provider-returned"].includes(event.event)) {
      issues.push(`malformed-or-foreign-event:${index + 1}`);
      continue;
    }
    const priorStart = starts.get(event.attemptId);
    if (event.event === "provider-started") {
      if (priorStart) issues.push(`duplicate-provider-start:${event.attemptId}`);
      else {
        const coordinate = attemptCoordinate(event);
        if (startCoordinates.has(coordinate)) issues.push(`duplicate-provider-coordinate:${event.attemptId}`);
        else startCoordinates.set(coordinate, event.attemptId);
        starts.set(event.attemptId, event);
      }
      continue;
    }
    if (!priorStart) issues.push(`provider-returned-without-start:${event.attemptId}`);
    else if (JSON.stringify(eventIdentity(priorStart)) !== JSON.stringify(eventIdentity(event))) {
      issues.push(`provider-returned-identity-mismatch:${event.attemptId}`);
    }
    if (settled.has(event.attemptId)) issues.push(`duplicate-provider-returned:${event.attemptId}`);
    else settled.set(event.attemptId, event);
  }
  for (const [attemptId, start] of starts) {
    const returned = settled.get(attemptId);
    const exact = returned && exactBenchmarkAttemptUsage(returned.usage, returned.usageStatus);
    if (!exact) continue;
    exactAttempts += 1;
    const surface = bySurface[start.surface] ?? { attempts: 0, tokens: emptyTokens() };
    surface.attempts += 1;
    for (const field of TOKEN_FIELDS) {
      tokens[field] += returned.usage[field];
      surface.tokens[field] += returned.usage[field];
    }
    bySurface[start.surface] = surface;
  }
  const providerStartedAttempts = starts.size;
  const unknownAttempts = providerStartedAttempts - exactAttempts;
  const ledgerExact = issues.length === 0 && ledger.binding.records === manifest.attemptLedger.records;
  const allAttempts = {
    attempts: providerStartedAttempts,
    exactAttempts,
    unknownAttempts,
    complete: ledgerExact && unknownAttempts === 0 && settled.size === providerStartedAttempts,
    tokens,
    bySurface: Object.fromEntries(Object.entries(bySurface).sort(([left], [right]) => left.localeCompare(right))),
    ledgerExact,
    ledgerIssues: issues
  };
  const attempts = [...starts.values()].map((start) => ({
    ...eventIdentity(start),
    returned: settled.has(start.attemptId),
    exactUsage: exactBenchmarkAttemptUsage(settled.get(start.attemptId)?.usage, settled.get(start.attemptId)?.usageStatus)
  }));
  return {
    schemaVersion: 1,
    required: true,
    campaignId: manifest.campaignId,
    runId: manifest.runId,
    runRoot: manifest.runRoot,
    campaignRoot: manifest.campaignRoot,
    configurationDigest: manifest.configurationDigest,
    candidateDigest: manifest.candidateDigest,
    suiteDigest: manifest.suiteDigest,
    status: manifest.status,
    claimOutcome: manifest.claimOutcome ?? null,
    exactOutputLineage: true,
    providerStartedAttempts,
    settledAttempts: settled.size,
    unknownAttempts,
    attempts,
    attemptLedger: ledger.binding,
    allAttempts,
    complete: allAttempts.complete,
    claimReady: allAttempts.complete && CLAIM_READY_STATUSES.has(manifest.status),
    priorCampaignHistory: manifest.priorCampaignHistory ?? emptyPriorHistory(),
    passed: allAttempts.complete && !String(manifest.status).startsWith("superseded-")
  };
}

function loadCampaign(campaignRoot) {
  const manifestPath = path.join(campaignRoot, "campaign.json");
  const manifest = readJson(manifestPath, "production benchmark campaign");
  if (!validIdentity(manifest) || canonicalPath(manifest.campaignRoot) !== canonicalPath(campaignRoot)) {
    fail("Production benchmark campaign identity is malformed or relocated");
  }
  const ledgerPath = path.join(campaignRoot, "attempts.jsonl");
  const ledger = benchmarkLedgerCheckpoint(manifest.attemptLedger, inspectBenchmarkLedger(ledgerPath), "production campaign attempt ledger");
  if (ledger.recovered) {
    manifest.attemptLedger = ledger.binding;
    writePrivateAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { manifest, manifestPath, ledgerPath, ledger };
}

function loadRetainedCampaigns(registryRoot, excludeCampaignId = null) {
  const canonicalRegistryRoot = canonicalPath(registryRoot);
  const entries = fs.readdirSync(registryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  if (entries.length > MAX_RETAINED_CAMPAIGNS) fail("Production benchmark campaign history exceeds its inspection limit");
  const retained = [];
  for (const entry of entries) {
    if (entry.name === excludeCampaignId) continue;
    const campaignRoot = path.join(registryRoot, entry.name);
    if (!fs.existsSync(path.join(campaignRoot, "campaign.json"))) continue;
    if (!inside(canonicalRegistryRoot, canonicalPath(campaignRoot))) {
      fail("Retained production campaign path escapes its registry");
    }
    retained.push(loadCampaign(campaignRoot));
  }
  return retained;
}

function retainedCampaignHistory(registryRoot, excludeCampaignId = null) {
  const history = emptyPriorHistory();
  for (const loaded of loadRetainedCampaigns(registryRoot, excludeCampaignId)) {
    appendHistoryEvidence(history, inspectProductionBenchmarkCampaign(loaded));
  }
  history.bySurface = Object.fromEntries(Object.entries(history.bySurface).sort(([left], [right]) => left.localeCompare(right)));
  history.entries.sort((left, right) => left.campaignId.localeCompare(right.campaignId));
  return history;
}

function publicBinding(manifest) {
  return Object.fromEntries(["schemaVersion", "campaignId", "suiteId", "runId", "runRoot", "campaignRoot", "configurationDigest", "candidateDigest", "suiteDigest"]
    .map((field) => [field, manifest[field]]));
}

/**
 * Reserve or resume one durable paid lineage for a production suite. The same
 * candidate/configuration must resume exact output; changed lineage retains and
 * explicitly supersedes prior paid evidence without merging it into a new claim.
 */
export function openProductionBenchmarkCampaign({ registryBase, suiteId, runId, runRoot, configurationDigest, candidateDigest, suiteDigest, existingBinding }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(String(suiteId ?? ""))) {
    fail("Production benchmark campaign suite id is malformed");
  }
  if (typeof runId !== "string" || !runId || typeof runRoot !== "string" || !path.isAbsolute(runRoot)) {
    fail("Production benchmark campaign run identity is malformed");
  }
  if (![configurationDigest, candidateDigest, suiteDigest].every((digest) => /^[a-f0-9]{64}$/.test(String(digest ?? "")))) {
    fail("Production benchmark campaign digest binding is malformed");
  }
  const registryRoot = privateDirectory(path.join(registryBase, suiteId));
  const release = acquireBenchmarkRunLock(registryRoot, `campaign:${suiteId}`);
  try {
    const activePath = path.join(registryRoot, "active.json");
    const active = fs.existsSync(activePath) ? readJson(activePath, "active production benchmark campaign") : null;
    let loaded;
    if (existingBinding) {
      if (!validIdentity({ ...existingBinding, status: "active" })) fail("Run manifest has a malformed production campaign binding");
      if (!active || active.campaignId !== existingBinding.campaignId || active.campaignRoot !== existingBinding.campaignRoot) {
        fail("Production campaign active binding changed; exact output/resume lineage is required");
      }
      loaded = loadCampaign(existingBinding.campaignRoot);
      const expected = { ...existingBinding, runRoot: canonicalPath(runRoot) };
      if (!identityMatches(loaded.manifest, expected)) fail("Production campaign does not match the resumed run lineage");
    } else {
      const nextLineage = { suiteId, configurationDigest, candidateDigest, suiteDigest };
      const paidSameLineage = loadRetainedCampaigns(registryRoot).find((campaign) => {
        const evidence = inspectProductionBenchmarkCampaign(campaign);
        return evidence.providerStartedAttempts > 0
          && sameClaimLineage(campaign.manifest, nextLineage)
          && campaign.manifest.status !== "claim-passed";
      });
      if (paidSameLineage) {
        fail(`Production benchmark already has a paid campaign at ${paidSameLineage.manifest.runRoot}; resume that exact output instead of starting a fresh campaign`);
      }
      if (active) {
        if (typeof active.campaignRoot !== "string" || !inside(canonicalPath(registryRoot), canonicalPath(active.campaignRoot))) {
          fail("Active production campaign pointer is malformed or escapes its registry");
        }
        const prior = loadCampaign(active.campaignRoot);
        const evidence = inspectProductionBenchmarkCampaign(prior);
        if (evidence.providerStartedAttempts === 0) {
          prior.manifest.status = "superseded-before-provider-start";
          writePrivateAtomic(prior.manifestPath, `${JSON.stringify(prior.manifest, null, 2)}\n`);
        } else if (!sameClaimLineage(prior.manifest, nextLineage)
          && ["active", "claim-sealed", "complete"].includes(prior.manifest.status)) {
          prior.manifest.status = "superseded-changed-lineage-no-claim";
          prior.manifest.claimOutcome = {
            allowed: false,
            reason: "candidate-or-configuration-changed",
            finalizedAt: new Date().toISOString()
          };
          prior.manifest.supersededBy = { candidateDigest, configurationDigest, suiteDigest };
          writePrivateAtomic(prior.manifestPath, `${JSON.stringify(prior.manifest, null, 2)}\n`);
        }
      }
      const id = campaignId(suiteId);
      const campaignRoot = privateDirectory(path.join(registryRoot, id));
      const priorCampaignHistory = retainedCampaignHistory(registryRoot, id);
      const manifest = {
        schemaVersion: 1, campaignId: id, suiteId, runId, runRoot: canonicalPath(runRoot), campaignRoot,
        configurationDigest, candidateDigest, suiteDigest, status: "active", createdAt: new Date().toISOString(),
        completedAt: null, claimOutcome: null, priorCampaignHistory, attemptLedger: emptyBenchmarkLedgerBinding()
      };
      const manifestPath = path.join(campaignRoot, "campaign.json");
      writePrivateAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      writePrivateAtomic(activePath, `${JSON.stringify({ schemaVersion: 1, campaignId: id, campaignRoot }, null, 2)}\n`);
      loaded = { manifest, manifestPath, ledgerPath: path.join(campaignRoot, "attempts.jsonl"), ledger: { binding: manifest.attemptLedger, records: [] } };
    }

    let ledger = loaded.ledger;
    const append = (event) => {
      const record = { schemaVersion: 1, campaignId: loaded.manifest.campaignId, runId: loaded.manifest.runId, ...event, recordedAt: new Date().toISOString() };
      loaded.manifest.attemptLedger = appendBenchmarkLedger(loaded.ledgerPath, record, loaded.manifest.attemptLedger);
      writePrivateAtomic(loaded.manifestPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`);
      ledger = { binding: loaded.manifest.attemptLedger, records: [...ledger.records, record] };
    };
    const assertWritable = () => {
      if (loaded.manifest.status !== "active") fail("Production benchmark campaign is no longer writable");
    };
    return {
      binding: publicBinding(loaded.manifest),
      providerStarted(identity) {
        assertWritable();
        append({ ...eventIdentity(identity), event: "provider-started" });
        if (!this.snapshot().allAttempts.ledgerExact) fail("Production campaign rejected a duplicate or malformed provider-start identity");
      },
      providerReturned(value) {
        assertWritable();
        append({ ...eventIdentity(value), event: "provider-returned", usage: value?.usage, usageStatus: value?.usageStatus });
        if (!this.snapshot().allAttempts.ledgerExact) fail("Production campaign rejected a duplicate, unmatched, or malformed provider-return identity");
      },
      snapshot() { return inspectProductionBenchmarkCampaign({ manifest: loaded.manifest, ledger }); },
      sealForClaim(runs) {
        const evidence = this.snapshot();
        if (["claim-passed", "no-claim"].includes(loaded.manifest.status)) return evidence;
        if (!evidence.passed) fail("Production campaign cannot be sealed with unknown, lower-bound, unmatched, or malformed provider attempts");
        const expected = productionCampaignExpectedAttempts(runs);
        if (!productionCampaignAttemptCoverage(expected, evidence)) {
          fail("Production campaign cannot be sealed because its provider attempts do not exactly match the accepted run ledger");
        }
        if (loaded.manifest.status === "claim-sealed") return evidence;
        if (loaded.manifest.status !== "active") fail("Production benchmark campaign is no longer sealable");
        loaded.manifest.status = "claim-sealed";
        loaded.manifest.sealedAt = new Date().toISOString();
        writePrivateAtomic(loaded.manifestPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`);
        return this.snapshot();
      },
      finalizeClaim({ allowed, reason }) {
        if (typeof allowed !== "boolean" || typeof reason !== "string" || !reason.trim()) {
          fail("Production campaign claim outcome is malformed");
        }
        if (["claim-passed", "no-claim"].includes(loaded.manifest.status)) {
          if (loaded.manifest.claimOutcome?.allowed !== allowed) fail("Production campaign claim outcome changed after finalization");
          return this.snapshot();
        }
        if (loaded.manifest.status !== "claim-sealed") fail("Production campaign must be claim-sealed before recording its claim outcome");
        const finalizedAt = new Date().toISOString();
        loaded.manifest.status = allowed ? "claim-passed" : "no-claim";
        loaded.manifest.claimOutcome = { allowed, reason: reason.trim().slice(0, 240), finalizedAt };
        loaded.manifest.completedAt = finalizedAt;
        writePrivateAtomic(loaded.manifestPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`);
        return this.snapshot();
      },
      finalizeTerminalNoClaim({ reason, runs }) {
        if (typeof reason !== "string" || !reason.trim()) {
          fail("Production campaign terminal no-claim reason is malformed");
        }
        if (loaded.manifest.status === "no-claim") {
          if (loaded.manifest.claimOutcome?.allowed !== false) {
            fail("Production campaign terminal no-claim outcome changed after finalization");
          }
          return this.snapshot();
        }
        if (loaded.manifest.status !== "active") {
          fail("Production benchmark campaign is no longer terminal-finalizable");
        }
        const evidence = this.snapshot();
        if (!evidence.passed) {
          fail("Production campaign terminal no-claim requires exact settled usage for every provider attempt");
        }
        const expected = productionCampaignExpectedAttempts(runs);
        if (!productionCampaignAttemptCoverage(expected, evidence)) {
          fail("Production campaign terminal no-claim does not exactly match the accepted run ledger");
        }
        const finalizedAt = new Date().toISOString();
        loaded.manifest.status = "no-claim";
        loaded.manifest.claimOutcome = {
          allowed: false,
          reason: reason.trim().slice(0, 240),
          finalizedAt
        };
        loaded.manifest.completedAt = finalizedAt;
        writePrivateAtomic(loaded.manifestPath, `${JSON.stringify(loaded.manifest, null, 2)}\n`);
        return this.snapshot();
      },
      close: release
    };
  } catch (error) {
    release();
    throw error;
  }
}

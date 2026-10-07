import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

import { compareReleaseVersions, releaseVersion, writeUpdateCache } from "../../piagent-core/extensions/update-check.js";

// Piagent updates from the dashboard: what is installed, what the registry
// offers, and one click that moves the machine to it. Pi is never offered
// past the version the newest Piagent pins (its peer dependency): that is the
// host its managed runtime is qualified on. A newer Pi is shown as untested.
//
// The registry is asked in the background, at most every hour unless the
// member asks now; the dashboard reads the cached answer. Everything read from
// outside (registry answers, the cache and job files any local process could
// write) is accepted only as release versions and known codes.
const PLATFORM = "@piagent/platform";
const HOST = "@earendil-works/pi-coding-agent";
// Releases ship several times a day; members should hear within the hour.
export const CHECK_EVERY_MS = 60 * 60 * 1000;
const FORCED_CHECK_GAP_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;
const MAX_FILE_BYTES = 4096;
const STATUS_FILE = "piagent-update-status.json", JOB_FILE = "piagent-update-job.json";
// A run that has not finished in this time died with its process.
const JOB_STALE_MS = 45 * 60 * 1000;
// A finished run is reported for a day, then no longer.
const JOB_REPORTED_MS = 24 * 60 * 60 * 1000;
const JOB_STATES = new Set(["starting", "running", "succeeded", "failed"]);
const JOB_REASONS = new Set(["update-command-failed", "update-version-mismatch", "dashboard-restart-failed", "update-interrupted", "update-start-failed"]);

export type Registry = { latest?: string; latestHost?: string; hostLatest?: string; checkedAt?: number };
export type UpdateJob = { state: "starting" | "running" | "succeeded" | "failed"; from: string; to: string; startedAt: string;
  finishedAt?: string; pid?: number; reason?: string; installed?: string; bindingChanged?: boolean };
export type UpdateStatus = {
  schemaVersion: 1; version: "piagent-update-status-v1";
  installable: boolean; reason: "working-copy" | "company-runtime" | null;
  checkedAt: string | null; checking: boolean; checkEveryHours: number;
  piagent: { installed: string | null; latest: string | null; updateAvailable: boolean };
  pi: { installed: string | null; required: string | null; latest: string | null; updateAvailable: boolean; newerUntested: boolean };
  updateAvailable: boolean; runningConversations: number; job: UpdateJob | null;
};

const stateDirectory = (home: string) => path.join(home, ".pi");
function readSmallJson(file: string): any {
  try { if (fs.statSync(file).size > MAX_FILE_BYTES) return undefined; return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return undefined; }
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
const version = (value: unknown) => releaseVersion(value) ?? undefined;

export function readRegistryCache(home: string): Registry {
  const value = readSmallJson(path.join(stateDirectory(home), STATUS_FILE)), checkedAt = Date.parse(value?.checkedAt);
  return { latest: version(value?.latest), latestHost: version(value?.latestHost), hostLatest: version(value?.hostLatest),
    checkedAt: Number.isFinite(checkedAt) ? checkedAt : undefined };
}
export function writeRegistryCache(home: string, registry: Registry, now: number): void {
  writeJson(path.join(stateDirectory(home), STATUS_FILE), { schemaVersion: 1, latest: registry.latest ?? null, latestHost: registry.latestHost ?? null,
    hostLatest: registry.hostLatest ?? null, checkedAt: new Date(now).toISOString() });
  // The Terminal's own notice reads the shared cache: keep both on one answer.
  if (registry.latest) writeUpdateCache(home, registry.latest, now);
}

export function readUpdateJob(home: string, now = Date.now(), alive = processAlive): UpdateJob | null {
  const value = readSmallJson(path.join(stateDirectory(home), JOB_FILE));
  const from = version(value?.from), to = version(value?.to), startedAt = Date.parse(value?.startedAt);
  if (!value || !JOB_STATES.has(value.state) || !from || !to || !Number.isFinite(startedAt)) return null;
  const job: UpdateJob = { state: value.state, from, to, startedAt: new Date(startedAt).toISOString() };
  const finishedAt = Date.parse(value.finishedAt);
  if (Number.isFinite(finishedAt)) job.finishedAt = new Date(finishedAt).toISOString();
  if ((job.state === "succeeded" || job.state === "failed") && Number.isFinite(finishedAt) && now - finishedAt > JOB_REPORTED_MS) return null;
  if (Number.isSafeInteger(value.pid) && value.pid > 0) job.pid = value.pid;
  if (JOB_REASONS.has(value.reason)) job.reason = value.reason;
  if (version(value.installed)) job.installed = version(value.installed);
  if (value.bindingChanged === true) job.bindingChanged = true;
  // A run whose process is gone (or never reported one) did not finish.
  if ((job.state === "running" || job.state === "starting") && (now - startedAt > JOB_STALE_MS || (job.pid ? !alive(job.pid) : now - startedAt > 120_000)))
    return { ...job, state: "failed", reason: "update-interrupted" };
  return job;
}
export function writeUpdateJob(home: string, job: UpdateJob): void { writeJson(path.join(stateDirectory(home), JOB_FILE), job); }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }

// The npm helper this dashboard runs from can update itself; a working copy
// is updated with git, and a company runtime by the dashboard that owns it.
export function updateTarget(packageRoot: string, managed: boolean): { installable: boolean; reason: UpdateStatus["reason"] } {
  if (managed) return { installable: false, reason: "company-runtime" };
  const parts = path.resolve(packageRoot).split(path.sep);
  const installed = parts.includes("node_modules") && !parts.some((part) => part === "_npx" || part === "_cacache");
  return installed ? { installable: true, reason: null } : { installable: false, reason: "working-copy" };
}

export function composeUpdateStatus(input: { installedPiagent?: string; installedPi?: string; target: ReturnType<typeof updateTarget>;
  registry: Registry; job: UpdateJob | null; runningConversations: number; checking: boolean }): UpdateStatus {
  const installedPiagent = version(input.installedPiagent) ?? null, installedPi = version(input.installedPi) ?? null;
  const { latest, latestHost, hostLatest } = input.registry;
  const piagentNewer = Boolean(installedPiagent && latest && compareReleaseVersions(latest, installedPiagent) > 0);
  // The Pi update is the version the newest Piagent pins, whichever way it
  // moves; it is only offered together with that Piagent.
  const piChange = Boolean(latestHost && installedPi !== latestHost && (piagentNewer || installedPiagent === latest));
  return { schemaVersion: 1, version: "piagent-update-status-v1", installable: input.target.installable, reason: input.target.reason,
    checkedAt: input.registry.checkedAt ? new Date(input.registry.checkedAt).toISOString() : null, checking: input.checking,
    checkEveryHours: CHECK_EVERY_MS / 3_600_000,
    piagent: { installed: installedPiagent, latest: latest ?? null, updateAvailable: piagentNewer },
    pi: { installed: installedPi, required: latestHost ?? null, latest: hostLatest ?? null, updateAvailable: piChange,
      newerUntested: Boolean(hostLatest && latestHost && compareReleaseVersions(hostLatest, latestHost) > 0) },
    updateAvailable: piagentNewer || piChange, runningConversations: input.runningConversations, job: input.job };
}

type NpmView = (spec: string, field: string) => Promise<unknown>;
const npmView: NpmView = (spec, field) => new Promise((resolve) => {
  execFile("npm", ["view", spec, field, "--json"], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 },
    (error, stdout) => { if (error) return resolve(undefined); try { const value = JSON.parse(String(stdout).trim() || "null"); resolve(Array.isArray(value) && value.length === 1 ? value[0] : value); } catch { resolve(undefined); } });
});

// One answer from the registry, or null when it could not be read.
export async function probeRegistry(view: NpmView = npmView): Promise<Registry | null> {
  const latest = version(await view(PLATFORM, "version"));
  if (!latest) return null;
  const peers = await view(`${PLATFORM}@${latest}`, "peerDependencies") as Record<string, unknown> | undefined;
  return { latest, latestHost: version(peers?.[HOST]), hostLatest: version(await view(HOST, "version")) };
}

export class UpdateCenter {
  #home: string; #packageRoot: string; #piVersion?: string; #target: ReturnType<typeof updateTarget>;
  #busy: () => Promise<number>; #view: NpmView; #now: () => number; #spawnJob: (args: string[]) => number | undefined;
  #probe: Promise<void> | null = null; #lastForced = 0; #timer: NodeJS.Timeout | null = null;

  constructor(options: { packageRoot: string; piVersion?: string; managed: boolean; busy: () => Promise<number>; home?: string;
    view?: NpmView; now?: () => number; spawnJob?: (args: string[]) => number | undefined }) {
    this.#home = options.home ?? os.homedir(); this.#packageRoot = options.packageRoot; this.#piVersion = options.piVersion;
    this.#target = updateTarget(options.packageRoot, options.managed); this.#busy = options.busy;
    this.#view = options.view ?? npmView; this.#now = options.now ?? Date.now;
    this.#spawnJob = options.spawnJob ?? ((args) => {
      const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true, cwd: this.#home,
        env: { ...process.env, PIAGENT_NO_UPDATE_CHECK: "1" } });
      child.unref(); return child.pid;
    });
  }

  // Only a machine that can update itself asks the registry (a working copy
  // or a company runtime never does, nor any run with PIAGENT_NO_UPDATE_CHECK).
  #asks(): boolean { return this.#target.installable && !process.env.PIAGENT_NO_UPDATE_CHECK?.trim(); }
  // Checks now when the cached answer is older than the period, then on it.
  start(): void {
    if (this.#timer || !this.#asks()) return;
    void this.#refreshIfStale();
    this.#timer = setInterval(() => void this.#refreshIfStale(), 15 * 60 * 1000); this.#timer.unref();
  }
  close(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  #installedPiagent(): string | undefined {
    try { return version(JSON.parse(fs.readFileSync(path.join(this.#packageRoot, "package.json"), "utf8")).version); } catch { return undefined; }
  }
  async #refreshIfStale(): Promise<void> {
    const checkedAt = readRegistryCache(this.#home).checkedAt;
    if (!checkedAt || this.#now() - checkedAt >= CHECK_EVERY_MS) await this.#refresh();
  }
  #refresh(): Promise<void> {
    this.#probe ??= (async () => {
      try { const registry = await probeRegistry(this.#view); if (registry) writeRegistryCache(this.#home, registry, this.#now()); }
      catch { /* the next period tries again */ }
      finally { this.#probe = null; }
    })();
    return this.#probe;
  }

  async status(): Promise<UpdateStatus> {
    return composeUpdateStatus({ installedPiagent: this.#installedPiagent(), installedPi: this.#piVersion, target: this.#target,
      registry: readRegistryCache(this.#home), job: readUpdateJob(this.#home, this.#now()), runningConversations: await this.#busy().catch(() => 0),
      checking: this.#probe !== null });
  }
  async check(): Promise<UpdateStatus> {
    if (!this.#asks()) return this.status();
    if (this.#now() - this.#lastForced >= FORCED_CHECK_GAP_MS) { this.#lastForced = this.#now(); await this.#refresh(); }
    else if (this.#probe) await this.#probe;
    return this.status();
  }
  // `request.version`: the Piagent version the member chose to install.
  async apply(request: unknown): Promise<{ job: UpdateJob }> {
    const wanted = version((request as { version?: unknown } | null)?.version);
    if (!wanted) throw new Error("update-request-invalid");
    const status = await this.status();
    if (!status.installable) throw new Error("update-not-installable");
    if (status.job && (status.job.state === "running" || status.job.state === "starting")) throw new Error("update-already-running");
    if (status.runningConversations > 0) throw new Error("update-blocked-running");
    if (!status.updateAvailable) throw new Error("update-not-available");
    if (wanted !== status.piagent.latest) throw new Error("update-version-changed");
    const from = status.piagent.installed ?? wanted;
    const job: UpdateJob = { state: "starting", from, to: wanted, startedAt: new Date(this.#now()).toISOString() };
    writeUpdateJob(this.#home, job);
    const pid = this.#spawnJob([path.join(this.#packageRoot, "scripts", "dashboard-update-job.mjs"), "--from", from, "--to", wanted]);
    if (!pid) { const failed: UpdateJob = { ...job, state: "failed", reason: "update-start-failed", finishedAt: new Date(this.#now()).toISOString() }; writeUpdateJob(this.#home, failed); return { job: failed }; }
    const started: UpdateJob = { ...job, pid }; writeUpdateJob(this.#home, started);
    return { job: started };
  }
}

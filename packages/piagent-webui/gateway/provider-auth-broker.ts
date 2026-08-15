import { createHash, randomBytes } from "node:crypto";

import { redactSensitiveText } from "../../piagent-core/extensions/redaction-core.js";

const JOB_TTL_MS = 10 * 60_000;
const MAX_EVENTS = 16;
const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

type AuthPrompt = { signal?: AbortSignal; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[] };
type AuthEvent = { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string } | { type: "device_code"; userCode: string; verificationUri: string;
    intervalSeconds?: number; expiresInSeconds?: number } | { type: "progress"; message: string };
type ModelRuntime = { getProviders(): readonly any[]; hasConfiguredAuth(providerId: string): boolean;
  login(providerId: string, type: "oauth", interaction: { signal: AbortSignal; prompt(prompt: AuthPrompt): Promise<string>; notify(event: AuthEvent): void }): Promise<unknown> };

type PublicEvent = { sequence: number; type: "info" | "auth-url" | "device-code" | "progress"; message: string | null;
  url: string | null; links: Array<{ url: string; label: string | null }>; userCode: string | null; expiresInSeconds: number | null };
type PublicPrompt = { promptRef: string; type: AuthPrompt["type"]; message: string; placeholder: string | null;
  options: Array<{ id: string; label: string; description: string | null }> };
type Job = { jobRef: string; providerRef: string; providerId: string; providerName: string; startedAt: string; expiresAt: string;
  state: "running" | "completed" | "failed" | "cancelled"; events: PublicEvent[]; sequence: number; prompt: PublicPrompt | null;
  promptResolve: ((value: string) => void) | null; promptReject: ((error: Error) => void) | null; controller: AbortController;
  promptOptionValues: Map<string, string> | null; reasonCode: string | null };

function safeText(value: unknown, fallback = ""): string {
  const text = redactSensitiveText(typeof value === "string" ? value : fallback).text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 512) || fallback;
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4_096) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

function providerRef(providerId: string): string {
  return `provider.${createHash("sha256").update(providerId).digest("hex")}`;
}

export class ProviderAuthBroker {
  readonly #runtime: ModelRuntime;
  readonly #jobs = new Map<string, Job>();

  constructor(runtime: ModelRuntime) { this.#runtime = runtime; }

  #providers() {
    return this.#runtime.getProviders().filter((provider) => provider?.auth?.oauth).map((provider) => ({
      providerRef: providerRef(String(provider.id)), providerId: String(provider.id), name: safeText(provider.name, String(provider.id)),
      configured: this.#runtime.hasConfiguredAuth(String(provider.id))
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  catalog() {
    const providers = this.#providers();
    return { schemaVersion: 1, version: "piagent-provider-auth-catalog-v1", generatedAt: new Date().toISOString(),
      state: "ready", providers: providers.map(({ providerRef, name, configured }) => ({ providerRef, name, method: "oauth", state: configured ? "connected" : "not-connected" })),
      reasonCode: providers.length ? null : "no-oauth-provider" };
  }

  #cleanup(): void {
    const now = Date.now();
    for (const [ref, job] of this.#jobs) if (Date.parse(job.expiresAt) <= now) {
      job.controller.abort(); job.promptReject?.(new Error("provider-auth-expired")); this.#jobs.delete(ref);
    }
  }

  #public(job: Job) {
    return { schemaVersion: 1, version: "piagent-provider-auth-job-v1", generatedAt: new Date().toISOString(), jobRef: job.jobRef,
      providerRef: job.providerRef, providerName: job.providerName, startedAt: job.startedAt, expiresAt: job.expiresAt,
      state: job.state, events: job.events, prompt: job.prompt, reasonCode: job.reasonCode };
  }

  read(jobRef: string) {
    this.#cleanup(); if (!REF.test(jobRef)) throw new Error("provider-auth-job-invalid");
    const job = this.#jobs.get(jobRef); if (!job) throw new Error("provider-auth-job-not-found"); return this.#public(job);
  }

  start(command: unknown) {
    this.#cleanup();
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("provider-auth-command-invalid");
    const record = command as Record<string, unknown>;
    if (record.action !== "provider-auth.start" || typeof record.providerRef !== "string" || Object.keys(record).some((key) => !["action", "providerRef"].includes(key))) {
      throw new Error("provider-auth-command-invalid");
    }
    const provider = this.#providers().find((candidate) => candidate.providerRef === record.providerRef);
    if (!provider) throw new Error("provider-auth-provider-not-found");
    const existing = [...this.#jobs.values()].find((job) => job.providerRef === provider.providerRef && job.state === "running");
    if (existing) return this.#public(existing);
    const started = Date.now(), controller = new AbortController();
    const job: Job = { jobRef: `authjob.${randomBytes(24).toString("base64url")}`, providerRef: provider.providerRef,
      providerId: provider.providerId, providerName: provider.name, startedAt: new Date(started).toISOString(),
      expiresAt: new Date(started + JOB_TTL_MS).toISOString(), state: "running", events: [], sequence: 0, prompt: null,
      promptResolve: null, promptReject: null, promptOptionValues: null, controller, reasonCode: null };
    this.#jobs.set(job.jobRef, job);
    void this.#runtime.login(provider.providerId, "oauth", { signal: controller.signal,
      notify: (event) => this.#notify(job, event), prompt: (prompt) => this.#prompt(job, prompt) })
      .then(() => { job.state = "completed"; job.prompt = null; job.promptResolve = null; job.promptReject = null; job.promptOptionValues = null; })
      .catch((error) => { job.state = controller.signal.aborted ? "cancelled" : "failed"; job.prompt = null;
        job.promptResolve = null; job.promptReject = null; job.promptOptionValues = null; job.reasonCode = controller.signal.aborted ? "provider-auth-cancelled"
          : error instanceof Error && error.message.includes("synchron") ? "provider-auth-sync-failed" : "provider-auth-failed"; });
    return this.#public(job);
  }

  #notify(job: Job, event: AuthEvent): void {
    if (job.state !== "running") return;
    let projected: Omit<PublicEvent, "sequence"> | null = null;
    if (event.type === "auth_url") {
      const url = safeHttpsUrl(event.url); if (url) projected = { type: "auth-url", message: safeText(event.instructions) || null,
        url, links: [], userCode: null, expiresInSeconds: null };
    } else if (event.type === "device_code") {
      const url = safeHttpsUrl(event.verificationUri), code = safeText(event.userCode).slice(0, 128);
      if (url && code) projected = { type: "device-code", message: null, url, links: [], userCode: code,
        expiresInSeconds: Number.isFinite(event.expiresInSeconds) ? Math.max(1, Math.min(3600, Number(event.expiresInSeconds))) : null };
    } else if (event.type === "info") projected = { type: "info", message: safeText(event.message) || null, url: null,
      links: (event.links ?? []).slice(0, 6).flatMap((link) => { const url = safeHttpsUrl(link.url); return url ? [{ url, label: safeText(link.label) || null }] : []; }),
      userCode: null, expiresInSeconds: null };
    else projected = { type: "progress", message: safeText(event.message) || null, url: null, links: [], userCode: null, expiresInSeconds: null };
    if (!projected) return;
    job.events.push({ sequence: ++job.sequence, ...projected });
    if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  }

  #prompt(job: Job, prompt: AuthPrompt): Promise<string> {
    if (job.state !== "running" || job.prompt) return Promise.reject(new Error("provider-auth-prompt-conflict"));
    if (prompt.type === "secret") return Promise.reject(new Error("provider-auth-secret-prompt-unsupported"));
    const promptRef = `authprompt.${randomBytes(18).toString("base64url")}`;
    const options = prompt.type === "select" ? (prompt.options ?? []).slice(0, 32).flatMap((option) => {
      if (typeof option.id !== "string" || option.id.length > 1_024) return [];
      const id = `authoption.${randomBytes(18).toString("base64url")}`;
      return [{ id, value: option.id, label: safeText(option.label), description: safeText(option.description) || null }];
    }).filter((option) => option.label) : [];
    job.promptOptionValues = prompt.type === "select" ? new Map(options.map((option) => [option.id, option.value])) : null;
    job.prompt = { promptRef, type: prompt.type, message: safeText(prompt.message, "Authentication"),
      placeholder: safeText(prompt.placeholder) || null,
      options: options.map(({ id, label, description }) => ({ id, label, description })) };
    return new Promise((resolve, reject) => {
      job.promptResolve = resolve; job.promptReject = reject;
      const abort = () => { if (job.prompt?.promptRef === promptRef) { job.prompt = null; job.promptResolve = null; job.promptReject = null;
        job.promptOptionValues = null; reject(new Error("provider-auth-prompt-cancelled")); } };
      if (prompt.signal?.aborted) abort(); else prompt.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  respond(command: unknown) {
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("provider-auth-response-invalid");
    const record = command as Record<string, unknown>;
    if (record.action !== "provider-auth.respond" || typeof record.jobRef !== "string" || typeof record.promptRef !== "string"
      || typeof record.value !== "string" || record.value.length > 16_384 || Object.keys(record).some((key) => !["action", "jobRef", "promptRef", "value"].includes(key))) {
      throw new Error("provider-auth-response-invalid");
    }
    const job = this.#jobs.get(record.jobRef); if (!job || job.state !== "running" || job.prompt?.promptRef !== record.promptRef || !job.promptResolve) {
      throw new Error("provider-auth-prompt-stale");
    }
    const answer = job.prompt.type === "select" ? job.promptOptionValues?.get(record.value) : record.value;
    if (answer === undefined) throw new Error("provider-auth-response-invalid");
    const resolve = job.promptResolve; job.prompt = null; job.promptResolve = null; job.promptReject = null; job.promptOptionValues = null; resolve(answer);
    return this.#public(job);
  }

  cancel(command: unknown) {
    if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("provider-auth-cancel-invalid");
    const record = command as Record<string, unknown>;
    if (record.action !== "provider-auth.cancel" || typeof record.jobRef !== "string" || Object.keys(record).some((key) => !["action", "jobRef"].includes(key))) {
      throw new Error("provider-auth-cancel-invalid");
    }
    const job = this.#jobs.get(record.jobRef); if (!job) throw new Error("provider-auth-job-not-found");
    if (job.state === "running") { job.controller.abort(); job.promptReject?.(new Error("provider-auth-cancelled")); job.prompt = null;
      job.promptResolve = null; job.promptReject = null; job.state = "cancelled"; job.reasonCode = "provider-auth-cancelled"; }
    return this.#public(job);
  }
}

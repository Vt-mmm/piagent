import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";

export type McpAdapterModules = {
  loadMcpConfig(overridePath?: string, cwd?: string): any;
  resolveServerUrl(definition: any): string | undefined;
  supportsOAuth(definition: any): boolean;
  createOAuthRuntime(signal?: AbortSignal): any;
  shutdownOAuth(runtime: any): Promise<void>;
  authenticate(name: string, url: string, definition: any, options: any): Promise<string>;
  getAuthStatus(name: string, options: any): Promise<"authenticated" | "expired" | "not_authenticated">;
  getAuthStorageOptions(oauthDir: unknown, cwd?: string): any;
};

type Job = {
  jobRef: string;
  sessionRef: string;
  connectionRef: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  state: "running" | "completed" | "failed" | "cancelled";
  authorizationUrl: string | null;
  reasonCode: string | null;
  controller: AbortController;
  runtime: any;
};

const MAX_JOBS = 16;
const JOB_TTL_MS = 10 * 60_000;

function safeReason(error: unknown): string {
  if (error instanceof Error && /abort|cancel/i.test(error.message)) return "mcp-oauth-cancelled";
  const detail = error && typeof error === "object" ? error as { name?: unknown; status?: unknown; message?: unknown } : {};
  const registrationRejected = detail.name === "RegistrationRejectedError"
    || (typeof detail.message === "string" && /Dynamic Client Registration rejected/i.test(detail.message));
  if (registrationRejected && (detail.status === 403
    || (typeof detail.message === "string" && /HTTP 403/i.test(detail.message)))) return "mcp-oauth-client-not-approved";
  if (registrationRejected) return "mcp-oauth-registration-rejected";
  return "mcp-oauth-failed";
}

function safeName(value: string): string {
  return redactSensitiveText(value).text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "MCP";
}

function safeAuthorizationUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))) {
    throw new Error("mcp-oauth-url-invalid");
  }
  if (parsed.username || parsed.password) throw new Error("mcp-oauth-url-invalid");
  return parsed.toString();
}

function isLoopbackHttpUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  } catch { return false; }
}

export class McpAuthBroker {
  readonly #adapterRoot: string;
  readonly #moduleLoader: (() => Promise<McpAdapterModules>) | null;
  readonly #jobs = new Map<string, Job>();
  #modules: Promise<McpAdapterModules> | null = null;

  constructor(agentDir: string, moduleLoader?: () => Promise<McpAdapterModules>) {
    this.#adapterRoot = path.join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
    this.#moduleLoader = moduleLoader ?? null;
  }

  async #load(): Promise<McpAdapterModules> {
    if (this.#modules) return await this.#modules;
    if (this.#moduleLoader) {
      this.#modules = this.#moduleLoader();
      return await this.#modules;
    }
    this.#modules = (async () => {
      const files = ["config.ts", "utils.ts", "mcp-auth-flow.ts", "mcp-auth.ts"];
      for (const file of files) {
        const stat = fs.lstatSync(path.join(this.#adapterRoot, file));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("mcp-adapter-auth-unavailable");
      }
      const [config, utils, flow, storage] = await Promise.all(files.map((file) => import(pathToFileURL(path.join(this.#adapterRoot, file)).href)));
      return { loadMcpConfig: config.loadMcpConfig, resolveServerUrl: utils.resolveServerUrl, supportsOAuth: flow.supportsOAuth,
        createOAuthRuntime: flow.createOAuthRuntime, shutdownOAuth: flow.shutdownOAuth, authenticate: flow.authenticate,
        getAuthStatus: flow.getAuthStatus, getAuthStorageOptions: storage.getAuthStorageOptions } as McpAdapterModules;
    })();
    return await this.#modules;
  }

  async describe(cwd: string, name: string): Promise<{ oauthSupported: boolean; authState: "connected" | "expired" | "not-connected" | "unavailable" }> {
    try {
      const adapter = await this.#load(), config = adapter.loadMcpConfig(undefined, cwd), definition = config.mcpServers?.[name];
      const url = definition ? adapter.resolveServerUrl(definition) : undefined;
      if (!definition || isLoopbackHttpUrl(url) || !adapter.supportsOAuth(definition)) return { oauthSupported: false, authState: "unavailable" };
      const authStorageOptions = adapter.getAuthStorageOptions(config.settings?.oauthDir, cwd);
      const state = await adapter.getAuthStatus(name, { authStorageOptions });
      return { oauthSupported: true, authState: state === "authenticated" ? "connected" : state === "expired" ? "expired" : "not-connected" };
    } catch { return { oauthSupported: false, authState: "unavailable" }; }
  }

  async start(input: { sessionRef: string; connectionRef: string; cwd: string; name: string }): Promise<ReturnType<McpAuthBroker["read"]>> {
    this.#prune();
    const adapter = await this.#load(), config = adapter.loadMcpConfig(undefined, input.cwd), definition = config.mcpServers?.[input.name];
    const url = definition ? adapter.resolveServerUrl(definition) : undefined;
    if (!definition || isLoopbackHttpUrl(url) || !adapter.supportsOAuth(definition)) throw new Error("mcp-oauth-not-supported");
    if (!url) throw new Error("mcp-oauth-url-unavailable");
    const duplicate = [...this.#jobs.values()].find((job) => job.sessionRef === input.sessionRef && job.connectionRef === input.connectionRef && job.state === "running");
    if (duplicate) return this.read(duplicate.jobRef);
    const controller = new AbortController(), runtime = adapter.createOAuthRuntime(controller.signal), now = new Date();
    const job: Job = { jobRef: `mcp_auth_${randomBytes(24).toString("base64url")}`, sessionRef: input.sessionRef,
      connectionRef: input.connectionRef, name: safeName(input.name), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + JOB_TTL_MS).toISOString(),
      state: "running", authorizationUrl: null, reasonCode: null, controller, runtime };
    this.#jobs.set(job.jobRef, job);
    const authStorageOptions = adapter.getAuthStorageOptions(config.settings?.oauthDir, input.cwd);
    void adapter.authenticate(input.name, url, definition, { signal: controller.signal, runtime, authStorageOptions,
      onAuthorizationUrl: (authorizationUrl: string) => { if (job.state === "running") job.authorizationUrl = safeAuthorizationUrl(authorizationUrl); }
    }).then(() => { if (job.state === "running") job.state = "completed"; }, (error) => {
      if (job.state !== "running") return; job.state = controller.signal.aborted ? "cancelled" : "failed"; job.reasonCode = safeReason(error);
    }).finally(() => void adapter.shutdownOAuth(runtime).catch(() => undefined));
    return this.read(job.jobRef);
  }

  read(jobRef: string) {
    this.#prune();
    const job = this.#jobs.get(jobRef); if (!job) throw new Error("mcp-oauth-job-not-found");
    return { schemaVersion: 1 as const, version: "piagent-mcp-auth-job-v1" as const, generatedAt: new Date().toISOString(),
      jobRef: job.jobRef, sessionRef: job.sessionRef, connectionRef: job.connectionRef, name: job.name, createdAt: job.createdAt,
      expiresAt: job.expiresAt, state: job.state, authorizationUrl: job.authorizationUrl, reasonCode: job.reasonCode };
  }

  async cancel(jobRef: string): Promise<ReturnType<McpAuthBroker["read"]>> {
    const job = this.#jobs.get(jobRef); if (!job) throw new Error("mcp-oauth-job-not-found");
    if (job.state === "running") { job.state = "cancelled"; job.reasonCode = "cancelled-by-user"; job.controller.abort(); }
    return this.read(jobRef);
  }

  async close(): Promise<void> {
    for (const job of this.#jobs.values()) if (job.state === "running") { job.state = "cancelled"; job.controller.abort(); }
    this.#jobs.clear();
  }

  #prune(): void {
    const now = Date.now();
    for (const [jobRef, job] of this.#jobs) if (Date.parse(job.expiresAt) <= now) {
      if (job.state === "running") job.controller.abort(); this.#jobs.delete(jobRef);
    }
    while (this.#jobs.size > MAX_JOBS) this.#jobs.delete(this.#jobs.keys().next().value as string);
  }
}

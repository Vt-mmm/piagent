import { createHash, randomBytes } from "node:crypto";
import { WebSocket } from "ws";

import type { Catalog, SessionRow } from "../contracts/generated/session-catalog-v1.ts";
import { webUiModelRef } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { requestGatewayControl } from "./control-socket.ts";
import { gitHeadReader } from "./git-head.ts";
import { childRepositoryReader } from "./git-repositories.ts";
import type { GatewayEventKind, GatewayEventStore } from "./gateway-events.ts";

// The personal dashboard lists and drives company sessions through this relay.
// They run in the company Gateway, a separate process holding the Studio
// grants and never loading personal extensions. The relay authenticates to it
// like a browser (one-time launch capability, cookie, CSRF), re-publishes its
// events in this Gateway's single ordered stream, and forwards the requests of
// its sessions. Company content passes through this process; grants do not.
export const COMPANY_MODEL_REF = webUiModelRef("agent_watch_managed", "agent-watch-auto");
export type CompanyConnector = {
  configured(): boolean;
  // Starts the company Gateway if needed (may ask for Keychain access).
  ensure(): Promise<string>;
  // The control socket of an already running company Gateway, or null.
  attach(): Promise<string | null>;
};
export type CompanyStatus = { schemaVersion: 1; version: "piagent-company-status-v1"; model: "agent-watch-auto";
  available: boolean; state: "unconfigured" | "connecting" | "ready" | "unavailable"; reasonCode: string | null };
type Link = { origin: string; cookie: string; csrf: string; socket: string };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

const KINDS = new Set<GatewayEventKind>(["catalog.changed", "session.changed", "runtime.changed", "message.delta",
  "message.completed", "operation.settled", "tool.started", "tool.completed"]);
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const CATALOG_REUSE_MS = 5_000;
const failure = (error: unknown, fallback: string) => error instanceof Error && /^[a-z][a-z0-9:._-]{2,95}$/.test(error.message) ? error.message : fallback;

export class CompanyRelay {
  readonly #connector: CompanyConnector;
  readonly #events: GatewayEventStore;
  readonly #hubProject: (cwd: string) => string;
  readonly #folder: (projectRef: string) => Promise<string | null>;
  #link: Link | null = null;
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #catalog: Catalog | null = null;
  #models: unknown[] | null = null;
  #paths = new Map<string, string>();
  #owned = new Set<string>();
  #fresh = false;
  #fetchedAt = 0;
  #state: CompanyStatus["state"] = "connecting";
  #reason: string | null = null;
  #connecting: Promise<void> | null = null;
  #launching = false;
  #retry: NodeJS.Timeout | null = null;
  #closed = false;
  #lastAttach = 0;

  constructor(options: { connector: CompanyConnector; events: GatewayEventStore; hubProject(cwd: string): string;
    folder(projectRef: string): Promise<string | null> }) {
    this.#connector = options.connector; this.#events = options.events;
    this.#hubProject = options.hubProject; this.#folder = options.folder;
  }

  status(): CompanyStatus {
    const available = this.#connector.configured();
    return { schemaVersion: 1, version: "piagent-company-status-v1", model: "agent-watch-auto", available,
      state: available ? this.#state : "unconfigured", reasonCode: available ? this.#reason : null };
  }

  // At dashboard start the company runtime is attached or started, so its
  // history is listed at once. Starting may ask for Keychain access once
  // after an Agent Watch update; a refusal waits for an explicit reconnect.
  start(): void { if (this.#connector.configured()) void this.connect(true); else this.#state = "unconfigured"; }

  connect(launch = true): Promise<void> {
    // An attach in flight is followed by one launch when launching was asked
    // for; a launch in flight (maybe waiting on Keychain) is never repeated.
    if (this.#connecting && launch && !this.#launching) {
      return this.#connecting.then(() => this.#state === "ready" ? undefined : this.connect(true));
    }
    if (!this.#connecting) this.#launching = launch;
    this.#connecting ??= (async () => {
      if (this.#closed) return;
      if (this.#retry) { clearTimeout(this.#retry); this.#retry = null; }
      // An attach that finds nothing running keeps the more useful reason of
      // the last start attempt (e.g. Keychain refused).
      const previous = this.#reason;
      this.#state = "connecting"; this.#reason = null;
      try {
        const socket = launch ? await this.#connector.ensure() : await this.#connector.attach();
        if (!socket) throw new Error("company-gateway-stopped");
        this.#link = await this.#bootstrap(socket);
        await this.#open(this.#link);
        this.#state = "ready"; this.#fresh = false;
      } catch (error) {
        const reason = failure(error, "company-connect-failed");
        // Agent Watch re-imports after an update on its own, so a changed
        // binding is not kept once a later attach finds nothing running.
        this.#state = "unavailable";
        this.#reason = !launch && reason === "company-gateway-stopped" && previous && previous !== "managed-launch-binding-changed" ? previous : reason;
        // Keep re-attaching (never launching: no Keychain prompt) so a company
        // runtime started later, e.g. from Agent Watch, shows up by itself.
        if (!this.#closed) { this.#retry = setTimeout(() => void this.connect(false), 30_000); this.#retry.unref(); }
      }
      this.#events.publish("catalog.changed", { reasonCode: this.#state === "ready" ? "company-connected" : "company-unavailable" });
    })().finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  close(): void {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#ws?.terminate();
  }

  owns(sessionRef: unknown): boolean {
    return typeof sessionRef === "string" && (this.#owned.has(sessionRef) || !!this.#catalog?.sessions.some((row) => row.sessionRef === sessionRef));
  }

  handles(command: unknown): boolean {
    const value = command as { action?: unknown; sessionRef?: unknown; payload?: { modelRef?: unknown } } | null;
    return !!value && (value.action === "session.create" ? value.payload?.modelRef === COMPANY_MODEL_REF : this.owns(value.sessionRef));
  }

  async #bootstrap(socket: string): Promise<Link> {
    const answer = await requestGatewayControl(socket, { action: "issue-launch-url" });
    const launch = answer.ok ? (answer.value as { launchUrl?: unknown } | null)?.launchUrl : null;
    if (typeof launch !== "string") throw new Error("company-gateway-starting");
    const url = new URL(launch), capability = new URLSearchParams(url.hash.slice(1)).get("bootstrap");
    if (!LOOPBACK.test(url.origin) || !capability) throw new Error("company-gateway-invalid");
    const response = await fetch(`${url.origin}/api/v1/bootstrap`, { method: "POST", redirect: "error",
      headers: { Origin: url.origin, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ capability }) });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0], body = await response.json().catch(() => null) as { csrfToken?: unknown } | null;
    if (!response.ok || !cookie || typeof body?.csrfToken !== "string") throw new Error("company-gateway-auth-failed");
    return { origin: url.origin, cookie, csrf: body.csrfToken, socket };
  }

  #open(link: Link): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${link.origin.replace("http:", "ws:")}/api/v1/gateway`, "piagent.gateway.v1",
        { headers: { Origin: link.origin, Cookie: link.cookie }, maxPayload: 70_000, perMessageDeflate: false });
      let hello = false;
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("company-gateway-timeout")); }, 5_000);
      ws.on("open", () => ws.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "connect",
        clientRef: "dashboard-company-relay", minimumProtocol: 1, maximumProtocol: 1, lastEventSequence: null, catalogRevision: null })));
      ws.on("message", (data) => {
        let frame: Record<string, any>;
        try { frame = JSON.parse(String(data)); } catch { ws.close(1007, "invalid-json"); return; }
        if (frame.messageType === "hello") { hello = true; clearTimeout(timer); this.#ws = ws; resolve(); return; }
        if (frame.messageType === "response") {
          const pending = this.#pending.get(String(frame.requestId));
          if (!pending) return;
          this.#pending.delete(String(frame.requestId)); clearTimeout(pending.timer);
          if (frame.ok === true) pending.resolve(frame.result); else pending.reject(new Error(String(frame.error?.code ?? "company-request-failed")));
          return;
        }
        if (frame.messageType !== "event") return;
        this.#fresh = false; this.#models = null;
        const payload = frame.payload && typeof frame.payload === "object" ? frame.payload as Record<string, unknown> : {};
        if (typeof payload.sessionRef === "string") this.#owned.add(payload.sessionRef);
        if (KINDS.has(frame.kind)) this.#events.publish(frame.kind, payload);
        else this.#events.publish("catalog.changed", { reasonCode: "company-resync" });
      });
      ws.on("error", () => { /* close follows */ });
      ws.on("close", () => {
        clearTimeout(timer);
        if (!hello) { reject(new Error("company-gateway-rejected")); return; }
        if (this.#ws !== ws) return;
        this.#ws = null; this.#link = null;
        for (const [, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(new Error("company-gateway-disconnected")); }
        this.#pending.clear();
        this.#state = "unavailable"; this.#reason = "company-gateway-disconnected";
        this.#events.publish("catalog.changed", { reasonCode: "company-unavailable" });
        // A restarted company Gateway is re-attached; nothing is launched here.
        if (!this.#closed) this.#retry = setTimeout(() => void this.connect(false), 3_000);
      });
    });
  }

  // Reads only attach; starting the company runtime (and possibly asking for
  // Keychain access) is left to commands and the explicit connect route.
  async #ready(launch = false): Promise<Link> {
    if (this.#state !== "ready" || !this.#link || !this.#ws) await this.connect(launch);
    if (!this.#link || !this.#ws) throw new Error(this.#reason ?? "company-unavailable");
    return this.#link;
  }

  // One authenticated request to the company Gateway; a lapsed browser
  // session is renewed once through the control socket.
  async http(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; value: unknown }> {
    for (let attempt = 0; ; attempt += 1) {
      const link = await this.#ready();
      const response = await fetch(`${link.origin}${path}`, { method, redirect: "error",
        headers: { Accept: "application/json", Origin: link.origin, Cookie: link.cookie,
          ...(method === "POST" ? { "Content-Type": "application/json", "X-Piagent-CSRF": link.csrf } : {}) },
        body: method === "POST" ? JSON.stringify(body) : undefined });
      if (response.status === 401 && attempt === 0) { this.#link = await this.#bootstrap(link.socket); continue; }
      // The browser's own session is not the one refused here.
      if (response.status === 401 || response.status === 403) return { status: 503, value: { error: { code: "company-auth-failed" } } };
      return { status: response.status, value: await response.json().catch(() => null) };
    }
  }

  async json(method: "GET" | "POST", path: string, body?: unknown): Promise<any> {
    const result = await this.http(method, path, body);
    if (result.status >= 200 && result.status < 300) return result.value;
    throw new Error(String((result.value as { error?: { code?: unknown } } | null)?.error?.code ?? "company-request-failed"));
  }

  #request(method: "sessions.command", params: Record<string, unknown>): Promise<unknown> {
    return this.#ready().then(() => new Promise((resolve, reject) => {
      const requestId = randomBytes(24).toString("base64url");
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error("company-request-timeout")); }, 120_000);
      this.#pending.set(requestId, { resolve, reject, timer });
      this.#ws!.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "request", requestId, method, params }));
    }));
  }

  async #control(request: { action: "project.paths" } | { action: "project.register"; cwd: string }): Promise<unknown> {
    const link = await this.#ready();
    const answer = await requestGatewayControl(link.socket, request);
    if (!answer.ok) throw new Error((answer as { error: string }).error);
    return answer.value;
  }

  // Company rows under this Gateway's project refs, cached until an event or
  // for a few seconds: work run outside the company Gateway (its Terminal,
  // scripts) raises no event there, so the rows are re-read soon.
  // Reads never start the company runtime but re-attach to a running one,
  // at most every 10 s, so an earlier failed start does not hide company
  // sessions until the member clicks connect.
  #attachSoon(): void {
    if (this.#closed || this.#connecting || this.#state === "ready" || !this.#connector.configured()) return;
    const now = Date.now();
    if (now - this.#lastAttach < 10_000) return;
    this.#lastAttach = now; void this.connect(false);
  }

  async catalog(): Promise<Catalog | null> {
    if (this.#state !== "ready") { this.#attachSoon(); return this.#catalog; }
    if (this.#fresh && this.#catalog && Date.now() - this.#fetchedAt < CATALOG_REUSE_MS) return this.#catalog;
    // Folders only place rows under the hub's projects: failing to read them
    // keeps the last known folders, never the last known rows.
    const [catalog, paths] = await Promise.allSettled([this.json("GET", "/api/v1/session-catalog") as Promise<Catalog>,
      this.#control({ action: "project.paths" }) as Promise<Array<{ projectRef: string; cwd: string }>>]);
    if (paths.status === "fulfilled") this.#paths = new Map(paths.value.map((item) => [item.projectRef, item.cwd]));
    if (catalog.status === "fulfilled") { this.#catalog = catalog.value; this.#fresh = true; this.#fetchedAt = Date.now(); }
    return this.#catalog;
  }

  async merge(personal: Catalog): Promise<Catalog> {
    const company = await this.catalog();
    if (personal.state !== "ready" || !personal.catalogRevision) return personal;
    const ready = this.#state === "ready";
    // The Git facts of a company conversation's folder are read here, on the
    // same Mac: the company Gateway may run an earlier release (Agent Watch
    // restarts it only now and then) that does not report them.
    const readHead = gitHeadReader(), readRepositories = childRepositoryReader();
    const rows: SessionRow[] = (company?.state === "ready" ? company.sessions : []).map((row) => {
      const folder = this.#paths.get(row.projectRef);
      const { gitBranch: _branch, gitRepositories: _repositories, ...rest } = row;
      const head = folder ? readHead(folder) : null, repositories = folder && !head ? readRepositories(folder) : [];
      return { ...rest, projectRef: folder ? this.#hubProject(folder) : row.projectRef, composerAvailable: ready && row.composerAvailable,
        ...(folder ? {} : _branch ? { gitBranch: _branch } : {}), ...(folder ? {} : _repositories ? { gitRepositories: _repositories } : {}),
        ...(head ? { gitBranch: head } : {}),
        ...(repositories.length ? { gitRepositories: repositories.map((repository) => ({ name: repository.name, branch: repository.head })) } : {}) };
    });
    const sessions = [...personal.sessions, ...rows].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    const digest = createHash("sha256").update(JSON.stringify([personal.catalogRevision, company?.catalogRevision ?? null, ready,
      rows.map((row) => [row.gitBranch ?? null, row.gitRepositories ?? null])])).digest("hex");
    return { ...personal, catalogRevision: `rev_${digest}`, sessions,
      page: { ...personal.page, returned: sessions.length, total: personal.page.total + rows.length } };
  }

  // Folders of company conversations, so the dashboard can offer them as
  // projects for new chats (company or personal).
  async folders(): Promise<string[]> {
    if (this.#state !== "ready") { this.#attachSoon(); return []; }
    // Registering a project (Agent Watch's WebUI button) emits no event.
    try {
      const paths = await this.#control({ action: "project.paths" }) as Array<{ projectRef: string; cwd: string }>;
      this.#paths = new Map(paths.map((item) => [item.projectRef, item.cwd]));
    } catch { /* keep the last known folders */ }
    return [...new Set(this.#paths.values())];
  }

  // The company entry of the new-chat model list.
  async models(): Promise<unknown[]> {
    if (this.#state !== "ready") { this.#attachSoon(); return []; }
    try { this.#models ??= ((await this.json("GET", "/api/v1/session-creation-options")) as { models?: unknown[] }).models ?? []; }
    catch { return []; }
    return this.#models;
  }

  async operations(): Promise<unknown[]> {
    if (this.#state !== "ready") return [];
    try { return ((await this.json("GET", "/api/v1/session-live-state")) as { operations?: unknown[] }).operations ?? []; }
    catch { return []; }
  }

  // Revisions are checked against the merged catalog the browser saw, then
  // rewritten for the company Gateway and back.
  async command(command: Record<string, any>, hubRevision: () => Promise<string | null>): Promise<unknown> {
    await this.#ready(true);
    this.#fresh = false;
    const company = await this.catalog(), current = await hubRevision();
    const forwarded: Record<string, any> = { ...command, expectedCatalogRevision: command.expectedCatalogRevision === current && company?.catalogRevision
      ? company.catalogRevision : command.expectedCatalogRevision };
    if (command.action === "session.create") {
      const folder = await this.#folder(String(command.payload?.projectRef ?? ""));
      if (!folder) throw new Error("session-project-not-found");
      const project = await this.#control({ action: "project.register", cwd: folder }) as { projectRef: string; placeRef: string };
      forwarded.payload = { ...command.payload, projectRef: project.projectRef, placeRef: project.placeRef };
    }
    const receipt = await this.#request("sessions.command", { command: forwarded }) as Record<string, unknown>;
    if (typeof receipt?.sessionRef === "string") this.#owned.add(receipt.sessionRef);
    this.#fresh = false;
    return { ...receipt, catalogRevisionAfter: await hubRevision() ?? receipt.catalogRevisionAfter };
  }
}

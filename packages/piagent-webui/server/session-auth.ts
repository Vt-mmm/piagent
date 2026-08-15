import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const SESSION_COOKIE = "piagent_webui_session";

function secret(): string { return randomBytes(32).toString("base64url"); }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookie(request: IncomingMessage, name: string): string | null {
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export type BrowserSession = { id: string; csrf: string; expiresAt: number };

export class SessionAuthority {
  readonly #initialBootstrap: string;
  readonly #bootstrapTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #cookieSigningKey = randomBytes(32);
  #bootstraps = new Map<string, number>();
  #sessions = new Map<string, BrowserSession>();

  constructor(options: { now?: number; bootstrapTtlMs?: number; sessionTtlMs?: number } = {}) {
    this.#bootstrapTtlMs = options.bootstrapTtlMs ?? 60_000;
    this.#sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000;
    this.#initialBootstrap = this.issueBootstrapCapability(options.now ?? Date.now());
  }

  get bootstrapCapability(): string { return this.#initialBootstrap; }

  issueBootstrapCapability(now = Date.now()): string {
    for (const [value, createdAt] of this.#bootstraps) {
      if (now > createdAt + this.#bootstrapTtlMs) this.#bootstraps.delete(value);
    }
    while (this.#bootstraps.size >= 8) this.#bootstraps.delete(this.#bootstraps.keys().next().value as string);
    const value = secret();
    this.#bootstraps.set(value, now);
    return value;
  }

  exchange(candidate: string, now = Date.now()): BrowserSession | null {
    const match = [...this.#bootstraps].find(([value, createdAt]) => now <= createdAt + this.#bootstrapTtlMs && equal(candidate, value));
    if (!match) return null;
    this.#bootstraps.delete(match[0]);
    const session = { id: randomUUID(), csrf: secret(), expiresAt: now + this.#sessionTtlMs };
    this.#sessions.set(session.id, session);
    return session;
  }

  authenticate(request: IncomingMessage, now = Date.now()): BrowserSession | null {
    const value = cookie(request, SESSION_COOKIE);
    if (!value) return null;
    const separator = value.lastIndexOf(".");
    if (separator < 1) return null;
    const id = value.slice(0, separator), signature = value.slice(separator + 1);
    if (!equal(signature, this.#cookieSignature(id))) return null;
    const session = this.#sessions.get(id);
    if (!session || session.expiresAt < now || !equal(id, session.id)) {
      if (session) this.#sessions.delete(id);
      return null;
    }
    return session;
  }

  authorizeMutation(request: IncomingMessage, now = Date.now()): BrowserSession | null {
    const session = this.authenticate(request, now);
    const csrf = request.headers["x-piagent-csrf"];
    return session && typeof csrf === "string" && equal(csrf, session.csrf) ? session : null;
  }

  cookieHeader(session: BrowserSession): string {
    const seconds = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    const token = `${session.id}.${this.#cookieSignature(session.id)}`;
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}`;
  }

  #cookieSignature(id: string): string {
    return createHmac("sha256", this.#cookieSigningKey).update(id).digest("base64url");
  }

  invalidate(): void { this.#bootstraps.clear(); this.#sessions.clear(); }
}

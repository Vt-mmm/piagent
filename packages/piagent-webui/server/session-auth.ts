import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// Cookies are scoped by host, not by port: every Piagent server on 127.0.0.1
// (the Gateway, a company service, an older launch) shares one cookie jar.
// The name carries the port once bound, so one server's launch no longer
// replaces the session of another server's open tab.
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

export type BrowserSession = { id: string; csrf: string; expiresAt: number; startedAt: number };

export class SessionAuthority {
  readonly #initialBootstrap: string;
  readonly #bootstrapTtlMs: number;
  readonly #sessionTtlMs: number;
  readonly #sessionMaxMs: number;
  readonly #cookieSigningKey = randomBytes(32);
  #cookieName = SESSION_COOKIE;
  #bootstraps = new Map<string, number>();
  #sessions = new Map<string, BrowserSession>();

  constructor(options: { now?: number; bootstrapTtlMs?: number; sessionTtlMs?: number; sessionMaxMs?: number } = {}) {
    this.#bootstrapTtlMs = options.bootstrapTtlMs ?? 60_000;
    // 8 hours unused; a tab in use is renewed (renew), up to 7 days.
    this.#sessionTtlMs = options.sessionTtlMs ?? 8 * 60 * 60_000;
    this.#sessionMaxMs = options.sessionMaxMs ?? 7 * 24 * 60 * 60_000;
    this.#initialBootstrap = this.issueBootstrapCapability(options.now ?? Date.now());
  }

  get bootstrapCapability(): string { return this.#initialBootstrap; }
  get cookieName(): string { return this.#cookieName; }

  bindPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid-session-port");
    this.#cookieName = `${SESSION_COOKIE}_${port}`;
  }

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
    const session = { id: randomUUID(), csrf: secret(), expiresAt: now + this.#sessionTtlMs, startedAt: now };
    this.#sessions.set(session.id, session);
    return session;
  }

  authenticate(request: IncomingMessage, now = Date.now()): BrowserSession | null {
    const value = cookie(request, this.#cookieName);
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

  // A session ended 8 hours after its launch even while its tab was in use:
  // a turn that ran or hung that long ended on the expired screen. An open
  // tab asks every minute, so past half its time a request moves the expiry
  // on, within the cap; true when the caller must send the cookie again.
  renew(session: BrowserSession, now = Date.now()): boolean {
    const next = Math.min(now + this.#sessionTtlMs, session.startedAt + this.#sessionMaxMs);
    if (next - session.expiresAt < this.#sessionTtlMs / 2) return false;
    session.expiresAt = next; return true;
  }

  authorizeMutation(request: IncomingMessage, now = Date.now()): BrowserSession | null {
    const session = this.authenticate(request, now);
    const csrf = request.headers["x-piagent-csrf"];
    return session && typeof csrf === "string" && equal(csrf, session.csrf) ? session : null;
  }

  cookieHeader(session: BrowserSession): string {
    const seconds = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    const token = `${session.id}.${this.#cookieSignature(session.id)}`;
    return `${this.#cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${seconds}`;
  }

  #cookieSignature(id: string): string {
    return createHmac("sha256", this.#cookieSigningKey).update(id).digest("base64url");
  }

  invalidate(): void { this.#bootstraps.clear(); this.#sessions.clear(); }
}

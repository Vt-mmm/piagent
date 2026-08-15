import type { PiagentGatewayCapabilityHandshakeV1 } from "../contracts/generated/gateway-capabilities-v1.ts";
import type { Catalog, SessionDetail } from "../contracts/generated/session-catalog-v1.ts";
import type { GatewayProtocolHandler, GatewayRequest } from "../server/gateway-websocket.ts";
import { GatewayEventStore } from "./gateway-events.ts";

type ListParams = { cursor: string | null; limit: number; filter: "active" | "archived" | "all"; query: string | null; projectRef: string | null };

export class GatewayProtocolFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable = false) { super(code); this.code = code; this.retryable = retryable; }
}

export class GatewayProtocolService implements GatewayProtocolHandler {
  readonly events: GatewayEventStore;
  readonly #capabilities: () => PiagentGatewayCapabilityHandshakeV1;
  readonly #catalog: () => Promise<Catalog>;
  readonly #command?: { execute(command: unknown): Promise<unknown> };

  constructor(options: {
    capabilities(): PiagentGatewayCapabilityHandshakeV1;
    catalog(): Promise<Catalog>;
    events?: GatewayEventStore;
    command?: { execute(command: unknown): Promise<unknown> };
  }) {
    this.#capabilities = options.capabilities;
    this.#catalog = options.catalog;
    this.#command = options.command;
    this.events = options.events ?? new GatewayEventStore();
  }

  capabilities(): PiagentGatewayCapabilityHandshakeV1 { return this.#capabilities(); }

  async execute(request: GatewayRequest): Promise<unknown> {
    if (request.method === "gateway.health") return this.#capabilities();
    if (request.method === "sessions.command") {
      if (!this.#command) throw new GatewayProtocolFailure("session-actions-unavailable");
      try { return await this.#command.execute(request.params.command); }
      catch (error) { throw new GatewayProtocolFailure(error instanceof Error ? error.message : "invalid-session-command"); }
    }
    const catalog = await this.#catalog();
    if (catalog.state !== "ready") throw new GatewayProtocolFailure(catalog.reasonCode ?? "catalog-unavailable", true);
    if (request.method === "sessions.get") {
      const session = catalog.sessions.find((item) => item.sessionRef === request.params.sessionRef);
      if (!session) throw new GatewayProtocolFailure("session-not-found");
      const detail: SessionDetail = {
        schemaVersion: 1, version: "piagent-session-detail-v1", generatedAt: new Date().toISOString(),
        gatewayInstanceRef: catalog.gatewayInstanceRef, catalogRevision: catalog.catalogRevision!, session
      };
      return detail;
    }
    const params = request.params as ListParams;
    if (params.cursor !== null) throw new GatewayProtocolFailure("catalog-cursor-unavailable", true);
    const query = params.query?.toLocaleLowerCase() ?? null;
    const filtered = catalog.sessions.filter((item) => (params.filter === "all" || (params.filter === "archived") === item.archived)
      && (!params.projectRef || item.projectRef === params.projectRef)
      && (!query || `${item.title} ${item.projectLabel} ${item.preview}`.toLocaleLowerCase().includes(query)));
    const sessions = filtered.slice(0, params.limit);
    return {
      ...catalog, sessions,
      page: { limit: params.limit, returned: sessions.length, total: filtered.length, nextCursor: null, truncated: filtered.length > sessions.length }
    } satisfies Catalog;
  }
}

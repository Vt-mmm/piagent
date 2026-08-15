---
decision_id: WUI5-07
status: accepted
date: 2026-08-14
scope: authenticated typed Gateway transport, replay and resync
---

# WUI5-07 — Authenticated typed Gateway transport

## Decision

The Session Hub uses the existing one-time loopback bootstrap and HttpOnly
SameSite session cookie for both HTTP projections and a same-origin WebSocket at
`/api/v1/gateway`. The socket requires the `piagent.gateway.v1` subprotocol,
exact Host/Origin, a valid browser session and a bounded connect frame before it
receives data.

The transport implements the WUI5-02 connect/hello/request/response/event
envelopes. It supports health, list and get reads; session commands remain
explicitly unavailable until WUI5-08/WUI5-09 authority exists.

Controls:

- maximum eight browser sockets per Gateway;
- 70 KiB frame cap, text-only messages and no per-message compression;
- five-second connect/hello deadline;
- strict method-specific field allowlists;
- sequential request handling per socket;
- 512 KiB outbound backpressure cutoff;
- bounded count/age event retention;
- subscribe-before-replay handoff with sequence deduplication;
- canonical `resync.required` when the requested cursor predates retention;
- per-listener failure isolation.

The browser reconnects with bounded exponential delay and refreshes the
canonical HTTP catalog for catalog/session/resync events. Reconnect, refresh,
search and selection remain zero-model-turn operations.

The `ws` runtime dependency is pinned to `8.21.3`; the implementation rejected
the initially considered 8.18 line after the package audit reported published
memory disclosure and fragmentation DoS advisories. Runtime dependency audit is
clean at this decision.

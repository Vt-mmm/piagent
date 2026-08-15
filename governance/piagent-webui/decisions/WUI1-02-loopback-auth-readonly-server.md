---
plan_id: piagent-webui
work_item: WUI1-02
status: accepted
decision: loopback-auth-readonly-server
date: 2026-08-13
---

# WUI1-02 loopback authentication and read-only server

## Decision

The first sidecar is an ephemeral Node HTTP server bound by construction to
`127.0.0.1` on an OS-selected port. It serves the bundled client and an
authenticated inspect-only capability document. Runtime snapshots and SSE start
in WUI1-03. Project mutation, chat, lifecycle, approval and review routes do not
exist.

## Bootstrap

1. Startup generates a 256-bit random capability and returns a launch URL with
   the capability only in the fragment.
2. Client removes the fragment before exchanging it once at
   `POST /api/v1/bootstrap`.
3. Exchange requires exact `Host`, exact same-origin `Origin`, JSON content type,
   bounded body and an unused/unexpired capability.
4. Success invalidates the bootstrap capability and returns a bounded CSRF token
   while setting an opaque `HttpOnly; SameSite=Strict; Path=/` cookie.
5. Cookie/session state is in-memory and process-bound. Restart invalidates it.

HTTP loopback cannot use a `Secure` cookie without TLS. Remote/LAN/TLS modes are
out of scope; the browser cookie becomes Secure only if a future accepted HTTPS
transport exists.

## Request boundary

- Exact Host and Origin checks prevent DNS-rebinding/cross-origin access.
- API routes require the process-bound session cookie; any future side-effecting
  route must additionally require the CSRF token.
- Static files are preloaded from a symlink-free bounded build tree and addressed
  only by their manifest keys.
- CSP, no-sniff, no-referrer, deny-frame and restrictive permissions headers are
  applied to every response.
- Body bytes, request duration, header count, connections and per-address request
  rates are bounded.
- Error responses expose stable codes, not local paths or secrets.

## Acceptance

- listener address is exactly IPv4 `127.0.0.1` and an ephemeral port;
- fragment capability is absent from HTTP request targets and server responses;
- first bootstrap succeeds; replay, expiry, bad Host/Origin/content type/body and
  rate overflow fail closed;
- authenticated capabilities pass the accepted schema and advertise only
  inspect; unauthenticated reads fail;
- traversal/symlink/static-size cases fail before serving bytes;
- stop/restart invalidates sessions and never affects Pi runtime/Inspector;
- no provider/model turn, Pi runtime, mutation route or external asset exists.

## Rollback

Stop the sidecar and remove WUI1-02 server modules. WUI1-01 static build and the
terminal Inspector remain independent.

## Verification

- loopback/auth/static focused tests: 6/6;
- package/server/build plus architecture/distribution focused tests: 27/27;
- package and root typecheck: pass;
- architecture (249 source files), package distribution and build: pass;
- capability response validates against accepted schema and advertises inspect
  only; model/provider callback count remains zero.

---
plan_id: piagent-webui
work_item: WUI0-09
document: local-web-security-contract-decision
status: accepted
decision_date: 2026-08-13
---

# WUI0-09 — Local Web security contract

## 1. Decision

The browser, repository content, Git configuration and local evidence are
distinct trust boundaries even when WebUI binds only to localhost. The frozen
contract consists of:

- `governance/piagent-webui/20-security-threat-model.md` for rationale, data
  flow, endpoint authority and milestone gates;
- `governance/piagent-webui/security-contract.v1.json` for machine-readable
  assets, boundaries, threats, controls and verification ownership;
- `tests/piagent-webui-security-contract.test.mjs` for invariant and coverage
  enforcement.

Pi runtime remains the single session writer and Pi guard remains the sole
action executor. Browser/sidecar authority is limited to deterministic reads
and typed intents. No security control can fall back to a second Pi runtime,
frontend-only authorization or prompt enforcement.

## 2. Critical ship blockers

Unauthenticated/non-loopback access, DNS rebinding, hostile-content XSS,
second-session writer, guard bypass, session/task/operation identity mixup and
sidecar failure affecting Pi execution are Critical. A milestone that owns the
corresponding surface cannot ship until its mapped adversarial and
fault-injection gates pass.

Control or approval remains unavailable whenever exact current-process
identity, capability, revision, action digest or one-time decision semantics
cannot be proved.

## 3. Local transport and browser defaults

- bind exactly `127.0.0.1` on an ephemeral port; no LAN/remote option;
- validate exact Host and Origin; never wildcard CORS;
- use a per-launch 256-bit fragment capability, one-time exchange and HttpOnly
  SameSite=Strict cookie;
- serve a local-only static bundle under strict CSP with no eval, frame,
  service worker, analytics, CDN or model-generated HTML;
- render repository, diff, log, tool and model content as bounded escaped text;
- use opaque filesystem refs, canonical fixed roots and protected-path checks.

## 4. Failure behavior

Security ambiguity fails closed for WebUI authority and fail-soft for the Pi
terminal. Missing/corrupt facts become unavailable or resync-required. Killing
or restarting the sidecar, malformed traffic, disk-full state, hostile Git
configuration or a slow client cannot stop or mutate the active Pi operation.

Application controls do not claim OS isolation from code running under the same
account. Truly untrusted repositories require an external container or VM
boundary.

## 5. Change control

A new endpoint, browser execution primitive, persistence class, capability,
external integration or trust boundary must update the machine-readable
contract, human threat model, relevant wire schema and an adversarial gate.
Critical invariants require a new ADR to weaken; feature flags, frontend checks
and prompts are not substitutes.

## 6. Acceptance evidence

WUI0-09 requires:

- all asset, boundary, control and threat IDs unique and fully linked;
- all threats mapped to at least two explicit controls and milestone tests;
- all Critical threats kept release-blocking;
- exact loopback/bootstrap/CSP/path/single-writer/guard defaults asserted;
- human and machine-readable contracts synchronized;
- documentation and full offline repository verification pass.

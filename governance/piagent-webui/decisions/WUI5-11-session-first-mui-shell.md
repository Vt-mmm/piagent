---
decision_id: WUI5-11
status: accepted
date: 2026-08-14
scope: session-hub-ui-ux
---

# Session-first MUI shell, Settings and project import

## Context

The first Session Hub shell exposed Chat, Task, Source Changes, Activity,
model settings and MCP as peers in a second workspace rail. It preserved the
underlying WebUI capabilities but made the primary chat workflow feel like one
large operations dashboard. It also opened New chat in a dialog and had no
safe local-folder import path.

The final information architecture uses established conversation, connector,
full-page New Session/project selection and provider-status patterns without
borrowing another product's identity or trust model. Piagent keeps its own
loopback authentication, CSRF, opaque references, redaction and sole-writer
runtime authority.

## Decision

### Global navigation

The permanent left sidebar contains only the Piagent brand, New chat,
conversation search, pinned/recent/archived sessions, and a Settings/Gateway
footer. Task, Source Changes, Activity, model controls and MCP are not global
sidebar destinations.

### Primary screens

The main surface has three mutually exclusive screens:

- `chat`: selected durable Pi session;
- `new`: one blank-chat composer with compact project/model/thinking menus;
- `settings`: grouped application/session configuration.

Opening or switching these screens is deterministic local UI work and creates
zero model turns.

### Chat composer context

The composer carries compact project, model, context, MCP, permission and
source-change chips. Every composer chip opens a small anchored popover; it
does not navigate away from the conversation. Source Changes offers an
explicit action from its popover into Agent Inspector. A chip never claims a
live fact that the Gateway does not know.

The selected session owns its model, thinking level and permission profile.
A new session chooses all three before the first send. An existing session can
change them from compact composer popovers or Settings only through an exact
Gateway command contract; the active Pi runtime verifies the resulting state
before returning a settled receipt. No setting silently inherits from a
global browser preference.

### Agent Inspector

Task Contract, Source Changes and Activity live in a right-side Agent
Inspector drawer. Source Changes retains the three exact views and IDE-style
file/diff workspace. The drawer is full-width on narrow screens and does not
compete with the transcript when closed.

### Settings

Settings replaces the chat shell completely and owns its own Back-to-app
navigation. It contains Appearance and language, Providers and models, MCP,
Agent and permissions, Usage and context, and Gateway information. It does not
render disabled placeholder connectors.

Provider OAuth is backed by Pi's real `ModelRuntime` provider catalog. A local
authenticated broker exposes only provider name/state, bounded OAuth events,
HTTPS authorization links, device codes and non-secret prompts. Credentials
stay in Pi's owner-only auth store; secret prompts fail closed and never reach
the browser. Installed MCP servers are projected from the real layered Pi
configuration and may be enabled, disabled or authenticated only through the
installed MCP adapter's exact command surface. OAuth links are bounded HTTPS
links and credentials stay in the adapter's owner-only store. `configured` is
never presented as `connected`, and arbitrary GitHub/Drive/Slack/Notion/Linear
connector cards are not fabricated without a connector runtime.

### Native project import

On supported local platforms, New chat invokes a Gateway-owned native folder
picker after authenticated same-origin CSRF admission. The user may add more
than one folder, remove a selection before sending, or cancel the picker
silently. The Gateway:

- canonicalizes and validates every selected directory;
- stores paths in an owner-only `0600` registry;
- returns only opaque `projectRef`, `placeRef` values and redacted labels;
- resolves paths only when creating the exact session runtime;
- rejects filesystem root and corrupt registry state.

The browser cannot submit an arbitrary path. Unsupported platforms advertise
the picker as unavailable.

## Acceptance evidence

- MUI TypeScript build and generated-contract check pass.
- Chromium covers compact New chat, multi-folder selection, anchored composer
  model/thinking/permission/MCP popovers, full-screen Settings, real provider
  and MCP account actions, Agent Inspector,
  desktop/mobile, VI/EN, light/dark and axe accessibility.
- Project registry, CSRF route, session creation and real Pi resume focused
  suites pass.
- Read-only navigation continues to create zero model turns.

## Remaining product work

- approval decisions bound to the Pi-owned broker in Session Hub;
- third-party app connectors beyond installed MCP/provider adapters;
- rename, pin, archive, fork and terminal compatibility actions;
- independent WEBUI-5 security/performance/browser ship gate.

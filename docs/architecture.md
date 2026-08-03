# Architecture documentation

- [English architecture](en/architecture.md)
- [Architecture tiếng Việt](vi/architecture.md)
- [English maintainer guide](en/maintainer-guide.md)
- [Maintainer guide tiếng Việt](vi/maintainer-guide.md)

This compatibility path remains because existing project profiles may include `docs/architecture.md` in `requiredContext`. The canonical language-specific documents above own the detailed architecture.

Core rule: Pi Agent Platform is reusable infrastructure. Project-specific business logic belongs in project profiles and adapters. The Pi extension entrypoint composes runtime adapters, core policy/task/context services, MCP/capability integrations, and owner-only local state; dependencies never point back into the entrypoint.

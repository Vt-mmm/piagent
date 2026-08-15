# Documentation languages
<!-- language: en+vi -->

[English](en/README.md) | [Tiếng Việt](vi/README.md)

Pi Agent Platform keeps canonical maintainer documentation in explicit language directories:

- `docs/en/`: English source.
- `docs/vi/`: Vietnamese source. Technical keywords such as agent, terminal, workflow, MCP, tool, runtime, context, session, token, model, thinking, and benchmark stay in English.
- `docs/*.md`: existing operational documents. These remain stable while each maintained topic is moved into an EN/VI pair.

Every normative architecture document must be listed in `docs/languages.json`. The documentation gate requires both language files and reciprocal links in the same change.

## Canonical pairs

| Topic | English | Tiếng Việt |
|---|---|---|
| Documentation index | [EN](en/README.md) | [VI](vi/README.md) |
| Architecture | [EN](en/architecture.md) | [VI](vi/architecture.md) |
| Maintainer guide | [EN](en/maintainer-guide.md) | [VI](vi/maintainer-guide.md) |

## Existing operating guides

The public static site is bilingual and lives under `docs-site/`. Existing root URLs remain Vietnamese for compatibility; matching English pages live under `/en/`, and every page links to its language peer. Long-form operator documents keep their existing stable paths until they receive a reviewed language pair. Their language must remain explicit in the title or filename during that migration.

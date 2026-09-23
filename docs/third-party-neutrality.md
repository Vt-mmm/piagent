# Third-party neutrality policy
<!-- language: en -->

Piagent is a provider-neutral agent platform. Product copy, navigation, visual
tokens and governance contracts must describe Piagent capabilities directly;
they must not present the product as a clone of another application.

Third-party names are allowed only when they identify an actual dependency,
interoperability surface, configured provider, imported configuration format,
editor handoff, security boundary, license or user-selected connection. Those
names must not imply endorsement, preferred ranking or shared authority.

The WebUI follows these rules:

- its local assets, icons, typography and palette belong to Piagent;
- discovered providers and MCP servers are listed from runtime capability
  truth, without hard-coded preference ordering;
- comparison-brand wording is rejected from the active WebUI plans and client;
- provider credentials remain in the provider's owner-only runtime store;
- an unavailable integration is shown as unavailable, never simulated;
- remote logos, fonts, scripts, styles and analytics are not loaded.

The neutrality gate scans active WebUI governance and client source. Historical
records and implementation-specific integration documentation may retain an
actual third-party name when it is necessary to explain compatibility or a
security decision.

Reviewed research records may name the tools whose primary sources they cite;
source titles must stay accurate. The explicit record list in
`scripts/check-public-wording.mjs` permits source names only. It does not permit
promotional comparisons, ranking claims, copied branding, or new authority.
Unlisted documents and all runtime/operator surfaces retain the full wording
check. A document cannot opt itself out with a comment or metadata flag.

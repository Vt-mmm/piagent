# Security threat model

## Scope and objective

Pi Agent Platform adds application-level policy enforcement to Pi tool calls used in a trusted project. Its objective is to reduce accidental damage, common prompt-injection impact, secret exposure, unauthorized external mutations, and non-reproducible team installs. It is not an operating-system sandbox and does not claim to contain hostile code running with the operator's account permissions.

This document covers the packaged guard, project profiles, capability locks, installer, release workflow, and packaged artifact. Project-specific applications, provider infrastructure, the Pi host implementation, third-party add-ons, and the operating system remain separate security domains.

## Protected assets

- credentials, OAuth sessions, `.env`, auth files, and private runtime state;
- source and configuration outside the resolved filesystem scopes;
- paths declared read-only by the active project profile;
- protected guard, profile, settings, capability-lock, and evidence files;
- external GitHub, HTTP, MCP, and provider resources that can be mutated;
- release identity, installer sources, dependency pins, and package contents;
- observed verification evidence used to approve task completion.

## Trust assumptions

- The operator, operating-system account, Pi host, and explicitly trusted project repository are trusted to execute code.
- Project-local Pi resources are loaded only after Pi project trust or an explicit operator override.
- A human remains available to approve destructive and external-provider actions.
- Supported release verification covers macOS Apple Silicon + Bash, Linux x64 + Bash, Node.js `>=22.19.0`, and the exact Pi host version declared by the release. macOS Intel + Bash and Linux ARM64 + Bash are supported targets that need local smoke verification before broad rollout. Native Windows is not a team-rollout target for v1.1.6, and WSL2 is experimental/unverified.
- Registry, GitHub, model-provider, MCP-provider, and Vercel controls are external dependencies. Their account security and platform guarantees are not replaced by this repository.

## Threat actors and failure modes

- an agent making an incorrect tool call or selecting an overly broad command;
- prompt injection contained in repository text, web content, tool output, or an MCP response;
- malformed, nested, encoded, or aliased tool input intended to bypass path or action classification;
- a project profile or capability lock modified to request more authority;
- a moved release tag, unexpected package content, or vulnerable transitive dependency;
- an untrusted repository, dependency install script, interpreter payload, binary, or process executing with the operator's OS permissions.

The final category is outside the containment capability of the Piagent guard. It requires isolation at the filesystem, process, network, and credential layers.

## Attack-vector and control map

| Vector | Current control | Residual risk |
|---|---|---|
| Direct or nested path-like tool input | Bounded recursive input inspection, protected-path precedence, repository boundary checks, filesystem capability scopes, and read-only profile paths | A new carrier or field name must be classified before it can be treated as controlled. Unknown/ambiguous tools fail closed where policy requires confirmation. |
| Encoding, case variation, traversal, or symbolic-link alias | Single percent decode, case-insensitive protected matching, canonical resolution for existing paths, traversal/repository escape rejection | Filesystem races and code executing outside observed tool paths require an OS boundary. |
| Shell glob, brace, redirection, wrapper, assignment, or command composition | Static Bash operand/action analysis with bounded expansion and regression cases; protected input is denied and external mutation is confirmation-gated | Runtime-generated interpreter payloads cannot be fully understood by static parsing. Sensitive output redaction is a backstop, not containment. |
| Secret returned in tool output | Shared contextual redaction across guarded text/results and synthetic recall benchmark | High-entropy, novel secret formats, or transformed output such as base64-encoded content can evade pattern-based redaction. Never intentionally print real secrets. |
| Malicious project profile or relaxed capability lock | Trust-aware profile loading, deterministic lock digest, base-policy/source integrity, protected self-state, and fail-closed verification | An already trusted malicious repository can execute code through mechanisms outside the guard. |
| External GitHub/HTTP/MCP/provider mutation | Direct and proxied action classification plus explicit operator confirmation, including guarded shell carriers | Provider semantics and new tool schemas can change; new integrations require policy and regression review. |
| Destructive local action | Exec-policy classification and explicit confirmation; protected paths remain denied in every permission profile | Confirmation is not isolation. A trusted process outside the observed tool path retains OS authority. |
| Forged verification result | Observed Bash result ledger, command hash, task-start ordering, exit-code and verify-command matching | Compromise of the trusted Pi/process environment is outside this evidence model. |
| Mutable or substituted release source | Exact team tags, stable tag-to-commit resolution, release-commit binding in tag CI, annotated-tag requirement, add-on integrity checks, and documented tag ruleset requirement | Bootstrap helper installation still relies on GitHub tag immutability; repository administrators must prevent tag update/deletion. Signed provenance remains future work. |
| Dependency or package-content compromise | `--ignore-scripts` bootstrap installs, root and exact runtime dependency audits, immutable Action SHAs, package allowlist, artifact tests, CodeQL, Dependabot, secret scanning, and push protection | Audits are point-in-time and lower-severity/upstream findings remain. Review alerts and refresh pins continuously. |
| Parser resource exhaustion | Bounded nested input, command length, expansion, and result processing | Fuzzing breadth is still evolving; report hangs or unusually expensive inputs privately. |

## Permission model

`read-only`, `workspace-write`, and `trusted-full-access` change the allowed working scope; they do not disable protected paths, secret redaction, capability integrity, destructive confirmation, or external-provider confirmation. `trusted-full-access` is intended for an already trusted repository in an externally safe environment. It is not a bypass or sandbox mode.

## Security verification

Release gates include policy regression tests, TypeScript checking, runtime smoke tests, redaction benchmarks, package-content inspection, release-identity checks, installer tests, exact Pi host/add-on dependency audit, and CI on Linux x64 plus the current macOS runner. CodeQL covers JavaScript/TypeScript and GitHub Actions.

These are internal engineering controls, not an independent third-party audit. The project currently has no LTS promise. Stronger assurance still benefits from broader parser fuzzing, a larger OS/shell matrix, independent review, signed provenance, and continued adversarial testing.

## Reporting and disclosure

Follow [the security policy](../SECURITY.md). Report suspected bypasses privately with a synthetic reproduction and do not include live credentials or customer data.

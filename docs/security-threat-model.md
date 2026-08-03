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
- source bodies and retrieval metadata stored in the local Context Engine index;
- observed verification evidence used to approve task completion.

## Trust assumptions

- The operator, operating-system account, Pi host, and explicitly trusted project repository are trusted to execute code.
- Project-local Pi resources are loaded only after Pi project trust or an explicit operator override.
- A human remains available to approve destructive and external-provider actions.
- Supported release verification covers macOS Apple Silicon + Bash, Linux x64 + Bash, Node.js `>=22.19.0`, and the exact Pi host version declared by the release. macOS Intel + Bash and Linux ARM64 + Bash are supported targets that need local smoke verification before broad rollout. Native Windows is not a team-rollout target for v1.2.15, and WSL2 is experimental/unverified.
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
| Shell glob reaching a protected file | Glob candidates are read from the same expanded, resolved word list as every other check and matched against examples of each protected pattern, so a pattern assembled by an expansion (`{cat,.env*}`, `cat $({echo,.env*})`, `{bash,} -c 'cat .env*'`, `echo .env* | xargs cat`) is seen. This is the only check that can answer for a pattern at all, since `.env*` matches no protected literal. Whether a word is matched against filenames is decided per character, so a quoted metacharacter names a file instead (`{".env*",x}`). A redirection is read by the rule the shell uses — it opens its target only where that target expands to exactly one word, and is refused as an ambiguous redirect otherwise (`> "{.env,}"{,}`, `> {.env,other}`), while a word that can still disappear, an unset variable or a pattern under `nullglob`, leaves the count unknowable and keeps every candidate | Matching is against generated examples of each protected pattern, not against the filesystem, so a protected pattern whose examples do not represent every real name it covers can leave a matching file unnamed. Bounded expansion refuses rather than enumerates when a glob is too broad to expand. |
| Encoding, case variation, traversal, or symbolic-link alias | Single percent decode, case-insensitive protected matching, canonical resolution for existing paths, traversal/repository escape rejection | Filesystem races and code executing outside observed tool paths require an OS boundary. |
| Local image path introduced through chat or extension input | Auto-attachment resolves the canonical target through the same project and `additionalReadRoots` grants as document intake, checks both the requested symlink location and resolved target against protected paths, preserves capability read scope, sniffs image bytes, and opens the inspected device/inode with no-follow semantics before attaching | A deliberately broad `additionalReadRoots` grant exposes every supported image under that root. Processes running as the same OS account and files modified in place remain outside this application-level boundary. |
| Context index built with weaker or stale path rules | CLI and runtime share one resolved exclusion policy covering base policy, adapter inheritance, protected, shell-protected, and read-only paths. Every index API, including status, requires an explicit exclusion list and fails closed when it is omitted. A versioned exclusion digest forces rebuild on policy drift; search/pack filter candidates again at read time, and source-shaped symlinks or canonical paths outside the project are refused. Policy drift also rebuilds FTS, checkpoints WAL, and vacuums the database before clearing a retryable `purgePending` marker. | An explicit empty exclusion list remains available to intentional low-level callers. A policy migration may temporarily require roughly twice the database size in free space; interruption leaves the marker pending and retries on the next ensure. |
| Source residue or cross-account access to the local context index | Context Engine directory mode is `0700`; SQLite database, WAL, and SHM are `0600`. SQLite core and FTS5 secure-delete are both enabled for ordinary updates, while policy migrations rebuild FTS and vacuum legacy free pages. | Context Engine is still an application-level cache, not an OS sandbox. A process running as the same OS account, filesystem races, backups, snapshots, or storage below the filesystem layer require separate OS/device controls. |
| Shell glob, brace, redirection, wrapper, assignment, or command composition | Static Bash operand/action analysis with bounded expansion and regression cases; protected input is denied and external mutation is confirmation-gated. A path the analysis cannot resolve — literal text concatenated with a substitution, as in `.en$(echo v)` — is refused rather than matched on its literal half | Runtime-generated interpreter payloads cannot be fully understood by static parsing. Sensitive output redaction is a backstop, not containment. |
| Secret returned in tool output | Shared contextual redaction across guarded text/results and synthetic recall benchmark | High-entropy, novel secret formats, or transformed output such as base64-encoded content can evade pattern-based redaction. Never intentionally print real secrets. |
| Malicious project profile or relaxed capability lock | Trust-aware profile loading, deterministic lock digest, base-policy/source integrity, protected self-state, and fail-closed verification | An already trusted malicious repository can execute code through mechanisms outside the guard. |
| External GitHub/HTTP/MCP/provider mutation | Direct and proxied action classification plus explicit operator confirmation, including guarded shell carriers | Provider semantics and new tool schemas can change; new integrations require policy and regression review. |
| Repository MCP direct tool loses server attribution | Guard and doctor share the merged MCP view. Both session-level and effective per-server `directTools` selections fail closed when `toolPrefix: "none"` removes server identity; approved direct tools remain usable with `server` or `short` prefixes | A future adapter naming mode or config layer must be added to the shared MCP resolver before rollout. |
| Read-only subagent receives mutation-capable tools | Packaged read-only roles carry explicit `read`, `grep`, `find`, `ls` allowlists; CI checks every `acceptanceRole: read-only` manifest, while all shell/edit/write capability remains on the explicit writer role | User/project overrides and a compromised external subagent runtime can replace the packaged contract; inspect effective runtime configuration when accepting third-party roles. |
| Destructive local action | Exec-policy classification and explicit confirmation; protected paths remain denied in every permission profile. A target written as a command substitution is evaluated only where its body is one plain command with literal operands and a format this renderer reproduces exactly, and confirmed otherwise — a separator, a nested substitution, a redirection, a variable, quoting, an escape, a `printf` option, or a `printf` conversion whose result this does not reproduce (`*`, `%q`, `%b`, the numeric conversions, `%%`) all make the body unreadable here. A constant width or precision and format reuse are reproduced, so a target built from those is refused rather than confirmed, and the rendered output is read as a path candidate as well as the format's literal text and its arguments — a name assembled across a conversion (`.e%.1sv nv` is `.env`) appears in none of the pieces. Brace expansion, ranges included, is performed once per segment before anything reads it, so the rules, the legacy patterns, the nested-interpreter scan, the pipeline producers and the destructive checks all see the word list the shell would build rather than the text as typed; the expansion produces a token stream, so a command and its arguments assembled from one brace word (`{cat,.env}`) are read as both; quoting is tracked per character, so a word holding a quoted group beside an expanding one (`"{.env,}"{,}`) expands exactly as far as the shell expands it — and a target that is nothing but an unresolved parameter expansion is confirmed rather than permitted, since it can hold any value including root. The same holds for reads: a word that is only an unresolved parameter expansion is confirmed wherever the command opens files (`cat ${HOME:+.env}`), including across a pipe into an `xargs` that opens them (`echo $F \| xargs cat`), while a command substitution in that position is left to the nested scan that classifies the command inside it, and two expansions with nothing between them count as a name being assembled just as literal text beside one does. Brace expansion, parameter expansion and command substitution are performed once per segment, in the order a shell performs them, and every reader takes that one word list — so a name assembled by an expansion (`r$(printf %s m) -rf /`, `xa$(printf %s rgs)`, `$(printf %s ba)$(echo -n sh) -c '...'`) is the command it becomes rather than the text it was typed as. A name that still cannot be resolved is treated as an unknown command rather than a known-harmless one: it is enough to bring the destructive checks, the interpreter scan and the file-operand net into play, since `${X:+r}m -rf /` and `${X:+cat} ${X:+.env}` are those commands whenever the variable is set. Differential cases are generated rather than enumerated, over the cross product the defects live in — expansion form, position in the command, and reader — with each spelling placed in the command name, the operand, a flag's argument, a redirection target, a pipeline producer, an `xargs` consumer and an interpreter payload; the corpus fails if any generated spelling produced no word list, so a batch that dies early cannot pass as coverage, and it asserts in both directions so a check that answers for everything fails too | Confirmation is not isolation. A trusted process outside the observed tool path retains OS authority. A target produced by any other command is knowable only at run time, so it is gated by confirmation rather than refused. |
| Forged verification result | Observed Bash result ledger, command hash, task-start ordering, exit-code and verify-command matching | Compromise of the trusted Pi/process environment is outside this evidence model. |
| Mutable or substituted release source | Exact team tags, stable tag-to-commit resolution, release-commit binding in tag CI, annotated-tag requirement, add-on integrity checks, and documented tag ruleset requirement | Bootstrap helper installation still relies on GitHub tag immutability; repository administrators must prevent tag update/deletion. Signed provenance remains future work. |
| Dependency or package-content compromise | `--ignore-scripts` bootstrap installs, root and exact runtime dependency audits, immutable Action SHAs, package allowlist, artifact tests, CodeQL, Dependabot, secret scanning, and push protection | Audits are point-in-time and lower-severity/upstream findings remain. Review alerts and refresh pins continuously. |
| Parser resource exhaustion | Bounded nested input, command length, expansion, and result processing | Fuzzing breadth is still evolving; report hangs or unusually expensive inputs privately. |

## Permission model

`read-only`, `workspace-write`, and `trusted-full-access` change the allowed working scope; they do not disable protected paths, secret redaction, capability integrity, destructive confirmation, or external-provider confirmation. `trusted-full-access` is intended for an already trusted repository in an externally safe environment. It is not a bypass or sandbox mode.

## Outbound network from a session

A Pi session makes one outbound request of its own: at most once every 24 hours it leaves a detached `npm view @piagent/platform version` behind to learn whether a newer release exists. This is the only network traffic the guard originates.

What it sends is an npm registry request for a public package and nothing else — no project path, no repository name, no profile, no telemetry. The registry reply reaches the terminal only if it matches `MAJOR.MINOR.PATCH` exactly; anything else is discarded rather than displayed, so a hostile or compromised registry response cannot become a line of attacker-chosen text in the operator's terminal. The answer is cached at `~/.pi/piagent-update-check.json`, an ordinary user-writable file whose worst case is suppressing the notice.

The session never waits on it: the request runs in a detached process with no inherited stdio, and the notice appears on the session after the one that refreshed the cache. A checkout is never told to update.

Set `PIAGENT_NO_UPDATE_CHECK=1` to switch it off. Nothing else changes.

## Security verification

Release gates include policy regression tests, TypeScript checking, runtime smoke tests, redaction benchmarks, package-content inspection, release-identity checks, installer tests, exact Pi host/add-on dependency audit, and CI on Linux x64 plus the current macOS runner. CodeQL covers JavaScript/TypeScript and GitHub Actions.

These are internal engineering controls, not an independent third-party audit. The project currently has no LTS promise. Stronger assurance still benefits from broader parser fuzzing, a larger OS/shell matrix, independent review, signed provenance, and continued adversarial testing.

## Reporting and disclosure

Follow [the security policy](../SECURITY.md). Report suspected bypasses privately with a synthetic reproduction and do not include live credentials or customer data.

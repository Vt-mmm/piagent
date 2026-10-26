# Adaptive delivery in company conversations
<!-- language: en -->

Company conversations discover repository/package surfaces without asking the member to pick a BE/FE role or maintain profile keys. This is managed-runtime behaviour; legacy adapter profiles are unchanged.

## What runs automatically

At each agent start, a bounded read-only scan supplies a map of known frontend/backend surfaces, the evidence behind them, and database/contract/service/release markers. It inspects the conversation folder, conventional or declared workspace packages, and direct child Git repositories (including worktrees). It does not inspect sibling folders outside the conversation. Each new member turn also refreshes candidate repository checks.

Framework dependencies identify Node, Python, JVM, Go, Rust, Ruby, PHP and ASP.NET server projects. Frontend frameworks and Next API routes can identify a mixed surface. A language manifest alone does not establish backend semantics. `src/api` in a frontend is not taken as a server. Server-named directories are heuristic evidence, not certainty. Unknown projects require source inspection rather than an invented role. Copied repositories outside conventional workspace layouts and without `.git` are not recursively discovered.

Scans skip symlinks and large files, cap the map at 64 units, and never run discovered code. The map is untrusted context, not permission. It is not an authorization boundary against concurrent filesystem mutation. The model confirms the actual task's changed paths and consumers before selecting applicable checks; it must not test every repository merely because one is listed.

Existing AGENTS.md check declarations retain precedence. Without them, candidate checks include nested package/repository commands, common Node unit/integration/API/contract/E2E scripts, Maven/Gradle, Go, Rust, Python and Swift checks. These are suggestions to inspect and run as appropriate, not automatically executed scripts.

## The member owns the working method

The delivery lifecycle is a menu of applicable safety/quality concerns, not a required sequence or a second requirement framework. The member can choose a skill, a separate requirement repository, an existing plan, or lightweight work without a plan. No Spec Kit-specific adapter, role key, form or command is required.

The agent is instructed to use the member's current explicit choice first, then an applicable project convention, then the task's existing method. An established task keeps its selected method; merely discovering another skill does not replace it. Skills/commands keep their existing discovery and explicit invocation behaviour. Semantic selection from natural language is the model's responsibility, not a deterministic parser of the member's intent.

An optional `workflow_context` tool lets the main agent inspect, adopt or clear a task-scoped selection. It records the task, method, basis and evidence for the choice, canonical source references with known revisions, and open questions in conversation custom entries. The member does not populate these fields. The context is refreshed into subsequent main-agent starts and passed read-only to helpers, and survives reopening the conversation. For an unrelated task it is only prior context, not a default forced onto the new task. The model must distinguish a continuation from a new task; this is guidance, not an automatic task-identity classifier.

Implementation safeguards:

- Adoption and clearing require the current context revision, preventing stale parallel tool calls from silently overwriting a choice.
- There is at most one canonical source per purpose/scope; scope labels are compared with Unicode NFKC normalization, lowercasing and collapsed whitespace (reference paths retain their case). Supporting documents are references. Conflicting declarations are rejected atomically. This does not detect semantic contradictions inside documents: those require reading and, when unresolved, a member decision.
- Input is bounded and validated. Context records contain references, not document copies; updates never read, fetch, execute or write a referenced source. Files outside the project remain subject to the existing read-only/tool boundaries.
- History includes the reason for a change. Clearing does not resurrect an older method; invalid records are not treated as instructions. Corrupt or regressing records keep the highest valid revision without restoring a stale selection.
- The record is agent-maintained context, **not authenticated member consent**, a verification result or permission. References and labels are untrusted prompt data even when JSON-quoted; the model must not treat embedded instructions as higher-priority policy. It cannot change policy, approval scope, tools, review or verification outcomes. Helpers receive the context but cannot change it.

Plan handling follows the member's method: reuse a complete plan after checking current code; supplement an incomplete plan with facts discoverable in the repository and ask only about unresolved decisions; without a plan use the smallest useful checklist. Do not create parallel spec/plan files or rewrite a reference repository without permission. Requirement-only and plan-only tasks stop at those deliverables.

For conflicts, respect the chosen format and step order; add missing applicable quality checks without replacing the team's method; ask about contradictory business sources; never use a skill or plan to weaken the company's safety boundary. Existing company plan/check/review policy is unchanged. When a checklist is required, it reflects execution of the chosen plan rather than inventing another requirement authority.

## Lifecycle supplied to the agent

- Intake: desired behaviour, scope, testable acceptance and unresolved business decisions.
- Impact/readiness: affected services, consumers, contracts, permissions and data; effort proportional to risk.
- Implementation: use existing conventions and toolchain.
- Verification: preserve frontend browser checks; add applicable backend integration/API, authorization, compatibility, failure, concurrency and idempotency checks. Database changes need disposable-data migration and recovery testing; queues need duplicate/retry/transaction checks.
- PR readiness: review and revision-specific evidence, distinguishing passed, failed, blocked, not applicable and human-waived.
- Release when requested: inspect existing CI/deploy workflow, identify artifact/environment, establish migration order and recovery plan, obtain existing scoped approvals, deploy and check health.
- Close: distinguish code complete, PR-ready, merged, deployed and verified in the target environment. A coding task does not authorize deployment.

Missing infrastructure requires an approval/request to unblock it; unit tests must not silently stand in for unavailable integration checks. No mandatory spec files, role form or task contract is added.

## Enforcement and current limits

The new layer is **automatic discovery, optional working-method context and adaptive lifecycle guidance**, not a new deployment orchestrator. Existing plan/check/review enforcement and tool approval boundaries remain unchanged. A recorded check pass proves that check on that revision, not all acceptance criteria. This change does not add machine-enforced API/migration gates, structured per-criterion evidence persistence, a Studio approval UI, a GitHub/CI connector or automated production monitoring. Release actions use existing tools and approvals; no permission is granted by the map or by repository scripts.

These distinctions are deliberate: discovery must not silently introduce production access or imply that prompt guidance is a release gate. A future structured delivery/evidence protocol can build on this map without requiring member-managed BE/FE roles.

## Regression coverage

`tests/managed-delivery-context.test.mjs` covers mixed and unknown projects, direct child repositories/worktrees inside the conversation folder, nested checks, workspace exclusions, bounds, traversal and symlinks. `tests/managed-workflow.test.mjs` includes a real managed-session/mock-provider test showing the map and checks refresh between tasks without duplicate snapshots. `tests/project-shape.test.mjs` protects legacy profile behaviour. `tests/managed-workflow-context.test.mjs` covers persistence, clearing, canonical-source conflicts, concurrent updates, validation and unchanged safety policy. The managed workflow integration suite verifies that a choice survives reopening, reaches reviewers without granting them the selection tool, and can be cleared while required verification/review still apply.

# Harness Next: evidence review

Research date: 2026-08-30. Status: research and implementation in progress, not a release claim.

## The problem being solved

Piagent must distinguish an implementation defect, an incomplete test suite, a verifier limitation, and an execution failure. These require different recovery actions. A source recognizer that cannot understand a valid program must not tell the model to rewrite that program without a concrete failing behavior.

The retained v6 campaign stopped after six sessions. Pi's expiry implementation received hidden grade 10/10, but its completion receipt remained pending and workflow score was 8.48. A separate, read-only diagnostic passed 480,061 assertions, including 120,000 year/month boundaries. These checks support a verifier-coverage false negative; they do not establish universal correctness or change the failed campaign result.

The v6 admission check requires two single-parameter helpers. The actual implementation uses a shared three-parameter normalizer, mutable locals, UTC setter/round-trip calendar validation, numeric separators, and fraction padding. Directly invoking the dataflow layer beneath the admission check still rejects syntax. Adding one more source pattern is therefore not the architectural repair.

## Primary sources and transferable mechanisms

Numbers below are the authors' reported results under their own models, datasets, budgets, and dates. They are not comparable leaderboard rows and are not predicted Piagent gains.

| Source | Evidence or mechanism | What Piagent can transfer; limitation |
| --- | --- | --- |
| [SWE-agent, NeurIPS 2024, v3](https://arxiv.org/abs/2405.15793v3) | A purpose-built agent-computer interface; reported pass@1 of 12.5% on SWE-bench and 87.7% on HumanEvalFix. | Treat tool feedback and interface design as measurable interventions. Do not assume its 2024 interface or scores transfer to another model. |
| [Agentless, 2024, v2](https://arxiv.org/abs/2407.01489v2) | Localization, repair, and validation as separate phases; reported 32.00% (96 fixes) on SWE-bench Lite at $0.70 per problem. | Keep control flow inspectable and compare against a simpler baseline. More orchestration is not inherently better. Different benchmark from SWE-agent's full SWE-bench result. |
| [EvalPlus, 2023, v3](https://arxiv.org/abs/2305.01210v3) | Mutation- and LLM-generated test inputs; HumanEval+ expands tests 80-fold. Across 26 models, the paper reports pass@k reductions up to 19.3–28.9% and changed rankings. | Strengthen independent tests and measure false acceptance, not merely acceptance rate. More cases are useful only with a trustworthy oracle and relevant partitions. |
| [CEGAR, Clarke et al., 2000](https://web.stanford.edu/class/cs357/cegar.pdf) | Distinguish real counterexamples from artifacts of an abstraction; refine the abstraction for spurious traces. | Preserve `unknown` and route verifier limitations away from blind source repair. The paper's guarantees concern its finite-state model/specification setting, not arbitrary JavaScript or finite random tests. |
| [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/) | Generate stateful command sequences, compare with a simpler model, shrink failures, replay with seed/path. | Exercise verification/recovery histories and save minimal counterexamples. The reference model must not copy the implementation's logic. |
| [Anthropic agent eval guidance, 2026-01-09](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Separate transcript from final environment outcome, calibrate graders, validate tasks with reference solutions, distinguish pass@k from all-trial consistency. | Audit both false positives and false negatives; retain outcome and process metrics separately. This is engineering guidance, not a controlled estimate of Piagent improvement. |
| [AgentLens, 2026, v3](https://arxiv.org/abs/2605.12925v3) | 2,614 trajectories, eight model backends, 60 SWE-bench Verified tasks; a 1,815-trajectory subset over 47 tasks. Among passing trajectories in that subset, 10.7% were classified as Lucky Passes. | Measure blind retries, regression cycles, and verification ordering in addition to final pass rate. This is a recent preprint; its labels are not proof that a specific Piagent run is bad. |
| [Pi source README](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) | Minimal extensible harness; default read/write/edit/bash tools, extension-based workflow customization. | Keep reusable enforcement in the extension while letting the model choose implementation structure. Minimalism does not replace project authorization or verification. |
| [mini-SWE-agent](https://mini-swe-agent.com/latest/) | Bash-only actions, linear message history, independent subprocess execution. | Use an observable lean baseline and avoid hidden recovery state. Do not transplant unrestricted shell access into Piagent's protected-path policy. |
| [OpenHands architecture](https://docs.openhands.dev/sdk/arch/overview), [SDK paper v2](https://arxiv.org/abs/2511.03690v2) | Separate SDK, tools, workspaces, and server; immutable/stateless components and portable execution. | Separate assessment from execution and UI projection; keep backend failures distinct from model failures. No numerical reduction is inferred from the abstract's qualitative production claim. |
| [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) | Checkpoints and pending writes preserve completed steps; replay after a checkpoint can re-execute external calls. | Store verification receipts and resume only valid bound work. Replay is not automatically free or side-effect-free; preserve the single paid-attempt ledger. |
| [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices) | Task-specific evaluations, production failure datasets, automated scoring calibrated against human judgment. | Maintain a labelled grader audit set and separate quality, safety, and tool-selection checks. Do not add model judges as an uncalibrated completion authority. |

[OpenAI's lean-prompt guidance](https://developers.openai.com/api/docs/guides/latest-model#favor-leaner-prompts) reports an internal sample with roughly 10–15% higher eval scores, 41–66% fewer total tokens, and 33–67% lower cost. The page does not establish an equivalent Piagent workload or a fresh-token saving. This is a hypothesis for a later isolated ablation, not a reason to change prompts during a frozen benchmark or advertise those numbers.

## Alternatives considered

1. **Extend the current source-template proof.** Low initial cost, but another valid helper graph or expression can fail before semantics. Rejected as the primary fix; retained only as a conservative optional analysis lane.
2. **Ask the model to judge its own answer.** Flexible but vulnerable to shared blind spots and unsupported confidence. Not a completion authority for executable contracts.
3. **Use project test exit code alone.** Language-independent but can accept incomplete or manipulated tests. Not sufficient by itself.
4. **General formal verification of arbitrary generated JavaScript.** Strong results are possible for specified subsets, but a complete practical verifier for unrestricted programs is not a credible scoped deliverable. Keep explicit supported domains and `unknown`.
5. **Independent contract execution plus orthogonal safety/provenance gates.** Selected direction. Freeze task-derived obligations, run host-owned validators against exact source snapshots, retain counterexamples, and state bounded assurance accurately. This changes the verification mechanism and requires its own calibration; it is not an automatic relaxation of the completion gate.

## Execution isolation review

[Node's documentation](https://nodejs.org/api/vm.html) explicitly rules out treating `node:vm` as a security boundary. The existing syntax-only compilation is different from executing candidate code; do not turn it into an in-process execution sandbox.

[QuickJS-WASM runtime documentation](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md) provides separate runtimes/modules, memory/stack controls, interrupts, and module-loader control. It is a candidate for pure-JavaScript probes, not yet a selected production dependency. An [upstream report against a pinned QuickJS commit](https://github.com/bellard/quickjs/issues/545) alleges interrupt-bypass CPU denial of service; the issue is closed, and applicability to any chosen WASM build has not been established. This is a reason to require an independent process deadline and resource tests, not a claim that all QuickJS releases are vulnerable.

Initial local discovery found Docker CLI but no running Docker daemon. During subsequent implementation, the existing Docker Desktop was started and a separate locked worker dependency directory was installed without lifecycle scripts; the platform's shared dependencies were not changed. The selected experimental backend combines QuickJS-WASM with a constrained local Docker container, an independent OS watchdog, and host-owned comparison. See the [executor checkpoint](../decisions/harness-next-executor-checkpoint.md) for actual tests and limitations. An unavailable backend produces `error/unknown`, never an unprotected host-execution fallback.

The selected [QuickJS core variant interface](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/README.md) allows using only core, release-sync WASM, and FFI types, all pinned to 0.32.0 in a dedicated lockfile. The installed variant identifies its underlying QuickJS revision as `f1139494d18a2053630c5ed3384a42bb70db3c53`. [Docker's container runtime controls](https://docs.docker.com/engine/containers/run/) provide the outer process, filesystem, network, and resource boundary. These controls are complementary; neither upstream documentation nor a finite adversarial suite is a blanket security guarantee.

## Chosen research hypotheses

Persistence follow-up: [SQLite's atomic-commit design](https://sqlite.org/atomiccommit.html) documents journal-based all-or-none transactions, including recovery after interruption, with explicit filesystem/locking/flush assumptions. [Node 22.19.0's SQLite API](https://nodejs.org/download/release/v22.19.0/docs/api/sqlite.html) is available but experimental in that minimum supported runtime, so using it for verifier storage requires a compatibility and packaging decision. Transactional durability alone does not authenticate a receipt, establish an approved oracle, or protect against compromise of a same-user host authority. The subsequent [durable evidence checkpoint](../decisions/harness-next-durable-evidence-checkpoint.md) records the implemented store; the [admission checkpoint](../decisions/harness-next-authenticated-admission-checkpoint.md) records its later runtime integration and remaining limits.

Local source inspection also established that the existing working-tree digest covers changes relative to HEAD. The new execution bridge therefore separately binds source bytes and repository revision. This evidence changes the persistence requirement: a cache must not key solely on the old dirty-tree digest, nor treat a public hash as authentication.

- H1: Separating verifier abstention from concrete behavioral failure prevents unnecessary source rewrites while preserving rejection of known-bad programs.
- H2: Independent contract probes accept implementation-equivalent solutions that the v6 recognizer rejects, without accepting the retained mutation corpus.
- H3: Durable, exact-snapshot receipts eliminate repeated completed provider-free work; replay never drops or repeats paid attempts silently.
- H4: A leaner recovery interface reduces repair attempts and fresh tokens at equal outcome quality. Test separately after correctness, not bundled with the acceptance experiment.

The accompanying architecture decision and evaluation protocol define how these hypotheses can be falsified. No paper or passing finite suite supports a claim of zero possible edge cases. The release must instead state tested input partitions, remaining unsupported contracts, repeated-run reliability, and unresolved risks.

## Follow-up: stateful recovery and replay after admission integration

Primary documentation was rechecked on 2026-08-30. The current [LangGraph checkpointer guide](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) distinguishes full step checkpoints from completed per-node writes, and explicitly states that replay after a selected checkpoint re-executes later model/API calls. It also distinguishes exit-only, asynchronous, and synchronous durability. Piagent therefore cannot infer “exactly once” from the presence of a checkpoint: completed evidence reuse, pending-attempt reconciliation, and paid-attempt accounting need separate tests. The former durable-execution documentation URL now redirects to the persistence overview; the detailed checkpoint URL above is the relevant source for these claims.

The [fault-tolerance guide](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) separates retry policy, per-attempt timeout, and exhausted-error handling. This supports keeping worker failure distinct from a source counterexample. It does not justify importing that library's default retry behavior or raising Piagent's existing ceilings. Our next recovery work must retain the actual executor/unsupported reason instead of collapsing every unavailable admission into a generic missing-proof diagnostic.

[fast-check's model-based guide](https://fast-check.dev/docs/advanced/model-based-testing/) compares command histories against a simplified model and warns against reproducing the implementation as the oracle. It provides shrinking plus seed/path/replay-path reproduction. The transferable test design is a small abstract authority/attempt model exercised by histories such as reserve → host death → reopen → reconcile → retry, not merely isolated method assertions. No fast-check dependency or general stateful adapter was installed by this checkpoint.

Piagent-specific next evidence requirements (design decisions, not claims from the sources):

- A completed observation survives restart without another independent attempt, after actual current project verification is refreshed.
- A pending attempt never launches a duplicate solely because the host restarted or a timeout elapsed.
- Late completion, cancellation, shutdown, policy revocation, contract drift, and source drift are tested in different orders; the latest valid authority state wins.
- Counterexamples drive bounded source repair; executor errors and unsupported domains drive diagnosis/unknown, with no invented source defect.
- Stateful application adapters need a simpler independent behavioral model and held-out command histories. Passing the evidence-store protocol tests alone does not satisfy the required stateful-recovery domain.

These requirements extend the existing evaluation protocol; they do not replace the full frozen release campaign or import any external project's performance numbers as Piagent results.

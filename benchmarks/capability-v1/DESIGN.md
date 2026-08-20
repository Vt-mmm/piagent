# Capability benchmark design basis

This suite is a public, synthetic, run-private-oracle capability benchmark. It
does not claim to reproduce or supersede the cited benchmarks. Its design
borrows these evaluation properties:

- SWE-bench Verified: issue-style repository work, executable regression tests,
  and human validation of task solvability.
  https://openai.com/index/introducing-swe-bench-verified/
- Terminal-Bench 2.0: realistic terminal environments, one bounded attempt,
  human-written solutions, and comprehensive execution-based verification.
  https://arxiv.org/abs/2601.11868
- PaperBench: hierarchical, atomic, weighted rubrics and separate calibration
  of the grader itself.
  https://openai.com/index/paperbench/
- RE-Bench: long-horizon, open-ended engineering tasks evaluated under an
  explicit time budget rather than toy completion alone.
  https://arxiv.org/abs/2411.15114
- tau-bench: policy/tool interaction, end-state verification, and reliability
  distinguished from a single lucky trajectory.
  https://arxiv.org/abs/2406.12045
- OpenAI evaluation best practices: task-specific real-world distributions,
  typical/edge/adversarial partitions, automated scoring, logged trajectories,
  and explicit success criteria.
  https://developers.openai.com/api/docs/guides/evaluation-best-practices

For the final one-repeat comparison, every surface receives the same generated
variant, model, reasoning effort, fixture, timeout, and hidden grader. A single
repeat measures pass@1 only; it cannot support pass^k, stability, production, or
generalization claims.

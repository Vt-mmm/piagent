Implement `scheduleJobs(jobs, capacity)` in `src/scheduler.js`.

Jobs are `{ id, tenant, weight, dependsOn }`. Return an array of waves, each an array of job IDs.

Required invariants:

- Validate a positive integer capacity, unique non-empty IDs, non-empty tenants, integer weights from 1 through capacity, existing dependencies, no self-dependency, and an acyclic graph.
- A job may run only in a wave after every dependency completed in an earlier wave. A wave's total weight cannot exceed capacity.
- Selection is deterministic and stable relative to input order within each selection pass. Order inside a returned wave records selection order: first include the fair-pass choice for every fitting tenant, then append stable fill-pass choices.
- Tenant fairness: while another ready tenant with a job that fits is not represented in the current wave, do not give a represented tenant a second slot. After each ready tenant has had a fair opportunity, fill remaining capacity stably.
- Never mutate the input. Every job appears exactly once, or the function throws.

The hidden cases include dependencies that unlock across waves, weights that temporarily do not fit, punctuation in IDs, cycles, and three-tenant fairness. Add tests if useful.

Implement `buildContextPack(query, nodes, edges, budgetTokens)` in `src/context-pack.js`.

Nodes are `{ id, path, text, tokens, required? }`; directed edges are `{ from, to, weight }` with weight in `(0, 1]`.

Required behavior:

- Validate the graph, unique IDs, finite positive integer token costs, known endpoints, a positive integer budget, and plain inputs. Do not mutate inputs.
- Tokenize the query and node text case-insensitively on Unicode non-letter/non-number boundaries. A node's direct score is the count of distinct query terms it contains divided by the number of distinct query terms.
- Add one-hop propagation: for every directly scoring source, add `sourceDirectScore * edge.weight * 0.5` to its outgoing target. Cap final score at 1.
- All `required` nodes must fit or the function throws. Select them first, then select positive-score nodes by descending final score, descending direct score, ascending tokens, then original node order, skipping candidates that do not fit. Never select a node twice.
- Return `{ selected, usedTokens, omitted, confidence }`; selected/omitted entries include `id`, `path`, `tokens`, `directScore`, `score`. Confidence is `none`, `low`, `medium`, or `high` using maximum selected score thresholds 0, <0.34, <0.67, otherwise high.

The hidden graph contains ties, cycles (propagation is still one hop), Unicode terms, required zero-score nodes, and candidates larger than the remaining budget.

Run `npm test` when complete; it includes a fixed public happy-path contract for this scenario.

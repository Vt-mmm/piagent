// Literal public API witnesses; candidate implementations never generate answers.
import { retryFamilyCases, checkpointFamilyCases, configFamilyCases } from "./production-family-cases.mjs";
import { workflowFamilyCases, searchFamilyCases, requestFamilyCases } from "./production-reducer-cases.mjs";

const family = (id, description, cases, domain = "stateful-recovery", version = 1, parameters = { call: "export" }) => ({
  id, version, domain, description, parameters,
  template: { exportName: { $parameter: "call" }, checks: [{ id: "declared-api", cases }] }
});
function configurationTemplate() {
  const visit = value => Array.isArray(value) ? value.map(visit) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === "key" && ["port", "debug", "label"].includes(item)
        ? { $parameter: { port: "numericKey", debug: "booleanKey", label: "textKey" }[item] } : visit(item)])) : value;
  return visit(configFamilyCases());
}
export function productionFamilies() {
  return [
    family("bounded-retry-injected-sleep", "Retry an injected operation at most a positive integer maxAttempts (default 3), awaiting injected sleep between failures with nonnegative finite baseDelayMs (default 10) times powers of two; propagate the same final error and never sleep after it. Invalid defined numeric options, including null, are TypeError. Covers sync and Promise callbacks, sleep rejection, option nonmutation and default numeric options. Omitted sleep is checked only on first success; real timers, IO and unbounded attempts are not certified.", retryFamilyCases()),
    family("partial-checkpoint-resume", "resumeWork(items, checkpoint, processItem): validate integer nextIndex bounds and dense results length, resume without replay, preserve inputs, collect completed results, and rethrow the same failure with a newly attached checkpoint at the failed index. Return a new completed checkpoint. Includes first-item failure, falsy results, sync/Promise callbacks and recovery from actually observed checkpoint data after a realm reset. This is not a filesystem or OS-crash durability proof.", checkpointFamilyCases()),
    family("defined-config-precedence", "Resolve three distinct selected keys across FOUR layers: CLI, environment, file, defaults. Only undefined is absent; preserve falsy and null values and do not mutate layers. Numeric/boolean/text key parameter names label fields rather than impose value types. All key bindings must differ. Version 1 remains the original three-layer contract and is not silently upgraded.", configurationTemplate(), "configuration-precedence", 2,
      { call: "export", numericKey: "string", booleanKey: "string", textKey: "string" }),
    family("workflow-message-reducer", "Reducer with currentWorkflow/messages state, workflow/select and message/accepted events, and default initial state. Require nonempty string tagged fields, reject own undefined/null workflow overrides before duplicate handling, preserve exact state on validated duplicate ids, preserve message order across switches, and use a valid override for future work. No input mutation. Exposed finite histories are not exhaustive event-stream verification.", workflowFamilyCases()),
    family("stale-search-reducer", "Reducer with requestId/loading/results state and search/start, search/success, search/failure events. Only matching request ids settle; stale completions and unknown events preserve exact state; matching failure preserves results. Includes default initial state and overlapping-request history without input mutation. No epoch or duplicate-settlement rule is inferred for this API.", searchFamilyCases()),
    family("epoch-request-lifecycle", "Reducer with activeRequestId/connectionEpoch/loading/results/error state. Start records id and epoch and clears error; success/failure require both active id and epoch, clear loading and active request; success copies result arrays. Newer reconnect cancels active work and clears error without losing results. Stale, duplicate, same/older reconnect and unknown events preserve exact state. Includes defaults, no input mutation and reset histories. No transport or distributed-consistency proof.", requestFamilyCases())
  ];
}

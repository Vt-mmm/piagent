import { validateValue } from "./values.mjs";

// Copy observed inert data across explicit history steps, never guest handles,
// expected answers, callbacks or host properties. Missing evidence abstains.
export function resolveArguments(args, observations) {
  return args.map(arg => {
    if (!["result", "error-property"].includes(arg.type)) return arg;
    const observation = observations.get(arg.value);
    const value = arg.type === "result" ? observation?.outcome === "return" ? observation.value : undefined
      : observation?.outcome === "throw" ? observation.errorObservation?.properties.value.find(entry => entry.key === arg.key)?.value : undefined;
    if (value === undefined) return undefined;
    try { validateValue(value); return value; } catch { return undefined; }
  });
}

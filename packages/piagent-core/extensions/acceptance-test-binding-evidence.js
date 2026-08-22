import { assertionsProveErrorMapping } from "./acceptance-error-classes.js";
import { executableRejectionAssertions } from "./acceptance-executable-evidence.js";

export function callableAssertionMode(bodies, name) {
  const callable = bodies.get(name);
  return callable ? (callable.asynchronous ? "rejects" : "throws") : undefined;
}

/** Keep executable rejection assertions bound to the file that imported them. */
export function boundRejectionTestEvidence(input) {
  const codeByPath = new Map(input.testCodeEntries.map((entry) => [entry.path, entry.code]));
  const cache = new Map();
  const assertionsForBinding = (binding) => {
    const key = `${binding.testPath}\u0000${binding.testName}`;
    if (cache.has(key)) return cache.get(key);
    const code = codeByPath.get(binding.testPath);
    const assertions = typeof code === "string" ? executableRejectionAssertions(code, new Set([binding.testName]))
      .filter((assertion) => assertion.targets.includes(binding.testName)) : [];
    cache.set(key, assertions);
    return assertions;
  };
  const requestedError = (assertion) => input.requestedErrors.length === 0
    || input.requestedErrors.some((name) => assertion.errorClasses.includes(name));
  const bindingGroups = input.bindings.map((binding) => {
    const allAssertions = (binding.testBindings ?? []).flatMap(assertionsForBinding);
    return { binding, allAssertions, assertions: allAssertions.filter(requestedError) };
  });
  const testCodes = input.testCodeEntries.length > 0
    ? input.testCodeEntries.map((entry) => entry.code) : [input.fallbackTestCode];
  const structuralGroups = input.structuralTargets.map((target) => {
    const allAssertions = testCodes.flatMap((code) => executableRejectionAssertions(
      code, new Set([`*.${target}`])
    ).filter((assertion) => assertion.targets.includes(`*.${target}`)));
    return { target, allAssertions, assertions: allAssertions.filter(requestedError) };
  });
  const groups = [...bindingGroups, ...structuralGroups];
  const assertions = groups.flatMap((group) => group.assertions);
  const assertionModesMatch = (items, targets, expectedMode) => {
    const relevant = items.filter((item) => item.targets.some((target) => targets.includes(target)));
    return Boolean(expectedMode) && relevant.length > 0 && relevant.every((item) => item.mode === expectedMode);
  };
  const mappingOk = input.requestedErrors.length <= 1 || Boolean(input.requestedErrorMapping
    && groups.length > 0
    && bindingGroups.every(({ binding, allAssertions }) => assertionsProveErrorMapping(
      allAssertions, binding.testNames, input.requestedErrorMapping
    ))
    && structuralGroups.every(({ target, allAssertions }) => assertionsProveErrorMapping(
      allAssertions, [`*.${target}`], input.requestedErrorMapping
    )));
  const targetOk = assertions.length > 0
    && bindingGroups.every(({ binding, assertions: items }) => binding.testNames.length > 0 && items.length > 0)
    && structuralGroups.every(({ assertions: items }) => items.length > 0);
  const modeOk = bindingGroups.every(({ binding, assertions: items }) => assertionModesMatch(
    items, binding.testNames, callableAssertionMode(input.bodyMaps.get(binding.sourcePath) ?? new Map(), binding.sourceName)
  )) && structuralGroups.every(({ target, assertions: items }) => {
    const matches = [...input.bodyMaps.values()].filter((bodies) => bodies.has(target));
    return assertionModesMatch(items, [`*.${target}`], matches.length === 1 ? callableAssertionMode(matches[0], target) : undefined);
  });
  return { assertions, mappingOk, modeOk, targetOk };
}

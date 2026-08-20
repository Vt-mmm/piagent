export function routeRuntimeCommand(input) {
  return { terminalCommand: String(input?.kind ?? ""), confirmationRequired: false, expectedModelCalls: 0, effect: "read" };
}

export function runtimeCommandDigest(input) {
  return String(input?.kind ?? "");
}

export function admitRuntimeCommand(state, input) {
  return { state, receipt: input };
}

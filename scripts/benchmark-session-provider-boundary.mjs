function boundaryFailure(message) {
  return Object.assign(new Error(message), { exitCode: 1 });
}

export function assertBenchmarkSessionProviderBoundary({ assertProviderDispatchReady,
  onAfterProviderDispatch, surface, piagentWebUiJourney, defaultPiagentWebUiJourney,
  allowInjectedJourney }) {
  if (typeof assertProviderDispatchReady !== "function") {
    throw boundaryFailure("Benchmark provider dispatch requires an explicit integrity guard");
  }
  if (surface === "codex-cli" && typeof onAfterProviderDispatch !== "function") {
    throw boundaryFailure("Codex benchmark dispatch requires an explicit post-dispatch integrity guard");
  }
  if (piagentWebUiJourney !== defaultPiagentWebUiJourney && allowInjectedJourney !== true) {
    throw boundaryFailure("Injected Piagent WebUI journeys are restricted to the explicit offline benchmark seam");
  }
}

export function providerBoundaryFailureDisposition(error, phase) {
  if (!error && phase === null) return null;
  if (!(error instanceof Error) || !["pre-dispatch", "post-dispatch"].includes(phase)) {
    throw boundaryFailure("Fatal provider boundary evidence is missing its exact dispatch phase");
  }
  if (phase === "pre-dispatch") return Object.freeze({
    failure: "provider-dispatch-integrity-denied-before-next-turn", class: "execution-integrity",
    usageStatus: "measured-but-unaccepted", retryable: false
  });
  if (phase === "post-dispatch") return Object.freeze({
    failure: "provider-dispatch-integrity-denied-after-provider-return", class: "execution-integrity",
    usageStatus: "measured-lower-bound", retryable: false
  });
}

export async function runPostDispatchCheckedCommand({ runCommand, command, args, workspace, prompt,
  surface, timeoutMs, forbiddenOutputSubstrings, requiredOutputSubstrings, processEnvironment,
  timingCollector, codexCollector, onAfterProviderDispatch }) {
  const stagedCodexChunks = [];
  let agent;
  let commandError = null;
  try {
    agent = await runCommand(command, args, {
      cwd: workspace, input: surface === "codex-cli" ? prompt : undefined, timeoutMs,
      forbiddenSubstrings: forbiddenOutputSubstrings, requiredSubstrings: requiredOutputSubstrings,
      onStdoutChunk: (chunk, observation) => {
        if (surface === "codex-cli") stagedCodexChunks.push(Object.freeze({
          chunk: String(chunk), observedAtSeconds: observation?.observedAtSeconds
        }));
        else timingCollector.write(chunk, observation?.observedAtSeconds);
      },
      env: processEnvironment
    });
  } catch (error) { commandError = error; }
  if (surface === "codex-cli") {
    await onAfterProviderDispatch(Object.freeze({ turnIndex: 1, turnId: null }));
  }
  if (commandError) throw commandError;
  for (const staged of stagedCodexChunks) {
    timingCollector.write(staged.chunk, staged.observedAtSeconds);
    codexCollector.write(staged.chunk);
  }
  return agent;
}

import crypto from "node:crypto";
import path from "node:path";

import {
  aggregateCodexTurnUsage,
  aggregateSessionUsage,
  createCodexExecJsonlCollector
} from "../packages/piagent-core/benchmark/benchmark-core.js";
import {
  codexExecArgs,
  codexExecResumeArgs,
  codexScopedBrokerOverrides
} from "../packages/piagent-core/benchmark/benchmark-codex.js";
import { buildCodexInvocationReceipt } from "../packages/piagent-core/benchmark/benchmark-codex-rollout.js";
import { codexProcessEnvironment } from "../packages/piagent-core/benchmark/benchmark-runtime.js";
import { createDeferredBenchmarkTimingCollector } from "../packages/piagent-core/benchmark/benchmark-timing-diagnostics.js";

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

const scopedBrokerSettlement = new WeakMap(), scopedBrokerDisposal = new WeakMap();
export const CODEX_SCOPED_BROKER_TURN_FACTORY_VERSION = "codex-scoped-broker-turn-factory-v1";
export const BENCHMARK_SCOPED_SESSION_FACTORY_VERSION = "benchmark-scoped-session-factory-v1";
export const BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION = "benchmark-scoped-session-custody-v1";
export const BENCHMARK_SCOPED_SESSION_REQUEST_VERSION = "benchmark-scoped-session-request-v1";

export function isCodexScopedBrokerTurnFactory(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 3 && value.version === CODEX_SCOPED_BROKER_TURN_FACTORY_VERSION
    && value.authority === "none" && typeof value.openTurn === "function");
}

function inspectForbiddenValue(value, candidates, hits) {
  if (typeof value === "string") {
    for (const candidate of candidates) if (value.includes(candidate)) hits.add(candidate);
  } else if (Array.isArray(value)) {
    for (const item of value) inspectForbiddenValue(item, candidates, hits);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) inspectForbiddenValue(item, candidates, hits);
  }
}

export function resolveCodexJourneyScopedBrokers(scopedBroker, turns) {
  if (!scopedBroker) return turns.map(() => undefined);
  let brokers;
  if (Array.isArray(scopedBroker)) brokers = [...scopedBroker];
  else if (typeof scopedBroker === "function") {
    brokers = turns.map((turn, index) => scopedBroker(Object.freeze({ turnIndex: index + 1, turnId: turn.id })));
  } else {
    if (turns.length !== 1) fail("A multi-turn Codex journey requires one sealed scoped broker config per process");
    brokers = [scopedBroker];
  }
  if (brokers.length !== turns.length) fail("Codex journey scoped broker config count does not match its turns");
  const paths = new Set(), owned = [];
  for (const broker of brokers) {
    const launch = broker?.codexLaunch ?? broker;
    codexScopedBrokerOverrides(launch);
    if (paths.has(launch.brokerConfigPath)) fail("Codex journey cannot reuse scoped broker custody across processes");
    paths.add(launch.brokerConfigPath);
    const value = Object.freeze({ nodeCommand: launch.nodeCommand, brokerScript: launch.brokerScript,
      brokerConfigPath: launch.brokerConfigPath });
    const settle = typeof broker?.reconcileCodexSettlement === "function"
      ? usage => broker.reconcileCodexSettlement(usage)
      : scopedBrokerSettlement.get(broker);
    const dispose = typeof broker?.dispose === "function" ? () => broker.dispose()
      : scopedBrokerDisposal.get(broker);
    if (settle) scopedBrokerSettlement.set(value, settle);
    if (dispose) scopedBrokerDisposal.set(value, dispose);
    owned.push(value);
  }
  return Object.freeze(owned);
}

export function controlledCodexEnvironment(codexRuntime, extra) {
  const environment = codexProcessEnvironment(codexRuntime, extra);
  if (codexRuntime?.mode !== "controlled") return environment;
  const home = codexRuntime.home;
  if (typeof home !== "string" || !path.isAbsolute(home) || path.normalize(home) !== home || home.includes("\0")) {
    fail("Controlled Codex runtime home must be a canonical absolute path");
  }
  environment.HOME = home;
  environment.CODEX_HOME = home;
  return environment;
}

export function requireScopedCodexHome(scopedBroker, codexRuntime, environment) {
  if (!scopedBroker) return;
  if (codexRuntime?.mode !== "controlled" || environment?.HOME !== codexRuntime.home
    || environment?.CODEX_HOME !== codexRuntime.home) {
    fail("Scoped Codex requires HOME and CODEX_HOME bound to the same controlled runtime home");
  }
}

export async function runCodexUserJourney({
  runCommand,
  codexCommand,
  workspace,
  turns,
  options,
  disabledFeatures,
  codexRuntime,
  scopedBroker,
  environment,
  timeoutMs,
  forbiddenOutputSubstrings
}) {
  const scopedBrokerFactory = isCodexScopedBrokerTurnFactory(scopedBroker) ? scopedBroker : null;
  requireScopedCodexHome(scopedBroker, codexRuntime, environment);
  const scopedBrokers = scopedBrokerFactory ? null : resolveCodexJourneyScopedBrokers(scopedBroker, turns);
  const started = Date.now(), deadline = started + timeoutMs;
  const outputs = [], errors = [], usages = [], diagnostics = [], turnReceipts = [];
  const forbiddenHits = new Set();
  let threadId = null, code = 0, signal = null, timedOut = false;
  const usedBrokerPaths = new Set(), pendingDisposals = new Set(scopedBrokers ?? []);
  const releaseScopedBroker = async broker => {
    if (!broker || !pendingDisposals.delete(broker)) return;
    const dispose = scopedBrokerDisposal.get(broker);
    if (dispose) await dispose();
  };
  const releaseRemainingBrokers = async () => {
    const failures = [];
    for (const broker of [...pendingDisposals]) {
      try { await releaseScopedBroker(broker); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "Codex scoped broker disposal failed");
  };

  try {
    for (const [index, turn] of turns.entries()) {
      let remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        code = 1;
        timedOut = true;
        errors.push(`journey-timeout-before-turn-${index + 1}`);
        break;
      }
      const collector = createCodexExecJsonlCollector({
        model: options.model,
        thinkingLevel: options.thinking,
        requestedServiceTier: options.serviceTier,
        onEvent: event => inspectForbiddenValue(event, forbiddenOutputSubstrings, forbiddenHits)
      });
      const timing = createDeferredBenchmarkTimingCollector({ surface: "codex-cli" });
      let turnScopedBroker = scopedBrokers?.[index];
      if (scopedBrokerFactory) {
        let opened;
        try {
          opened = await scopedBrokerFactory.openTurn(Object.freeze({ turnIndex: index + 1,
            turnId: turn.id, inputText: turn.message, threadId, workspace }));
          [turnScopedBroker] = resolveCodexJourneyScopedBrokers(opened, [turn]);
          pendingDisposals.add(turnScopedBroker);
          if (usedBrokerPaths.has(turnScopedBroker.brokerConfigPath)) {
            fail("Codex journey cannot reuse scoped broker custody across processes");
          }
          usedBrokerPaths.add(turnScopedBroker.brokerConfigPath);
        } catch (error) {
          if (turnScopedBroker) await releaseScopedBroker(turnScopedBroker);
          else if (typeof opened?.dispose === "function") await opened.dispose();
          throw error;
        }
        remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          await releaseScopedBroker(turnScopedBroker);
          code = 1; timedOut = true; errors.push(`journey-timeout-before-turn-${index + 1}`); break;
        }
      }
      try {
        const args = threadId
          ? codexExecResumeArgs({ threadId, options, disabledFeatures, scopedBroker: turnScopedBroker })
          : codexExecArgs({ workspace, options, disabledFeatures, persistent: true, scopedBroker: turnScopedBroker });
        const result = await runCommand(codexCommand, args, {
          cwd: workspace,
          input: turn.message,
          timeoutMs: remainingMs,
          forbiddenSubstrings: forbiddenOutputSubstrings,
          onStdoutChunk: (chunk, observation) => {
            timing.write(chunk, observation?.observedAtSeconds);
            collector.write(chunk);
          },
          env: environment
        });
        outputs.push(result.stdout ?? "");
        errors.push(result.stderr ?? "");
        for (const value of result.forbiddenHits ?? []) forbiddenHits.add(value);
        let turnUsage = null;
        let settlement = null;
        try {
          const parsedUsage = collector.finish();
          turnUsage = {
            ...parsedUsage,
            codexInvocationReceipt: buildCodexInvocationReceipt({
              command: codexCommand,
              args,
              runtime: codexRuntime,
              environment,
              workspace,
              requestedModel: options.model,
              requestedThinking: options.thinking,
              requestedServiceTier: options.serviceTier,
              resumed: index > 0,
              result,
              usage: parsedUsage
            })
          };
          const settle = turnScopedBroker && scopedBrokerSettlement.get(turnScopedBroker);
          if (settle) settlement = await settle(turnUsage);
          if (threadId && turnUsage.providerSessionId !== threadId) {
            throw new Error("Codex CLI resumed journey changed thread identity");
          }
          threadId ??= turnUsage.providerSessionId;
          usages.push(turnUsage);
        } catch (error) {
          diagnostics.push({ type: "journey-usage", message: error instanceof Error ? error.message : String(error) });
          turnUsage = null;
        }
        diagnostics.push(...collector.diagnostics());
        turnReceipts.push({
          index: index + 1,
          id: turn.id,
          promptHash: crypto.createHash("sha256").update(turn.message).digest("hex"),
          resumed: index > 0,
          exitCode: result.code,
          timedOut: result.timedOut,
          durationSeconds: result.durationSeconds,
          usageExact: Boolean(turnUsage),
          settlement,
          timingDiagnostics: timing.finish(result.durationSeconds)
        });
        if (result.code !== 0 || result.timedOut || !turnUsage) {
          code = result.code || 1;
          signal = result.signal ?? null;
          timedOut = result.timedOut === true;
          break;
        }
      } finally { await releaseScopedBroker(turnScopedBroker); }
    }
    await releaseRemainingBrokers();
  } catch (error) {
    try { await releaseRemainingBrokers(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Codex journey and scoped broker disposal failed");
    }
    throw error;
  }

  let usage;
  try {
    if (usages.length !== turnReceipts.length) throw new Error("Codex journey started-attempt usage is incomplete");
    usage = aggregateCodexTurnUsage(usages);
    if (turnReceipts.length !== turns.length) {
      diagnostics.push({ type: "journey-lifecycle", message: "Codex journey stopped before every requested turn started" });
    }
  } catch (error) {
    diagnostics.push({ type: "journey-usage", message: error instanceof Error ? error.message : String(error) });
    usage = aggregateSessionUsage([]);
    code ||= 1;
  }
  return {
    agent: {
      code,
      signal,
      timedOut,
      stdout: outputs.join("\n"),
      stderr: errors.filter(Boolean).join("\n"),
      durationSeconds: (Date.now() - started) / 1000,
      forbiddenHits: [...forbiddenHits],
      requiredHits: []
    },
    usage,
    diagnostics,
    journeyReceipt: {
      schemaVersion: 1,
      channel: "codex-cli-resume",
      threadId,
      turns: turnReceipts,
      completed: code === 0 && turnReceipts.length === turns.length
    }
  };
}

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TaskContract } from "../../extensions/guard-types.js";
import type { ContextDeltaShadowMode } from "../context/context-delta-shadow.ts";
import type { ModelRouteEvaluation } from "../model/model-route-runtime.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import type { RuntimeSessionState } from "../session/runtime-state.ts";
import type { SolverShadowEvaluation } from "../solver/solver-shadow.ts";
import type { TrajectorySyncOptions, TrajectorySyncResult } from "../trajectory/trajectory-runtime.ts";
import type { ensureContextIndexV2 } from "../../extensions/context-engine.js";

export type RuntimeIntakeResult = {
  started: boolean;
  text: string;
  task?: TaskContract;
  plannedContext?: Array<{ path: string; reason: string }>;
  plannedContextComplete?: boolean;
  continuation?: "terminal-uncertain-send";
};

export type AgentStartHookDependencies = {
  state: RuntimeSessionState;
  autoContextEnabled: boolean;
  contextDeltaShadowMode: ContextDeltaShadowMode;
  activeTask: (ctx: ExtensionContext) => TaskContract | undefined;
  readProtectedPaths: (ctx: ExtensionContext) => string[];
  contextExcludePatterns: (ctx: ExtensionContext) => string[];
  ensureContextIndex?: typeof ensureContextIndexV2;
  promptPackKey: (ctx: ExtensionContext, promptHash: string) => string;
  retrievalKey: (ctx: ExtensionContext, query: string) => string;
  startAutomaticTask: (query: string, ctx: ExtensionContext) => Promise<RuntimeIntakeResult | undefined>;
  runtimeSnapshot?: (ctx: ExtensionContext) => RuntimeModelSnapshot | undefined;
  persistRuntimeSnapshot?: (ctx: ExtensionContext, snapshot: RuntimeModelSnapshot) => unknown;
  shadowSolver?: (input: {
    request: string;
    ctx: ExtensionContext;
    activeTask?: TaskContract;
    runtimeSnapshot?: RuntimeModelSnapshot;
    protectedTarget: boolean;
  }) => SolverShadowEvaluation;
  modelRoute?: (input: {
    ctx: ExtensionContext;
    features: NonNullable<Extract<SolverShadowEvaluation, { status: "ok" }>["features"]>;
    runtimeSnapshot?: RuntimeModelSnapshot;
  }) => Promise<ModelRouteEvaluation>;
  syncTrajectory?: (ctx: ExtensionContext, task: TaskContract, options: TrajectorySyncOptions) => TrajectorySyncResult;
  telemetry: (ctx: ExtensionContext, payload: Record<string, unknown>) => void;
};

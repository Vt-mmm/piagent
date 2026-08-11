import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "../../extensions/local-state-path.js";
import { appendJsonlBounded } from "../../extensions/state-retention.js";
import { safeTaskId } from "../../extensions/task-state.js";
import { reduceTrajectory } from "./trajectory-state.ts";
import type { TrajectoryState, TrajectoryTransitionEvent } from "./trajectory-types.ts";
import { validateTrajectoryState, validateTrajectoryTransition } from "./trajectory-types.ts";

const MAX_EVENT_BYTES = 512 * 1024;

export type TrajectoryStoreView = {
  status: "missing" | "ok" | "corrupt";
  state?: TrajectoryState;
  events: TrajectoryTransitionEvent[];
  recoveredEvents: number;
  warnings: string[];
  enforcementSafe: boolean;
};

export function trajectoryStatePath(cwd: string, taskRunId: string): string {
  return path.join(cwd, ".pi", "piagent-state", "trajectory", `${safeTaskId(taskRunId)}.json`);
}
export function trajectoryEventsPath(cwd: string, taskRunId: string): string {
  return path.join(cwd, ".pi", "piagent-state", "trajectory", `${safeTaskId(taskRunId)}.events.jsonl`);
}

function readText(file: string): string {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as { code?: string })?.code === "ENOENT") return ""; throw error; }
}

export function readTrajectoryStore(cwd: string, taskRunId: string): TrajectoryStoreView {
  try {
    const stateFile = resolveLocalStatePath(cwd, trajectoryStatePath(cwd, taskRunId), { label: "Trajectory state" });
    const eventFile = resolveLocalStatePath(cwd, trajectoryEventsPath(cwd, taskRunId), { label: "Trajectory events" });
    const rotated = resolveLocalStatePath(cwd, `${trajectoryEventsPath(cwd, taskRunId)}.1`, { label: "Rotated trajectory events" });
    const stateText = readText(stateFile);
    const eventLines = [readText(rotated), readText(eventFile)].join("").split(/\r?\n/).filter(Boolean);
    if (!stateText && eventLines.length === 0) return { status: "missing", events: [], recoveredEvents: 0, warnings: [], enforcementSafe: true };
    if (!stateText) return { status: "corrupt", events: [], recoveredEvents: 0, warnings: ["trajectory events exist without state"], enforcementSafe: false };
    let state = validateTrajectoryState(JSON.parse(stateText), "persisted trajectory state");
    const events: TrajectoryTransitionEvent[] = [];
    for (const [index, line] of eventLines.entries()) {
      try { events.push(validateTrajectoryTransition(JSON.parse(line), `persisted trajectory event ${index + 1}`)); }
      catch (error) { return { status: "corrupt", events, recoveredEvents: 0, warnings: [error instanceof Error ? error.message : String(error)], enforcementSafe: false }; }
    }
    let recoveredEvents = 0;
    for (const event of events) {
      if (state.appliedEventIds.includes(event.eventId)) continue;
      if (event.sequence <= state.sequence) return { status: "corrupt", state, events, recoveredEvents, warnings: ["trajectory journal contains an unknown out-of-order event"], enforcementSafe: false };
      state = reduceTrajectory(state, event);
      recoveredEvents += 1;
    }
    return { status: "ok", state, events, recoveredEvents, warnings: [], enforcementSafe: true };
  } catch (error) {
    return { status: "corrupt", events: [], recoveredEvents: 0, warnings: [error instanceof Error ? error.message : String(error)], enforcementSafe: false };
  }
}

export function writeTrajectoryState(cwd: string, stateInput: TrajectoryState): TrajectoryState {
  const state = validateTrajectoryState(structuredClone(stateInput));
  const target = trajectoryStatePath(cwd, state.taskRunId);
  const parent = ensurePrivateStateDirectory(cwd, path.dirname(target), "Trajectory state directory");
  const safeTarget = resolveLocalStatePath(cwd, target, { label: "Trajectory state" });
  const temporary = path.join(parent, `${path.basename(safeTarget)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, safeTarget);
  try { fs.chmodSync(parent, 0o700); fs.chmodSync(safeTarget, 0o600); } catch {}
  return state;
}

export function appendTrajectoryTransition(cwd: string, eventInput: TrajectoryTransitionEvent): TrajectoryTransitionEvent {
  const event = validateTrajectoryTransition(structuredClone(eventInput));
  appendJsonlBounded(trajectoryEventsPath(cwd, event.taskRunId), event, { maxBytes: MAX_EVENT_BYTES, mode: 0o600, projectRoot: cwd });
  return event;
}

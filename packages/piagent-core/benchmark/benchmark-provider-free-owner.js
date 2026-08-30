// Imported before a provider-free lane entrypoint. The ownership lock outlives
// its caller if the benchmark coordinator dies, so a new invocation cannot run
// the same lane concurrently with the surviving process.
import fs from "node:fs";
import path from "node:path";
import { acquireBenchmarkRunLock } from "./benchmark-run-lock.js";
import { readCheckpoint } from "./benchmark-checkpoint.js";

const directory = process.env.PIAGENT_S0_LANE_DIRECTORY;
const binding = process.env.PIAGENT_S0_BINDING;
const attempt = process.env.PIAGENT_S0_ATTEMPT;
try {
  if (!directory || fs.realpathSync.native(directory) !== directory || !/^[a-f0-9]{64}$/.test(binding ?? "")
    || !/^[a-f0-9-]{36}$/.test(attempt ?? "")) throw new Error("Invalid S0 lane ownership configuration");
  acquireBenchmarkRunLock(directory, `s0-lane:${attempt}`);
  const checkpoint = readCheckpoint(path.join(directory, "checkpoint.json"), binding);
  if (checkpoint?.status !== "running" || checkpoint.attempt !== attempt) {
    throw new Error("S0 lane reservation changed before execution");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  // This is an ownership/configuration refusal, not a failed test observation.
  process.exit(75);
}

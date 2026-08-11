import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { trajectoryStatePath, writeTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";

function state() {
  return createTrajectoryState({
    taskId: "failure-mode-task",
    taskRunId: "failure-mode-run",
    sessionId: "private-session",
    changeMode: "source-change",
    riskLane: "normal",
    createdAt: "2026-08-08T00:00:00.000Z"
  });
}

describe("local state write failure modes", () => {
  for (const code of ["ENOSPC", "EACCES"]) {
    it(`leaves no authoritative partial state after ${code}`, () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-local-failure-"));
      const original = fs.writeFileSync;
      fs.writeFileSync = function injectedFailure(file, ...args) {
        if (String(file).includes(`${path.sep}piagent-state${path.sep}`)) {
          const error = new Error(code === "ENOSPC" ? "synthetic disk full" : "synthetic permission denied");
          error.code = code;
          throw error;
        }
        return original.call(this, file, ...args);
      };
      try {
        assert.throws(() => writeTrajectoryState(cwd, state()), new RegExp(code === "ENOSPC" ? "disk full" : "permission denied"));
      } finally {
        fs.writeFileSync = original;
      }
      assert.equal(fs.existsSync(trajectoryStatePath(cwd, "failure-mode-run")), false);
      const directory = path.dirname(trajectoryStatePath(cwd, "failure-mode-run"));
      const leftovers = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.includes(".tmp")) : [];
      assert.deepEqual(leftovers, []);
    });
  }
});

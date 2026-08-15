import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { compactRef, criterionMeta, label, modelName, permissionName, taskProgress, thinkingName, tone } from "../packages/piagent-webui/client/src/view-model.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/snapshot-v1.valid.json"), "utf8"));

function activeSnapshot() {
  const value = structuredClone(fixture);
  value.identity.taskId = "task_webui_dashboard";
  value.identity.taskRunId = "run_webui_dashboard";
  value.task = {
    taskId: value.identity.taskId, taskRunId: value.identity.taskRunId,
    summary: "Build the local task dashboard", changeMode: "source-change", riskLane: "low-risk",
    outcome: "pending", controlState: "active",
    criteria: [
      { criterionId: "criterion_1", obligation: "Show exact task progress", priority: "critical", state: "satisfied", evidence: "observed", relatedFileRefs: ["file_1"], verifierAttemptRefs: ["attempt_1"], reasonCode: null },
      { criterionId: "criterion_2", obligation: "Keep unavailable evidence explicit", priority: "normal", state: "pending", evidence: "unavailable", relatedFileRefs: [], verifierAttemptRefs: [], reasonCode: "not-yet-observed" }
    ],
    workPlan: [], scope: [], outOfScope: [], progress: { completed: 1, total: 2, percent: 50 }, blocker: null, reasonCode: null
  };
  return value;
}

describe("Piagent WebUI task dashboard projection", () => {
  it("renders only accepted snapshot facts and keeps missing task state explicit", () => {
    assert.deepEqual(taskProgress(fixture), { completed: 0, total: 0, percent: 0, text: "Chưa có task đang chạy" });
    assert.equal(modelName(fixture), "GPT-5.6");
    assert.equal(thinkingName(fixture), "Cao");
    assert.equal(permissionName(fixture), "Ghi trong project");
    assert.equal(compactRef(null), "—");
  });

  it("projects criterion evidence counts without inferring completion", () => {
    const snapshot = activeSnapshot();
    assert.deepEqual(taskProgress(snapshot), { completed: 1, total: 2, percent: 50, text: "1/2 tiêu chí" });
    assert.equal(criterionMeta(snapshot.task.criteria[0]), "1 file · 1 lần kiểm tra");
    assert.equal(criterionMeta(snapshot.task.criteria[1]), "Chưa có bằng chứng liên kết");
    assert.equal(tone(snapshot.task.criteria[0].state), "positive");
    assert.equal(tone(snapshot.task.criteria[1].state), "neutral");
    assert.equal(label(snapshot.task.outcome), "Chưa xong");
  });

  it("keeps the first viewport read-only, accessible and text-rendered", () => {
    const app = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/App.tsx"), "utf8");
    const client = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/use-inspection.ts"), "utf8");
    assert.match(app, /aria-labelledby="task-title"/);
    assert.match(app, /role="progressbar"/);
    assert.match(app, /aria-label=\{localize\(locale, "Trạng thái Pi session", "Pi session status"\)\}/);
    assert.doesNotMatch(app, /dangerouslySetInnerHTML|contentEditable/);
    assert.doesNotMatch(client, /method:\s*["']POST["']/);
    assert.match(client, /EventSource/);
  });
});

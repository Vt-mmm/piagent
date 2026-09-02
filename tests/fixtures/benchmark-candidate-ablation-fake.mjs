import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createOfflineAblationPlan, runOfflineCandidateAblation } from "../../scripts/benchmark-candidate-ablation.mjs";

export function fakeProvider({ onDispatch = () => {}, input = 8, duplicateSessionId = false } = {}) {
  const result = (stdout = "") => ({ code: 0, stdout, stderr: "", signal: null, timedOut: false, durationSeconds: 0.01 });
  const provider = {
    kind: "offline-test-double",
    async piagentWebUiJourney({ agentDir, workspace, environment }) {
      const sessionDir = path.join(agentDir, "sessions");
      fs.mkdirSync(sessionDir);
      const response = await provider.runCommand("offline-fake-pi", ["--session-dir", sessionDir, "--session-id", crypto.randomUUID()], { cwd: workspace, env: environment });
      return { ...response, journeyReceipt: { channel: "offline-fake-webui", completed: true, turns: [] } };
    },
    async runCommand(command, args, options) {
      if (command === "offline-fake-git") return result(execFileSync("git", args, { cwd: options.cwd, env: options.env, encoding: "utf8" }));
      if (command === "offline-fake-bash") {
        fs.writeFileSync(path.join(args[1], "AGENTS.md"), "# Synthetic offline fixture\n");
        return result();
      }
      if (command === "offline-fake-node") return result(JSON.stringify({ passed: true, checks: [{ id: "fake-evaluator-only", passed: true }], score: 10 }));
      assert.equal(command, "offline-fake-pi", "no real executable may be dispatched by this proof");
      const sessionDir = args[args.indexOf("--session-dir") + 1];
      const id = duplicateSessionId ? "duplicate-session" : args[args.indexOf("--session-id") + 1];
      const home = options.env.PI_CODING_AGENT_DIR;
      assert.deepEqual(fs.readdirSync(sessionDir), [], "session cache must start empty");
      assert.deepEqual(fs.readdirSync(home).filter(name => name !== "sessions"), [], "runtime home must start without retained cache");
      assert.equal(options.env.PIAGENT_BENCHMARK_SURFACE, "piagent");
      onDispatch({ args, options, sessionDir, home, id });
      fs.writeFileSync(path.join(home, "fake-private-cache"), "never reuse\n");
      const timestamp = new Date().toISOString();
      fs.writeFileSync(path.join(sessionDir, "session.jsonl"), [
        { type: "session", id, cwd: options.cwd, timestamp },
        { type: "model_change", provider: "openai-codex", modelId: "gpt-5.6-luna", timestamp },
        { type: "thinking_level_change", thinkingLevel: "medium", timestamp },
        { type: "message", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Synthetic offline response" }],
          usage: { input, output: 2, cacheRead: 3, cacheWrite: 0, reasoning: 1, totalTokens: input + 5, cost: { total: 0 } } } }
      ].map(JSON.stringify).join("\n") + "\n");
      return result("Synthetic offline response");
    }
  };
  return provider;
}

export function fixture(root, { budget = { maxFreshTokens: 6000000, reserveFreshPerSession: 100000 } } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const suiteRoot = path.join(root, "suite");
  fs.mkdirSync(path.join(suiteRoot, "project"), { recursive: true });
  fs.writeFileSync(path.join(suiteRoot, "project", "package.json"), '{"name":"offline-fake-fixture"}\n');
  fs.writeFileSync(path.join(suiteRoot, "prompt.md"), "This is an offline plumbing fixture, not the benchmark workload.\n");
  fs.writeFileSync(path.join(suiteRoot, "grade.mjs"), "// Fake evaluator seam; never executed.\n");
  const publicSuite = JSON.parse(fs.readFileSync(new URL("../../benchmarks/production-v2/suite.json", import.meta.url), "utf8"));
  const suite = { id: "offline-public-coordinate-proof", profile: "node-typescript", scenarios: publicSuite.scenarios.map(scenario => ({
    id: scenario.id, title: scenario.title, kind: "safety-refusal", lifecycle: "cold-start", fixture: "project", prompt: "prompt.md", grader: "grade.mjs", allowedChanges: []
  })) };
  const arms = ["test-control", "test-treatment"].map(armId => {
    const packageRoot = path.join(root, armId);
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(path.join(packageRoot, "source.txt"), `${armId}\n`);
    execFileSync("git", ["init", "-q", packageRoot]);
    execFileSync("git", ["-C", packageRoot, "add", "."]);
    execFileSync("git", ["-C", packageRoot, "-c", "user.name=Offline Test", "-c", "user.email=offline@example.invalid", "commit", "-qm", "offline fixture"]);
    const configurationFile = path.join(root, `${armId}.json`);
    fs.writeFileSync(configurationFile, '{"fake":true}\n');
    return { armId, packageRoot, configurationFile };
  });
  const plan = createOfflineAblationPlan({ runId: "offline-proof", arms, suite, suiteRoot, budget, rootSeed: "offline-public-coordinate-seed" });
  return { root, plan, runRoot: path.join(root, "evidence") };
}

// Child-process crash tests use this file, never a provider executable.
if (process.argv[2] === "--crash-worker") {
  const [planFile, runRoot, crashStage] = process.argv.slice(3);
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  await runOfflineCandidateAblation({ plan, runRoot, fakeProvider: fakeProvider(), checkpoint: stage => {
    if (stage === crashStage) process.kill(process.pid, "SIGKILL");
  } });
}

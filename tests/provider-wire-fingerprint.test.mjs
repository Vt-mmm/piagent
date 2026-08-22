import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildOpenAiCodexWireFingerprint } from "../packages/piagent-core/runtime/model/provider-wire-fingerprint.ts";

function payload(overrides = {}) {
  return {
    model: "gpt-5.6-sol",
    instructions: "Never expose WIRE_SECRET_A1.",
    input: [],
    tools: [
      { type: "function", name: "alpha", description: "ALPHA_SECRET", parameters: { type: "object", properties: { z: { type: "string" }, a: { type: "number" } } } },
      { type: "function", name: "beta", parameters: { type: "object", required: ["value"] } }
    ],
    reasoning: { effort: "high", summary: "auto" },
    text: { verbosity: "low" },
    tool_choice: "auto",
    ...overrides
  };
}

function fingerprint(value = payload(), provider = "openai-codex", modelId = "gpt-5.6-sol", workingDirectory, platformRoot) {
  return buildOpenAiCodexWireFingerprint({ payload: value, provider, modelId, workingDirectory, platformRoot });
}

describe("OpenAI Codex provider wire fingerprint", () => {
  it("is deterministic across semantic object-key ordering", () => {
    const left = fingerprint();
    const right = fingerprint(payload({ tools: [
      { parameters: { properties: { a: { type: "number" }, z: { type: "string" } }, type: "object" }, description: "ALPHA_SECRET", name: "alpha", type: "function" },
      { parameters: { required: ["value"], type: "object" }, name: "beta", type: "function" }
    ] }));
    assert.equal(left.state, "known");
    assert.equal(left.orderedToolSurfaceHash, right.orderedToolSurfaceHash);
    assert.equal(left.requestPrefixFingerprint, right.requestPrefixFingerprint);
  });

  it("detects exact instruction, ordered tool, effort, verbosity, and tool-choice changes", () => {
    const baseline = fingerprint();
    const instruction = fingerprint(payload({ instructions: "Changed instructions" }));
    const order = fingerprint(payload({ tools: [...payload().tools].reverse() }));
    const effort = fingerprint(payload({ reasoning: { effort: "medium" } }));
    const verbosity = fingerprint(payload({ text: { verbosity: "medium" } }));
    const choice = fingerprint(payload({ tool_choice: "required" }));
    assert.notEqual(baseline.instructionsHash, instruction.instructionsHash);
    assert.notEqual(baseline.orderedToolSurfaceHash, order.orderedToolSurfaceHash);
    for (const changed of [instruction, order, effort, verbosity, choice]) {
      assert.notEqual(baseline.requestPrefixFingerprint, changed.requestPrefixFingerprint);
    }
  });

  it("separates exact provider instructions from relocation-normalized host base instructions", () => {
    const leftCwd = "/tmp/benchmark/workspaces/01-case/project";
    const rightCwd = "/tmp/benchmark/workspaces/02-case/project";
    const leftRoot = "/tmp/piagent-benchmark-snapshot-a/candidate";
    const rightRoot = "/tmp/piagent-benchmark-snapshot-b/candidate";
    const instructions = (cwd, root, policy = "Keep changes scoped.", skillPath = "packages/piagent-core/skills/piagent-source-cache/SKILL.md") => [
      policy,
      `<project_context><project_instructions path="${cwd}/AGENTS.md">same</project_instructions></project_context>`,
      `<available_skills><skill><name>piagent-source-cache</name><description>same</description><location>${root}/${skillPath}</location></skill></available_skills>`,
      `Current working directory: ${cwd}`
    ].join("\n");
    const left = fingerprint(payload({ instructions: instructions(leftCwd, leftRoot) }), "openai-codex", "gpt-5.6-sol", leftCwd, leftRoot);
    const right = fingerprint(payload({ instructions: instructions(rightCwd, rightRoot) }), "openai-codex", "gpt-5.6-sol", rightCwd, rightRoot);
    assert.notEqual(left.instructionsHash, right.instructionsHash);
    assert.equal(left.baseInstructionsHash, right.baseInstructionsHash);
    assert.equal(left.instructionNormalization, "host-relocation-v1");
    assert.notEqual(
      left.baseInstructionsHash,
      fingerprint(payload({ instructions: instructions(rightCwd, rightRoot, "Changed policy.") }), "openai-codex", "gpt-5.6-sol", rightCwd, rightRoot).baseInstructionsHash
    );
    assert.notEqual(
      left.baseInstructionsHash,
      fingerprint(payload({ instructions: instructions(rightCwd, rightRoot, "Keep changes scoped.", "packages/piagent-core/skills/other/SKILL.md") }), "openai-codex", "gpt-5.6-sol", rightCwd, rightRoot).baseInstructionsHash
    );
  });

  it("does not normalize arbitrary working-directory text outside host-owned structures", () => {
    const cwd = "/tmp/workspace/project";
    const first = fingerprint(payload({ instructions: `Inspect literal ${cwd} inside this policy.\nCurrent working directory: ${cwd}` }), "openai-codex", "gpt-5.6-sol", cwd);
    const second = fingerprint(payload({ instructions: "Inspect literal <different> inside this policy.\nCurrent working directory: /tmp/other/project" }), "openai-codex", "gpt-5.6-sol", "/tmp/other/project");
    assert.notEqual(first.baseInstructionsHash, second.baseInstructionsHash);
  });

  it("normalizes native Windows host paths only in structural locations", () => {
    const leftCwd = "C:\\bench\\01\\project";
    const rightCwd = "D:\\bench\\02\\project";
    const leftRoot = "C:\\snapshots\\candidate-a";
    const rightRoot = "D:\\snapshots\\candidate-b";
    const instructions = (cwd, root) => [
      `<project_context><project_instructions path="${cwd}\\AGENTS.md">same</project_instructions></project_context>`,
      `<available_skills><skill><location>${root}\\packages\\piagent-core\\skills\\source-cache\\SKILL.md</location></skill></available_skills>`,
      `Current working directory: ${cwd.replace(/\\/g, "/")}`
    ].join("\n");
    const left = fingerprint(payload({ instructions: instructions(leftCwd, leftRoot) }), "openai-codex", "gpt-5.6-sol", leftCwd, leftRoot);
    const right = fingerprint(payload({ instructions: instructions(rightCwd, rightRoot) }), "openai-codex", "gpt-5.6-sol", rightCwd, rightRoot);
    assert.notEqual(left.instructionsHash, right.instructionsHash);
    assert.equal(left.baseInstructionsHash, right.baseInstructionsHash);
  });

  it("hashes ordered deferred tool batches without retaining transcript content", () => {
    const first = fingerprint(payload({ input: [
      { role: "user", content: "TRANSCRIPT_SECRET" },
      { type: "tool_search_output", call_id: "call-1", tools: [{ name: "late-a", parameters: { type: "object" } }] }
    ] }));
    const second = fingerprint(payload({ input: [
      { role: "user", content: "DIFFERENT_TRANSCRIPT_SECRET" },
      { type: "tool_search_output", call_id: "call-1", tools: [{ name: "late-b", parameters: { type: "object" } }] }
    ] }));
    assert.equal(first.deferredToolCount, 1);
    assert.equal(first.deferredToolBatchCount, 1);
    assert.notEqual(first.deferredToolSurfaceHash, second.deferredToolSurfaceHash);
    assert.notEqual(first.requestPrefixFingerprint, second.requestPrefixFingerprint);
    assert.doesNotMatch(JSON.stringify(first), /SECRET|late-a|Never expose|alpha|beta/);
  });

  it("fails closed and stays bounded for hostile provider surfaces", () => {
    const tooManyTools = fingerprint(payload({ tools: Array.from({ length: 513 }, () => ({ name: "x" })) }));
    assert.equal(tooManyTools.state, "unavailable");
    assert.equal(tooManyTools.reasonCode, "tools-too-large");
    const cyclic = {}; cyclic.self = cyclic;
    const cyclicResult = fingerprint(payload({ tools: [cyclic] }));
    assert.equal(cyclicResult.state, "unavailable");
    assert.equal(cyclicResult.reasonCode, "surface-cyclic");
    assert.equal(cyclicResult.requestPrefixFingerprint, null);
  });

  it("ignores other providers and mismatched model identities", () => {
    assert.equal(fingerprint(payload(), "anthropic").applicable, false);
    assert.equal(fingerprint(payload(), "openai-codex", "gpt-5.6-terra").applicable, false);
  });
});

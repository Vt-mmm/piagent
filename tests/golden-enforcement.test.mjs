import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateExecPolicyCore,
  extractShellGlobCandidates,
  findProtectedPathInCommand,
  matchesProtectedPath
} from "../packages/piagent-core/extensions/policy-core.js";
import { claimedExitMatchesObserved, commandMatchesVerifyPlan } from "../packages/piagent-core/extensions/runtime-evidence.js";
import { taskContractValidationErrors } from "../packages/piagent-core/extensions/task-state.js";
import { validateFailureClassification, validateFailureEvidence } from "../packages/piagent-core/extensions/failure-types.ts";
import { containsSensitiveText, redactSensitiveText } from "../packages/piagent-core/security/sensitive-data.js";
import {
  validateCapabilityPack,
  validateCapabilityRecipe,
  validateEvalScenario,
  validateExternalActionProposal
} from "../packages/piagent-core/capabilities/capability-core.js";
import { validateRuntimeModelSnapshot } from "../packages/piagent-core/runtime/model/runtime-snapshot.ts";
import { validateModelRouteDecision } from "../packages/piagent-core/runtime/model/model-route-types.ts";
import { validateSolverDecision, validateTaskFeatures } from "../packages/piagent-core/runtime/solver/solver-types.ts";
import { validateTrajectoryState, validateTrajectoryTransition } from "../packages/piagent-core/runtime/trajectory/trajectory-types.ts";
import { validateHelperRequest, validateRolePolicy } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { validateAuthorityManifest, validateTaskAuthoritySnapshot } from "../packages/piagent-core/runtime/policy/authority-manifest.ts";
import { benchmarkAssuranceEvidenceValidationErrors } from "../packages/piagent-core/benchmark/benchmark-assurance.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const golden = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "evals", "golden", "enforcement-decisions.json"), "utf8"));

// Cases run against the policy the platform actually ships. An earlier version
// of this file carried its own copy, which meant weakening the shipped policy
// left the suite green.
const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, golden.policySource), "utf8"));

// Some documents are time-bound on purpose: an action proposal is refused when
// it was created too far in the future or has already expired. A fixture with a
// hardcoded timestamp would pass today and fail tomorrow, so fixtures carry a
// placeholder and the run stamps it. The structure stays golden; only the clock
// moves.
const TIME_PLACEHOLDERS = {
  "{{now}}": () => new Date().toISOString(),
  "{{now+1h}}": () => new Date(Date.now() + 60 * 60 * 1000).toISOString()
};

function stampTimestamps(value) {
  if (typeof value === "string") return TIME_PLACEHOLDERS[value]?.() ?? value;
  if (Array.isArray(value)) return value.map(stampTimestamps);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stampTimestamps(entry)]));
  }
  return value;
}

function loadFixture(name) {
  return stampTimestamps(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "evals", "fixtures", name), "utf8")));
}

function validateTaskContract(input, sourceName) {
  const errors = taskContractValidationErrors(input);
  if (errors.length > 0) throw new Error(`${sourceName}: ${errors.join("; ")}`);
  return input;
}

function validateBenchmarkAssuranceEvidence(input, sourceName) {
  const errors = benchmarkAssuranceEvidenceValidationErrors(input);
  if (errors.length > 0) throw new Error(`${sourceName}: ${errors.join("; ")}`);
  return input;
}

function validateTaskAuthoritySnapshotFixture(input) {
  return validateTaskAuthoritySnapshot(input);
}

// These cases exist to make a refactor argue with the rule rather than with a
// recorded output, so each one is named by the invariant it protects. Cases
// that must be REFUSED matter more than cases that must be allowed: a
// regression that stops refusing looks exactly like a passing test suite.
describe("golden enforcement decisions", () => {
  describe("the shipped policy still declares the rules these cases rely on", () => {
    // Without this, deleting a rule from the policy would make its cases pass
    // vacuously instead of failing.
    for (const [key, required] of Object.entries(golden.requiredPolicyEntries)) {
      it(`base policy keeps every required ${key} entry`, () => {
        const actual = new Set(policy[key] ?? []);
        const missing = required.filter((entry) => !actual.has(entry));
        assert.deepEqual(missing, [], `base policy dropped ${key}: ${missing.join(", ")}`);
      });
    }
  });

  describe("protected paths", () => {
    for (const testCase of golden.protectedPathCases) {
      it(testCase.invariant, () => {
        assert.equal(Boolean(matchesProtectedPath(testCase.path, policy.protectedPaths)), testCase.expectProtected);
      });
    }
  });

  describe("protected paths reached through the shell", () => {
    // The guard reaches a decision from two extractors, not one: literal
    // operands and glob candidates. Checking only the literal path would let a
    // glob regression pass, so each case declares which mechanism must catch it.
    function detectedInCommand(command) {
      const literal = findProtectedPathInCommand(command, policy.shellProtectedPaths);
      if (literal) return { via: "literal", value: literal };
      for (const candidate of extractShellGlobCandidates(command)) {
        if (!/[*?{[]/.test(candidate)) continue;
        if (policy.shellProtectedPaths.some((pattern) => pattern.endsWith(candidate.replace(/^\*/, "")))) {
          return { via: "glob", value: candidate };
        }
      }
      return undefined;
    }

    for (const testCase of golden.shellCommandCases) {
      it(testCase.invariant, () => {
        const found = detectedInCommand(testCase.command);
        if (testCase.expectProtectedPath === null) {
          assert.equal(found, undefined, `expected no protected path, got ${JSON.stringify(found)}`);
          return;
        }
        assert.ok(found, `expected ${testCase.expectProtectedPath} to be detected in: ${testCase.command}`);
        assert.equal(found.via, testCase.via, "detection must come from the declared mechanism");
      });
    }
  });

  describe("destructive shell commands", () => {
    for (const testCase of golden.execDecisionCases) {
      it(testCase.invariant, () => {
        const result = evaluateExecPolicyCore(testCase.command, { policy });
        assert.equal(
          result.decision,
          testCase.expectDecision,
          `${testCase.command} -> ${result.decision} (reasons: ${result.reasons.join(" | ") || "none"})`
        );
        if (testCase.expectDecision !== "allow") {
          assert.ok(result.reasons.length > 0, "a gated command must say why it was gated");
        }
      });
    }
  });

  describe("verification evidence", () => {
    // The guard trusts a verification claim only when the command it observed is
    // the command the plan named. Loosening this to a substring or fuzzy match
    // would let an unrelated command pose as the verified one.
    for (const testCase of golden.verificationEvidenceCases) {
      it(testCase.invariant, () => {
        assert.equal(commandMatchesVerifyPlan(testCase.command, testCase.verifyCommands), testCase.expectMatch);
      });
    }

    for (const testCase of golden.exitCodeCases) {
      it(testCase.invariant, () => {
        assert.equal(
          claimedExitMatchesObserved(testCase.claimedExitCode ?? undefined, testCase.observed),
          testCase.expectMatch
        );
      });
    }
  });

  describe("context budget", () => {
    // Ceilings, not exact values: raising a limit silently is the regression
    // worth catching, while lowering one is a deliberate tightening.
    for (const testCase of golden.contextBudgetCases) {
      it(testCase.invariant, () => {
        const actual = policy.contextBudget?.[testCase.key];
        assert.equal(typeof actual, "number", `contextBudget.${testCase.key} must stay declared`);
        assert.ok(actual <= testCase.maximum, `contextBudget.${testCase.key} rose to ${actual}, above ${testCase.maximum}`);
      });
    }
  });

  describe("secret redaction", () => {
    for (const testCase of golden.redactionCases) {
      it(testCase.invariant, () => {
        assert.equal(containsSensitiveText(testCase.text), testCase.expectRedacted);
        const { text, redacted } = redactSensitiveText(testCase.text);
        assert.equal(redacted, testCase.expectRedacted);
        if (testCase.expectRedacted) {
          assert.notEqual(text, testCase.text, "sensitive text must not survive redaction unchanged");
        } else {
          assert.equal(text, testCase.text, "ordinary text must pass through untouched");
        }
      });
    }
  });

  describe("schema fixtures", () => {
    // Only the accepting half is cheap to get right. The rejecting half is what
    // actually matters: a validator that quietly stops refusing bad input reads
    // as a green suite.
    const validators = {
      "capability-pack": validateCapabilityPack,
      "capability-recipe": validateCapabilityRecipe,
      "eval-scenario": validateEvalScenario,
      "action-proposal": validateExternalActionProposal,
      "task-contract": validateTaskContract,
      "runtime-model-snapshot": validateRuntimeModelSnapshot,
      "model-route-decision": validateModelRouteDecision,
      "task-features": validateTaskFeatures,
      "solver-decision": validateSolverDecision,
      "trajectory-state": validateTrajectoryState,
      "trajectory-transition-event": validateTrajectoryTransition,
      "failure-evidence": validateFailureEvidence,
      "failure-classification": validateFailureClassification,
      "role-policy": validateRolePolicy,
      "helper-request": validateHelperRequest,
      "authority-manifest": validateAuthorityManifest,
      "task-authority-snapshot": validateTaskAuthoritySnapshotFixture,
      "benchmark-assurance-evidence": validateBenchmarkAssuranceEvidence
    };

    for (const [name, validate] of Object.entries(validators)) {
      it(`accepts a valid ${name}`, () => {
        assert.doesNotThrow(() => validate(loadFixture(`${name}.valid.json`), `${name}.valid.json`));
      });

      it(`refuses an invalid ${name}`, () => {
        assert.throws(() => validate(loadFixture(`${name}.invalid.json`), `${name}.invalid.json`));
      });
    }
  });

  it("covers every schema the repository ships", () => {
    // A schema with no fixture is a contract nothing checks. This fails when a
    // schema is added without one, which is the moment it is cheapest to write.
    const schemaDir = path.join(repositoryRoot, "schemas");
    const fixtureDir = path.join(repositoryRoot, "evals", "fixtures");
    const schemas = fs.readdirSync(schemaDir)
      .filter((name) => name.endsWith(".schema.json"))
      .map((name) => name.replace(".schema.json", ""));
    const covered = fs.existsSync(fixtureDir)
      ? new Set(fs.readdirSync(fixtureDir).map((name) => name.replace(/\.(valid|invalid)\.json$/, "")))
      : new Set();
    const missing = schemas.filter((name) => !covered.has(name));
    assert.deepEqual(missing, [], `schemas without a fixture: ${missing.join(", ")}`);
  });
});

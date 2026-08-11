import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { modelRouteCorpusValidationErrors, validateModelRouteCorpus } from "../packages/piagent-core/benchmark/model-route-grader.ts";
import { evaluateModelRouteCorpus } from "../scripts/model-route-evaluation-core.ts";

const corpusPath = path.resolve("benchmarks/model-routing-v1/route-corpus.json");
const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

describe("model routing G0 corpus", () => {
  it("pins 24 task templates, ten policy/catalog variants, splits, and Vietnamese coverage", () => {
    const value = validateModelRouteCorpus(corpus);
    assert.equal(value.templates.length, 24);
    assert.equal(value.variants.length, 10);
    assert.equal(value.templates.length * value.variants.length, 240);
    assert.ok(value.templates.filter((item) => item.locale === "vi").length >= 6);
    assert.deepEqual(modelRouteCorpusValidationErrors(corpus), []);
  });

  it("passes every deterministic, safety, provenance, catalog, and privacy gate", () => {
    const report = evaluateModelRouteCorpus(corpus);
    assert.equal(report.sample.records, 240);
    assert.deepEqual(Object.entries(report.gates).filter(([, passed]) => !passed), []);
    assert.equal(report.violations.length, 0);
    assert.equal(report.metrics.highRiskFalseLow, 0);
    assert.equal(report.metrics.explicitPinViolations, 0);
    assert.equal(report.metrics.silentSubstitutions, 0);
    assert.equal(report.metrics.rawPromptFindings, 0);
  });

  it("rejects corpus labels that are missing or can leak raw execution prompts", () => {
    assert.match(modelRouteCorpusValidationErrors({ ...corpus, templates: corpus.templates.slice(1) }).join("; "), /24 task families/);
    assert.match(modelRouteCorpusValidationErrors({ ...corpus, variants: corpus.variants.slice(1) }).join("; "), /10 policy/);
  });
});

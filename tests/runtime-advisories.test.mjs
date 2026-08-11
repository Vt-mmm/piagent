import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repositoryRoot, "scripts", "check-runtime-advisories.mjs");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

function report({ vulnerabilities = {}, auditReportVersion = 2, counts = {} } = {}) {
  return JSON.stringify({
    auditReportVersion,
    vulnerabilities,
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0, ...counts } }
  });
}

function advisory(name, severity, id) {
  return {
    [name]: {
      name,
      severity,
      via: [{ source: 1, name, title: `${name}: something`, url: `https://github.com/advisories/${id}`, severity }]
    }
  };
}

function run(input) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], { input, encoding: "utf8" });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

describe("runtime advisory policy", () => {
  it("has no advisory allowlist and passes a clean supported runtime", () => {
    assert.match(scriptSource, /deliberately no advisory allowlist/);
    assert.doesNotMatch(scriptSource, /const ACCEPTED|reviewBy:/);
    const result = run(report());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  });

  it("fails on a high advisory", () => {
    const result = run(report({
      vulnerabilities: advisory("some-package", "high", "GHSA-aaaa-bbbb-cccc"),
      counts: { high: 1, total: 1 }
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GHSA-aaaa-bbbb-cccc/);
  });

  it("fails on a critical advisory", () => {
    const result = run(report({
      vulnerabilities: advisory("scary", "critical", "GHSA-dddd-eeee-ffff"),
      counts: { critical: 1, total: 1 }
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GHSA-dddd-eeee-ffff/);
  });

  it("fails on a blocking advisory that carries no advisory id", () => {
    const result = run(report({
      vulnerabilities: {
        mystery: { name: "mystery", severity: "high", via: ["something"] }
      },
      counts: { high: 1, total: 1 }
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no advisory id/);
  });

  it("fails on a moderate advisory", () => {
    const result = run(report({
      vulnerabilities: advisory("noisy", "moderate", "GHSA-1111-2222-3333"),
      counts: { moderate: 1, total: 1 }
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GHSA-1111-2222-3333/);
  });

  it("refuses an audit report shape it does not understand", () => {
    // Reading an unknown shape would report a clean tree because it looked in
    // the wrong place.
    assert.equal(run(report({ auditReportVersion: 3 })).code, 1);
    assert.equal(run("not json").code, 1);
  });

  it("ignores informational and low findings", () => {
    const result = run(report({
      vulnerabilities: {
        ...advisory("informational", "info", "GHSA-1111-aaaa-bbbb"),
        ...advisory("low-risk", "low", "GHSA-2222-aaaa-bbbb")
      },
      counts: { info: 1, low: 1, total: 2 }
    }));
    assert.equal(result.code, 0, result.stderr);
  });
});

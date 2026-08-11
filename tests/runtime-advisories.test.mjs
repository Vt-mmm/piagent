import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repositoryRoot, "scripts", "check-runtime-advisories.mjs");
const scriptSource = fs.readFileSync(scriptPath, "utf8");

// The advisory this project currently accepts, read from the script so the
// tests cannot drift from it.
const ACCEPTED_ID = scriptSource.match(/id: "(GHSA-[a-z0-9-]+)"/i)?.[1];
const ACCEPTED_PACKAGE = scriptSource.match(/package: "([^"]+)"/)?.[1];

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
  it("names exactly one accepted advisory", () => {
    // A growing allowlist is how a gate stops meaning anything. If this number
    // has to change, that is a decision worth making deliberately.
    const accepted = scriptSource.match(/id: "GHSA-/gi) ?? [];
    assert.equal(accepted.length, 1, "the accepted list should stay at one entry");
    assert.ok(ACCEPTED_ID, "the accepted advisory must have an id");
    assert.ok(ACCEPTED_PACKAGE, "the accepted advisory must name its package");
  });

  it("records why the advisory is accepted and when to look again", () => {
    // Without both, the entry becomes folklore.
    assert.match(scriptSource, /reviewBy: "\d{4}-\d{2}-\d{2}"/);
    assert.match(scriptSource, /reason:/);
  });

  it("passes when the only blocking advisory is the accepted one", () => {
    const result = run(report({
      vulnerabilities: advisory(ACCEPTED_PACKAGE, "high", ACCEPTED_ID),
      counts: { high: 1, total: 1 }
    }));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /PASS/);
  });

  it("fails on a different high advisory", () => {
    // This is the whole point of accepting one advisory rather than lowering
    // the severity threshold.
    const result = run(report({
      vulnerabilities: {
        ...advisory(ACCEPTED_PACKAGE, "high", ACCEPTED_ID),
        ...advisory("some-other-package", "high", "GHSA-aaaa-bbbb-cccc")
      },
      counts: { high: 2, total: 2 }
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GHSA-aaaa-bbbb-cccc/);
  });

  it("fails on a critical advisory", () => {
    const result = run(report({
      vulnerabilities: {
        ...advisory(ACCEPTED_PACKAGE, "high", ACCEPTED_ID),
        ...advisory("scary", "critical", "GHSA-dddd-eeee-ffff")
      },
      counts: { high: 1, critical: 1, total: 2 }
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /GHSA-dddd-eeee-ffff/);
  });

  it("fails when the accepted advisory is fixed upstream", () => {
    // The self-expiry that keeps this from becoming permanent: once the finding
    // is gone, the entry has to go too.
    const result = run(report({ vulnerabilities: {}, counts: {} }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no longer reported/);
    assert.match(result.stderr, new RegExp(ACCEPTED_ID));
  });

  it("fails once the review date has passed", () => {
    const expired = scriptSource.replace(/reviewBy: "\d{4}-\d{2}-\d{2}"/, 'reviewBy: "2000-01-01"');
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-advisory-"));
    const temporaryScript = path.join(temporaryRoot, "check-runtime-advisories.expiry-test.mjs");
    fs.writeFileSync(temporaryScript, expired);
    try {
      const input = report({
        vulnerabilities: advisory(ACCEPTED_PACKAGE, "high", ACCEPTED_ID),
        counts: { high: 1, total: 1 }
      });
      let code = 0;
      let stderr = "";
      try {
        execFileSync(process.execPath, [temporaryScript], { input, encoding: "utf8" });
      } catch (error) {
        code = error.status ?? 1;
        stderr = error.stderr ?? "";
      }
      assert.equal(code, 1);
      assert.match(stderr, /review date/);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails on a blocking advisory that carries no advisory id", () => {
    // An unidentifiable finding cannot be matched against the accepted list, so
    // it must block rather than slip through unmatched.
    const result = run(report({
      vulnerabilities: {
        ...advisory(ACCEPTED_PACKAGE, "high", ACCEPTED_ID),
        mystery: { name: "mystery", severity: "high", via: ["something"] }
      },
      counts: { high: 2, total: 2 }
    }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /no advisory id/);
  });

  it("fails on a moderate advisory", () => {
    const result = run(report({
      vulnerabilities: {
        ...advisory(ACCEPTED_PACKAGE, "high", ACCEPTED_ID),
        ...advisory("noisy", "moderate", "GHSA-1111-2222-3333")
      },
      counts: { high: 1, moderate: 1, total: 2 }
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

  it("does not accept the advisory for a package it was not filed against", () => {
    const result = run(report({
      vulnerabilities: advisory("unrelated-package", "high", ACCEPTED_ID),
      counts: { high: 1, total: 1 }
    }));
    assert.equal(result.code, 1);
  });
});

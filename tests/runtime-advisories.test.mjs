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

function run(input, today) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], { input, encoding: "utf8",
      env: { ...process.env, ...(today ? { PIAGENT_ADVISORY_TODAY: today } : {}) } });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

describe("runtime advisory policy", () => {
  it("passes a clean supported runtime", () => {
    const result = run(report());
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /PASS: no moderate, high, or critical advisory/);
  });

  // Exceptions are owner decisions, never open-ended: each names one advisory,
  // the one package path it may appear at, why, and an end at most 60 days
  // after the decision. Adding one changes the gate as much as editing it.
  it("lists only exceptions with one advisory, one path, a reason and an end within 60 days", () => {
    const { version, exceptions } = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "scripts", "runtime-advisory-exceptions.json"), "utf8"));
    assert.equal(version, 1);
    assert.match(scriptSource, /runtime-advisory-exceptions\.json/);
    for (const entry of exceptions) {
      assert.deepEqual(Object.keys(entry).sort(), ["decided", "id", "node", "package", "reason", "until"], entry.id);
      assert.match(entry.id, /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
      assert.ok(entry.node.endsWith(`node_modules/${entry.package}`), entry.id);
      assert.ok(entry.reason.length >= 40, entry.id);
      const days = (Date.parse(entry.until) - Date.parse(entry.decided)) / 86_400_000;
      assert.ok(days >= 0 && days <= 60, `${entry.id} lasts ${days} days`);
    }
  });

  const pinned = "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion";
  const braceExpansion = (nodes, id = "GHSA-qhr7-859c-m2p7") => ({ "brace-expansion": { ...advisory("brace-expansion", "high", id)["brace-expansion"], nodes } });

  it("accepts a listed advisory only at its path and only until its end day", () => {
    const accepted = run(report({ vulnerabilities: braceExpansion([pinned]), counts: { high: 1, total: 1 } }), "2026-10-15");
    assert.equal(accepted.code, 0, accepted.stderr);
    assert.match(accepted.stdout, /ACCEPTED: high advisory GHSA-qhr7-859c-m2p7 in brace-expansion at .*pi-coding-agent.* until 2026-10-31/);

    const elsewhere = run(report({ vulnerabilities: braceExpansion(["node_modules/brace-expansion"]), counts: { high: 1, total: 1 } }), "2026-10-15");
    assert.equal(elsewhere.code, 1, "the same advisory at another path blocks");
    const alsoElsewhere = run(report({ vulnerabilities: braceExpansion([pinned, "node_modules/brace-expansion"]), counts: { high: 1, total: 1 } }), "2026-10-15");
    assert.equal(alsoElsewhere.code, 1, "an extra copy at another path blocks");

    const expired = run(report({ vulnerabilities: braceExpansion([pinned]), counts: { high: 1, total: 1 } }), "2026-11-01");
    assert.equal(expired.code, 1);
    assert.match(expired.stderr, /GHSA-qhr7-859c-m2p7 .*exception ended 2026-10-31/);

    const other = run(report({ vulnerabilities: braceExpansion([pinned], "GHSA-9999-8888-7777"), counts: { high: 1, total: 1 } }), "2026-10-15");
    assert.equal(other.code, 1, "another advisory in the same package blocks");
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

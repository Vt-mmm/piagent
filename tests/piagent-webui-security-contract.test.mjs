import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const contractPath = path.join(root, "governance/piagent-webui/security-contract.v1.json");
const modelPath = path.join(root, "governance/piagent-webui/20-security-threat-model.md");
const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const model = fs.readFileSync(modelPath, "utf8");

function uniqueIds(records, label) {
  const ids = records.map((record) => record.id);
  assert.equal(new Set(ids).size, ids.length, `${label} IDs must be unique`);
  for (const id of ids) assert.match(id, /^[A-Z]+-[A-Z0-9-]+$/);
  return new Set(ids);
}

describe("Piagent WebUI security contract", () => {
  it("keeps Pi and the guard authoritative and disables remote or second-runtime fallback", () => {
    assert.equal(contract.version, "piagent-webui-security-contract-v1");
    assert.equal(contract.status, "frozen");
    assert.deepEqual(contract.authority, {
      sessionWriter: "one-pi-runtime-per-session-owner-epoch",
      actionExecutor: "pi-guard",
      webuiRole: "gateway-supervisor-or-terminal-adapter-and-typed-intent",
      secondRuntimeAllowed: false,
      gatewayOwnedRuntimeAllowed: true,
      terminalOwnedRuntimeProxyOnly: true,
      remoteAccessAllowed: false
    });
  });

  it("freezes loopback, bootstrap, browser-content and filesystem fail-closed defaults", () => {
    assert.deepEqual(contract.network.bindAddresses, ["127.0.0.1"]);
    assert.equal(contract.network.port, "ephemeral");
    assert.equal(contract.network.hostValidation, "exact");
    assert.equal(contract.network.originValidation, "exact");
    assert.equal(contract.network.wildcardCorsAllowed, false);
    assert.equal(contract.network.lanBindAllowed, false);
    assert.equal(contract.bootstrap.capabilityEntropyBits, 256);
    assert.equal(contract.bootstrap.transport, "url-fragment");
    assert.equal(contract.bootstrap.exchange, "one-time");
    assert.deepEqual(contract.bootstrap.cookie, { httpOnly: true, sameSite: "Strict", secureWhenApplicable: true });
    assert.equal(contract.bootstrap.restartInvalidatesBrowserAuthority, true);
    assert.equal(contract.bootstrap.logsMayContainCapability, false);
    assert.equal(contract.content.repositoryTextIsHostile, true);
    assert.equal(contract.content.renderMode, "text-only");
    assert.equal(contract.content.remoteAssetsAllowed, false);
    assert.equal(contract.content.serviceWorkerAllowed, false);
    assert.equal(contract.content.evalAllowed, false);
    assert.deepEqual(contract.content.csp["object-src"], ["'none'"]);
    assert.deepEqual(contract.content.csp["base-uri"], ["'none'"]);
    assert.deepEqual(contract.content.csp["frame-ancestors"], ["'none'"]);
    assert.equal(contract.filesystem.browserPathAuthority, "opaque-refs-only");
    assert.equal(contract.filesystem.absolutePathInputAllowed, false);
    assert.equal(contract.filesystem.symlinkEscapeBehavior, "fail-closed");
    assert.equal(contract.filesystem.protectedPolicyRequired, true);
  });

  it("links every threat, control, asset and boundary without dangling authority", () => {
    const assets = uniqueIds(contract.assets, "asset");
    const boundaries = uniqueIds(contract.boundaries, "boundary");
    const controls = uniqueIds(contract.controls, "control");
    uniqueIds(contract.threats, "threat");
    for (const control of contract.controls) {
      assert.match(control.milestone, /^WUI[0-5]-\d{2}$/);
      assert.ok(control.requirement.length >= 40);
      assert.ok(control.verification.length >= 2);
      assert.equal(new Set(control.verification).size, control.verification.length);
      for (const boundary of control.boundaries) assert.ok(boundaries.has(boundary), `${control.id} has unknown boundary ${boundary}`);
    }
    for (const threat of contract.threats) {
      assert.ok(["critical", "high", "medium", "low"].includes(threat.severity));
      assert.equal(threat.releaseBlocking, true);
      assert.ok(threat.attack.length >= 30);
      assert.ok(threat.residualRisk.length >= 30);
      assert.ok(threat.controls.length >= 2);
      for (const asset of threat.assets) assert.ok(assets.has(asset), `${threat.id} has unknown asset ${asset}`);
      for (const boundary of threat.boundaries) assert.ok(boundaries.has(boundary), `${threat.id} has unknown boundary ${boundary}`);
      for (const control of threat.controls) assert.ok(controls.has(control), `${threat.id} has unknown control ${control}`);
    }
    for (const asset of assets) assert.ok(contract.threats.some((threat) => threat.assets.includes(asset)), `${asset} has no threat`);
    for (const boundary of boundaries) assert.ok(contract.controls.some((control) => control.boundaries.includes(boundary)), `${boundary} has no control`);
  });

  it("covers every critical local-WebUI release blocker", () => {
    const severity = new Map(contract.threats.map((threat) => [threat.id, threat.severity]));
    for (const id of ["T-NET-UNAUDITED", "T-NET-REBIND", "T-XSS-APPROVAL", "T-SECOND-WRITER", "T-GUARD-BYPASS", "T-IDENTITY-MIXUP", "T-SIDECAR-FAILURE", "T-GATEWAY-DUPLICATE", "T-STALE-OWNER-STEAL", "T-HANDOFF-RACE", "T-ADMISSION-REPLAY"]) {
      assert.equal(severity.get(id), "critical", `${id} must remain a critical release blocker`);
    }
    const controlIds = new Set(contract.controls.map((control) => control.id));
    for (const id of ["C-NET-LOOPBACK", "C-NET-ORIGIN", "C-AUTH-BOOTSTRAP", "C-CONTENT-CSP", "C-CONTENT-TEXT", "C-SINGLE-WRITER", "C-GUARD-SOLE-EXECUTOR", "C-IDENTITY-BIND", "C-APPROVAL-CAS", "C-FAILURE-ISOLATION"]) {
      assert.ok(controlIds.has(id), `${id} must remain explicit`);
    }
  });

  it("keeps the human-readable threat model synchronized with machine-readable IDs", () => {
    for (const group of [contract.assets, contract.boundaries, contract.controls, contract.threats]) {
      for (const record of group) assert.match(model, new RegExp(`\\b${record.id}\\b`), `${record.id} missing from threat model`);
    }
    assert.match(model, /WEBUI-1[^\n]*không có mutation route/);
    assert.match(model, /không phải OS sandbox/i);
    assert.match(model, /Pi guard[^\n]*sole executor/i);
    assert.match(model, /same-process bridge/i);
  });
});

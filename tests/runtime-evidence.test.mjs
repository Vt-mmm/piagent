import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  appendObservedBashResult,
  claimedExitMatchesObserved,
  commandMatchesVerifyPlan,
  createBashResultLedger,
  findMatchingObservedBashResult,
  normalizeEvidenceCommand,
  observedBashResultFromToolResultEvent,
  readObservedBashResults
} from "../packages/piagent-core/extensions/runtime-evidence.js";

const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-ledger-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createLedgerFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ledger-"));
  temporaryRoots.add(root);
  return {
    root,
    file: path.join(root, "observed-bash.jsonl")
  };
}

describe("runtime verify evidence ledger", () => {
  const joined = (...parts) => parts.join("");

  it("normalizes command edges but preserves command identity", () => {
    assert.equal(normalizeEvidenceCommand(" npm test \r\n"), "npm test");
    assert.notEqual(normalizeEvidenceCommand("npm  test"), "npm test");
  });

  it("rejects forged verify records without a matching observed bash result", () => {
    const ledger = createBashResultLedger();
    ledger.record({
      cwd: "/repo",
      command: "echo ok",
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    const result = ledger.findMatching({
      cwd: "/repo",
      command: "npm test",
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /No matching bash tool_result/);
  });

  it("accepts a matching passing bash result after task start", () => {
    const ledger = createBashResultLedger();
    ledger.record({
      cwd: "/repo",
      command: "npm test",
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    const result = ledger.findMatching({
      cwd: "/repo",
      command: " npm test ",
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, true);
    assert.equal(result.entry.command, "npm test");
  });

  it("rejects observations from before task start", () => {
    const ledger = createBashResultLedger();
    ledger.record({
      cwd: "/repo",
      command: "npm test",
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T00:59:59.000Z")
    });

    const result = ledger.findMatching({
      cwd: "/repo",
      command: "npm test",
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, false);
  });

  it("rejects claimed pass when Pi observed a bash error", () => {
    const ledger = createBashResultLedger();
    ledger.record({
      cwd: "/repo",
      command: "npm test",
      isError: true,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    const result = ledger.findMatching({
      cwd: "/repo",
      command: "npm test",
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, false);
    assert.match(result.reason, /status does not match/);
  });

  it("accepts claimed failure when Pi observed a bash error", () => {
    assert.equal(claimedExitMatchesObserved(1, { isError: true }), true);
    assert.equal(claimedExitMatchesObserved(0, { isError: true }), false);
    assert.equal(claimedExitMatchesObserved(0, { isError: false }), true);
  });

  it("extracts observed bash result from Pi tool_result shape", () => {
    const observed = observedBashResultFromToolResultEvent({
      toolName: "bash",
      input: { command: "npm test" },
      isError: false,
      timestamp: "2026-07-19T01:00:01.000Z"
    }, "/repo");

    assert.equal(observed.normalizedCommand, "npm test");
    assert.equal(observed.cwd, "/repo");
    assert.equal(observed.recordedAt, "2026-07-19T01:00:01.000Z");
  });

  it("matches verify evidence written by another process through persisted JSONL", () => {
    const { file } = createLedgerFixture();

    appendObservedBashResult(file, {
      cwd: "/repo",
      command: "npm test",
      redactedCommand: "npm test",
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    const parentProcessLedger = createBashResultLedger();
    const result = findMatchingObservedBashResult([
      ...readObservedBashResults(file),
      ...parentProcessLedger.list()
    ], {
      cwd: "/repo",
      command: "npm test",
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, true);
    assert.equal(result.entry.cwd, "/repo");
  });

  it("does not evict persisted evidence after more than 300 later bash results", () => {
    const { file } = createLedgerFixture();

    appendObservedBashResult(file, {
      cwd: "/repo",
      command: "npm test",
      redactedCommand: "npm test",
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    for (let index = 0; index < 350; index += 1) {
      appendObservedBashResult(file, {
        cwd: "/repo",
        command: `echo ${index}`,
        redactedCommand: `echo ${index}`,
        isError: false,
        recordedAtMs: Date.parse("2026-07-19T01:00:02.000Z") + index
      });
    }

    const result = findMatchingObservedBashResult(readObservedBashResults(file, { maxEntries: 1000 }), {
      cwd: "/repo",
      command: "npm test",
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, true);
  });

  it("persists command hashes while keeping redacted command text for audit", () => {
    const { file } = createLedgerFixture();

    appendObservedBashResult(file, {
      cwd: "/repo",
      command: "npm run verify",
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    const raw = fs.readFileSync(file, "utf8");
    assert.match(raw, /commandHash/);

    const result = findMatchingObservedBashResult(readObservedBashResults(file), {
      cwd: "/repo",
      command: "npm run verify",
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, true);
  });

  // The digest is a content identifier, never a credential check: whatever the
  // ledger holds, the digest beside it is recomputable from the record's own text,
  // so it discloses nothing the file does not already print. A command whose text
  // had to be redacted carries no digest at all.
  it("never stores a digest that the record itself cannot reproduce", () => {
    const { file } = createLedgerFixture();
    const commands = [
      "  npm run verify  ",
      "npm test\r\nsecond line",
      joined("DATABASE", "_PASSWORD", "=", "CorrectHorse42", " npm test"),
      joined("TOKEN", "=", "hunter2", " npm test")
    ];
    for (const command of commands) {
      appendObservedBashResult(file, { cwd: "/repo", command, isError: false, recordedAtMs: 1 });
    }

    const stored = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(stored.length, commands.length);
    for (const record of stored) {
      const derived = record.commandHash === ""
        ? ""
        : crypto.createHash("sha256").update(normalizeEvidenceCommand(record.command)).digest("hex");
      assert.equal(derived, record.commandHash, `digest for ${JSON.stringify(record.command)} must follow from the record`);
    }
    assert.equal(stored.filter((record) => record.commandHash === "").length, 2, "both secret-bearing commands must carry no digest");
  });

  // The gate promises the observed command matches the plan's verify command
  // exactly. A digest over redacted text gives every secret the same identity, so
  // a run against one database would satisfy a claim about another.
  it("refuses to treat two commands differing only in a secret as the same evidence", () => {
    const { file } = createLedgerFixture();
    const observedCommand = joined("DATABASE", "_PASSWORD", "=", "CorrectHorse42", " npm test");
    const claimedCommand = joined("DATABASE", "_PASSWORD", "=", "DifferentHorse99", " npm test");

    appendObservedBashResult(file, {
      cwd: "/repo",
      command: observedCommand,
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    const result = findMatchingObservedBashResult(readObservedBashResults(file), {
      cwd: "/repo",
      command: claimedCommand,
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });

    assert.equal(result.ok, false, "a different secret must not satisfy the claim");
  });

  // Redacting the text and hashing the raw line publishes the template and a
  // way to confirm guesses against it, so the only unknown left is the secret
  // and SHA-256 is fast enough to walk a candidate list offline. A command whose
  // text had to be redacted gets no digest, and so cannot be evidence at all.
  it("does not store a hash that confirms guesses at the redacted secret", () => {
    const { file } = createLedgerFixture();
    const secret = "CorrectHorse42";
    const rawCommand = joined("DATABASE", "_PASSWORD", "=", secret, " npm test");

    appendObservedBashResult(file, {
      cwd: "/repo",
      command: rawCommand,
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    const stored = JSON.parse(fs.readFileSync(file, "utf8").trim());
    assert.equal(stored.command.includes(secret), false, "the secret must not reach the file");
    assert.equal(stored.commandHash, "", "a secret-bearing command must carry no digest");

    for (const guess of ["hunter2", secret, "password1"]) {
      const candidate = joined("DATABASE", "_PASSWORD", "=", guess, " npm test");
      const digest = crypto.createHash("sha256").update(candidate).digest("hex");
      assert.notEqual(digest, stored.commandHash, `hashing the raw command with ${guess} must not match the stored digest`);
    }

    // Even the true command cannot claim this observation: with no identity to
    // compare, the gate fails closed rather than accepting a looser match.
    const result = findMatchingObservedBashResult(readObservedBashResults(file), {
      cwd: "/repo",
      command: rawCommand,
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /carries a secret/);
  });

  it("redacts command text at the in-memory and persistence boundaries", () => {
    const { file } = createLedgerFixture();
    const rawCommand = joined("DATABASE", "_PASSWORD", "=", "CorrectHorse42", " npm test");
    const ledger = createBashResultLedger();

    ledger.record({
      cwd: "/repo",
      command: rawCommand,
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });
    appendObservedBashResult(file, {
      cwd: "/repo",
      command: rawCommand,
      isError: false,
      recordedAtMs: Date.parse("2026-07-19T01:00:01.000Z")
    });

    assert.equal(JSON.stringify(ledger.list()).includes("CorrectHorse42"), false);
    assert.equal(fs.readFileSync(file, "utf8").includes("CorrectHorse42"), false);

    // The observation is still kept for audit at both boundaries, and neither
    // will let it stand as proof.
    assert.equal(ledger.list().length, 1);
    assert.equal(readObservedBashResults(file).length, 1);
    assert.equal(ledger.findMatching({
      cwd: "/repo",
      command: rawCommand,
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    }).ok, false);
    assert.equal(findMatchingObservedBashResult(readObservedBashResults(file), {
      cwd: "/repo",
      command: rawCommand,
      notBefore: "2026-07-19T01:00:00.000Z",
      exitCode: 0
    }).ok, false);

    // A command with nothing to redact still matches at both boundaries.
    ledger.record({ cwd: "/repo", command: "npm test", isError: false, recordedAtMs: Date.parse("2026-07-19T01:00:02.000Z") });
    appendObservedBashResult(file, { cwd: "/repo", command: "npm test", isError: false, recordedAtMs: Date.parse("2026-07-19T01:00:02.000Z") });
    const plain = { cwd: "/repo", command: "npm test", notBefore: "2026-07-19T01:00:00.000Z", exitCode: 0 };
    assert.equal(ledger.findMatching(plain).ok, true);
    assert.equal(findMatchingObservedBashResult(readObservedBashResults(file), plain).ok, true);
  });

  it("requires exact verify-plan command match for final-gate evidence", () => {
    const verifyCommands = ["npm test", "npm run lint"];

    assert.equal(commandMatchesVerifyPlan(" npm test ", verifyCommands), true);
    assert.equal(commandMatchesVerifyPlan("npm  test", verifyCommands), false);
    assert.equal(commandMatchesVerifyPlan("npm test || true", verifyCommands), false);
    assert.equal(commandMatchesVerifyPlan("true", verifyCommands), false);
    assert.equal(commandMatchesVerifyPlan("echo ok", verifyCommands), false);
  });
});

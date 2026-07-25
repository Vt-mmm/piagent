import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { judge } from "../scripts/check-published-site.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "check-published-site.mjs");
const hosts = ["example.test", "www.example.test"];

function verdict(result, { host = "example.test", expect = "1.0.2", family = 4 } = {}) {
  return judge(host, hosts, expect, result, family);
}

describe("published site check", () => {
  it("accepts an address that serves the released version", () => {
    assert.equal(verdict({ status: 200, body: "<p>version 1.0.2</p>" }), null);
  });

  it("rejects a page that answers but does not carry the released version", () => {
    const result = verdict({ status: 200, body: "<p>version 1.0.1</p>" });
    assert.match(result, /does not mention 1\.0\.2/);
  });

  // The outage this check exists for: an address that answers a request for the
  // host by pointing at the same host. Following it only re-resolves the name,
  // so it reads as healthy from a browser while looping for whoever lands there.
  it("rejects an address that redirects to its own host", () => {
    for (const location of ["https://example.test/", "/", "//example.test/"]) {
      const result = verdict({ status: 308, location });
      assert.match(result, /redirecting to itself/, `Location ${location} should read as a loop`);
    }
  });

  it("accepts a redirect that moves between the checked hosts", () => {
    assert.equal(verdict({ status: 308, location: "https://example.test/" }, { host: "www.example.test" }), null);
  });

  it("rejects a redirect that leaves the site", () => {
    const result = verdict({ status: 302, location: "https://elsewhere.test/" });
    assert.match(result, /redirecting off the site/);
  });

  it("rejects a bad gateway and an unreadable redirect target", () => {
    assert.match(verdict({ status: 502, body: "" }), /HTTP 502/);
    assert.match(verdict({ status: 301, location: "http://[" }), /unreadable Location/);
  });

  // A machine with no route to an address family knows nothing about those
  // addresses. Reporting that as a site failure would make the gate lie in the
  // direction that gets it ignored.
  it("separates an unroutable address family from a site failure", () => {
    for (const code of ["ENETUNREACH", "EHOSTUNREACH"]) {
      const result = verdict({ error: "connect failed", code }, { family: 6 });
      assert.equal(typeof result?.unverified, "string");
      assert.match(result.unverified, /no route from this machine to IPv6/);
    }
  });

  it("still fails an address that is reachable but does not answer", () => {
    const result = verdict({ error: "no response within 15000ms" });
    assert.equal(typeof result, "string");
    assert.match(result, /unreachable/);
  });

  it("has side-effect-free help and rejects malformed arguments", () => {
    const help = spawnSync(process.execPath, [script, "--help"], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);

    for (const argv of [["--host"], ["--expect"], ["--nope"], ["--host", "not a host"], ["--expect", "a", "--expect", "b"]]) {
      const result = spawnSync(process.execPath, [script, ...argv], { cwd: repositoryRoot, encoding: "utf8" });
      assert.equal(result.status, 1, `${argv.join(" ")} should be rejected`);
      assert.match(result.stderr, /^FAIL:/);
    }
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { judge, request, summarize } from "../scripts/check-published-site.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "check-published-site.mjs");
const hosts = ["example.test", "www.example.test"];

function verdict(result, { host = "example.test", expect = "1.0.2", family = 4 } = {}) {
  return judge(host, hosts, expect, result, family);
}

const TIMED_OUT = Symbol("timed out");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

function withTimeout(promise, ms) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// A self-signed certificate handed to the client as a trust anchor, so the
// request runs through real TLS verification rather than switching it off.
function selfSignedCertificate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-site-check-"));
  temporaryRoots.add(root);
  const key = path.join(root, "key.pem");
  const cert = path.join(root, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert, "-days", "1", "-nodes",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
    { stdio: "ignore" }
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// Streams more than the 4 MB cap, so the client hits the cap and destroys the
// response mid-stream.
function startOversizedServer(credentials) {
  const chunk = "x".repeat(64 * 1024);
  const server = https.createServer({ key: credentials.key, cert: credentials.cert }, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    let sent = 0;
    const pump = () => {
      while (sent < 6 * 1024 * 1024) {
        sent += chunk.length;
        if (!response.write(chunk)) {
          response.once("drain", pump);
          return;
        }
      }
      response.end();
    };
    pump();
  });
  server.on("clientError", () => {});
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
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

  // The body cap destroys the response, and a destroyed response emits neither
  // `end` nor `error`. Before this was handled the promise stayed pending and
  // the request timeout could not rescue it, so an oversized or misbehaving page
  // hung the release gate instead of failing it.
  it("settles instead of hanging when a response exceeds the body cap", async (t) => {
    let credentials;
    try {
      credentials = selfSignedCertificate();
    } catch {
      t.skip("openssl is not available to mint a test certificate");
      return;
    }
    const server = await startOversizedServer(credentials);
    try {
      const result = await withTimeout(
        request("localhost", { address: "127.0.0.1", family: 4, port: server.port }, { ca: credentials.cert }),
        20_000
      );
      assert.notEqual(result, TIMED_OUT, "request() never settled on a capped response");
      assert.equal(result.truncated, true, JSON.stringify(result));
    } finally {
      server.close();
    }
  });

  it("reports a cut-short body as cut short rather than as a page missing the version", () => {
    const result = verdict({ status: 200, body: "x".repeat(64), truncated: true });
    assert.match(result, /exceeded .* bytes and the part read does not mention 1\.0\.2/);
  });

  // Reporting an address as unverified and then exiting 0 makes the gate claim
  // it verified every address in a run where it verified fewer.
  it("fails on an address it could not check unless the gap is accepted", () => {
    const unverified = ["example.test at ::1: no route from this machine to IPv6"];
    const strict = summarize({ checked: 2, failures: [], unverified, expect: "1.0.2", allowUnverified: false });
    assert.equal(strict.code, 1);
    assert.match(strict.err, /1 of 2 addresses could not be checked/);
    assert.doesNotMatch(strict.out, /^PASS/m);

    const accepted = summarize({ checked: 2, failures: [], unverified, expect: "1.0.2", allowUnverified: true });
    assert.equal(accepted.code, 0);
    assert.match(accepted.out, /PASS: 1 of 2 addresses serve 1\.0\.2 \(1 accepted as not reachable/);
  });

  it("passes only when every checked address served the version", () => {
    const clean = summarize({ checked: 3, failures: [], unverified: [], expect: "1.0.2", allowUnverified: false });
    assert.equal(clean.code, 0);
    assert.equal(clean.out, "PASS: 3 of 3 addresses serve 1.0.2\n");

    const broken = summarize({
      checked: 3,
      failures: ["example.test at 10.0.0.1: HTTP 502"],
      unverified: [],
      expect: "1.0.2",
      allowUnverified: true
    });
    assert.equal(broken.code, 1);
    assert.match(broken.err, /1 of 3 addresses do not serve 1\.0\.2/);
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

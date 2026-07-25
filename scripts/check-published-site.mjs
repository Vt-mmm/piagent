#!/usr/bin/env node

// Checks that the published documentation site serves the released version from
// every address it resolves to.
//
// Opening the site in a browser is not this check. A domain with several A
// records answers from whichever one the resolver picked that second, so one
// address can be dead for a week while every manual look happens to land on a
// healthy one. This resolves the name, then asks each address directly with the
// right Host header and SNI, and reports them separately. A partial outage has
// to read as a failure, not as an average.
//
// A redirect from a pinned address back to the same host is reported rather
// than followed: that is the shape of a loop, and following it would only
// re-resolve the name and hide which address caused it.

import dns from "node:dns/promises";
import https from "node:https";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function parseArguments(values) {
  const options = { hosts: [], expect: null };
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === "-h" || option === "--help") {
      process.stdout.write("Usage: node scripts/check-published-site.mjs [--host <name>]... [--expect <text>]\n");
      process.stdout.write("Verify every resolved address of the docs site serves the released version.\n");
      process.stdout.write("Defaults to piagent.io.vn and www.piagent.io.vn, expecting the root package version.\n");
      process.exit(0);
    }
    const value = values[index + 1];
    if (option === "--host") {
      if (!value || value.startsWith("--")) fail("--host requires a value");
      if (!/^[a-z0-9.-]{1,253}$/i.test(value)) fail(`--host value ${JSON.stringify(value)} is not a hostname`);
      options.hosts.push(value);
      index += 1;
      continue;
    }
    if (option === "--expect") {
      if (!value || value.startsWith("--")) fail("--expect requires a value");
      if (options.expect !== null) fail("duplicate option --expect");
      options.expect = value;
      index += 1;
      continue;
    }
    fail(`unknown option ${option}`);
  }
  if (options.hosts.length === 0) options.hosts = ["piagent.io.vn", "www.piagent.io.vn"];
  if (options.expect === null) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    options.expect = manifest.version;
  }
  return options;
}

async function resolveAddresses(host) {
  const addresses = [];
  for (const [family, resolver] of [[4, dns.resolve4], [6, dns.resolve6]]) {
    try {
      for (const address of await resolver(host)) addresses.push({ address, family });
    } catch (error) {
      if (error?.code !== "ENODATA" && error?.code !== "ENOTFOUND") throw error;
    }
  }
  return addresses;
}

function request(host, { address, family }) {
  return new Promise((resolve) => {
    const call = https.request(
      {
        host: address,
        family,
        servername: host,
        port: 443,
        path: "/",
        method: "GET",
        headers: { Host: host, "User-Agent": "piagent-site-check" },
        timeout: REQUEST_TIMEOUT_MS
      },
      (response) => {
        let body = "";
        let bytes = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk, "utf8");
          if (bytes > MAX_BODY_BYTES) {
            response.destroy();
            return;
          }
          body += chunk;
        });
        response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location, body }));
        response.on("error", (error) => resolve({ error: error.message, code: error.code }));
      }
    );
    call.on("timeout", () => {
      call.destroy();
      resolve({ error: `no response within ${REQUEST_TIMEOUT_MS}ms` });
    });
    call.on("error", (error) => resolve({ error: error.message, code: error.code }));
    call.end();
  });
}

// A redirect is only acceptable when it leaves this host for another name we are
// also checking. Pointing back at itself is the loop; pointing off the domain
// means the released page is not what this address serves.
export function judge(host, hosts, expect, result, family) {
  // A machine with no route to the address family cannot say anything about the
  // address. Calling that a site failure would be a false positive, and a gate
  // that cries wolf gets ignored, so it is reported as unverified instead.
  if (result.code === "ENETUNREACH" || result.code === "EHOSTUNREACH") {
    return { unverified: `no route from this machine to IPv${family}: ${result.error}` };
  }
  if (result.error) return `unreachable: ${result.error}`;
  if (result.status >= 300 && result.status < 400) {
    let target;
    try {
      target = new URL(result.location ?? "", `https://${host}/`);
    } catch {
      return `HTTP ${result.status} with an unreadable Location header`;
    }
    if (target.hostname === host) return `HTTP ${result.status} redirecting to itself at ${target.href}`;
    if (!hosts.includes(target.hostname)) return `HTTP ${result.status} redirecting off the site to ${target.href}`;
    return null;
  }
  if (result.status !== 200) return `HTTP ${result.status}`;
  if (!result.body.includes(expect)) return `HTTP 200 but the page does not mention ${expect}`;
  return null;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const failures = [];
  const unverified = [];
  let checked = 0;

  for (const host of options.hosts) {
    let addresses;
    try {
      addresses = await resolveAddresses(host);
    } catch (error) {
      fail(`${host} did not resolve: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (addresses.length === 0) fail(`${host} resolved to no addresses`);
    for (const entry of addresses) {
      const verdict = judge(host, options.hosts, options.expect, await request(host, entry), entry.family);
      checked += 1;
      if (verdict?.unverified) {
        unverified.push(`${host} at ${entry.address}: ${verdict.unverified}`);
        process.stdout.write(`  ????  ${host} ${entry.address} — ${verdict.unverified}\n`);
      } else if (verdict) {
        failures.push(`${host} at ${entry.address}: ${verdict}`);
        process.stdout.write(`  FAIL  ${host} ${entry.address} — ${verdict}\n`);
      } else {
        process.stdout.write(`  ok    ${host} ${entry.address}\n`);
      }
    }
  }

  for (const entry of unverified) process.stdout.write(`UNVERIFIED: ${entry}\n`);

  if (failures.length > 0) {
    process.stderr.write(`FAIL: ${failures.length} of ${checked} addresses do not serve ${options.expect}\n`);
    for (const failure of failures) process.stderr.write(`  ${failure}\n`);
    process.stderr.write("Each address is a real path users take. Fix the DNS records or the deployment behind them.\n");
    process.exit(1);
  }

  const verified = checked - unverified.length;
  const note = unverified.length > 0 ? ` (${unverified.length} not reachable from this machine)` : "";
  process.stdout.write(`PASS: ${verified} of ${checked} addresses serve ${options.expect}${note}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

#!/usr/bin/env node

// Applies the runtime advisory policy to `npm audit --json` read from stdin.
//
// The rule is "no moderate, high, or critical advisory in the pinned Pi host
// and add-on tree".
// The only exceptions are listed in runtime-advisory-exceptions.json, each an
// owner decision for one advisory at one package path in the tree, with a day
// it stops applying. The same advisory anywhere else, any other advisory, and
// an exception past its day all block. Its tests check every entry. A package
// flagged only because it depends on flagged packages (no advisory of its
// own, `via` names packages) is carried: it passes when every package it
// names is in the report with all of its advisories accepted, and blocks
// otherwise.
import fs from "node:fs";

function readStdin() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

function advisoryIdsFor(vulnerability) {
  // `via` mixes advisory objects with plain package names for transitive
  // effects; only the objects carry an advisory URL.
  return (vulnerability.via ?? [])
    .filter((item) => item && typeof item === "object" && typeof item.url === "string")
    .map((item) => item.url.match(/(GHSA-[a-z0-9-]+)/i)?.[1])
    .filter(Boolean);
}

const raw = await readStdin();
let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error("FAIL: npm audit did not produce parseable JSON");
  process.exit(1);
}

if (report.auditReportVersion !== 2) {
  // The shape this reads is version 2. Guessing at another shape could report
  // a clean tree because it looked in the wrong place.
  console.error(`FAIL: unsupported npm audit report version ${report.auditReportVersion ?? "(none)"}`);
  process.exit(1);
}

// PIAGENT_ADVISORY_EXCEPTIONS points the tests at a fixture list.
const { exceptions } = JSON.parse(fs.readFileSync(process.env.PIAGENT_ADVISORY_EXCEPTIONS || new URL("./runtime-advisory-exceptions.json", import.meta.url), "utf8"));
// A test seam for the day exceptions are judged on; the gate uses today (UTC).
const today = process.env.PIAGENT_ADVISORY_TODAY ?? new Date().toISOString().slice(0, 10);

const blocking = [], accepted = [], pending = [], carried = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  if (!["moderate", "high", "critical"].includes(vulnerability.severity)) continue;
  const ids = advisoryIdsFor(vulnerability);
  if (ids.length === 0) {
    const via = vulnerability.via ?? [];
    if (via.length > 0 && via.every((item) => typeof item === "string")) pending.push({ name, severity: vulnerability.severity, via });
    else blocking.push({ name, severity: vulnerability.severity, id: "(no advisory id)" });
    continue;
  }
  const nodes = Array.isArray(vulnerability.nodes) ? vulnerability.nodes : [];
  for (const id of ids) {
    const exception = exceptions.find((entry) => entry.id === id && entry.package === name
      && nodes.length > 0 && nodes.every((node) => node === entry.node));
    if (exception && today <= exception.until) accepted.push({ name, severity: vulnerability.severity, id, exception });
    else blocking.push({ name, severity: vulnerability.severity, id, expired: exception?.until });
  }
}

// Carried packages may chain (a via b via c): settle them until nothing changes;
// whatever is left names a package that is not accepted.
const cleared = new Set(accepted.map((entry) => entry.name).filter((name) => !blocking.some((entry) => entry.name === name)));
for (let changed = true; changed;) {
  changed = false;
  for (const entry of [...pending]) {
    if (!entry.via.every((name) => cleared.has(name))) continue;
    pending.splice(pending.indexOf(entry), 1);
    carried.push(entry);
    cleared.add(entry.name);
    changed = true;
  }
}
for (const entry of pending) blocking.push({ name: entry.name, severity: entry.severity, id: `(no advisory id, through ${entry.via.join(", ")})` });

for (const entry of accepted) {
  console.log(`ACCEPTED: ${entry.severity} advisory ${entry.id} in ${entry.name} at ${entry.exception.node} until ${entry.exception.until} (owner decision ${entry.exception.decided})`);
}

for (const entry of carried) {
  console.log(`CARRIED: ${entry.severity} in ${entry.name} only through accepted advisories of ${entry.via.join(", ")}`);
}

const failures = blocking.map(
  (entry) => `${entry.severity} advisory ${entry.id} in ${entry.name} blocks the supported runtime`
    + (entry.expired ? ` (its exception ended ${entry.expired})` : "")
);

if (failures.length > 0) {
  console.error("FAIL: runtime advisory policy");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(accepted.length
  ? `PASS: no unaccepted moderate, high, or critical advisory (${accepted.length} accepted, each until its end day)`
  : `PASS: no moderate, high, or critical advisory (${counts.moderate ?? 0} moderate, ${counts.high ?? 0} high, ${counts.critical ?? 0} critical)`);

#!/usr/bin/env node

// Applies the runtime advisory policy to `npm audit --json` read from stdin.
//
// The rule is "no moderate, high, or critical advisory in the pinned Pi host
// and add-on tree".
// There is deliberately no advisory allowlist. A supported host release must
// audit clean at these severities; changing that policy requires changing this
// gate and its tests explicitly.

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

const blocking = [];
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  if (!["moderate", "high", "critical"].includes(vulnerability.severity)) continue;
  const ids = advisoryIdsFor(vulnerability);
  if (ids.length === 0) {
    blocking.push({ name, severity: vulnerability.severity, id: "(no advisory id)" });
    continue;
  }
  for (const id of ids) {
    blocking.push({ name, severity: vulnerability.severity, id });
  }
}

const failures = blocking.map(
  (entry) => `${entry.severity} advisory ${entry.id} in ${entry.name} blocks the supported runtime`
);

if (failures.length > 0) {
  console.error("FAIL: runtime advisory policy");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(`PASS: no moderate, high, or critical advisory (${counts.moderate ?? 0} moderate, ${counts.high ?? 0} high, ${counts.critical ?? 0} critical)`);

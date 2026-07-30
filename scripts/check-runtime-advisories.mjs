#!/usr/bin/env node

// Applies the runtime advisory policy to `npm audit --json` read from stdin.
//
// The rule is "no moderate, high, or critical advisory in the pinned Pi host
// and add-on tree".
// What this adds is a way to accept one named advisory when there is provably
// nothing to do about it, without lowering the bar for everything else.
//
// An accepted advisory is not forgotten:
//   - it must still be present, so the entry disappears the moment upstream
//     ships a fix rather than lingering as scar tissue;
//   - it expires on a date, so accepting it can never become permanent by
//     inattention.
// Both of those fail the audit. A gate that quietly stops checking is worse
// than no gate, because it reads as a pass.

const ACCEPTED = [
  {
    id: "GHSA-mh99-v99m-4gvg",
    package: "brace-expansion",
    reviewBy: "2026-08-25",
    reason: [
      "Denial of service only: brace expansion can exhaust memory and crash the",
      "process. No privilege escalation and no data exposure.",
      "Nothing can fix it from here. The Pi host publishes an npm-shrinkwrap.json",
      "that pins brace-expansion 5.0.7, and a published shrinkwrap takes",
      "precedence over consumer overrides, so the resolution cannot be changed",
      "by this repository. Every released Pi host carries a high brace-expansion",
      "advisory: 0.81.1 and 0.82.0 carry this one, and 0.80.x carry the previous",
      "GHSA-3jxr-9vmj-r5cp, so pinning an older host only trades one for another.",
      "The fix is a regenerated shrinkwrap in a Pi release."
    ].join(" ")
  }
];

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

function today() {
  // Date-only comparison in UTC keeps the expiry independent of the runner's
  // timezone.
  return new Date().toISOString().slice(0, 10);
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
const seen = new Set();
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  if (!["moderate", "high", "critical"].includes(vulnerability.severity)) continue;
  const ids = advisoryIdsFor(vulnerability);
  if (ids.length === 0) {
    blocking.push({ name, severity: vulnerability.severity, id: "(no advisory id)" });
    continue;
  }
  for (const id of ids) {
    seen.add(id);
    const accepted = ACCEPTED.find((entry) => entry.id === id && entry.package === name);
    if (!accepted) blocking.push({ name, severity: vulnerability.severity, id });
  }
}

const failures = [];
for (const entry of blocking) {
  failures.push(`${entry.severity} advisory ${entry.id} in ${entry.name} is not accepted`);
}
for (const entry of ACCEPTED) {
  if (!seen.has(entry.id)) {
    failures.push(`accepted advisory ${entry.id} is no longer reported; remove it from ACCEPTED in ${"scripts/check-runtime-advisories.mjs"}`);
  } else if (today() > entry.reviewBy) {
    failures.push(`accepted advisory ${entry.id} passed its ${entry.reviewBy} review date; confirm it still applies or remove it`);
  }
}

if (failures.length > 0) {
  console.error("FAIL: runtime advisory policy");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

const counts = report.metadata?.vulnerabilities ?? {};
const acceptedList = ACCEPTED.map((entry) => `${entry.id} (review by ${entry.reviewBy})`).join(", ");
console.log(`PASS: no unaccepted moderate, high, or critical advisory (${counts.moderate ?? 0} moderate, ${counts.high ?? 0} high, ${counts.critical ?? 0} critical)`);
if (acceptedList) console.log(`Accepted, with reasons recorded in scripts/check-runtime-advisories.mjs: ${acceptedList}`);

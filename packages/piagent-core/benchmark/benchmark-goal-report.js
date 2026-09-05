import { assessProductionV3Goal } from "./benchmark-goal-assessment.js";

const number = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : "n/a";
const outcome = value => value === true ? "PASS" : "FAIL";
const html = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const markdown = value => html(value).replaceAll("|", "&#124;").replaceAll("`", "&#96;")
  .replaceAll("\\", "&#92;").replaceAll("\n", " ").replaceAll("\r", " ");

// Bind only from the real frozen manifest and the re-read verified ledger.
// No report-derived stand-ins for absent candidate/configuration/order bindings.
export function attachBenchmarkGoalAssessment({ report, suite, manifest, verifiedLedgerRecords }) {
  if (report?.suite?.id !== "production-v3") return report;
  report.goalAssessment = assessProductionV3Goal({ report, suite, bindings: {
    expectedOrder: manifest?.order,
    expectedLedger: manifest?.ledger,
    verifiedLedgerRecords,
    expectedCandidateDigest: manifest?.candidateProvenance?.contentDigest,
    expectedConfigurationDigest: manifest?.configurationDigest
  } });
  return report;
}

function tables(goal) {
  const timing = value => `${number(value?.medianSeconds, 3)} / ${number(value?.p95Seconds, 3)}`;
  const counted = (value, field) => `${value?.[field] ?? 0}/${value?.attempts ?? 0}`;
  return [
    { title: "All-attempt latency", headers: ["Surface", "Available / recorded", "Median seconds", "P95 seconds"],
      rows: ["piagent", "codex-cli"].map(surface => {
        const item = goal.latency?.[surface];
        return [surface, `${item?.availableAttempts ?? 0}/${item?.attempts ?? 0}`,
          number(item?.medianSeconds, 3), number(item?.p95Seconds, 3)];
      }) },
    { title: "Every scenario (both repeats retained)", headers: ["Scenario", "Pi fresh", "Codex fresh", "Fresh ratio",
      "Resolved Pi / Codex", "Grade passes Pi / Codex", "Pi median / P95 s", "Codex median / P95 s", "Goal"],
      rows: (goal.scenarios ?? []).map(item => [item.scenarioId,
        number(item.usage?.piagent?.freshTokens, 0), number(item.usage?.["codex-cli"]?.freshTokens, 0),
        number(item.freshTokenRatio, 6), `${counted(item.outcomes?.piagent, "resolved")} / ${counted(item.outcomes?.["codex-cli"], "resolved")}`,
        `${counted(item.outcomes?.piagent, "gradePassed")} / ${counted(item.outcomes?.["codex-cli"], "gradePassed")}`,
        timing(item.latency?.piagent), timing(item.latency?.["codex-cli"]), outcome(item.passed)]) },
    { title: "Every matched scenario / repeat pair", headers: ["Scenario", "Repeat", "Fresh ratio", "Duration ratio",
      "Quality", "Safety", "Workflow", "Goal", "Failures / missing evidence"],
      rows: (goal.pairs ?? []).map(item => [item.scenarioId, item.repeat, number(item.freshTokenRatio, 6), number(item.durationRatio, 6),
        outcome(item.qualityGate), outcome(item.safetyGate), outcome(item.workflowGate), item.complete ? outcome(item.passed) : "UNPROVEN",
        [...(item.failedRequirements ?? []), ...(item.evidenceFailures ?? [])].join(", ") || "none"]) }
  ];
}

function summary(goal) {
  return [
    `Stricter goal status: ${goal.status ?? "GOAL_UNPROVEN"}`,
    `Observed requirements: ${goal.observedRequirementsPassed === true ? "PASS" : goal.complete === true ? "FAIL" : "UNPROVEN"}`,
    `Goal claim eligible under existing gates: ${goal.claimAllowed === true ? "yes" : "no"}`,
    `Existing production verdict (unchanged): ${goal.existingVerdict ?? "unavailable"}`,
    `Passing pairs: ${goal.observed?.passingPairs ?? 0}/54; passing scenarios: ${goal.observed?.passingScenarios ?? 0}/27`,
    "Every matched pair must use at most 0.65x fresh tokens and at most 1.00x wall time, without quality, safety, or workflow regression.",
    "Latency includes valid failed attempts. P95 uses nearest-rank; two repeats per scenario do not establish future-task confidence.",
    "Stock Codex has no Pi workflow score: compare native terminal outcomes and enforce Pi's additional required workflow continuity.",
    `Measurement evidence failures: ${(goal.evidenceFailures ?? []).join(", ") || "none"}`,
    `Upstream claim restrictions: ${(goal.claimFailures ?? []).join(", ") || "none"}`,
    `Retained limitations: ${(goal.claimBoundary?.limitations ?? []).join(", ") || "none"}`,
    "Scope: observed public-regression workload only; no universal, causal, private-generalization, or member-production claim."
  ];
}

export function renderBenchmarkGoalMarkdown(goal) {
  if (!goal) return "";
  return ["## Stricter every-pair goal assessment", "", ...summary(goal).flatMap(line => [markdown(line), ""]),
    ...tables(goal).flatMap(table => [`### ${table.title}`, "", `| ${table.headers.map(markdown).join(" | ")} |`,
      `| ${table.headers.map(() => "---").join(" | ")} |`, ...table.rows.map(row => `| ${row.map(markdown).join(" | ")} |`), ""])
  ].join("\n");
}

export function renderBenchmarkGoalText(goal) {
  if (!goal) return "";
  return ["Stricter every-pair goal assessment", ...summary(goal),
    ...tables(goal).flatMap(table => ["", table.title, table.headers.join(" | "), ...table.rows.map(row => row.join(" | "))]), ""]
    .join("\n");
}

export function renderBenchmarkGoalHtml(goal) {
  if (!goal) return "";
  return `<section id="every-pair-goal"><h2>Stricter every-pair goal assessment</h2>${summary(goal).map(line => `<p>${html(line)}</p>`).join("")}`
    + tables(goal).map(table => `<h3>${html(table.title)}</h3><div class="table-wrap"><table><thead><tr>${table.headers.map(value => `<th>${html(value)}</th>`).join("")}</tr></thead><tbody>`
      + table.rows.map(row => `<tr>${row.map(value => `<td>${html(value)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>").join("")
    + "</section>";
}

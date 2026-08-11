#!/usr/bin/env node
import { spawnSync } from "node:child_process";

function usage() {
  process.stdout.write(`Usage:
  piagent-models [--json] [--provider <provider>] [--offline]

Reads Pi's authenticated model view through \`pi --list-models\`. It never reads
credential storage or substitutes public provider metadata.
`);
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(2);
}

function parseArguments(values) {
  const options = { json: false, provider: "", offline: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") options.json = true;
    else if (value === "--offline") options.offline = true;
    else if (value === "-h" || value === "--help") {
      usage();
      process.exit(0);
    } else if (value === "--provider") {
      const provider = values[index + 1];
      if (!provider || provider.startsWith("--")) fail("Missing value for --provider");
      options.provider = provider;
      index += 1;
    } else fail(`unknown option ${value}`);
  }
  return options;
}

function count(value) {
  const match = String(value ?? "").trim().match(/^(\d+(?:\.\d+)?)([KMG])?$/i);
  if (!match) return null;
  const scale = { K: 1_000, M: 1_000_000, G: 1_000_000_000 }[match[2]?.toUpperCase()] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

export function parsePiModelTable(value) {
  const models = [];
  for (const line of String(value ?? "").split(/\r?\n/).slice(1)) {
    const columns = line.trim().split(/\s{2,}/);
    if (columns.length < 6) continue;
    const [provider, modelId, context, maxOutput, thinking, images] = columns;
    if (!provider || !modelId) continue;
    models.push({
      provider,
      modelId,
      contextWindow: count(context),
      maxOutputTokens: count(maxOutput),
      reasoning: thinking === "yes" ? true : thinking === "no" ? false : null,
      imageInput: images === "yes" ? true : images === "no" ? false : null,
      supportedThinkingLevels: null
    });
  }
  return [...new Map(models.map((model) => [`${model.provider}\u0000${model.modelId}`, model])).values()]
    .sort((left, right) => `${left.provider}/${left.modelId}`.localeCompare(`${right.provider}/${right.modelId}`));
}

export function capturePiModelCatalog(options, environment = process.env) {
  const capturedAt = new Date().toISOString();
  if (options.offline) return {
    schemaVersion: 1,
    capturedAt,
    source: "authenticated-catalog",
    availability: "offline",
    piHostVersion: null,
    models: [],
    provenance: [{ field: "models", source: "authenticated-catalog", capturedAt }],
    warnings: ["Authenticated model catalog was not queried in offline mode."]
  };
  const version = spawnSync("pi", ["--version"], { encoding: "utf8", env: environment });
  const args = ["--list-models", ...(options.provider ? [options.provider] : [])];
  const listed = spawnSync("pi", args, { encoding: "utf8", env: environment });
  if (listed.error || listed.status !== 0) return {
    schemaVersion: 1,
    capturedAt,
    source: "authenticated-catalog",
    availability: "unavailable",
    piHostVersion: version.status === 0 ? version.stdout.trim() || null : null,
    models: [],
    provenance: [{ field: "models", source: "authenticated-catalog", capturedAt }],
    warnings: ["Pi authenticated model catalog is unavailable; login or runtime access may be missing."]
  };
  const models = parsePiModelTable(listed.stdout);
  return {
    schemaVersion: 1,
    capturedAt,
    source: "authenticated-catalog",
    availability: models.length > 0 ? "authenticated" : "logged-out",
    piHostVersion: version.status === 0 ? version.stdout.trim() || null : null,
    models,
    provenance: [
      { field: "models", source: "authenticated-catalog", capturedAt },
      { field: "piHostVersion", source: "pi-runtime", capturedAt }
    ],
    warnings: models.length > 0 ? [] : ["Pi returned no models available through current authentication."]
  };
}

function humanReport(report) {
  const lines = [
    "# Pi Agent authenticated model catalog",
    "",
    `source: ${report.source}`,
    `availability: ${report.availability}`,
    `capturedAt: ${report.capturedAt}`,
    `piHostVersion: ${report.piHostVersion ?? "unknown"}`,
    ""
  ];
  if (report.models.length === 0) lines.push("_No authenticated models available._");
  else {
    lines.push("| Provider/model | Context | Reasoning | Images |", "|---|---:|---|---|");
    for (const model of report.models) {
      lines.push(`| \`${model.provider}/${model.modelId}\` | ${model.contextWindow ?? "unknown"} | ${model.reasoning ?? "unknown"} | ${model.imageInput ?? "unknown"} |`);
    }
  }
  if (report.warnings.length > 0) lines.push("", ...report.warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const options = parseArguments(process.argv.slice(2));
  const report = capturePiModelCatalog(options);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : humanReport(report));
  process.exit(report.availability === "unavailable" && !options.json ? 1 : 0);
}

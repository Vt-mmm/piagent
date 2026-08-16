#!/usr/bin/env node
// Archives GitHub repository traffic before GitHub discards it.
//
// The traffic API only serves a rolling 14-day window. Anything older is gone
// for good -- there is no endpoint that returns it and no way to reconstruct
// it. So the counts are merged into CSV files that keep growing, and a run that
// happens at least every 14 days loses nothing.
//
// Merge rule: a row is keyed by its day and the newest fetch wins. Today's
// bucket is still filling while the run happens, so it is always partial; the
// next run overwrites it with the settled value. Once a day leaves the window
// it stops being returned at all, and the stored row is final.

import fs from "node:fs";
import path from "node:path";

const EXIT_USAGE = 2;
const EXIT_FORBIDDEN = 3;

const SERIES = [
  { endpoint: "clones", file: "clones.csv", columns: ["date", "count", "uniques"] },
  { endpoint: "views", file: "views.csv", columns: ["date", "count", "uniques"] }
];
// Referrers and paths are a 14-day rollup, not a daily series: the API gives no
// per-day breakdown, so a row is only meaningful next to the day it was read.
const ROLLUPS = [
  { endpoint: "popular/referrers", file: "referrers.csv", key: "referrer", columns: ["snapshot_date", "referrer", "count", "uniques"] },
  { endpoint: "popular/paths", file: "paths.csv", key: "path", columns: ["snapshot_date", "path", "title", "count", "uniques"] }
];

function fail(message, code = EXIT_USAGE) {
  console.error(`FAIL: ${message}`);
  process.exit(code);
}

export function parseArguments(argv) {
  const options = { repository: "", out: "traffic", dryRun: false, today: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--repository": case "--repo": {
        options.repository = argv[index += 1] ?? "";
        if (!/^[^/\s]+\/[^/\s]+$/.test(options.repository)) fail("--repository needs owner/name");
        break;
      }
      case "--out": {
        options.out = argv[index += 1] ?? "";
        if (!options.out) fail("--out needs a directory");
        break;
      }
      // The archive is written from a snapshot date, and a test cannot wait a
      // day to prove the merge. Injecting it keeps the assertions exact.
      case "--today": {
        options.today = argv[index += 1] ?? "";
        if (!/^\d{4}-\d{2}-\d{2}$/.test(options.today)) fail("--today needs YYYY-MM-DD");
        break;
      }
      case "--dry-run": options.dryRun = true; break;
      case "-h": case "--help": options.help = true; break;
      default: fail(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (character !== "\r") field += character;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((entry) => entry.some((cell) => cell !== ""));
}

function readTable(file, columns) {
  if (!fs.existsSync(file)) return [];
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const header = rows.shift();
  if (!header || header.join(",") !== columns.join(",")) {
    fail(`${file} has header [${header?.join(", ") ?? "none"}], expected [${columns.join(", ")}]`);
  }
  return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index] ?? ""])));
}

function writeTable(file, columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => csvEscape(row[column])).join(","));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

/**
 * Existing rows plus fetched rows, keyed by `key`. The fetched value wins,
 * because it is the newer reading of the same day. Rows outside the API window
 * are untouched -- that is the whole point of the archive.
 */
export function mergeByKey(existing, fetched, key) {
  const merged = new Map(existing.map((row) => [row[key], row]));
  for (const row of fetched) merged.set(row[key], row);
  return [...merged.values()].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
}

/** Rollup rows for one snapshot date, replacing any earlier run on that date. */
export function mergeRollup(existing, fetched, snapshotDate) {
  const kept = existing.filter((row) => row.snapshot_date !== snapshotDate);
  return [...kept, ...fetched].sort((a, b) =>
    String(a.snapshot_date).localeCompare(String(b.snapshot_date))
    || Number(b.count) - Number(a.count));
}

async function fetchTraffic(repository, endpoint, token) {
  const url = `https://api.github.com/repos/${repository}/traffic/${endpoint}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "piagent-traffic-snapshot",
      "x-github-api-version": "2022-11-28"
    }
  });
  if (response.status === 403 || response.status === 404) {
    // The distinction matters: this is the one failure an operator cannot debug
    // from the status code, because the traffic API answers 403 for a token
    // that is valid but lacks push access -- which the default workflow token
    // may or may not have, depending on repository settings.
    fail(`the token cannot read ${endpoint} for ${repository} (HTTP ${response.status}).\n`
      + "  Repository traffic needs push access. If this ran in GitHub Actions with the\n"
      + "  default GITHUB_TOKEN, create a fine-grained personal access token with the\n"
      + "  'Administration: read' permission on this repository, store it as the\n"
      + "  TRAFFIC_TOKEN secret, and re-run. Nothing was written.", EXIT_FORBIDDEN);
  }
  if (!response.ok) fail(`GET ${url} returned HTTP ${response.status}`);
  return response.json();
}

export async function snapshot(options, token, fetcher = fetchTraffic) {
  const today = options.today || new Date().toISOString().slice(0, 10);
  const summary = { repository: options.repository, snapshotDate: today, files: {} };

  // Read every existing file before fetching anything. A corrupt archive is a
  // reason to stop, and stopping before the network call keeps the failure
  // about the file rather than about whatever the API happened to answer.
  const existing = new Map();
  for (const target of [...SERIES, ...ROLLUPS]) {
    existing.set(target.file, readTable(path.join(options.out, target.file), target.columns));
  }

  for (const series of SERIES) {
    const payload = await fetcher(options.repository, series.endpoint, token);
    const fetched = (payload[series.endpoint] ?? []).map((entry) => ({
      date: String(entry.timestamp ?? "").slice(0, 10),
      count: String(entry.count ?? 0),
      uniques: String(entry.uniques ?? 0)
    })).filter((row) => row.date);
    const file = path.join(options.out, series.file);
    const merged = mergeByKey(existing.get(series.file), fetched, "date");
    if (!options.dryRun) writeTable(file, series.columns, merged);
    summary.files[series.file] = { fetchedDays: fetched.length, totalDays: merged.length };
  }

  for (const rollup of ROLLUPS) {
    const payload = await fetcher(options.repository, rollup.endpoint, token);
    const fetched = (Array.isArray(payload) ? payload : []).map((entry) => ({
      snapshot_date: today,
      [rollup.key]: String(entry[rollup.key] ?? entry.referrer ?? entry.path ?? ""),
      title: String(entry.title ?? ""),
      count: String(entry.count ?? 0),
      uniques: String(entry.uniques ?? 0)
    }));
    const file = path.join(options.out, rollup.file);
    const merged = mergeRollup(existing.get(rollup.file), fetched, today);
    if (!options.dryRun) writeTable(file, rollup.columns, merged);
    summary.files[rollup.file] = { fetchedRows: fetched.length, totalRows: merged.length };
  }

  return summary;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(`Usage:
  node scripts/traffic-snapshot.mjs --repository <owner/name> [--out <dir>] [--dry-run]

Archives GitHub traffic (clones, views, referrers, paths) into growing CSV files.
The API only keeps 14 days, so run this at least fortnightly or the gap is
permanent. Reads the token from TRAFFIC_TOKEN, else GITHUB_TOKEN.`);
    process.exit(0);
  }
  if (!options.repository) fail("--repository is required");
  const token = process.env.TRAFFIC_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) fail("set TRAFFIC_TOKEN or GITHUB_TOKEN");
  const summary = await snapshot(options, token);
  console.log(JSON.stringify(summary, null, 2));
}

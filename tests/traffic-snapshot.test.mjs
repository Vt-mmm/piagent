import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { csvEscape, mergeByKey, mergeRollup, parseCsv, snapshot } from "../scripts/traffic-snapshot.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "traffic-snapshot.mjs");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-traffic-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-traffic-"));
  temporaryRoots.add(root);
  return root;
}

/** Fourteen daily buckets ending on `lastDay`, the shape the API returns. */
function window14(lastDay, countFor) {
  const end = Date.parse(`${lastDay}T00:00:00Z`);
  return Array.from({ length: 14 }, (_, offset) => {
    const day = new Date(end - (13 - offset) * 86_400_000).toISOString().slice(0, 10);
    return { timestamp: `${day}T00:00:00Z`, count: countFor(day), uniques: 1 };
  });
}

function fetcherFor(map) {
  return async (_repository, endpoint) => {
    if (!(endpoint in map)) throw new Error(`unexpected endpoint: ${endpoint}`);
    return map[endpoint];
  };
}

function readCsv(file) {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  const header = rows.shift();
  return rows.map((row) => Object.fromEntries(header.map((column, index) => [column, row[index]])));
}

describe("traffic snapshot archive", () => {
  // The reason this script exists. GitHub serves a rolling 14-day window and
  // discards everything older, with no endpoint to recover it. If a later run
  // replaced the file instead of merging, the archive would never hold more
  // than 14 days and the whole exercise would be pointless.
  it("keeps days that have fallen out of the API window", async () => {
    const out = path.join(scratch(), "traffic");
    const options = { repository: "o/r", out, dryRun: false };

    await snapshot({ ...options, today: "2026-01-14" },
      "t", fetcherFor({
        clones: { clones: window14("2026-01-14", () => 5) },
        views: { views: window14("2026-01-14", () => 9) },
        "popular/referrers": [], "popular/paths": []
      }));

    // Twenty days later: the windows do not overlap at all.
    await snapshot({ ...options, today: "2026-02-03" },
      "t", fetcherFor({
        clones: { clones: window14("2026-02-03", () => 7) },
        views: { views: window14("2026-02-03", () => 3) },
        "popular/referrers": [], "popular/paths": []
      }));

    const clones = readCsv(path.join(out, "clones.csv"));
    const days = clones.map((row) => row.date);
    assert.equal(days.length, 28, days.join(","));
    // The first window survived even though the API no longer returns it.
    assert.ok(days.includes("2026-01-01"), days.join(","));
    assert.ok(days.includes("2026-01-14"), days.join(","));
    assert.ok(days.includes("2026-02-03"), days.join(","));
    assert.equal(clones.find((row) => row.date === "2026-01-01").count, "5");
    assert.equal(clones.find((row) => row.date === "2026-02-03").count, "7");
    // Sorted by date, so the file reads as a series rather than by write order.
    assert.deepEqual(days, [...days].sort());
  });

  // Today's bucket is still filling while the run happens, so every snapshot
  // records a partial value for its own date. Keeping the first reading would
  // permanently understate one day in fourteen.
  it("replaces a partial day with the settled value from a later run", async () => {
    const out = path.join(scratch(), "traffic");
    const options = { repository: "o/r", out, dryRun: false };
    const counts = { "2026-03-10": 4 };

    await snapshot({ ...options, today: "2026-03-10" },
      "t", fetcherFor({
        clones: { clones: window14("2026-03-10", (day) => counts[day] ?? 1) },
        views: { views: [] }, "popular/referrers": [], "popular/paths": []
      }));
    assert.equal(readCsv(path.join(out, "clones.csv")).find((row) => row.date === "2026-03-10").count, "4");

    counts["2026-03-10"] = 31;
    await snapshot({ ...options, today: "2026-03-11" },
      "t", fetcherFor({
        clones: { clones: window14("2026-03-11", (day) => counts[day] ?? 1) },
        views: { views: [] }, "popular/referrers": [], "popular/paths": []
      }));

    const clones = readCsv(path.join(out, "clones.csv"));
    assert.equal(clones.find((row) => row.date === "2026-03-10").count, "31");
    // One row per day, not two.
    assert.equal(clones.filter((row) => row.date === "2026-03-10").length, 1);
  });

  it("keeps one rollup per snapshot date and re-runs the same day cleanly", async () => {
    const out = path.join(scratch(), "traffic");
    const options = { repository: "o/r", out, dryRun: false };
    const run = (today, referrers) => snapshot({ ...options, today }, "t", fetcherFor({
      clones: { clones: [] }, views: { views: [] },
      "popular/referrers": referrers, "popular/paths": []
    }));

    await run("2026-04-01", [{ referrer: "github.com", count: 10, uniques: 3 }]);
    await run("2026-04-01", [{ referrer: "github.com", count: 12, uniques: 4 }]);
    await run("2026-04-02", [{ referrer: "Google", count: 2, uniques: 2 }]);

    const rows = readCsv(path.join(out, "referrers.csv"));
    // The same day run twice leaves one set of rows, not two.
    assert.equal(rows.filter((row) => row.snapshot_date === "2026-04-01").length, 1);
    assert.equal(rows.find((row) => row.snapshot_date === "2026-04-01").count, "12");
    // ...and the earlier day is still there, because a rollup is a reading, not a state.
    assert.equal(rows.filter((row) => row.snapshot_date === "2026-04-02").length, 1);
    assert.equal(rows.length, 2);
  });

  it("round-trips a referrer carrying a comma, a quote and a newline", async () => {
    // Referrers and page titles are attacker-influenceable strings that land in
    // a CSV. Unescaped, one of them silently shifts every later column.
    const out = path.join(scratch(), "traffic");
    const hostile = 'evil,"site"\nnext';
    await snapshot({ repository: "o/r", out, dryRun: false, today: "2026-05-01" },
      "t", fetcherFor({
        clones: { clones: [] }, views: { views: [] },
        "popular/referrers": [{ referrer: hostile, count: 1, uniques: 1 }],
        "popular/paths": []
      }));

    const rows = readCsv(path.join(out, "referrers.csv"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].referrer, hostile);
    assert.equal(rows[0].count, "1");
  });

  it("writes nothing under --dry-run", async () => {
    const out = path.join(scratch(), "traffic");
    await snapshot({ repository: "o/r", out, dryRun: true, today: "2026-06-01" },
      "t", fetcherFor({
        clones: { clones: window14("2026-06-01", () => 1) }, views: { views: [] },
        "popular/referrers": [], "popular/paths": []
      }));
    assert.equal(fs.existsSync(out), false);
  });

  it("refuses a file whose header is not the one it writes", () => {
    // Appending to a file with a different shape would corrupt the archive in a
    // way no later run could untangle.
    const out = path.join(scratch(), "traffic");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "clones.csv"), "day,total\n2026-01-01,5\n");
    const result = spawnSync(process.execPath, [script, "--repository", "o/r", "--out", out], {
      env: { ...process.env, TRAFFIC_TOKEN: "unused" }, encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /has header \[day, total\], expected \[date, count, uniques\]/);
  });
});

describe("traffic snapshot failure reporting", () => {
  // The one failure an operator cannot read off the status code: the traffic
  // API answers 403 for a token that is perfectly valid but lacks push access.
  // Without naming the fix, a nightly job just goes red forever.
  for (const status of [403, 404]) {
    it(`explains an HTTP ${status} as a token permission problem and writes nothing`, () => {
      const root = scratch();
      const out = path.join(root, "traffic");
      // --import, not -e: the script only runs its CLI block when argv[1] is
      // the script itself, and -e replaces argv[1] so nothing would execute.
      const stub = path.join(root, "stub.mjs");
      fs.writeFileSync(stub, `globalThis.fetch = async () => new Response("{}", { status: ${status} });\n`);
      const result = spawnSync(process.execPath, ["--import", stub, script, "--repository", "o/r", "--out", out], {
        env: { ...process.env, TRAFFIC_TOKEN: "t" }, encoding: "utf8"
      });
      assert.equal(result.status, 3, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /cannot read clones for o\/r \(HTTP \d+\)/);
      assert.match(result.stderr, /TRAFFIC_TOKEN/);
      assert.match(result.stderr, /Administration: read/);
      assert.match(result.stderr, /Nothing was written/);
      assert.equal(fs.existsSync(out), false);
    });
  }

  it("refuses to run without a token rather than fetching anonymously", () => {
    const result = spawnSync(process.execPath, [script, "--repository", "o/r"], {
      env: { ...process.env, TRAFFIC_TOKEN: "", GITHUB_TOKEN: "" }, encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /set TRAFFIC_TOKEN or GITHUB_TOKEN/);
  });

  it("rejects a repository argument that is not owner/name", () => {
    const result = spawnSync(process.execPath, [script, "--repository", "not-a-repo"], {
      env: { ...process.env, TRAFFIC_TOKEN: "t" }, encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--repository needs owner\/name/);
  });
});

describe("traffic snapshot merge helpers", () => {
  it("lets the newer reading win and keeps everything else", () => {
    const merged = mergeByKey(
      [{ date: "2026-01-01", count: "1" }, { date: "2026-01-02", count: "2" }],
      [{ date: "2026-01-02", count: "9" }, { date: "2026-01-03", count: "3" }],
      "date"
    );
    assert.deepEqual(merged.map((row) => `${row.date}=${row.count}`),
      ["2026-01-01=1", "2026-01-02=9", "2026-01-03=3"]);
  });

  it("drops only the rollup rows for the date being rewritten", () => {
    const merged = mergeRollup(
      [{ snapshot_date: "2026-01-01", referrer: "a", count: "1" },
        { snapshot_date: "2026-01-02", referrer: "b", count: "2" }],
      [{ snapshot_date: "2026-01-02", referrer: "c", count: "5" }],
      "2026-01-02"
    );
    assert.deepEqual(merged.map((row) => `${row.snapshot_date}:${row.referrer}`),
      ["2026-01-01:a", "2026-01-02:c"]);
  });

  it("quotes only what needs quoting", () => {
    assert.equal(csvEscape("plain"), "plain");
    assert.equal(csvEscape("a,b"), '"a,b"');
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscape(undefined), "");
  });
});

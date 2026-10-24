import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { piSdkRoot } from "./helpers/pi-sdk.mjs";

// The packaged fe-change-report skill: Pi loads it as a model-invocable skill,
// and its scripts turn two running versions of a page into one report file.
const root = path.resolve(import.meta.dirname, "..");
const scripts = path.join(root, "packages", "piagent-core", "skills", "fe-change-report", "scripts");
const { capture, loadChromium, readConfig } = await import(pathToFileURL(path.join(scripts, "capture.mjs")).href);
const { diffRegions, groupCells } = await import(pathToFileURL(path.join(scripts, "diff-regions.mjs")).href);
const { buildReport, REPORT_MARKER } = await import(pathToFileURL(path.join(scripts, "build-report.mjs")).href);
const chromium = await loadChromium(root).catch(() => undefined);
const browserReady = Boolean(chromium && fs.existsSync(chromium.executablePath()));

test("Pi loads fe-change-report from the package as a model-invocable skill", { skip: !fs.existsSync(piSdkRoot()) }, async () => {
  const { loadSkillsFromDir } = await import(pathToFileURL(path.join(piSdkRoot(), "dist", "index.js")).href);
  const { skills, diagnostics } = loadSkillsFromDir({ dir: path.join(root, "packages", "piagent-core", "skills"), source: "package" });
  const skill = skills.find((item) => item.name === "fe-change-report");
  assert.ok(skill, JSON.stringify(diagnostics));
  assert.match(skill.description, /before\/after screenshots/);
  assert.notEqual(skill.disableModelInvocation, true);
});

test("changed cells close together become one box, distant ones stay apart", () => {
  const columns = 20, rows = 10, cells = new Array(columns * rows).fill(0);
  for (const [x, y] of [[1, 1], [3, 1], [3, 2], [16, 8]]) cells[y * columns + x] = 1;
  assert.deepEqual(groupCells({ cells, columns, rows, cell: 8, gap: 3, pad: 4, width: 160, height: 80 }), [
    { n: 1, x: 4, y: 4, w: 32, h: 24 },
    { n: 2, x: 124, y: 60, w: 16, h: 16 }
  ]);
});

function serve(variant) {
  const pages = {
    // The clock is masked, but its width still differs between the two sides.
    before: "<span id='clock' style='float:right;margin:8px'>9:05</span><h1 style='margin:40px'>3 listings</h1><p style='margin:40px'>Same footer</p>",
    after: "<span id='clock' style='float:right;margin:8px'>10:45:59 PM</span><h1 style='margin:40px'>Homes for sale in Ward 7</h1><p style='margin:40px'>Same footer</p>"
  };
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><body style="margin:0;font:20px sans-serif;background:#fff">${pages[variant]}</body>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("two versions of a page become a report with the change framed on both", { skip: !browserReady }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-change-report-"));
  const configFile = path.join(dir, "shots.json");
  fs.writeFileSync(configFile, JSON.stringify({ viewports: [{ name: "desktop", width: 800, height: 400 }], mask: ["#clock"],
    pages: [{ key: "home", path: "/", clipHeight: 300 }] }));
  const shots = path.join(dir, "shots");
  for (const side of ["before", "after"]) {
    const server = await serve(side);
    try {
      const failures = await capture({ config: readConfig(configFile), side, baseUrl: `http://127.0.0.1:${server.address().port}`, out: shots, chromium });
      assert.deepEqual(failures, []);
    } finally { server.close(); }
  }
  const regions = await diffRegions({ dir: shots, chromium });
  const [box] = regions["home-desktop"].boxes;
  // The heading changed and the footer did not, and the masked clock is skipped,
  // so one frame sits on the heading only.
  assert.equal(regions["home-desktop"].boxes.length, 1, JSON.stringify(regions["home-desktop"].boxes));
  assert.ok(box.y < 120 && box.y + box.h < 150, JSON.stringify(box));
  assert.ok(fs.existsSync(path.join(shots, "diff-home-desktop.png")));

  const html = buildReport({ dir: shots, spec: {
    kind: "fe-change-report", title: "Heading <b>change</b>", business: [{ title: "Heading", before: "3 listings", after: "Homes for sale", impact: "Area keyword" }],
    sections: [{ key: "home", title: "Home", boxes: [{ ...box, text: "New heading" }] }],
    e2e: { command: "npm run test:e2e", result: "failed", passed: 9, failed: 1 }
  } });
  assert.match(html, new RegExp(REPORT_MARKER));
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /Heading &lt;b&gt;change&lt;\/b&gt;/);
  // One frame on each side and one zoom per side, with the screenshots embedded once each.
  assert.equal(html.match(/class="box"/g).length, 2);
  assert.equal(html.match(/class="crop /g).length, 2);
  assert.equal(html.match(/data:image\/png;base64/g).length, 3);
  assert.match(html, /class="badge failed"/);
});

test("a page key that is not a plain name is refused before it becomes a file name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-change-report-"));
  assert.throws(() => buildReport({ dir, spec: { kind: "fe-change-report", sections: [{ key: "../secret", boxes: [] }] } }), /section key and viewport names must match/);
  const config = path.join(dir, "shots.json");
  fs.writeFileSync(config, JSON.stringify({ pages: [{ key: "home", path: "/" }], storageState: path.join(dir, "missing-login.json") }));
  assert.throws(() => readConfig(config), /storageState not found/);
});

test("a box outside the screenshot is refused with the section and box named", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fe-change-report-"));
  const png = Buffer.alloc(24); png.writeUInt32BE(0x49484452, 12); png.writeUInt32BE(100, 16); png.writeUInt32BE(50, 20);
  fs.writeFileSync(path.join(dir, "after-home-desktop.png"), png);
  assert.throws(() => buildReport({ dir, spec: { kind: "fe-change-report", sections: [{ key: "home", viewport: "desktop", boxes: [{ x: -1, y: 0, w: 10, h: 10 }] }] } }),
    /section home box 1: box.x must be a non-negative number/);
});

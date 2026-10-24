---
name: fe-change-report
description: "Use when a front-end task asks for a change report: before/after screenshots with numbered red frames, headless E2E, and what changed in business rules, logic, and UI/UX, delivered as one HTML file the dashboard shows."
---

# Front-end change report

The report answers four questions for the person who asked for the change:
what the business now does differently, what logic changed, what the screen
looked like before and after, and whether the checks passed. Everything in it
must come from something you ran or read in this task. Never describe a screen
you did not capture or a check you did not run.

The scripts are in `scripts/` next to this file; resolve that path against
this skill's directory. They use the Playwright installed in the project under
test (`--project <dir>` when you run them from elsewhere), run Chromium
headless, and add no dependency. If the project has Playwright but no browser,
`npx playwright install chromium` downloads one: ask the member first.

## 1. Scope

- Read the diff against the base (`git diff <base>...HEAD` plus uncommitted
  work) and list the routes and states the change can show: pages, dialogs,
  empty and error states, desktop and mobile. A change with no visible effect
  gets a report without screenshots; say so in the summary.
- Pick a slug such as `2026-10-24-listing-seo` and work in
  `reports/fe-change/<slug>/` at the project root. Unless the project already
  tracks reports, add `reports/fe-change/` to `.git/info/exclude` so the
  report never lands in a commit by accident.
- Write `reports/fe-change/<slug>/shots/shots.json`. Everything the capture
  needs or produces stays in `shots/`, so the dashboard lists only the report:

```json
{
  "viewports": [{ "name": "desktop", "width": 1440, "height": 1000 }, { "name": "mobile", "width": 390, "height": 844 }],
  "mask": ["[data-testid=clock]"],
  "pages": [
    { "key": "listings", "title": "Listings page", "path": "/listings", "clipHeight": 900 },
    { "key": "detail", "title": "Listing detail", "path": "/listings/demo", "scroll": true },
    { "key": "market", "title": "Market section", "path": "/", "selector": "[data-testid=market-data-section]" }
  ]
}
```

Page options:

| Option | Effect |
|---|---|
| `fullPage` | Whole page, default `true` |
| `clipHeight` | Only the top N pixels |
| `selector` | One element only |
| `waitFor` | A selector that must appear before the shot |
| `scroll` | Scroll through the page first so lazy sections render |
| `settleMs` | Extra wait before the shot, default 600 |
| `mask` | Selectors painted grey on both sides |
| `viewports` | Subset of viewport names for this page |

Top-level `mask`, `locale`, `colorScheme`, `ignoreHTTPSErrors`, and
`storageState` (a Playwright login state file, path relative to where you run
the script) apply to every page. A viewport narrower than 768 px is emulated
as a touch phone unless it sets `isMobile`. Keys and viewport names are
lowercase letters, digits and dashes.

Mask anything that changes on its own (clocks, relative times, random ids,
carousels, ads). Otherwise it shows up as a change you did not make.

## 2. Run both sides on the same data

- **Before:** `git worktree add <tmp>/fe-report-base <base>` and install there
  the way the project installs (a lockfile install, never an upgrade).
- **After:** the current working tree.
- Start each one on its own free port in the background, with output going to
  a log file. Wait until each URL answers before capturing. Prefer the
  project's own production-like E2E setup (built app plus mock API or seed
  data) so both sides show the same records. Screenshots of two different
  data sets are not a comparison. If live data was unavoidable, say so in
  `lede`.

Run the scripts from `reports/fe-change/<slug>/`. Below, `scripts/` stands for
the absolute path of this skill's `scripts/` folder; `shots/` and the report
files are relative to the report folder.

```bash
node scripts/capture.mjs --config shots/shots.json --side before --base-url http://127.0.0.1:<before-port> --out shots
node scripts/capture.mjs --config shots/shots.json --side after  --base-url http://127.0.0.1:<after-port> --out shots
node scripts/diff-regions.mjs --dir shots
```

`capture.mjs` exits non-zero and names the shot when a page fails to load, a
`waitFor` never appears, or a screenshot is over the 8 MB the dashboard
shows. Fix the cause and capture again; do not report around a missing shot.

`diff-regions.mjs` writes two things:
- `shots/regions.json`: proposed boxes per page and viewport, in image pixels.
- `shots/diff-<page>-<viewport>.png`: the new screenshot with changed pixels in red.

It also names any page that exists on one side only.

**Look before you frame.** Open the before, after and diff images and decide
the boxes yourself:
- Merge boxes that belong to one change.
- Drop boxes caused only by content moving down. When a new block pushes the
  rest of the page down, frame only the new block.
- Use separate `before`/`after` coordinates when the same element moved.
- Write one plain sentence per box saying what changed for the user.

## 3. Verify

Run the project's own checks after the last code change, headless and in the
background with output to a log file: typecheck, lint, unit tests, and the
full E2E suite. Never use `--headed`, `--ui`, `--debug` or `PWDEBUG`.
- Record the exact command, the counts, and the duration.
- A test that also fails on the base worktree is a baseline failure: say so in
  `detail`, and do not call the check passed.
- A check you could not run is `skipped` with the reason.

## 4. Write report.json and build

```json
{
  "kind": "fe-change-report",
  "title": "Listing SEO: before and after",
  "lede": "Production build with E2E mock data, 1440 px.",
  "base": "main@ecc3944f", "head": "feature/seo@1a2b3c4d", "lang": "vi", "viewports": ["desktop", "mobile"],
  "summary": ["One line per user-visible outcome"],
  "business": [{ "title": "Listing heading", "before": "3 listings · Buy", "after": "Homes for sale in {ward}", "impact": "Area keyword in H1" }],
  "logic": [{ "title": "Same-area links", "before": "None", "after": "Up to 6 from the same ward, then province", "files": ["src/features/listings/logic/index.ts"] }],
  "sections": [{ "key": "listings", "title": "Listings page", "note": "Optional context", "viewport": "desktop",
    "boxes": [{ "x": 70, "y": 92, "w": 520, "h": 56, "text": "New heading and live count" }],
    "otherBoxes": { "mobile": [{ "x": 10, "y": 98, "w": 268, "h": 44 }] } }],
  "e2e": { "command": "npm run test:e2e", "result": "passed", "passed": 214, "failed": 0, "skipped": 3, "duration": "6m12s" },
  "checks": [{ "name": "typecheck", "result": "passed" }, { "name": "unit", "result": "failed", "detail": "1 baseline failure, also on main" }],
  "files": [{ "path": "src/app/sitemap.ts", "kind": "logic", "summary": "Listing sitemap" }],
  "risks": ["What was not verified and why"]
}
```

- `kind` must be `fe-change-report`: it is how the dashboard knows to draw
  the file as a report.
- `viewports` lists the sizes captured, with the primary one first.
- `business` is what a user or the business sees differently.
- `logic` is the rule or data flow behind it.
- `files` covers every changed file with a short reason.
- `result` is `passed`, `failed` or `skipped`.
- A box uses the same coordinates on both images unless it has its own
  `before` or `after` box (`{ "x", "y", "w", "h" }`).
- `lang` is `vi` (default) or `en`.

Then build:

```bash
node scripts/build-report.mjs --spec report.json --dir shots --out report.html
```

The builder refuses a box outside its image or a key that is not a plain
name, and says which section. `report.html` is self-contained, has no
scripts, and opens in any browser, so it can be sent to someone. Keep it under
15 MB: clip long pages with `clipHeight` or `selector`.

Read the result before you report it:
- open `report.html`, or screenshot it with Playwright;
- check that every frame sits on the change it describes, on both sides.

## 5. Finish

1. Stop both servers, remove the base worktree
   (`git worktree remove <tmp>/fe-report-base`), and leave
   `reports/fe-change/<slug>/` in place.
2. Reply with:
   - the report path;
   - where to see it: the Piagent dashboard draws it under Documents from
     `reports/fe-change/<slug>/report.json`, with a full-screen view;
   - one line per check;
   - anything not verified.
3. Do not commit the report unless asked.

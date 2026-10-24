#!/usr/bin/env node
// Headless screenshots of one side (before or after) of a front-end change.
// Playwright comes from the project under test, so the skill adds no dependency.
//   node capture.mjs --config shots.json --side before --base-url http://127.0.0.1:3001 --out <dir>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)$/.exec(argv[index]);
    if (!match || argv[index + 1] === undefined) throw new Error(`unexpected argument: ${argv[index]}`);
    options[match[1]] = argv[++index];
  }
  return options;
}

export async function loadChromium(projectDir) {
  const require = createRequire(path.join(path.resolve(projectDir), "package.json"));
  for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
    let module;
    try { module = await import(pathToFileURL(require.resolve(name)).href); } catch { continue; }
    // A CommonJS package imported from ESM keeps its exports under `default`.
    const chromium = module.chromium ?? module.default?.chromium;
    if (chromium) return chromium;
  }
  throw new Error(`Playwright was not found from ${projectDir}; install it in the project or pass --project <dir>`);
}

// Width and height sit at fixed offsets of the IHDR chunk that opens every PNG.
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) throw new Error("not a PNG file");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const DEFAULT_VIEWPORTS = [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }];
export const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The dashboard refuses a screenshot larger than this; say so at capture time.
export const MAX_SHOT_BYTES = 8 * 1024 * 1024;

export function readConfig(file) {
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  const viewports = config.viewports ?? DEFAULT_VIEWPORTS;
  if (!Array.isArray(config.pages) || config.pages.length === 0) throw new Error("config.pages must list at least one page");
  for (const entry of [...config.pages.map((page) => page.key), ...viewports.map((viewport) => viewport.name)]) {
    if (!SAFE_NAME.test(String(entry))) throw new Error(`page keys and viewport names must match ${SAFE_NAME}: ${entry}`);
  }
  // A login state that is named but missing would silently capture the logged-out page on both sides.
  if (config.storageState && !fs.existsSync(config.storageState)) throw new Error(`storageState not found: ${config.storageState}`);
  return { ...config, viewports };
}

async function settle(page, entry) {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  if (entry.waitFor) await page.locator(entry.waitFor).first().waitFor({ timeout: 30_000 });
  if (entry.scroll) {
    // Lazy sections render only after they enter the viewport.
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight / 2) {
        window.scrollTo(0, y); await new Promise((resolve) => setTimeout(resolve, 120));
      }
      window.scrollTo(0, 0);
    });
  }
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(entry.settleMs ?? 600);
}

// Where the masked elements sit in the screenshot. A masked clock is grey on
// both sides, but its width still follows the time it showed, so the diff has
// to skip these areas rather than compare two grey boxes of different sizes.
async function maskRects(page, mask, target) {
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const origin = target ? await target.boundingBox() : { x: -scroll.x, y: -scroll.y };
  const rects = [];
  for (const locator of mask) {
    for (const element of await locator.all()) {
      const box = await element.boundingBox();
      if (box && origin) rects.push({ x: Math.floor(box.x - origin.x), y: Math.floor(box.y - origin.y), w: Math.ceil(box.width), h: Math.ceil(box.height) });
    }
  }
  return rects;
}

export async function capture({ config, side, baseUrl, out, chromium }) {
  fs.mkdirSync(out, { recursive: true });
  const metaFile = path.join(out, "meta.json");
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : { shots: {} };
  meta[`${side}BaseUrl`] = baseUrl;
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    for (const viewport of config.viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1,
        // A phone-sized viewport without a touch device still renders desktop hover and meta-viewport behaviour.
        isMobile: viewport.isMobile ?? viewport.width < 768, hasTouch: viewport.isMobile ?? viewport.width < 768,
        reducedMotion: "reduce", locale: config.locale, colorScheme: config.colorScheme ?? "light",
        ignoreHTTPSErrors: config.ignoreHTTPSErrors === true, storageState: config.storageState || undefined
      });
      for (const entry of config.pages) {
        if (entry.viewports && !entry.viewports.includes(viewport.name)) continue;
        const name = `${side}-${entry.key}-${viewport.name}`;
        const page = await context.newPage();
        try {
          await page.goto(new URL(entry.path, baseUrl).href, { waitUntil: "load", timeout: 60_000 });
          await settle(page, entry);
          const file = path.join(out, `${name}.png`);
          // Masked regions (clocks, random ids, ads) are painted the same colour on both sides, so they never count as a change.
          const mask = [...(config.mask ?? []), ...(entry.mask ?? [])].map((selector) => page.locator(selector));
          const shot = { path: file, animations: "disabled", caret: "hide", mask, maskColor: "#c8c8c8" };
          const target = entry.selector ? page.locator(entry.selector).first() : null;
          if (target) await target.scrollIntoViewIfNeeded();
          const masks = await maskRects(page, mask, target);
          if (target) await target.screenshot(shot);
          else if (entry.clipHeight) {
            // fullPage lets the clip reach below the first screen.
            const height = Math.min(entry.clipHeight, await page.evaluate(() => document.documentElement.scrollHeight));
            await page.screenshot({ ...shot, fullPage: true, clip: { x: 0, y: 0, width: viewport.width, height } });
          } else await page.screenshot({ ...shot, fullPage: entry.fullPage !== false });
          const bytes = fs.readFileSync(file), size = pngSize(bytes);
          meta.shots[name] = { key: entry.key, title: entry.title ?? entry.key, viewport: viewport.name, url: page.url(), ...size, bytes: bytes.length, masks };
          console.log(`captured ${name} ${size.width}x${size.height}`);
          if (bytes.length > MAX_SHOT_BYTES) failures.push(`${name}: ${Math.round(bytes.length / 1048576)} MB is over the 8 MB the dashboard shows; use clipHeight or selector`);
        } catch (error) {
          failures.push(`${name}: ${error.message.split("\n")[0]}`);
        } finally { await page.close(); }
      }
      await context.close();
    }
  } finally { await browser.close(); }
  fs.writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  return failures;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.config || !["before", "after"].includes(options.side) || !options["base-url"] || !options.out) {
    console.error("usage: capture.mjs --config shots.json --side before|after --base-url <url> --out <dir> [--project <dir>]");
    process.exit(2);
  }
  const failures = await capture({
    config: readConfig(options.config), side: options.side, baseUrl: options["base-url"], out: options.out,
    chromium: await loadChromium(options.project ?? process.cwd())
  });
  for (const failure of failures) console.error(`failed ${failure}`);
  process.exit(failures.length ? 1 : 0);
}

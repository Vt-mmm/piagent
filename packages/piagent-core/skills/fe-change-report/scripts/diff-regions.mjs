#!/usr/bin/env node
// Finds where each before/after screenshot pair differs and proposes numbered
// red boxes. Pixels are compared on a canvas inside headless Chromium, so no
// image library is needed; grouping the changed cells into boxes runs here.
//   node diff-regions.mjs --dir <shots dir> [--project <dir>] [--cell 8] [--gap 3]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadChromium, parseArgs } from "./capture.mjs";

// cells: Uint8Array-like grid, 1 where the cell changed. Cells closer than
// `gap` cells join one box so a changed paragraph becomes one frame, not forty.
export function groupCells({ cells, columns, rows, cell, gap = 3, pad = 6, width, height, limit = 12 }) {
  const seen = new Uint8Array(columns * rows), boxes = [];
  for (let start = 0; start < cells.length; start += 1) {
    if (!cells[start] || seen[start]) continue;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
    const queue = [start]; seen[start] = 1;
    while (queue.length) {
      const index = queue.pop(), x = index % columns, y = Math.floor(index / columns);
      count += 1; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (let dy = -gap; dy <= gap; dy += 1) {
        for (let dx = -gap; dx <= gap; dx += 1) {
          const nx = x + dx, ny = y + dy, next = ny * columns + nx;
          if (nx < 0 || ny < 0 || nx >= columns || ny >= rows || seen[next] || !cells[next]) continue;
          seen[next] = 1; queue.push(next);
        }
      }
    }
    const x = Math.max(0, minX * cell - pad), y = Math.max(0, minY * cell - pad);
    boxes.push({ x, y, w: Math.min(width, (maxX + 1) * cell + pad) - x, h: Math.min(height, (maxY + 1) * cell + pad) - y, cells: count });
  }
  return boxes.sort((a, b) => b.cells - a.cells).slice(0, limit)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map(({ cells: _cells, ...box }, index) => ({ n: index + 1, ...box }));
}

async function comparePair(page, beforeFile, afterFile, cell, masks) {
  return page.evaluate(async ({ before, after, cell, masks }) => {
    const masked = (x, y) => masks.some((rect) => x >= rect.x - 2 && x < rect.x + rect.w + 2 && y >= rect.y - 2 && y < rect.y + rect.h + 2);
    const load = async (source) => {
      const bitmap = await createImageBitmap(await (await fetch(source)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap };
    };
    const [a, b] = await Promise.all([load(before), load(after)]);
    const width = Math.max(a.width, b.width), height = Math.max(a.height, b.height);
    const columns = Math.ceil(width / cell), rows = Math.ceil(height / cell), cells = new Array(columns * rows).fill(0);
    const overlay = new OffscreenCanvas(b.width, b.height), draw = overlay.getContext("2d");
    draw.globalAlpha = 0.35; draw.drawImage(b.bitmap, 0, 0); draw.globalAlpha = 1;
    const mark = draw.createImageData(b.width, b.height);
    let changed = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const inA = x < a.width && y < a.height, inB = x < b.width && y < b.height;
        let differs = inA !== inB;
        if (inA && inB) {
          const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4;
          differs = Math.max(Math.abs(a.data[i] - b.data[j]), Math.abs(a.data[i + 1] - b.data[j + 1]), Math.abs(a.data[i + 2] - b.data[j + 2])) > 40;
        }
        if (!differs || masked(x, y)) continue;
        changed += 1; cells[Math.floor(y / cell) * columns + Math.floor(x / cell)] += 1;
        if (inB) { const j = (y * b.width + x) * 4; mark.data[j] = 220; mark.data[j + 1] = 30; mark.data[j + 2] = 40; mark.data[j + 3] = 255; }
      }
    }
    const markCanvas = new OffscreenCanvas(b.width, b.height); markCanvas.getContext("2d").putImageData(mark, 0, 0);
    draw.drawImage(markCanvas, 0, 0);
    const blob = await overlay.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = ""; for (let i = 0; i < bytes.length; i += 32_768) binary += String.fromCharCode(...bytes.subarray(i, i + 32_768));
    // A cell counts once a few pixels changed, so antialiasing noise stays out.
    return { width, height, columns, rows, changed, total: width * height, cells: cells.map((count) => (count > 3 ? 1 : 0)), overlay: btoa(binary) };
  }, { before: dataUrl(beforeFile), after: dataUrl(afterFile), cell, masks });
}

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;

export async function diffRegions({ dir, chromium, cell = 8, gap = 3 }) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const names = Object.keys(meta.shots);
  const pairs = names.filter((name) => name.startsWith("after-")).map((name) => name.slice("after-".length)).filter((name) => meta.shots[`before-${name}`]);
  // A page captured on one side only is a new or removed page, or a failed capture: say which shots have no partner.
  for (const name of names) {
    const [side, rest] = [name.slice(0, name.indexOf("-")), name.slice(name.indexOf("-") + 1)];
    if (!pairs.includes(rest)) console.log(`${rest}: only the ${side} screenshot exists, nothing to compare`);
  }
  const browser = await chromium.launch({ headless: true });
  const regions = {};
  try {
    const page = await browser.newPage();
    for (const name of pairs) {
      const masks = [...(meta.shots[`before-${name}`].masks ?? []), ...(meta.shots[`after-${name}`].masks ?? [])];
      const result = await comparePair(page, path.join(dir, `before-${name}.png`), path.join(dir, `after-${name}.png`), cell, masks);
      fs.writeFileSync(path.join(dir, `diff-${name}.png`), Buffer.from(result.overlay, "base64"));
      const boxes = groupCells({ ...result, cell, gap });
      regions[name] = { changedRatio: Number((result.changed / result.total).toFixed(5)), boxes };
      console.log(`${name}: ${(regions[name].changedRatio * 100).toFixed(2)}% changed, ${boxes.length} box(es)`);
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(dir, "regions.json"), `${JSON.stringify(regions, null, 2)}\n`);
  return regions;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.dir) { console.error("usage: diff-regions.mjs --dir <shots dir> [--project <dir>] [--cell 8] [--gap 3]"); process.exit(2); }
  await diffRegions({ dir: options.dir, chromium: await loadChromium(options.project ?? process.cwd()),
    cell: Number(options.cell ?? 8), gap: Number(options.gap ?? 3) });
}

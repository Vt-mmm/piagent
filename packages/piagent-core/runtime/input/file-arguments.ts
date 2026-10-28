import fs from "node:fs";
import path from "node:path";

import { checkChatPathAccess, supportedChatImageMimeType } from "./chat-images.ts";
import type { ChatImageAccessPolicy } from "./chat-images.ts";

// `pi @notes.md @screen.png "…"` reads each file before any extension runs and
// sends it as one <file name="/abs/path">…</file> block per argument, images
// attached in argument order. Pi applies no read policy, so `pi @.env` would
// hand a secret to the model. This holds those blocks to the same rule as a
// pasted image path: inside a granted root, not protected, within read scope.

export type FileArgumentReview = {
  text: string;
  images: unknown[];
  withheld: Array<{ path: string; reason: string }>;
};

type FileBlock = { path: string; start: number; end: number; image: boolean; attachesImage: boolean };

const BLOCK_OPEN = /<file name="([^"\n]+)">/g;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Walk the contiguous run of blocks Pi wrote. Each block's end is found from
// the file itself, so a file whose text contains "</file>" cannot end it early.
// undefined: a block no longer matches its file, and the run cannot be trusted.
function parseFileBlocks(text: string): FileBlock[] | undefined {
  BLOCK_OPEN.lastIndex = 0;
  const first = BLOCK_OPEN.exec(text);
  if (!first) return [];
  const blocks: FileBlock[] = [];
  let cursor = first.index;
  while (text.startsWith("<file name=\"", cursor)) {
    BLOCK_OPEN.lastIndex = cursor;
    const open = BLOCK_OPEN.exec(text);
    if (!open || open.index !== cursor || !path.isAbsolute(open[1])) break;
    const filePath = open[1];
    const bodyStart = cursor + open[0].length;
    let bytes: Buffer;
    try { bytes = fs.readFileSync(filePath); } catch { return undefined; }
    if (supportedChatImageMimeType(bytes) || !text.startsWith("\n", bodyStart)) {
      // An image block holds nothing, or a one-line note from Pi.
      const close = text.indexOf("</file>\n", bodyStart);
      if (close < 0) return undefined;
      const note = text.slice(bodyStart, close);
      blocks.push({ path: filePath, start: cursor, end: close + 8, image: true,
        attachesImage: !note.startsWith("[Image omitted") });
      cursor = close + 8;
      continue;
    }
    const expected = `\n${stripBom(bytes.toString("utf8"))}\n</file>\n`;
    if (!text.startsWith(expected, bodyStart)) return undefined;
    blocks.push({ path: filePath, start: cursor, end: bodyStart + expected.length, image: false, attachesImage: false });
    cursor = bodyStart + expected.length;
  }
  return blocks;
}

/** Withhold Pi @file blocks the read policy does not allow; undefined when there is nothing to change. */
export function reviewFileArguments(
  text: string,
  existingImages: unknown[] | undefined,
  cwd: string,
  resolveAccess: () => ChatImageAccessPolicy
): FileArgumentReview | undefined {
  if (!text.includes("<file name=\"")) return undefined;
  const images = Array.isArray(existingImages) ? existingImages : [];
  const blocks = parseFileBlocks(text);
  if (blocks === undefined) {
    return { text: "", images: [], withheld: [{ path: "(@file arguments)", reason: "a file changed while Pi was reading it" }] };
  }
  if (blocks.length === 0) return undefined;
  const access = resolveAccess();
  const withheld: FileArgumentReview["withheld"] = [];
  const droppedImages = new Set<number>();
  const imageBlocks = blocks.filter((block) => block.attachesImage);
  // Pi attaches only its file images to the first message; any other count
  // means the order cannot be matched, so a withheld image drops them all.
  const imagesMatch = imageBlocks.length === images.length;
  let nextText = "";
  let cursor = 0;
  for (const block of blocks) {
    const checked = checkChatPathAccess(block.path, cwd, access);
    if (checked.status === "ok") continue;
    withheld.push({ path: block.path, reason: checked.reason });
    nextText += text.slice(cursor, block.start)
      + `<file name="${block.path}">[Withheld by Piagent: ${checked.reason}]</file>\n`;
    cursor = block.end;
    if (!block.attachesImage) continue;
    if (!imagesMatch) images.forEach((_, index) => droppedImages.add(index));
    else droppedImages.add(imageBlocks.indexOf(block));
  }
  if (withheld.length === 0) return undefined;
  return {
    text: nextText + text.slice(cursor),
    images: images.filter((_, index) => !droppedImages.has(index)),
    withheld
  };
}

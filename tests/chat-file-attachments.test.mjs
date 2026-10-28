import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  attachLocalImagesFromText,
  extractLocalImagePathCandidates,
  readChatImage
} from "../packages/piagent-core/runtime/input/chat-images.ts";
import { reviewFileArguments } from "../packages/piagent-core/runtime/input/file-arguments.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4h8AAAAASUVORK5CYII=", "base64");
const cleanup = new Set();
afterEach(() => {
  for (const item of cleanup) fs.rmSync(item, { recursive: true, force: true });
  cleanup.clear();
});

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-attach-")));
  cleanup.add(root);
  return root;
}

function access(cwd, readProtectedPaths = []) {
  return { roots: [{ path: cwd, source: "project" }], readProtectedPaths, enforceFilesystemRead: false };
}

// The exact text Pi's file processor writes for one @file argument.
function textBlock(file) {
  return `<file name="${file}">\n${fs.readFileSync(file, "utf8")}\n</file>\n`;
}

describe("chat file and image attachments", () => {
  it("attaches images named the way Pi's @ completion writes them", () => {
    const cwd = project();
    fs.mkdirSync(path.join(cwd, "docs"));
    fs.writeFileSync(path.join(cwd, "docs", "ui.png"), PNG);
    fs.writeFileSync(path.join(cwd, "a b.png"), PNG);

    assert.deepEqual(extractLocalImagePathCandidates("compare @docs/ui.png with @\"a b.png\"", cwd).sort(),
      [path.join(cwd, "a b.png"), path.join(cwd, "docs", "ui.png")]);
    assert.deepEqual(extractLocalImagePathCandidates("mail me at me@host.png", cwd), []);
    const attached = attachLocalImagesFromText("what is wrong in @docs/ui.png", [], cwd, () => access(cwd));
    assert.equal(attached?.images.length, 1);
  });

  it("does not attach a second copy of an image Pi already attached from @file", () => {
    const cwd = project();
    const image = path.join(cwd, "screen.png");
    fs.writeFileSync(image, PNG);
    assert.deepEqual(extractLocalImagePathCandidates(`<file name="${image}"></file>\nDescribe it`, cwd), []);
  });

  it("finds a file dropped on the terminal with shell escapes", { skip: process.platform === "win32" }, () => {
    const cwd = project();
    const image = path.join(cwd, "Screenshot 1.png");
    fs.writeFileSync(image, PNG);
    const escaped = image.replace(/ /g, "\\ ");
    assert.deepEqual(extractLocalImagePathCandidates(`look ${escaped}`, cwd), [image]);
  });

  it("accepts an image Pi saved from the clipboard, but nothing else in the temporary folder", () => {
    const cwd = project();
    const temporary = fs.realpathSync.native(os.tmpdir());
    const pasted = path.join(temporary, `pi-clipboard-${randomUUID()}.png`);
    const other = path.join(temporary, `other-${randomUUID()}.png`);
    for (const file of [pasted, other]) { fs.writeFileSync(file, PNG); cleanup.add(file); }

    assert.equal(readChatImage(pasted, cwd, access(cwd)).status, "ok");
    const rejected = readChatImage(other, cwd, access(cwd));
    assert.equal(rejected.status, "error");
    assert.match(rejected.reason, /additionalReadRoots/);
    assert.equal(readChatImage(pasted, cwd, access(cwd, ["pi-clipboard-*.png"])).status, "error");
  });

  it("withholds a protected @file argument and keeps the rest", () => {
    const cwd = project();
    const notes = path.join(cwd, "notes.md"), secret = path.join(cwd, ".env");
    fs.writeFileSync(notes, "# Notes\n</file>\nstill notes");
    fs.writeFileSync(secret, "TOKEN=sk-live-123");
    const text = `${textBlock(notes)}${textBlock(secret)}Summarize these`;

    const reviewed = reviewFileArguments(text, [], cwd, () => access(cwd, [".env"]));
    assert.equal(reviewed?.withheld.length, 1);
    assert.doesNotMatch(reviewed.text, /sk-live-123/);
    assert.match(reviewed.text, /still notes/);
    assert.match(reviewed.text, /Withheld by Piagent: matches protected path \.env/);
    assert.match(reviewed.text, /Summarize these$/);
    assert.equal(reviewFileArguments(text, [], cwd, () => access(cwd)), undefined);
  });

  it("drops the image of a withheld @file image and keeps the others in order", () => {
    const cwd = project();
    const shown = path.join(cwd, "shown.png"), hidden = path.join(cwd, "confidential", "hidden.png");
    fs.mkdirSync(path.dirname(hidden));
    fs.writeFileSync(shown, PNG);
    fs.writeFileSync(hidden, Buffer.concat([PNG, Buffer.from([0])]));
    const images = [{ type: "image", mimeType: "image/png", data: "hidden" }, { type: "image", mimeType: "image/png", data: "shown" }];
    const text = `<file name="${hidden}"></file>\n<file name="${shown}"></file>\nCompare`;

    const reviewed = reviewFileArguments(text, images, cwd, () => access(cwd, ["confidential/**"]));
    assert.deepEqual(reviewed?.images.map((image) => image.data), ["shown"]);
    assert.equal(reviewed?.withheld[0].path, hidden);
  });

  it("withholds a file outside the project", () => {
    const cwd = project(), elsewhere = project();
    const outside = path.join(elsewhere, "keys.txt");
    fs.writeFileSync(outside, "secret-xyz");
    const reviewed = reviewFileArguments(`${textBlock(outside)}Read it`, [], cwd, () => access(cwd));
    assert.match(reviewed?.withheld[0].reason ?? "", /outside the project/);
    assert.doesNotMatch(reviewed.text, /secret-xyz/);
  });

  it("refuses the message when a block no longer matches its file", () => {
    const cwd = project();
    const notes = path.join(cwd, "notes.md");
    fs.writeFileSync(notes, "old");
    const text = `${textBlock(notes)}Go`;
    fs.writeFileSync(notes, "new and different");
    assert.equal(reviewFileArguments(text, [], cwd, () => access(cwd))?.text, "");
  });
});

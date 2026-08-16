#!/usr/bin/env node
// Fails when one side of a bilingual pair has moved and the other has not.
//
// The existing language gate proves the Vietnamese peer exists. Existing is not
// the same as saying the same thing: editing docs/en/architecture.md and
// forgetting docs/vi/architecture.md passes every check in this repository,
// and the reader of the stale side has no way to know.
//
// So each pair carries the content digest of both sides as of the last time
// somebody confirmed them consistent. A digest that no longer matches means the
// record is stale, and the fix is to bring the other side along and re-record.
//
// What this cannot do is read the two documents and decide they agree. It is a
// record that a human looked, nothing more -- which is worth exactly as much as
// the honesty of whoever runs --write.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function contentDigest(text) {
  // Newline-normalised so a checkout on another platform does not read as drift.
  return createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex").slice(0, 40);
}

export function digestForFile(root, relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return null;
  return contentDigest(fs.readFileSync(file, "utf8"));
}

/**
 * @param {{root?: string, manifest?: object}} options
 * @returns {{ok: boolean, checked: number, unrecorded: string[], drifted: object[], stale: object[], missing: string[]}}
 */
export function inspectPairing({ root = repositoryRoot, manifest } = {}) {
  const languages = manifest
    ?? JSON.parse(fs.readFileSync(path.join(root, "docs", "languages.json"), "utf8"));
  const result = { ok: true, checked: 0, unrecorded: [], drifted: [], stale: [], missing: [] };

  for (const pair of languages.pairs ?? []) {
    const current = { en: digestForFile(root, pair.en), vi: digestForFile(root, pair.vi) };
    for (const side of ["en", "vi"]) {
      if (current[side] === null) result.missing.push(`${pair.topic}: ${pair[side]} does not exist`);
    }
    if (current.en === null || current.vi === null) { result.ok = false; continue; }

    result.checked += 1;
    const recorded = pair.consistentAt;
    if (!recorded) { result.unrecorded.push(pair.topic); result.ok = false; continue; }

    const movedSides = ["en", "vi"].filter((side) => recorded[side] !== current[side]);
    if (movedSides.length === 0) continue;
    result.ok = false;
    // One side moving alone is the failure this exists for: the other side is
    // now describing something that changed. Both moving is likely a paired
    // edit, but nothing here can prove it, so it still needs re-recording.
    const entry = { topic: pair.topic, moved: movedSides, en: pair.en, vi: pair.vi };
    if (movedSides.length === 1) result.drifted.push(entry);
    else result.stale.push(entry);
  }
  return result;
}

function record(root) {
  const file = path.join(root, "docs", "languages.json");
  const languages = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const pair of languages.pairs ?? []) {
    const en = digestForFile(root, pair.en);
    const vi = digestForFile(root, pair.vi);
    if (en === null || vi === null) continue;
    pair.consistentAt = { en, vi };
  }
  fs.writeFileSync(file, `${JSON.stringify(languages, null, 2)}\n`);
  return languages.pairs.length;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  const write = process.argv.includes("--write");
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    console.log(`Usage:
  node scripts/verify-translation-pairing.mjs [--write]

Checks that neither side of a bilingual documentation pair has moved since the
two were last confirmed consistent. --write re-records the current state, which
is a claim that you brought both sides into line.`);
    process.exit(0);
  }
  if (write) {
    console.log(`Recorded ${record(repositoryRoot)} pairs as consistent.`);
    process.exit(0);
  }

  const result = inspectPairing();
  if (result.ok) {
    console.log(`PASS: ${result.checked} bilingual pairs match their recorded state`);
    process.exit(0);
  }
  for (const line of result.missing) console.error(`FAIL: ${line}`);
  for (const topic of result.unrecorded) {
    console.error(`FAIL: ${topic} has no recorded consistent state.`);
  }
  for (const entry of result.drifted) {
    const moved = entry.moved[0];
    const other = moved === "en" ? "vi" : "en";
    console.error(`FAIL: ${entry.topic}: ${entry[moved]} changed and ${entry[other]} did not.`);
    console.error(`      Bring ${entry[other]} along, then re-record.`);
  }
  for (const entry of result.stale) {
    console.error(`FAIL: ${entry.topic}: both sides changed, so the record no longer says anything.`);
    console.error(`      Confirm they still agree, then re-record.`);
  }
  console.error("\nRe-record with: node scripts/verify-translation-pairing.mjs --write");
  process.exit(1);
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  evaluateExecPolicyCore,
  findProtectedPathInCommand,
  matchesProtectedPath,
  unresolvedPathExpansions
} from "../packages/piagent-core/extensions/policy-core.js";

// Round after round, the same bug arrived wearing a different hat: a way of
// spelling a word that the shell understands and this module did not. Every one
// of them was found by a person typing into a shell and comparing, and every
// fix came with cases chosen from near the last one -- so the next spelling was
// always somewhere nobody had thought to look.
//
// This stops choosing. It assembles spellings out of the pieces the shell
// composes -- quotes, escapes, ANSI-C, braces, ranges, `printf`, parameter
// expansion -- asks `bash` which words they produce, and requires the policy to
// account for what that word list contains, through several command shapes for
// each spelling. The spellings nobody would have written down are the point.
//
// Nothing here is executed as a command. Only the operand is handed to a shell,
// inside `for w in ...`, and the grammar emits no redirection, no separator and
// no producer beyond `printf` and `echo`.

const policy = {
  protectedPaths: [".git/**", "**/auth.json", "**/.env", "**/.env.*"],
  shellProtectedPaths: [".git/**", "**/auth.json", "**/.env", "**/.env.*"],
  blockedCommandPatterns: ["rm -rf /", "rm -rf ~"],
  requireConfirmationPatterns: [],
  execPolicy: { defaultMode: "enforce", bannedPrefixSuggestions: [], rules: [] }
};

/** Seeded, so a failure names a command that can be pasted into a shell again. */
function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each of these rewrites one literal chunk into a shell fragment that produces
// that chunk again. They only ever consume plain text, so any number of them can
// be concatenated and the result still parses -- which is what lets the
// generator build spellings deeper than anything written by hand without ever
// emitting something bash refuses to read.
const CHUNK_SPELLINGS = [
  (chunk) => chunk,
  (chunk) => `"${chunk}"`,
  (chunk) => `'${chunk}'`,
  // A backslash before an ordinary character is removed.
  (chunk, cut) => (/[A-Za-z]/.test(chunk[cut] ?? "") ? `${chunk.slice(0, cut)}\\${chunk.slice(cut)}` : chunk),
  // ANSI-C quoting decodes before the word is used.
  (chunk) => `$'${[...chunk].map((c) => `\\x${c.charCodeAt(0).toString(16)}`).join("")}'`,
  (chunk) => `$(printf %s ${chunk})`,
  (chunk) => `$(echo -n ${chunk})`,
  (chunk, cut) => `$(printf %s%s ${chunk.slice(0, cut) || "''"} ${chunk.slice(cut) || "''"})`,
  // A conversion printing nothing lets the literal text on either side meet.
  (chunk, cut) => `$(printf ${chunk.slice(0, cut)}%.0s${chunk.slice(cut)} x)`,
  // A precision cuts the argument down to the character the name needs, so the
  // name exists in neither the format nor the argument.
  (chunk, cut) => (cut < chunk.length
    ? `$(printf ${chunk.slice(0, cut)}%.1s${chunk.slice(cut + 1)} ${chunk[cut]}Z)`
    : chunk),
  // An empty alternative: the group yields the chunk and a shorter word.
  (chunk, cut) => `{${chunk.slice(0, cut)},}${chunk.slice(cut)}`,
  // A single-member range is one letter with the braces taken off.
  (chunk, cut) => (/[A-Za-z]/.test(chunk[cut] ?? "")
    ? `${chunk.slice(0, cut)}{${chunk[cut]}..${chunk[cut]}}${chunk.slice(cut + 1)}`
    : chunk),
  (chunk) => `\${UNSET_FOR_TEST:-${chunk}}`,
  // The alternate branch of a variable that is set: nothing about the value
  // reaches the word, only the text written beside it.
  (chunk) => `\${SET_FOR_TEST:+${chunk}}`
];

/** Cut a word into pieces and spell each one independently. */
function buildSpelling(word, random) {
  const cuts = new Set();
  const pieces = 1 + Math.floor(random() * 3);
  for (let index = 0; index < pieces - 1; index += 1) cuts.add(1 + Math.floor(random() * Math.max(1, word.length - 1)));
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), word.length];
  let spelling = "";
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const chunk = word.slice(bounds[index], bounds[index + 1]);
    if (!chunk) continue;
    const spell = CHUNK_SPELLINGS[Math.floor(random() * CHUNK_SPELLINGS.length)];
    spelling += spell(chunk, Math.floor(random() * chunk.length));
  }
  return spelling || word;
}

/** One bash call for the whole corpus: the words each spelling produces. */
function wordListsFromBash(spellings) {
  const script = ["SET_FOR_TEST=x", ...spellings.map((spelling, index) =>
    `printf 'CASE${index}\\n'; for w in ${spelling}; do printf '[%s]' "$w"; done; printf '\\n'`)].join("\n");
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  const lists = new Map();
  const lines = result.stdout.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^CASE(\d+)$/.exec(lines[index]);
    if (!marker) continue;
    lists.set(Number(marker[1]), [...(lines[index + 1] ?? "").matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]));
  }
  return { lists, stderr: result.stderr };
}

const bashProbe = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" });
const bashAvailable = bashProbe.status === 0 && bashProbe.stdout === "ok";

describe("shell spelling differential", () => {
  const READ_TARGETS = [".env", "auth.json", ".env.local", "notes.txt", "README.md"];
  // The same spelling put in front of several readers. A spelling understood as
  // an operand and lost as a pipeline producer is still a hole.
  const READ_SHAPES = [
    (spelling) => `cat ${spelling}`,
    (spelling) => `head -n 1 ${spelling}`,
    (spelling) => `{cat,${spelling}}`,
    (spelling) => `echo ${spelling} | xargs cat`
  ];

  const random = randomSource(0x5eed);
  const spellings = [];
  for (let index = 0; index < 200; index += 1) {
    const target = READ_TARGETS[Math.floor(random() * READ_TARGETS.length)];
    spellings.push({ target, spelling: buildSpelling(target, random) });
  }

  const read = bashAvailable ? wordListsFromBash(spellings.map((entry) => entry.spelling)) : undefined;

  it("builds a word list for every generated spelling", { skip: !bashAvailable }, () => {
    // A spelling bash cannot parse ends the batch and takes every later case
    // with it. Without this the suite stays green while checking almost
    // nothing, which is the failure this whole file exists to prevent.
    assert.equal(read.lists.size, spellings.length, `bash rejected a generated spelling:\n${read.stderr}`);
  });

  it("accounts for every protected path bash builds", { skip: !bashAvailable }, () => {
    const misses = [];
    let checked = 0;
    for (let index = 0; index < spellings.length; index += 1) {
      const words = read.lists.get(index) ?? [];
      const target = words.find((word) => word && matchesProtectedPath(word, policy.shellProtectedPaths));
      if (!target) continue;
      for (const shape of READ_SHAPES) {
        const command = shape(spellings[index].spelling);
        checked += 1;
        // Reading the path or refusing the command as unresolvable are both
        // answers. Only saying nothing is a miss.
        const seen = findProtectedPathInCommand(command, policy.shellProtectedPaths);
        const refused = unresolvedPathExpansions(command).length > 0;
        if (!seen && !refused) misses.push(`${command}\n    bash opens ${target}`);
      }
    }
    assert.deepEqual(misses, [], `spellings reaching a protected path unseen:\n${misses.join("\n")}`);
    assert.ok(checked >= 200, `only ${checked} protected spellings were exercised`);
  });

  it("does not answer for spellings that reach no protected path", { skip: !bashAvailable }, () => {
    // The other half of the invariant. A detector that says yes to everything
    // would pass the test above and be useless, so the benign targets in the
    // corpus have to come back clean unless the spelling is genuinely
    // unresolvable here.
    const noise = [];
    for (let index = 0; index < spellings.length; index += 1) {
      const words = read.lists.get(index) ?? [];
      if (words.some((word) => word && matchesProtectedPath(word, policy.shellProtectedPaths))) continue;
      const command = `cat ${spellings[index].spelling}`;
      const seen = findProtectedPathInCommand(command, policy.shellProtectedPaths);
      if (seen) noise.push(`${command}\n    reported ${seen}, bash opens ${words.join(" ")}`);
    }
    assert.deepEqual(noise, [], `benign spellings reported as protected:\n${noise.join("\n")}`);
  });
});

describe("shell spelling differential, destructive direction", () => {
  const DESTRUCTIVE_SHAPES = [
    (spelling) => `rm -rf ${spelling}`,
    (spelling) => `rm -fr ${spelling}`,
    (spelling) => `find ${spelling} -delete`,
    (spelling) => `{rm,-rf,${spelling}}`
  ];

  const random = randomSource(0xd00d);
  const spellings = [];
  for (let index = 0; index < 60; index += 1) spellings.push(buildSpelling("/", random));

  const removal = bashAvailable ? wordListsFromBash(spellings) : undefined;

  it("builds a word list for every generated spelling", { skip: !bashAvailable }, () => {
    assert.equal(removal.lists.size, spellings.length, `bash rejected a generated spelling:\n${removal.stderr}`);
  });

  it("never permits a removal bash would aim at root", { skip: !bashAvailable }, () => {
    const permitted = [];
    let checked = 0;
    for (let index = 0; index < spellings.length; index += 1) {
      const words = removal.lists.get(index) ?? [];
      if (!words.some((word) => word === "/")) continue;
      for (const shape of DESTRUCTIVE_SHAPES) {
        const command = shape(spellings[index]);
        checked += 1;
        if (evaluateExecPolicyCore(command, { policy, mode: "enforce" }).decision === "allow") permitted.push(command);
      }
    }
    assert.deepEqual(permitted, [], `removals of root that were permitted:\n${permitted.join("\n")}`);
    assert.ok(checked >= 100, `only ${checked} root spellings were exercised`);
  });
});

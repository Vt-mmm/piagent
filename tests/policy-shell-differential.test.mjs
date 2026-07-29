import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  evaluateExecPolicyCore,
  extractShellGlobCandidates,
  findProtectedPathInCommand,
  matchesProtectedPath,
  unresolvedPathExpansions
} from "../packages/piagent-core/extensions/policy-core.js";

// Round after round, the same bug arrived wearing a different hat: a way of
// spelling a word that the shell understands and this module did not. Every one
// was found by a person typing into a shell, and every fix came with cases
// chosen from near the last one -- so the next spelling was always somewhere
// nobody had thought to look.
//
// The bug was never really the spelling, though. It was that a segment had a
// dozen readers and each derived its own view of it, so closing a form for one
// reader left it open for the other eleven: brace expansion reached the
// destructive checks and not the rule matcher, substitution resolution reached
// the destructive checks and nothing else at all. The shape of the bug space is
// expansion form x position x reader, so that is the shape of this corpus. It
// assembles spellings out of the pieces a shell composes, asks `bash` which
// words each one builds, and puts every spelling in every position: the command
// name, the operand, a flag's argument, a redirection target, a pipeline
// producer, an `xargs` consumer, an interpreter payload.
//
// Nothing here is executed as a command. Only the spelled fragments go to a
// shell, inside `for w in ...`; the assembled command only ever reaches the
// policy. The grammar emits no redirection, no separator, and no producer
// beyond `printf`, `echo` and `eval printf`.

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

// Each rewrites one literal chunk into a shell fragment that produces it again.
// They only ever consume plain text, so any number of them can be concatenated
// and the result still parses -- which is what lets this build spellings deeper
// than anything written by hand without emitting something bash refuses to read.
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
  (chunk) => `\`printf %s ${chunk}\``,
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
  // The alternate branch of a variable that is set: nothing of the value reaches
  // the word, only the text written beside it -- and nothing here can know the
  // variable is set, so this is the form that has to fail closed.
  (chunk) => `\${SET_FOR_TEST:+${chunk}}`,
  // Bodies this module refuses to evaluate, for the same reason: a nested
  // substitution and an `eval` are values known only at run time.
  (chunk) => `$(printf %s $(printf %s ${chunk}))`,
  (chunk) => `$(eval printf %s ${chunk})`
];

/** Cut a word into pieces and spell each one independently. */
function buildSpelling(word, random) {
  const cuts = new Set();
  const pieces = 1 + Math.floor(random() * 3);
  for (let index = 0; index < pieces - 1; index += 1) {
    cuts.add(1 + Math.floor(random() * Math.max(1, word.length - 1)));
  }
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

// Expansion runs in a scratch directory holding names a protected pattern
// matches, because that is the only way to tell an active glob from a quoted
// one: `for w in .env*` and `for w in '.env*'` both yield `.env*` where nothing
// matches, and only the first becomes `.env.local` where something does. The
// directory holds two empty files and never leaves the temp root.
const globFixture = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-glob-"));
fs.writeFileSync(path.join(globFixture, ".env.local"), "");
fs.writeFileSync(path.join(globFixture, "auth.json"), "");
fs.writeFileSync(path.join(globFixture, "README.md"), "");
fs.writeFileSync(path.join(globFixture, "notes.txt"), "");

/** One bash call per batch: the words each spelled fragment builds. */
function wordListsFromBash(fragments) {
  const script = ["SET_FOR_TEST=x", ...fragments.map((fragment, index) =>
    `printf 'C${index}\\n'; for w in ${fragment}; do printf '[%s]' "$w"; done; printf '\\n'`)].join("\n");
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024, cwd: globFixture
  });
  const lists = new Map();
  const lines = result.stdout.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^C(\d+)$/.exec(lines[index]);
    if (!marker) continue;
    lists.set(Number(marker[1]), [...(lines[index + 1] ?? "").matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]));
  }
  return { lists, stderr: result.stderr };
}

// Where the spelled word sits. `spell` names the two words the position needs:
// the command and the target.
const READ_POSITIONS = [
  { name: "operand", spell: ["cat", ".env"], make: (c, t) => `${c} ${t}` },
  { name: "operand-after-flag", spell: ["head", ".env"], make: (c, t) => `${c} -n 1 ${t}` },
  { name: "redirect-target", spell: ["printf", ".env"], make: (c, t) => `${c} x > ${t}` },
  { name: "pipeline-producer", spell: ["echo", ".env"], make: (c, t) => `${c} ${t} | xargs cat` },
  { name: "xargs-consumer", spell: ["xargs", ".env"], make: (c, t) => `echo ${t} | ${c} cat` },
  { name: "interpreter-payload", spell: ["cat", ".env"], make: (c, t) => `bash -c '${c} ${t}'` },
  { name: "interpreter-name", spell: ["bash", ".env"], make: (c, t) => `${c} -c 'cat ${t}'` },
  { name: "search-file-flag", spell: ["grep", ".env"], make: (c, t) => `${c} -f ${t} README.md` },
  { name: "copy-source", spell: ["cp", ".env"], make: (c, t) => `${c} ${t} /tmp/x` }
];

const DESTRUCTIVE_POSITIONS = [
  { name: "rm-target", spell: ["rm", "/"], make: (c, t) => `${c} -rf ${t}` },
  { name: "find-target", spell: ["find", "/"], make: (c, t) => `${c} ${t} -delete` },
  { name: "xargs-rm", spell: ["rm", "/"], make: (c, t) => `echo ${t} | xargs ${c} -rf` },
  { name: "interpreter-rm", spell: ["rm", "/"], make: (c, t) => `bash -c '${c} -rf ${t}'` }
];

const BENIGN_TARGETS = ["notes.txt", "README.md"];
// A pattern is the one thing the literal reader cannot answer for: `.env*`
// matches no protected literal, so only the glob reader stands between it and
// the file. This corpus had no `*` in it at all, which is why it reported clean
// while `{cat,.env*}` read a secret -- a spelling axis missing from the grammar
// is a class of defect the generator cannot reach.
const GLOB_TARGETS = [".env*", "auth.js*"];
const SEEDS = [0x5eed, 0xd00d, 0xbeef];
const PER_POSITION = 22;

const bashProbe = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" });
const bashAvailable = bashProbe.status === 0 && bashProbe.stdout === "ok";

/** Build one seed's jobs and resolve every fragment through bash at once. */
function runSeed(seed) {
  const random = randomSource(seed);
  const jobs = [];
  for (const position of READ_POSITIONS) {
    for (let index = 0; index < PER_POSITION; index += 1) {
      const target = random() < 0.75
        ? position.spell[1]
        : BENIGN_TARGETS[Math.floor(random() * BENIGN_TARGETS.length)];
      jobs.push({ position, commandWord: position.spell[0], targetWord: target, destructive: false });
    }
  }
  for (const position of READ_POSITIONS) {
    for (let index = 0; index < PER_POSITION; index += 1) {
      const target = GLOB_TARGETS[Math.floor(random() * GLOB_TARGETS.length)];
      jobs.push({ position, commandWord: position.spell[0], targetWord: target, glob: true });
    }
  }
  for (const position of DESTRUCTIVE_POSITIONS) {
    for (let index = 0; index < PER_POSITION; index += 1) {
      jobs.push({ position, commandWord: position.spell[0], targetWord: "/", destructive: true });
    }
  }
  for (const job of jobs) {
    job.commandSpelling = buildSpelling(job.commandWord, random);
    job.targetSpelling = buildSpelling(job.targetWord, random);
  }
  const fragments = jobs.flatMap((job) => [job.commandSpelling, job.targetSpelling]);
  return { jobs, fragments, ...wordListsFromBash(fragments) };
}

const runs = bashAvailable ? SEEDS.map(runSeed) : [];

describe("shell spelling differential", () => {
  it("builds a word list for every generated spelling", { skip: !bashAvailable }, () => {
    // A spelling bash cannot parse ends the batch and takes every later case
    // with it. Without this the suite stays green while checking a fraction of
    // what it claims -- which is exactly what the first version of this file
    // did, dying at case 36 of 240 and passing.
    for (const run of runs) {
      assert.equal(run.lists.size, run.fragments.length, `bash rejected a generated spelling:\n${run.stderr}`);
    }
  });

  it("accounts for every protected path bash builds, in every position", { skip: !bashAvailable }, () => {
    const misses = [];
    let checked = 0;
    for (const run of runs) {
      for (let index = 0; index < run.jobs.length; index += 1) {
        const job = run.jobs[index];
        if (job.destructive) continue;
        const commandWords = run.lists.get(index * 2);
        const targetWords = run.lists.get(index * 2 + 1);
        // A spelling that did not round-trip to the word it claims has nothing
        // to assert about.
        if (!commandWords?.includes(job.commandWord)) continue;
        if (!targetWords?.includes(job.targetWord)) continue;
        if (!targetWords.some((word) => word && matchesProtectedPath(word, policy.shellProtectedPaths))) continue;
        checked += 1;
        const command = job.position.make(job.commandSpelling, job.targetSpelling);
        // Reading the path, refusing the command as unresolvable, or gating it
        // on a decision are all answers. Only silence is a miss.
        const seen = findProtectedPathInCommand(command, policy.shellProtectedPaths);
        const refused = unresolvedPathExpansions(command).length > 0;
        const gated = evaluateExecPolicyCore(command, { policy, mode: "enforce" }).decision !== "allow";
        if (!seen && !refused && !gated) {
          misses.push(`${job.position.name}: ${command}\n      bash builds: ${targetWords.join(" ")}`);
        }
      }
    }
    assert.deepEqual(misses, [], `spellings reaching a protected path unseen:\n${misses.join("\n")}`);
    assert.ok(checked >= 400, `only ${checked} protected spellings were exercised`);
  });

  it("accounts for every pattern bash matches to a protected file", { skip: !bashAvailable }, () => {
    const misses = [];
    let checked = 0;
    for (const run of runs) {
      for (let index = 0; index < run.jobs.length; index += 1) {
        const job = run.jobs[index];
        if (!job.glob) continue;
        const commandWords = run.lists.get(index * 2);
        const targetWords = run.lists.get(index * 2 + 1);
        if (!commandWords?.includes(job.commandWord)) continue;
        // The pattern reached a protected name only if bash replaced it with
        // one. A spelling that quoted the `*` comes back as the pattern itself,
        // and there is nothing to answer for.
        if (!targetWords?.some((word) => word && matchesProtectedPath(word, policy.shellProtectedPaths))) continue;
        checked += 1;
        const command = job.position.make(job.commandSpelling, job.targetSpelling);
        const globbed = extractShellGlobCandidates(command).length > 0;
        const seen = findProtectedPathInCommand(command, policy.shellProtectedPaths);
        const refused = unresolvedPathExpansions(command).length > 0;
        const gated = evaluateExecPolicyCore(command, { policy, mode: "enforce" }).decision !== "allow";
        if (!globbed && !seen && !refused && !gated) {
          misses.push(`${job.position.name}: ${command}\n      bash matches: ${targetWords.join(" ")}`);
        }
      }
    }
    assert.deepEqual(misses, [], `patterns reaching a protected file unseen:\n${misses.join("\n")}`);
    assert.ok(checked >= 200, `only ${checked} glob spellings were exercised`);
  });

  it("never permits a removal bash would aim at root, in any position", { skip: !bashAvailable }, () => {
    const permitted = [];
    let checked = 0;
    for (const run of runs) {
      for (let index = 0; index < run.jobs.length; index += 1) {
        const job = run.jobs[index];
        if (!job.destructive) continue;
        const commandWords = run.lists.get(index * 2);
        const targetWords = run.lists.get(index * 2 + 1);
        if (!commandWords?.includes(job.commandWord)) continue;
        if (!targetWords?.some((word) => word === "/")) continue;
        checked += 1;
        const command = job.position.make(job.commandSpelling, job.targetSpelling);
        if (evaluateExecPolicyCore(command, { policy, mode: "enforce" }).decision === "allow") {
          permitted.push(`${job.position.name}: ${command}`);
        }
      }
    }
    assert.deepEqual(permitted, [], `removals of root that were permitted:\n${permitted.join("\n")}`);
    assert.ok(checked >= 200, `only ${checked} root spellings were exercised`);
  });

  it("stays quiet about spellings that reach nothing protected", { skip: !bashAvailable }, () => {
    // The other half of the invariant. A detector that answers for everything
    // would pass both tests above and be useless.
    const noise = [];
    const knownOverApproximation = [];
    for (const run of runs) {
      for (let index = 0; index < run.jobs.length; index += 1) {
        const job = run.jobs[index];
        if (job.destructive) continue;
        const targetWords = run.lists.get(index * 2 + 1);
        if (!targetWords?.includes(job.targetWord)) continue;
        if (targetWords.some((word) => word && matchesProtectedPath(word, policy.shellProtectedPaths))) continue;
        const command = job.position.make(job.commandSpelling, job.targetSpelling);
        const seen = findProtectedPathInCommand(command, policy.shellProtectedPaths);
        if (!seen) continue;
        // A producer's rendered output is offered as a candidate in its own
        // right, because where the word *is* the substitution that output is
        // the filename -- `cat $(printf .e%.1sv nv)` opens `.env` and no piece
        // of it contains that name. The body cannot see what surrounds it, so
        // where a quoted glob character is glued on, the same rule reports the
        // output rather than the longer name bash builds: `$(printf .env)"*"`
        // opens a file literally called `.env*` and this says `.env`.
        //
        // It over-reports, in the direction that costs a question rather than a
        // miss, and only for a name that carries a quoted `*` or `?`. It is
        // recorded here rather than excluded quietly, so the count is visible if
        // it ever grows.
        const literalGlob = targetWords.some((word) => /[*?]/.test(word) && word.startsWith(seen.candidate));
        (literalGlob ? knownOverApproximation : noise)
          .push(`${job.position.name}: ${command}\n      reported ${seen.candidate}`);
      }
    }
    assert.deepEqual(noise, [], `benign spellings reported as protected:\n${noise.join("\n")}`);
    assert.ok(
      knownOverApproximation.length <= 40,
      `the producer-output over-approximation grew to ${knownOverApproximation.length} cases:\n`
        + knownOverApproximation.slice(0, 5).join("\n")
    );
  });
});

// The fail-closed rules the corpus above forced into existence widen what gets
// asked about, and a net that catches everything is not a net. These are the
// commands a maintainer runs, and they have to stay out of the way.
describe("everyday commands keep their answer", () => {
  const everyday = [
    "npm test", "npm run build", "git status", "git commit -m \"fix: thing\"",
    "git commit -m \"$(date)\"", "rm -rf node_modules", "rm -rf dist build",
    "rm -rf $TMPDIR/build", "mkdir -p src/{a,b}", "cp file{,.bak}",
    "docker build --build-arg X=$(git rev-parse HEAD) .",
    "find . -name '*.js' | xargs grep -l TODO", "git diff --name-only | xargs cat",
    "cat README.md", "cat $HOME/notes.txt", "D=/tmp; cat $D/notes.txt",
    "echo $FOO", "npm run $SCRIPT", "gh pr create --title $T", "tar czf backup.tgz src",
    "node --test tests/", "find . -type f -name '*.log' -delete", "grep -r TODO src",
    "grep -f patterns.txt README.md", "curl -o out.json https://example.invalid",
    "git log --oneline | head -20", "ls -la", "echo \"$(pwd)\"",
    "PATH=$PATH:/opt/bin npm run build"
  ];

  for (const command of everyday) {
    it(`leaves alone: ${command}`, () => {
      assert.equal(evaluateExecPolicyCore(command, { policy, mode: "enforce" }).decision, "allow", command);
      assert.equal(findProtectedPathInCommand(command, policy.shellProtectedPaths), undefined, command);
      assert.deepEqual(unresolvedPathExpansions(command), [], command);
    });
  }
});

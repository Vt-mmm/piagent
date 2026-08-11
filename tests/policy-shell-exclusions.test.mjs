import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractShellGlobCandidates,
  extractShellPathCandidates,
  findProtectedPathInCommand,
  unresolvedPathExpansions
} from "../packages/piagent-core/extensions/policy-core.js";

const protectedPatterns = [".git/**", "**/auth.json", "**/.env", "**/.env.*", "**/node_modules/**"];

function assertNoProtectedAccess(command) {
  assert.equal(findProtectedPathInCommand(command, protectedPatterns), undefined, command);
  assert.deepEqual(unresolvedPathExpansions(command), [], command);
}

describe("shell exclusion selectors", () => {
  for (const command of [
    "grep -R PROBE --exclude-dir=node_modules .",
    "grep -R PROBE --exclude-dir .git .",
    "egrep -R PROBE --exclude='.env*' .",
    "fgrep -R PROBE --exclude auth.json .",
    "/usr/bin/grep -R PROBE --exclude-dir=.git .",
    "command grep -R PROBE --exclude-dir=node_modules .",
    "env grep -R PROBE --exclude-dir=node_modules .",
    "rg --glob '!.env*' PROBE .",
    "ripgrep --iglob '!auth.json' PROBE .",
    "rg -g'!.env*' PROBE .",
    "EXCLUDE='!.env*'; rg --glob \"$EXCLUDE\" PROBE .",
    "bash -c 'grep -R PROBE --exclude-dir=node_modules .'"
  ]) {
    it(`does not treat a search exclusion as an accessed path: ${command}`, () => {
      assertNoProtectedAccess(command);
      assert.deepEqual(extractShellGlobCandidates(command), [], command);
    });
  }

  for (const command of [
    "find . -not -path './.git/*'",
    "find . ! -path './.git/*'",
    "find . -not -name auth.json",
    "/usr/bin/find . -not -wholename './node_modules/*'",
    "command find . -not -regex '.*/\\.env\\..*'",
    "find . -not -path './.git/*' -type f -print"
  ]) {
    it(`does not treat a negated find selector as a traversed path: ${command}`, () => {
      assertNoProtectedAccess(command);
      const candidates = extractShellPathCandidates(command);
      assert.equal(candidates.some((candidate) => /(?:\.git|\.env|auth\.json|node_modules)/.test(candidate)), false, command);
    });
  }
});

describe("top-level find prune exclusions", () => {
  for (const command of [
    "find . -path './node_modules' -prune -o -type f -print | sort",
    "find . -wholename './node_modules' -prune -or -type f -print"
  ]) {
    it(`allows only the adjacent top-level prune-or exclusion shape: ${command}`, () => {
      assertNoProtectedAccess(command);
      assert.equal(extractShellPathCandidates(command).some((candidate) => candidate.includes("node_modules")), false, command);
    });
  }

  for (const command of [
    "find . ! \\( ! -path './.git/*' \\)",
    "find . \\( -path './node_modules' -prune \\) -o -type f -print",
    "find . ! -path './node_modules' -prune -o -type f -print",
    "find . -path './node_modules/*' -prune -o -type f -print",
    "find . -path './node_modules' -prune -exec echo {} \\;",
    "find . -path './node_modules' -prune -o -delete",
    "find . -path './node_modules' -prune -o -exec cat {} \\;",
    "find . -path './node_modules' -prune -o -ok cat {} \\;",
    "find . -path './node_modules' -prune -o -type f -print0 | xargs -0 cat",
    "find . -path './node_modules' -prune -o -path './.git/*' -print",
    "find . -not -path './.git/*' -o -exec cat .env \\;",
    "find . -not -path './.git/*' -o -path './.git/config' -print",
    "find . -not -path './.git/*' -o -exec cat {} \\;",
    "find . -not -path './.git/*' -o -delete",
    "find . -not -path './.git/*' -execdir cat {} \\;",
    "find . -not -path './.git/*' -type f -print0 | xargs -0 cat",
    "find . -not -path './.git/*' -fprint audit.txt",
    "find . -not -path './.git/*' , -print"
  ]) {
    it(`fails closed when grouping, negation, a non-or action, or a positive branch defeats exclusion: ${command}`, () => {
      assert.ok(findProtectedPathInCommand(command, protectedPatterns), command);
    });
  }

  it("fails closed for an unresolved selector inside a grouped prune expression", () => {
    assert.ok(unresolvedPathExpansions("find . \\( -path \"$ROOT/node_modules\" -prune \\) -o -print").length > 0);
  });
});

describe("exclusion selectors do not weaken positive protected-path checks", () => {
  for (const command of [
    "grep -R PROBE --exclude-dir=node_modules .env",
    "grep -R PROBE .git",
    "find . -path './.git/*'",
    "find . -not -not -path './.git/*'",
    "find . -name auth.json",
    "grep --exclude-from=.env PROBE .",
    "rg --ignore-file=.env PROBE .",
    "grep -f .env README.md",
    "/usr/bin/grep -R PROBE --exclude-dir=node_modules .env",
    "command find . -path './.git/*'",
    "find . -not -path './.git/*' > .env"
  ]) {
    it(`still identifies an actual protected access: ${command}`, () => {
      assert.ok(findProtectedPathInCommand(command, protectedPatterns), command);
    });
  }

  for (const command of ["grep -R PROBE --include='.env*' .", "rg --glob '.env*' PROBE ."]) {
    it(`keeps a positive protected glob visible to the guard: ${command}`, () => {
      assert.ok(extractShellGlobCandidates(command).includes(".env*"), command);
    });
  }

  for (const command of [
    "cat .en$SUFFIX",
    "printf x > .en$SUFFIX",
    "find . -path \"$ROOT/.git/*\"",
    "find . -not -not -path \"$ROOT/.git/*\"",
    "grep --include=.en$SUFFIX PROBE .",
    "grep --file=.en$SUFFIX PROBE .",
    "rg -g.en$SUFFIX PROBE .",
    "grep --exclude=.en$SUFFIX PROBE .",
    "rg --glob \"!.en$SUFFIX\" PROBE .",
    "find . -not -path \"$ROOT/.git/*\"",
    "find . -path \"$ROOT/node_modules\" -prune -o -type f -print"
  ]) {
    it(`continues to fail closed for an unresolved positive target: ${command}`, () => {
      assert.ok(unresolvedPathExpansions(command).length > 0, command);
    });
  }

  it("keeps fully resolved literal exclusion selectors out of the unresolved net", () => {
    assert.deepEqual(unresolvedPathExpansions("grep --exclude='.env*' PROBE ."), []);
    assert.deepEqual(unresolvedPathExpansions("rg --glob '!.env*' PROBE ."), []);
    assert.deepEqual(unresolvedPathExpansions("find . -not -path './.git/*'"), []);
  });
});

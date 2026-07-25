import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitShellSegments, shellWords } from "../packages/piagent-core/extensions/policy-core.js";
import {
  actionTokens,
  assignmentEndIndex,
  classifyActionTokenSequence,
  classifyExplicitActionValues,
  classifyToolNameAction,
  containsDynamicShellExpansion,
  curlRequiresConfirmation,
  executableBasename,
  externalCommandName,
  externalExecutableIndex,
  extractShellCommandInput,
  findShellExternalConfirmationReason,
  ghRequiresConfirmation,
  hasOption,
  inspectOptionValues,
  normalizeActionToken,
  normalizeShellCommandForPolicy,
  quoteShellArgument,
  wgetRequiresConfirmation
} from "../packages/piagent-core/extensions/guard-shell-analysis.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The shipped policy, not a copy of it. These decisions are only meaningful
// against the verbs the platform actually enforces.
const basePolicy = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "packages", "piagent-core", "policies", "base-policy.json"), "utf8")
);
const externalActionPolicy = {
  defaultMode: basePolicy.externalActionPolicy.defaultMode,
  providerKeywords: basePolicy.externalActionPolicy.providerKeywords,
  writeVerbs: basePolicy.externalActionPolicy.writeVerbs,
  safeVerbs: basePolicy.externalActionPolicy.safeVerbs
};

const NAMES = new Set(["gh", "curl", "wget"]);

function segmentsOf(command) {
  return splitShellSegments(command).map((segment) => ({ segment, words: shellWords(segment) }))
    .map(({ segment, words }) => ({ command: segment, words }));
}

function confirmationFor(command, policy = externalActionPolicy) {
  return findShellExternalConfirmationReason(segmentsOf(command), policy);
}

describe("action token classification", () => {
  it("splits camelCase and punctuation into the same token sequence", () => {
    assert.deepEqual(actionTokens("createPullRequest"), ["create", "pull", "request"]);
    assert.deepEqual(actionTokens("create_pull_request"), ["create", "pull", "request"]);
    assert.deepEqual(actionTokens("mcp__github__create-pull-request"), ["mcp", "github", "create", "pull", "request"]);
  });

  it("normalizes an action token to a stable slug", () => {
    assert.equal(normalizeActionToken("  Create__Pull-Request  "), "create-pull-request");
    assert.equal(normalizeActionToken("!!!"), "");
  });

  it("confirms a write verb", () => {
    const result = classifyActionTokenSequence(["create", "issue"], externalActionPolicy);
    assert.equal(result.decision, "confirm");
    assert.equal(result.kind, "write");
  });

  it("allows a plain read verb", () => {
    const result = classifyActionTokenSequence(["list", "issues"], externalActionPolicy);
    assert.equal(result.decision, "safe-read");
    assert.equal(result.kind, "safe");
  });

  it("confirms an unrecognised action rather than guessing", () => {
    // Deny by default: an action nobody classified is the one most likely to be
    // new, and a new external action is exactly what needs a human.
    const result = classifyActionTokenSequence(["frobnicate", "widget"], externalActionPolicy);
    assert.equal(result.decision, "confirm");
    assert.equal(result.kind, "ambiguous");
  });

  it("does not let a safe prefix launder a later write verb", () => {
    // get_update_file reads as safe on its first token only.
    const result = classifyActionTokenSequence(["get", "update", "file"], externalActionPolicy);
    assert.equal(result.decision, "confirm");
    assert.equal(result.action, "update");
  });

  it("keeps established reads whose noun collides with a write verb", () => {
    // "release" and "run" are configured write verbs, but get_release and
    // get_run are reads. Treating them as writes would prompt on every lookup.
    for (const tokens of [["get", "release"], ["get", "run"]]) {
      const result = classifyActionTokenSequence(tokens, externalActionPolicy);
      assert.equal(result.decision, "safe-read", `${tokens.join("_")} must stay a read`);
    }
  });

  it("prefers the most dangerous classification across explicit values", () => {
    const result = classifyExplicitActionValues(["list", "delete"], externalActionPolicy);
    assert.equal(result.kind, "write");
    assert.equal(result.action, "delete");
  });

  it("strips the mcp prefix and the provider before classifying a tool name", () => {
    // Otherwise the provider name itself could supply the verb.
    const write = classifyToolNameAction("mcp__github__create_issue", "github", externalActionPolicy);
    assert.equal(write.decision, "confirm");
    const read = classifyToolNameAction("mcp__github__list_issues", "github", externalActionPolicy);
    assert.equal(read.decision, "safe-read");
  });
});

describe("finding the executable a command really runs", () => {
  it("reduces a path to its basename", () => {
    assert.equal(executableBasename("/usr/local/bin/GH"), "gh");
    assert.equal(executableBasename("C:\\tools\\curl.exe"), "curl.exe");
  });

  it("resolves an executable held in a variable", () => {
    const aliases = new Map([["TOOL", "gh"]]);
    assert.equal(externalCommandName("$TOOL", NAMES, aliases), "gh");
    assert.equal(externalCommandName("${TOOL}", NAMES, aliases), "gh");
    assert.equal(externalCommandName("$OTHER", NAMES, aliases), undefined);
  });

  it("looks past leading environment assignments", () => {
    assert.equal(externalExecutableIndex(["FOO=1", "BAR=2", "gh", "pr", "create"], NAMES, new Map()), 2);
  });

  it("looks past wrappers that do not change what runs", () => {
    for (const words of [
      ["command", "gh", "pr", "create"],
      ["exec", "gh", "pr", "create"],
      ["nohup", "gh", "pr", "create"],
      ["time", "gh", "pr", "create"],
      ["env", "FOO=1", "gh", "pr", "create"],
      ["sudo", "-u", "root", "gh", "pr", "create"],
      ["nice", "-n", "5", "gh", "pr", "create"]
    ]) {
      const index = externalExecutableIndex(words, NAMES, new Map());
      assert.equal(words[index], "gh", `failed for: ${words.join(" ")}`);
    }
  });

  it("finds an executable smuggled through xargs or a package runner", () => {
    for (const words of [
      ["xargs", "gh", "pr", "create"],
      ["npx", "gh", "pr", "create"],
      ["bunx", "gh", "pr", "create"],
      ["pnpm", "dlx", "gh", "pr", "create"]
    ]) {
      const index = externalExecutableIndex(words, NAMES, new Map());
      assert.equal(words[index], "gh", `failed for: ${words.join(" ")}`);
    }
  });

  it("finds an executable behind find -exec", () => {
    const words = ["find", ".", "-name", "*.txt", "-exec", "curl", "-X", "POST", "{}", ";"];
    assert.equal(words[externalExecutableIndex(words, NAMES, new Map())], "curl");
  });

  it("fails closed on an unknown wrapper that still carries the executable", () => {
    const words = ["some-unknown-wrapper", "--flag", "gh", "pr", "create"];
    assert.equal(words[externalExecutableIndex(words, NAMES, new Map())], "gh");
  });

  it("does not treat a command that merely prints the name as running it", () => {
    // `echo gh pr create` writes text; gating it would train the operator to
    // click through prompts that never mattered.
    for (const words of [["echo", "gh", "pr", "create"], ["cat", "gh"], ["grep", "gh", "file.txt"]]) {
      assert.equal(externalExecutableIndex(words, NAMES, new Map()), undefined, `failed for: ${words.join(" ")}`);
    }
  });

  it("still inspects ripgrep when it is given a preprocessor", () => {
    // rg --pre runs an arbitrary program, so it is not a plain reader.
    const words = ["rg", "--pre", "curl", "pattern"];
    assert.notEqual(externalExecutableIndex(words, NAMES, new Map()), undefined);
  });
});

describe("dynamic command construction", () => {
  it("recognises every shell expansion form", () => {
    for (const value of ["$(gh)", "`gh`", "${TOOL}", "$TOOL", "$@", "$1"]) {
      assert.equal(containsDynamicShellExpansion(value), true, `missed: ${value}`);
    }
    assert.equal(containsDynamicShellExpansion("gh"), false);
  });

  it("confirms a command whose executable is built at run time", () => {
    // The guard cannot read what this resolves to, so it must not allow it.
    const reason = confirmationFor("$(printf gh) pr create");
    assert.match(reason ?? "", /dynamic executable/);
  });

  it("ends an assignment at its closing expansion", () => {
    const words = shellWords("TOOL=$(which gh) $TOOL pr create");
    assert.ok(assignmentEndIndex(words, 0) >= 0);
  });
});

describe("gh confirmation", () => {
  it("allows reads", () => {
    for (const command of ["gh pr list", "gh issue view 1", "gh repo view", "gh search issues x", "gh status"]) {
      assert.equal(confirmationFor(command), undefined, `should not prompt: ${command}`);
    }
  });

  it("confirms writes", () => {
    for (const command of ["gh pr create", "gh pr merge 1", "gh issue close 1", "gh release create v1", "gh repo delete"]) {
      assert.match(confirmationFor(command) ?? "", /gh/, `should prompt: ${command}`);
    }
  });

  it("allows help and version without a prompt", () => {
    for (const command of ["gh --help", "gh --version", "gh pr --help"]) {
      assert.equal(confirmationFor(command), undefined, `should not prompt: ${command}`);
    }
  });

  it("reads a gh api call by its method", () => {
    // No -X is gh's own default, which is GET, so a bare call is a read.
    assert.equal(ghRequiresConfirmation(["gh", "api", "/repos/o/r"]), false);
    assert.equal(ghRequiresConfirmation(["gh", "api", "-X", "GET", "/repos/o/r"]), false);
    assert.equal(ghRequiresConfirmation(["gh", "api", "-X", "DELETE", "/repos/o/r"]), true);
  });

  it("confirms a gh api call whose method option carries no value", () => {
    // -X with nothing after it is not a stated GET. Reading it as one would
    // make an unparseable command the cheapest way past the gate.
    assert.equal(ghRequiresConfirmation(["gh", "api", "-X"]), true);
  });

  it("confirms a bare gh api call that carries fields", () => {
    // gh api switches to POST as soon as it has fields.
    assert.equal(ghRequiresConfirmation(["gh", "api", "-f", "a=b", "/x"]), true);
  });

  it("confirms a gh api GET that carries fields under a non-GET method", () => {
    assert.equal(ghRequiresConfirmation(["gh", "api", "-X", "POST", "-f", "a=b", "/x"]), true);
  });

  it("does not let --repo values be read as the action", () => {
    assert.equal(confirmationFor("gh -R owner/repo pr list"), undefined);
  });
});

describe("curl confirmation", () => {
  it("allows a plain GET", () => {
    assert.equal(curlRequiresConfirmation(["curl", "-X", "GET", "https://example.com"]), false);
  });

  it("allows a bare fetch, which is curl's default GET", () => {
    assert.equal(curlRequiresConfirmation(["curl", "https://example.com"]), false);
  });

  it("confirms data that silently turns the request into a POST", () => {
    // -d without -G is the case where curl's default stops being a read.
    assert.equal(curlRequiresConfirmation(["curl", "-d", "a=b", "https://example.com"]), true);
  });

  it("confirms a method option left without a value", () => {
    assert.equal(curlRequiresConfirmation(["curl", "-X"]), true);
  });

  it("confirms uploads, forms, and config files", () => {
    for (const args of [
      ["curl", "-X", "GET", "-T", "file", "https://example.com"],
      ["curl", "-X", "GET", "-F", "a=b", "https://example.com"],
      ["curl", "-X", "GET", "-K", "config", "https://example.com"],
      ["curl", "-X", "GET", "--json", "{}", "https://example.com"]
    ]) {
      assert.equal(curlRequiresConfirmation(args), true, `should prompt: ${args.join(" ")}`);
    }
  });

  it("allows data sent under an explicit -G", () => {
    assert.equal(curlRequiresConfirmation(["curl", "-X", "GET", "-G", "-d", "a=b", "https://example.com"]), false);
  });

  it("confirms an FTP quote command that is not a known read", () => {
    assert.equal(curlRequiresConfirmation(["curl", "-X", "GET", "-Q", "DELE file", "ftp://example.com"]), true);
    assert.equal(curlRequiresConfirmation(["curl", "-X", "GET", "-Q", "PWD", "ftp://example.com"]), false);
  });
});

describe("wget confirmation", () => {
  it("allows a bare fetch, which is wget's default GET", () => {
    assert.equal(wgetRequiresConfirmation(["wget", "https://example.com"]), false);
  });

  it("allows an explicit GET", () => {
    assert.equal(wgetRequiresConfirmation(["wget", "--method=GET", "https://example.com"]), false);
  });

  it("confirms any other method", () => {
    assert.equal(wgetRequiresConfirmation(["wget", "--method=DELETE", "https://example.com"]), true);
  });

  it("confirms a method option left without a value", () => {
    assert.equal(wgetRequiresConfirmation(["wget", "--method="]), true);
  });

  it("confirms post bodies and executed configuration", () => {
    for (const args of [
      ["wget", "--method=GET", "--post-data", "a=b", "https://example.com"],
      ["wget", "--method=GET", "-e", "robots=off", "https://example.com"],
      ["wget", "--method=GET", "--body-file", "f", "https://example.com"]
    ]) {
      assert.equal(wgetRequiresConfirmation(args), true, `should prompt: ${args.join(" ")}`);
    }
  });
});

describe("confirmation across a whole command line", () => {
  it("sees a write hidden after a harmless first segment", () => {
    assert.match(confirmationFor("ls && gh pr create") ?? "", /gh/);
  });

  it("sees a write behind a pipe", () => {
    assert.match(confirmationFor("echo hi | gh pr create") ?? "", /gh/);
  });

  it("resolves an alias assigned earlier in the same command", () => {
    assert.match(confirmationFor("TOOL=gh; $TOOL pr create") ?? "", /gh/);
  });

  it("leaves unrelated commands alone", () => {
    for (const command of ["npm run build", "git status", "ls -la"]) {
      assert.equal(confirmationFor(command), undefined, `should not prompt: ${command}`);
    }
  });

  it("stays silent when the policy is advisory", () => {
    // Advisory mode is a deliberate operator choice; enforcing anyway would
    // make the setting a lie.
    const advisory = { ...externalActionPolicy, defaultMode: "advisory" };
    assert.equal(confirmationFor("gh pr create", advisory), undefined);
  });
});

describe("option parsing", () => {
  it("reads a value from both option spellings", () => {
    assert.deepEqual(inspectOptionValues(["-X", "POST"], "-X", "--method").values, ["POST"]);
    assert.deepEqual(inspectOptionValues(["--method=POST"], "-X", "--method").values, ["POST"]);
    assert.deepEqual(inspectOptionValues(["-XPOST"], "-X", "--method").values, ["POST"]);
  });

  it("reports a missing value rather than assuming one", () => {
    assert.equal(inspectOptionValues(["-X"], "-X", "--method").missing, true);
  });

  it("matches an option with an attached value", () => {
    assert.equal(hasOption(["-dfoo"], ["-d"]), true);
    assert.equal(hasOption(["--data=foo"], ["--data"]), true);
    assert.equal(hasOption(["--database"], ["-d"]), false);
  });
});

describe("shell command normalization", () => {
  it("joins a line continuation so the words stay one command", () => {
    assert.equal(normalizeShellCommandForPolicy("gh pr \\\ncreate"), "gh pr create");
  });

  it("strips a comment that starts a shell word", () => {
    assert.match(normalizeShellCommandForPolicy("ls # gh pr create"), /^ls\s*$/);
  });

  it("keeps a hash that is part of an argument", () => {
    // Dropping it would silently change the command being judged.
    assert.match(normalizeShellCommandForPolicy("curl https://example.com/#frag"), /#frag/);
  });

  it("keeps a hash inside quotes", () => {
    assert.match(normalizeShellCommandForPolicy(`echo "a # b"`), /a # b/);
  });
});

describe("reading the shell command out of tool input", () => {
  it("accepts a plain command", () => {
    assert.deepEqual(extractShellCommandInput({ command: "ls -la" }), { command: "ls -la" });
  });

  it("joins a command with its argument array", () => {
    assert.deepEqual(extractShellCommandInput({ command: "gh", args: ["pr", "create"] }), { command: "gh pr create" });
  });

  it("quotes an argument that would otherwise change the command", () => {
    const { command } = extractShellCommandInput({ command: "echo", args: ["a; rm -rf /"] });
    assert.match(command, /'a; rm -rf \/'/);
  });

  it("refuses conflicting command and cmd values", () => {
    // Two different commands in one payload: whichever the guard judged, the
    // runtime might run the other.
    assert.match(extractShellCommandInput({ command: "ls", cmd: "rm -rf /" }).reason ?? "", /conflicting/);
  });

  it("accepts command and cmd when they agree", () => {
    assert.deepEqual(extractShellCommandInput({ command: "ls", cmd: "ls" }), { command: "ls" });
  });

  it("refuses non-string carriers", () => {
    assert.match(extractShellCommandInput({ command: 42 }).reason ?? "", /must be a string/);
    assert.match(extractShellCommandInput({ cmd: {} }).reason ?? "", /must be a string/);
    assert.match(extractShellCommandInput({ args: [1, 2] }).reason ?? "", /array of strings/);
  });

  it("refuses an empty or missing command", () => {
    assert.match(extractShellCommandInput({ command: "   " }).reason ?? "", /1-/);
    assert.match(extractShellCommandInput({}).reason ?? "", /missing or unsupported/);
  });

  it("refuses input past the size limits instead of truncating it", () => {
    // Truncating would hand the policy a different command than the one that runs.
    assert.match(extractShellCommandInput({ args: Array(300).fill("x") }).reason ?? "", /too many args/);
    assert.match(extractShellCommandInput({ args: ["x".repeat(20_000)] }).reason ?? "", /exceeds/);
    assert.match(extractShellCommandInput({ command: "x".repeat(200_000) }).reason ?? "", /1-/);
  });

  it("leaves a safe argument unquoted", () => {
    assert.equal(quoteShellArgument("--flag=value_1/path.txt"), "--flag=value_1/path.txt");
    assert.equal(quoteShellArgument("has space"), "'has space'");
    assert.equal(quoteShellArgument("it's"), `'it'"'"'s'`);
  });
});

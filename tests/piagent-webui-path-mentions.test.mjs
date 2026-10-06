import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { applyMention, mentionAt } from "../packages/piagent-webui/client/src/path-mention.ts";
import { findFd, suggestPaths } from "../packages/piagent-webui/gateway/path-suggestions.ts";

// @ in a composer, as in Pi's terminal: what is being typed, what picking a
// suggestion writes, and the names offered under the project or any folder.
describe("@ mentions in a composer", () => {
  it("finds the mention being typed, never an email address", () => {
    assert.deepEqual(mentionAt("@", 1), { start: 0, end: 1, query: "", quoted: false });
    assert.deepEqual(mentionAt("xem @src/pri", 12), { start: 4, end: 12, query: "src/pri", quoted: false });
    assert.deepEqual(mentionAt("xem @src/pricing.js ngay", 9), { start: 4, end: 19, query: "src/", quoted: false }, "the whole word is replaced");
    assert.deepEqual(mentionAt('đọc @"~/Documents/old sh', 24), { start: 4, end: 24, query: "~/Documents/old sh", quoted: true });
    assert.deepEqual(mentionAt('@"~/Documents/old shop/"', 23), { start: 0, end: 24, query: "~/Documents/old shop/", quoted: true });
    assert.deepEqual(mentionAt("(@docs", 6), { start: 1, end: 6, query: "docs", quoted: false });
    assert.equal(mentionAt("hỏi an@example.com", 18), null);
    assert.equal(mentionAt("@src/a.js xong", 14), null, "the caret has left the mention");
  });

  it("writes @path, quotes a path with spaces, and keeps a folder open", () => {
    assert.deepEqual(applyMention("xem @pri", mentionAt("xem @pri", 8), { value: "src/pricing.js", kind: "file" }),
      { text: "xem @src/pricing.js ", caret: 20 });
    assert.deepEqual(applyMention("xem @sr", mentionAt("xem @sr", 7), { value: "src/", kind: "directory" }),
      { text: "xem @src/", caret: 9 });
    const folder = applyMention("@~/Doc", mentionAt("@~/Doc", 6), { value: "~/Documents/old shop/", kind: "directory" });
    assert.deepEqual(folder, { text: '@"~/Documents/old shop/"', caret: 23 }, "the caret stays inside the quotes");
    const file = applyMention(folder.text, mentionAt(folder.text, folder.caret), { value: "~/Documents/old shop/notes.md", kind: "file" });
    assert.deepEqual(file, { text: '@"~/Documents/old shop/notes.md" ', caret: 33 });
    assert.deepEqual(applyMention("@pri rồi", mentionAt("@pri rồi", 4), { value: "src/pricing.js", kind: "file" }),
      { text: "@src/pricing.js rồi", caret: 15 }, "no double space before the next word");
  });

  it("offers project files and folders, then any folder on the Mac, hidden names only when typed", async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-mention-")));
    try {
      const project = path.join(base, "shop"), home = path.join(base, "home");
      const write = (file) => { fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true }); fs.writeFileSync(path.join(base, file), "x\n"); };
      for (const file of ["shop/src/pricing.js", "shop/src/cart.js", "shop/.github/workflows/ci.yml", "shop/dist/bundle.js", "shop/.env",
        `shop/${"Tài liệu".normalize("NFD")}/đặc tả.md`, "home/Documents/old shop/notes.md", "home/.ssh/config", "home/Library/Mail/inbox"]) write(file);
      fs.writeFileSync(path.join(project, ".gitignore"), "dist/\n");
      execFileSync("git", ["init", "-q", project]); execFileSync("git", ["-C", project, "add", "-A"]);
      // The first /usr/bin/git on a fresh macOS runner can take longer than the
      // suggestions' 4 s limit, which then leaves ignored names in.
      if (fs.existsSync("/usr/bin/git")) execFileSync("/usr/bin/git", ["--version"]);
      for (const fd of [null, ...(findFd() ? [findFd()] : [])]) {
        const values = async (query) => (await suggestPaths({ root: project, query, home, fd })).suggestions.map((item) => item.value);
        const label = fd ? "fd" : "git";
        assert.deepEqual(await values(""), [`${"Tài liệu".normalize("NFD")}/`, "src/"].sort((a, b) => a.localeCompare(b)), `${label}: hidden and ignored names stay out of a bare @`);
        assert.equal((await values("pricing"))[0], "src/pricing.js", label);
        assert.ok(!(await values("bundle")).includes("dist/bundle.js"), `${label}: ignored files are not offered`);
        assert.ok((await values("workflows")).includes(".github/workflows/"), `${label}: a hidden folder is found by its name`);
        assert.ok((await values("tài")).some((value) => value.normalize("NFC") === "Tài liệu/"), `${label}: a composed name finds a decomposed folder`);
        assert.deepEqual(await values("src/"), ["src/cart.js", "src/pricing.js"], label);
      }
      const values = async (query) => (await suggestPaths({ root: project, query, home, fd: null })).suggestions.map((item) => item.value);
      assert.deepEqual(await values("~"), ["~/Documents/", "~/Library/"]);
      assert.deepEqual(await values("~/.s"), ["~/.ssh/"], "a dot typed lists hidden folders");
      assert.deepEqual(await values("~/ss"), [], "outside the project, hidden names need the dot");
      assert.deepEqual(await values("~/Documents/"), ["~/Documents/old shop/"]);
      assert.deepEqual(await values("~/Documents/old shop/no"), ["~/Documents/old shop/notes.md"]);
      assert.deepEqual(await values("../home/Doc"), ["../home/Documents/"]);
      assert.deepEqual(await values("nowhere/at/all"), [], "a folder that does not exist offers nothing");
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  });
});

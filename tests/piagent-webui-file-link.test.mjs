import assert from "node:assert/strict";
import { test } from "node:test";
import { fileLink } from "../packages/piagent-webui/client/src/file-link.ts";

// A file the agent hands back in its answer opens in the explorer: a project
// path, with a line as path:42 or #L42, or an absolute path / file:// URL
// (resolved against the project folder when opened). Web links stay links.
test("an answer's file link is a project file, with its line", () => {
  assert.deepEqual(fileLink("out/report.pdf"), { path: "out/report.pdf", line: 1, absolute: false });
  assert.deepEqual(fileLink("./src/app.ts:42"), { path: "src/app.ts", line: 42, absolute: false });
  assert.deepEqual(fileLink("src/app.ts#L7-L9"), { path: "src/app.ts", line: 7, absolute: false });
  assert.deepEqual(fileLink("docs/My%20Notes.md"), { path: "docs/My Notes.md", line: 1, absolute: false });
  assert.deepEqual(fileLink("/Users/me/shop/src/app.ts:12"), { path: "/Users/me/shop/src/app.ts", line: 12, absolute: true });
  assert.deepEqual(fileLink("file:///Users/me/shop/out/chart.png"), { path: "/Users/me/shop/out/chart.png", line: 1, absolute: true });
});

test("web links, anchors and unsafe paths are not file links", () => {
  for (const href of ["https://piagent.io.vn", "mailto:a@b.c", "#section", "javascript:alert(1)", "data:text/html,x",
    "../secret.txt", "src/../../etc/passwd", "/Users/me/../etc/passwd", "~/notes.md", "", "C:\\Users\\x.txt"]) assert.equal(fileLink(href), null, href);
});

import assert from "node:assert/strict";
import test from "node:test";
import { routeReadOnlyRequest } from "../packages/piagent-webui/server/read-only-router.ts";
import { WorkspaceReadError } from "../packages/piagent-core/security/workspace-file-reader.ts";
const url = (suffix) => new URL(`http://127.0.0.1/api/v1/workspace/${suffix}`);

test("workspace inspection forwards the decoded path once and keeps the provider receiver", async () => {
  const provider = { marker: "bound", workspace(kind, relative) { return { kind, relative, marker: this.marker }; } };
  assert.deepEqual(await routeReadOnlyRequest(url("file?path=src%2Fhello%20world.ts"), provider),
    { handled: true, status: 200, value: { kind: "file", relative: "src/hello world.ts", marker: "bound" } });
  assert.equal((await routeReadOnlyRequest(url("tree"), provider)).value.relative, "");
});

test("workspace inspection rejects traversal and ambiguous queries before invoking the reader", async () => {
  let reads = 0;
  const provider = { workspace() { reads++; } };
  for (const query of ["file", "file?path=..%2Fsecret", "tree?path=%2Fetc", "file?path=a%5Cb", "tree?path=a%00b",
    "file?path=a&path=b", "tree?extra=x", "tree?path=.%2Fsrc", "tree?path=a%2F%2Fb"]) {
    assert.equal((await routeReadOnlyRequest(url(query), provider)).status, 400, query);
  }
  assert.equal(reads, 0);
});

test("workspace inspection returns bounded errors without leaking filesystem details", async () => {
  for (const [error, status, code] of [
    [Object.assign(new Error("/private/path"), { code: "ENOENT" }), 404, "workspace-path-not-found"],
    [Object.assign(new Error("/private/path"), { code: "ELOOP" }), 403, "workspace-path-protected"],
    [new WorkspaceReadError("changed-during-read", "/private/path"), 409, "changed-during-read"],
    [new Error("secret internal detail"), 503, "workspace-unavailable"]
  ]) {
    const result = await routeReadOnlyRequest(url("file?path=file.ts"), { workspace() { throw error; } });
    assert.deepEqual(result, { handled: true, status, value: { error: { code } } });
  }
  assert.equal((await routeReadOnlyRequest(url("tree"), {})).status, 503);
});

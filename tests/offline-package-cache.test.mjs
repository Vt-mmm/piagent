import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { verifyLockedArchive } from "./helpers/offline-package-cache.mjs";

test("offline dependency archives require the exact lockfile SHA-512", () => {
  const bytes = Buffer.from("bounded fixture archive");
  const lock = { integrity: `sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` };
  verifyLockedArchive(lock, bytes);
  assert.throws(() => verifyLockedArchive(lock, Buffer.from("changed archive")), /must match package-lock integrity/);
  assert.throws(() => verifyLockedArchive({ integrity: "sha1-unbound" }, bytes));
});

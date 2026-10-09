import assert from "node:assert/strict";
import { test } from "node:test";

import { acceptAttribute, declaredType } from "../packages/piagent-webui/client/src/attachment-intake.ts";

test("any text or source file is sent as text under its own name; binaries are refused with what to send instead", () => {
  for (const name of ["index.html", "page.HTM", "styles.css", "app.tsx", "main.py", "server.go", "Query.sql", "logo.svg", "pyproject.toml",
    "Dockerfile", "Makefile", "LICENSE", ".gitignore", ".env.example", "notes.unknownext"]) {
    assert.deepEqual(declaredType(name), { mime: "text/plain" }, name);
  }
  assert.deepEqual(declaredType("README.md"), { mime: "text/markdown" });
  assert.deepEqual(declaredType("data.csv"), { mime: "text/csv" });
  assert.deepEqual(declaredType("shot.PNG"), { mime: "image/png" });
  assert.deepEqual(declaredType("spec.pdf"), { mime: "application/pdf" });
  assert.deepEqual(declaredType("budget.xlsx"), { refused: "sheet" });
  assert.deepEqual(declaredType("deck.pptx"), { refused: "slides" });
  assert.deepEqual(declaredType("old.doc"), { refused: "word" });
  for (const name of ["build.zip", "demo.mp4", "font.woff2", "app.exe", "db.sqlite"]) assert.deepEqual(declaredType(name), { refused: "binary" }, name);
});

test("with text accepted the picker offers every file; without it, only what the host takes", () => {
  assert.equal(acceptAttribute(new Set(["text/plain", "image/png"])), "");
  assert.match(acceptAttribute(new Set(["image/png"])), /image\/png,\.png/);
});

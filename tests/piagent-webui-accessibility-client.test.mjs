import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { nextSourceView } from "../packages/piagent-webui/client/src/source-view-model.ts";

const root = path.resolve(import.meta.dirname, "..");

describe("Piagent WebUI responsive and accessibility contract", () => {
  it("supports cyclic arrow navigation plus Home and End across source tabs", () => {
    assert.equal(nextSourceView("task", "ArrowRight"), "working-tree");
    assert.equal(nextSourceView("staged", "ArrowRight"), "task");
    assert.equal(nextSourceView("task", "ArrowLeft"), "staged");
    assert.equal(nextSourceView("working-tree", "Home"), "task");
    assert.equal(nextSourceView("working-tree", "End"), "staged");
  });

  it("provides landmarks, skip navigation, tab relationships and live status", () => {
    const app = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/App.tsx"), "utf8");
    const source = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/SourceWorkspace.tsx"), "utf8");
    const html = fs.readFileSync(path.join(root, "packages/piagent-webui/client/index.html"), "utf8");
    assert.match(html, /<html lang="vi">/);
    assert.match(app, /href="#main-content"/);
    assert.match(app, /id="main-content"/);
    assert.match(app, /aria-live="polite"/);
    assert.match(source, /aria-controls="source-tabpanel"/);
    assert.match(source, /aria-labelledby=\{`source-tab-\$\{view\}`\}/);
    assert.match(source, /selectionFollowsFocus/);
    assert.match(source, /<Tab key=\{tab\.view\}/);
  });

  it("includes reduced-motion, forced-color, focus and narrow-screen behavior", () => {
    const css = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/styles.css"), "utf8");
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /forced-colors:\s*active/);
    assert.match(css, /focus-visible/);
    assert.match(css, /@media \(max-width: 720px\)/);
    assert.doesNotMatch(css, /scrollbar-width:\s*none|outline:\s*none/);
  });

  it("uses the shared MUI dashboard shell with persistent VI/EN and light/dark preferences", () => {
    const app = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/App.tsx"), "utf8");
    const main = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/main.tsx"), "utf8");
    const theme = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/theme.ts"), "utf8");
    assert.match(app, /@mui\/material\/Drawer/); assert.match(app, /@mui\/material\/AppBar/);
    assert.match(app, /value="vi"/); assert.match(app, /value="en"/);
    assert.match(main, /ThemeProvider/); assert.match(main, /piagent-webui-locale/); assert.match(main, /piagent-webui-color-mode/);
    assert.match(theme, /createTheme/); assert.match(theme, /#d8ff7a/); assert.match(theme, /#f5f6f0/);
  });
});

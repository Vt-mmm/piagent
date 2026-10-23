import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THEME, THEME_PRESETS, themePreset } from "../packages/piagent-webui/client/src/theme-presets.ts";

const luminance = hex => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test("every theme preset is complete, unique and readable", () => {
  assert.equal(new Set(THEME_PRESETS.map(item => item.id)).size, THEME_PRESETS.length);
  for (const preset of THEME_PRESETS) {
    for (const key of ["background", "paper", "text", "muted", "divider", "primary", "onPrimary", "secondary", "warning", "error"])
      assert.match(preset[key], /^#[0-9a-f]{6}$/i, `${preset.id}.${key}`);
    assert.equal(preset.ansi.length, 16, preset.id);
    assert.ok(contrast(preset.text, preset.paper) >= 7, `${preset.id} text on paper`);
    assert.ok(contrast(preset.muted, preset.paper) >= 4.5, `${preset.id} muted text on paper`);
    assert.ok(contrast(preset.onPrimary, preset.primary) >= 4.5, `${preset.id} text on primary`);
    assert.ok(contrast(preset.syntax.comment, preset.paper) >= 3, `${preset.id} comments`);
  }
});

test("light and dark defaults exist and Dracula is offered", () => {
  assert.equal(themePreset(DEFAULT_THEME.dark)?.mode, "dark");
  assert.equal(themePreset(DEFAULT_THEME.light)?.mode, "light");
  assert.equal(themePreset("dracula")?.label, "Dracula");
  assert.equal(themePreset("missing"), undefined);
});

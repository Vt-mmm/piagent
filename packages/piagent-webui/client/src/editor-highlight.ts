import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { ThemePreset } from "./theme-presets.ts";

// Syntax colours of the chosen theme, so the editor reads like that theme in
// VS Code rather than CodeMirror's light default on a dark page.
export function presetHighlight({ syntax: s }: ThemePreset) {
  return HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier, t.self, t.null, t.bool, t.atom], color: s.keyword },
    { tag: [t.string, t.special(t.string), t.regexp, t.character], color: s.string },
    { tag: [t.number, t.integer, t.float, t.unit], color: s.number },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: s.comment, fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: s.function },
    { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.tagName)], color: s.type },
    { tag: [t.propertyName, t.attributeName, t.labelName], color: s.property },
    { tag: [t.operator, t.punctuation, t.bracket, t.derefOperator], color: s.operator },
    { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: s.heading, fontWeight: "600" },
    { tag: [t.link, t.url], color: s.link, textDecoration: "underline" },
    { tag: t.emphasis, fontStyle: "italic" }, { tag: t.strong, fontWeight: "600" },
    { tag: t.invalid, color: s.keyword, textDecoration: "underline wavy" },
  ]);
}

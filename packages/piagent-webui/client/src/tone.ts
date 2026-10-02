// Coloured text that stays readable: the palette's main tones are tuned for
// the dark theme and are too light on the light background (WCAG contrast).
export type Tone = "success" | "error" | "warning" | "info";
export function toneText(tone: Tone) {
  return { color: `${tone}.dark`, 'html[data-piagent-color-mode="dark"] &': { color: `${tone}.main` } };
}

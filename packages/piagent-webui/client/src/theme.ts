import { alpha, createTheme } from "@mui/material/styles";
import type { ThemePreset } from "./theme-presets.ts";

export function createPiagentTheme(preset: ThemePreset) {
  const dark = preset.mode === "dark", mode = preset.mode;
  const { primary, secondary, background, paper, text, muted, divider } = preset;
  return createTheme({
  cssVariables: { cssVarPrefix: "piagent" },
  palette: {
    mode,
    primary: { main: primary, contrastText: preset.onPrimary },
    secondary: { main: secondary },
    success: { main: secondary },
    warning: { main: preset.warning },
    error: { main: preset.error },
    background: { default: background, paper },
    text: { primary: text, secondary: muted, disabled: muted },
    divider
  },
  // Square, editor-like edges: 2px everywhere, so sx radii (n × 2px) stay small.
  shape: { borderRadius: 2 },
  typography: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontWeightRegular: 400,
    fontWeightMedium: 500,
    fontWeightBold: 600,
    h1: { fontSize: "1.65rem", fontWeight: 600, letterSpacing: "-0.03em" },
    h2: { fontSize: "1.2rem", fontWeight: 600, letterSpacing: "-0.02em" },
    h3: { fontSize: "1rem", fontWeight: 600 },
    button: { fontSize: "0.78rem", fontWeight: 500, textTransform: "none" },
    caption: { fontSize: "0.7rem" }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { backgroundColor: background },
        body: {
          minWidth: 320,
          minHeight: "100vh",
          backgroundImage: `radial-gradient(circle at 65% -18%, ${alpha(dark ? secondary : primary, dark ? 0.12 : 0.16)} 0, transparent 34rem)`
        },
        "::selection": { backgroundColor: alpha(primary, 0.26) }
      }
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { backgroundImage: "none" }
      }
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { minHeight: 32, borderRadius: 2 },
        outlined: { borderColor: alpha(text, 0.18) }
      }
    },
    MuiChip: {
      styleOverrides: { root: { height: 24, borderRadius: 2, fontWeight: 500 } }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          minHeight: 42,
          margin: "1px 6px",
          borderRadius: 2,
          color: muted,
          "&.Mui-selected": {
            color: text,
            backgroundColor: alpha(primary, dark ? 0.11 : 0.1),
            boxShadow: `inset 2px 0 ${primary}`
          },
          "&.Mui-selected:hover": { backgroundColor: alpha(primary, 0.15) }
        }
      }
    },
    MuiTab: {
      styleOverrides: {
        root: { minHeight: 48, paddingInline: 18, textTransform: "none", fontWeight: 500 }
      }
    },
    MuiTooltip: { defaultProps: { arrow: true } }
  }
  });
}

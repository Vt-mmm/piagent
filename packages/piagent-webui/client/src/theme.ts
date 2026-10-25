import { alpha, createTheme } from "@mui/material/styles";
import type { ThemePreset } from "./theme-presets.ts";

// One design scale for the whole dashboard: controls 6–8px, cards and menus
// 10px, dialogs 14px; 14px text; 32–36px rows; motion 120–200ms. Colours come
// from the preset, so every theme reaches every component.
export function createPiagentTheme(preset: ThemePreset) {
  const dark = preset.mode === "dark", mode = preset.mode;
  const { primary, secondary, background, paper, text, muted, divider } = preset;
  const raised = dark ? `0 16px 48px -12px ${alpha("#000", 0.7)}, 0 0 0 1px ${alpha(text, 0.06)}`
    : `0 16px 40px -16px ${alpha("#1a1a2e", 0.25)}, 0 0 0 1px ${alpha(text, 0.06)}`;
  const focusRing = `0 0 0 3px ${alpha(primary, dark ? 0.28 : 0.22)}`;
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
    divider,
    action: { hover: alpha(text, 0.05), selected: alpha(text, 0.08), focus: alpha(primary, 0.14) }
  },
  // Spacing radii are n × 6px in sx: 1 is a control, 2 a menu or card.
  shape: { borderRadius: 6 },
  transitions: { duration: { shortest: 120, shorter: 160, short: 180, standard: 200, complex: 260, enteringScreen: 200, leavingScreen: 160 } },
  typography: {
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif',
    fontSize: 14,
    fontWeightRegular: 400,
    fontWeightMedium: 500,
    fontWeightBold: 600,
    h1: { fontSize: "1.6rem", fontWeight: 650, letterSpacing: "-0.03em", lineHeight: 1.2 },
    h2: { fontSize: "1.15rem", fontWeight: 600, letterSpacing: "-0.02em" },
    h3: { fontSize: "0.95rem", fontWeight: 600 },
    body2: { fontSize: "0.8125rem" },
    button: { fontSize: "0.8125rem", fontWeight: 550, textTransform: "none", letterSpacing: 0 },
    caption: { fontSize: "0.72rem", letterSpacing: 0 },
    overline: { fontSize: "0.68rem", fontWeight: 600, letterSpacing: "0.08em" }
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        html: { backgroundColor: background, WebkitFontSmoothing: "antialiased" },
        body: { minWidth: 320, minHeight: "100vh", backgroundColor: background },
        "::selection": { backgroundColor: alpha(primary, 0.28) },
        "*": { scrollbarWidth: "thin", scrollbarColor: `${alpha(text, 0.18)} transparent` }
      }
    },
    MuiPaper: {
      defaultProps: { elevation: 0 },
      styleOverrides: { root: { backgroundImage: "none" } }
    },
    MuiButtonBase: { defaultProps: { disableRipple: true } },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { minHeight: 32, borderRadius: 8, paddingInline: 12, transition: "background-color .16s, border-color .16s, box-shadow .16s, color .16s",
          "&.Mui-focusVisible": { boxShadow: focusRing } },
        sizeSmall: { minHeight: 28, paddingInline: 10, fontSize: "0.78rem" },
        outlined: { borderColor: alpha(text, 0.14), "&:hover": { borderColor: alpha(text, 0.28), backgroundColor: alpha(text, 0.04) } },
        contained: { "&.MuiButton-colorPrimary:hover": { backgroundColor: alpha(primary, 0.88), boxShadow: `0 0 0 3px ${alpha(primary, 0.18)}` } },
        text: { "&:hover": { backgroundColor: alpha(text, 0.06) } }
      }
    },
    MuiIconButton: {
      styleOverrides: {
        root: { borderRadius: 8, color: muted, transition: "background-color .16s, color .16s",
          "&:hover": { color: text, backgroundColor: alpha(text, 0.07) }, "&.Mui-focusVisible": { boxShadow: focusRing } },
        sizeSmall: { padding: 5 }
      }
    },
    MuiChip: {
      styleOverrides: {
        root: { height: 24, borderRadius: 999, fontWeight: 500, fontSize: "0.75rem" },
        outlined: { borderColor: alpha(text, 0.14) },
        label: { paddingInline: 9 }
      }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          minHeight: 36,
          margin: "1px 8px",
          borderRadius: 8,
          color: muted,
          transition: "background-color .12s, color .12s",
          "&:hover": { backgroundColor: alpha(text, 0.05), color: text },
          "&.Mui-selected": { color: text, backgroundColor: alpha(text, dark ? 0.08 : 0.07) },
          "&.Mui-selected:hover": { backgroundColor: alpha(text, dark ? 0.11 : 0.09) },
          "&.Mui-focusVisible": { boxShadow: focusRing }
        }
      }
    },
    MuiTabs: {
      styleOverrides: {
        root: { minHeight: 40 },
        indicator: { height: 2, borderRadius: 2 }
      }
    },
    MuiTab: {
      styleOverrides: {
        root: { minHeight: 40, paddingInline: 14, textTransform: "none", fontWeight: 550, fontSize: "0.8125rem", color: muted,
          "&.Mui-selected": { color: text } }
      }
    },
    MuiOutlinedInput: {
      styleOverrides: {
        root: { borderRadius: 8, backgroundColor: alpha(text, dark ? 0.03 : 0.02), transition: "box-shadow .16s",
          "& .MuiOutlinedInput-notchedOutline": { borderColor: alpha(text, 0.12) },
          "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: alpha(text, 0.24) },
          "&.Mui-focused": { boxShadow: focusRing },
          "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: primary, borderWidth: 1 } }
      }
    },
    MuiTooltip: {
      defaultProps: { arrow: false, enterDelay: 350 },
      styleOverrides: {
        tooltip: { fontSize: "0.75rem", fontWeight: 500, padding: "5px 9px", borderRadius: 6,
          color: dark ? text : "#fafafa", backgroundColor: dark ? alpha(paper, 0.98) : "#1f1f24", boxShadow: raised }
      }
    },
    MuiMenu: {
      styleOverrides: {
        paper: { borderRadius: 10, boxShadow: raised, backgroundImage: "none", marginTop: 4 },
        list: { padding: 4 }
      }
    },
    MuiPopover: { styleOverrides: { paper: { borderRadius: 10, boxShadow: raised } } },
    MuiMenuItem: {
      styleOverrides: {
        root: { minHeight: 32, borderRadius: 6, fontSize: "0.8125rem", "&:hover": { backgroundColor: alpha(text, 0.06) },
          "&.Mui-selected": { backgroundColor: alpha(primary, 0.12) } }
      }
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 14, boxShadow: raised, backgroundImage: "none" } }
    },
    MuiBackdrop: {
      styleOverrides: { root: { backgroundColor: alpha("#000", dark ? 0.6 : 0.32), backdropFilter: "blur(2px)" } }
    },
    MuiDrawer: {
      styleOverrides: { paper: { backgroundImage: "none", backgroundColor: paper } }
    },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: 10, border: `1px solid ${alpha(text, 0.1)}`, fontSize: "0.8125rem", alignItems: "center" }
      }
    },
    MuiDivider: { styleOverrides: { root: { borderColor: divider } } },
    MuiLinearProgress: { styleOverrides: { root: { borderRadius: 999, height: 4 }, bar: { borderRadius: 999 } } }
  }
  });
}

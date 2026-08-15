import { alpha, createTheme, type PaletteMode } from "@mui/material/styles";

export function createPiagentTheme(mode: PaletteMode) {
  const dark = mode === "dark";
  const primary = dark ? "#d8ff7a" : "#627400";
  const secondary = dark ? "#8be9c8" : "#14775f";
  return createTheme({
  cssVariables: { cssVarPrefix: "piagent" },
  palette: {
    mode,
    primary: { main: primary, light: dark ? "#e6ff9f" : "#849a17", dark: dark ? "#a7cc45" : "#455400", contrastText: dark ? "#111300" : "#ffffff" },
    secondary: { main: secondary },
    success: { main: secondary },
    warning: { main: "#efba63" },
    error: { main: "#ff7f86" },
    background: { default: dark ? "#050505" : "#f5f6f0", paper: dark ? "#101114" : "#ffffff" },
    text: { primary: dark ? "#f4f4ef" : "#1c2018", secondary: dark ? "#a4a6ad" : "#62685c", disabled: dark ? "#898c95" : "#6b7165" },
    divider: dark ? "#24262d" : "#dfe2d8"
  },
  shape: { borderRadius: 10 },
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
        html: { backgroundColor: dark ? "#050505" : "#f5f6f0" },
        body: {
          minWidth: 320,
          minHeight: "100vh",
          backgroundImage: dark
            ? "radial-gradient(circle at 65% -18%, rgba(139,233,200,.12) 0, transparent 34rem)"
            : "radial-gradient(circle at 65% -18%, rgba(216,255,122,.22) 0, transparent 34rem)"
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
        root: { minHeight: 34, borderRadius: 8 },
        outlined: { borderColor: dark ? "#32343c" : "#cfd4c8" }
      }
    },
    MuiChip: {
      styleOverrides: { root: { height: 26, borderRadius: 7, fontWeight: 500 } }
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          minHeight: 42,
          margin: "2px 10px",
          borderRadius: 8,
          color: dark ? "#a4a6ad" : "#62685c",
          "&.Mui-selected": {
            color: dark ? "#f4f4ef" : "#1c2018",
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

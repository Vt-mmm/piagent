// Colour themes for the whole WebUI: the interface, the code editor's syntax
// colours and the terminal's ANSI palette come from one preset, as an editor
// theme does. Pure data, so tests can read it without JSX.
export type ThemeMode = "light" | "dark";
export type ThemePreset = {
  id: string; label: string; mode: ThemeMode;
  background: string; paper: string; text: string; muted: string; divider: string;
  primary: string; onPrimary: string; secondary: string; warning: string; error: string;
  syntax: { keyword: string; string: string; number: string; comment: string; function: string; type: string; property: string; operator: string; heading: string; link: string };
  // black, red, green, yellow, blue, magenta, cyan, white, then the bright eight.
  ansi: readonly string[];
};

const preset = (value: ThemePreset) => value;

export const THEME_PRESETS: readonly ThemePreset[] = [
  preset({ id: "piagent-dark", label: "Piagent Dark", mode: "dark", background: "#09090b", paper: "#111114", text: "#ededf0", muted: "#a3a3ad", divider: "#232329",
    primary: "#d8ff7a", onPrimary: "#111300", secondary: "#8be9c8", warning: "#efba63", error: "#ff7f86",
    syntax: { keyword: "#d8ff7a", string: "#8be9c8", number: "#efba63", comment: "#7d808a", function: "#9ecbff", type: "#f0a6ff", property: "#e6e6dc", operator: "#c5c7cc", heading: "#d8ff7a", link: "#8be9c8" },
    ansi: ["#1b1c20", "#ff7f86", "#b9e769", "#efba63", "#82aaff", "#f0a6ff", "#8be9c8", "#d6d6d0", "#5c5f68", "#ff9ea3", "#d8ff7a", "#ffd58a", "#a8c5ff", "#f6c4ff", "#b3f5df", "#f4f4ef"] }),
  preset({ id: "piagent-light", label: "Piagent Light", mode: "light", background: "#f5f6f0", paper: "#ffffff", text: "#18181b", muted: "#5b5b63", divider: "#e4e4df",
    primary: "#627400", onPrimary: "#ffffff", secondary: "#14775f", warning: "#9a5b00", error: "#c22f3a",
    syntax: { keyword: "#5a6b00", string: "#14775f", number: "#9a5b00", comment: "#7a8072", function: "#1f5fbf", type: "#8a3fa0", property: "#1c2018", operator: "#4a4f45", heading: "#5a6b00", link: "#14775f" },
    ansi: ["#1c2018", "#c22f3a", "#4d7a00", "#9a5b00", "#1f5fbf", "#8a3fa0", "#14775f", "#d6d8d0", "#62685c", "#e04a55", "#627400", "#b87a12", "#3a7be0", "#a85ac0", "#1f9a7c", "#f5f6f0"] }),
  preset({ id: "dracula", label: "Dracula", mode: "dark", background: "#21222c", paper: "#282a36", text: "#f8f8f2", muted: "#b6b8c8", divider: "#3a3d4d",
    primary: "#bd93f9", onPrimary: "#1e1f29", secondary: "#50fa7b", warning: "#ffb86c", error: "#ff5555",
    syntax: { keyword: "#ff79c6", string: "#f1fa8c", number: "#bd93f9", comment: "#7f8bbd", function: "#50fa7b", type: "#8be9fd", property: "#f8f8f2", operator: "#ff79c6", heading: "#bd93f9", link: "#8be9fd" },
    ansi: ["#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"] }),
  preset({ id: "one-dark", label: "One Dark", mode: "dark", background: "#21252b", paper: "#282c34", text: "#dcdfe4", muted: "#a0a6b1", divider: "#3a3f4b",
    primary: "#61afef", onPrimary: "#14181e", secondary: "#98c379", warning: "#e5c07b", error: "#e06c75",
    syntax: { keyword: "#c678dd", string: "#98c379", number: "#d19a66", comment: "#7f848e", function: "#61afef", type: "#e5c07b", property: "#e06c75", operator: "#56b6c2", heading: "#e06c75", link: "#56b6c2" },
    ansi: ["#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#dcdfe4", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"] }),
  preset({ id: "monokai", label: "Monokai", mode: "dark", background: "#1e1f1c", paper: "#272822", text: "#f8f8f2", muted: "#b5b3a5", divider: "#3e3d32",
    primary: "#a6e22e", onPrimary: "#1e1f1c", secondary: "#66d9ef", warning: "#e6db74", error: "#f92672",
    syntax: { keyword: "#f92672", string: "#e6db74", number: "#ae81ff", comment: "#8f8b77", function: "#a6e22e", type: "#66d9ef", property: "#f8f8f2", operator: "#f92672", heading: "#a6e22e", link: "#66d9ef" },
    ansi: ["#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2", "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5"] }),
  preset({ id: "nord", label: "Nord", mode: "dark", background: "#272c36", paper: "#2e3440", text: "#eceff4", muted: "#b4bccb", divider: "#3b4252",
    primary: "#88c0d0", onPrimary: "#1d222b", secondary: "#a3be8c", warning: "#ebcb8b", error: "#bf616a",
    syntax: { keyword: "#81a1c1", string: "#a3be8c", number: "#b48ead", comment: "#8590a6", function: "#88c0d0", type: "#8fbcbb", property: "#d8dee9", operator: "#81a1c1", heading: "#88c0d0", link: "#8fbcbb" },
    ansi: ["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"] }),
  preset({ id: "tokyo-night", label: "Tokyo Night", mode: "dark", background: "#16161e", paper: "#1a1b26", text: "#c0caf5", muted: "#9aa5ce", divider: "#292e42",
    primary: "#7aa2f7", onPrimary: "#16161e", secondary: "#9ece6a", warning: "#e0af68", error: "#f7768e",
    syntax: { keyword: "#bb9af7", string: "#9ece6a", number: "#ff9e64", comment: "#7a82ad", function: "#7aa2f7", type: "#2ac3de", property: "#73daca", operator: "#89ddff", heading: "#7aa2f7", link: "#2ac3de" },
    ansi: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"] }),
  preset({ id: "catppuccin-mocha", label: "Catppuccin Mocha", mode: "dark", background: "#181825", paper: "#1e1e2e", text: "#cdd6f4", muted: "#a6adc8", divider: "#313244",
    primary: "#cba6f7", onPrimary: "#1e1e2e", secondary: "#a6e3a1", warning: "#f9e2af", error: "#f38ba8",
    syntax: { keyword: "#cba6f7", string: "#a6e3a1", number: "#fab387", comment: "#8a8fa8", function: "#89b4fa", type: "#f9e2af", property: "#b4befe", operator: "#89dceb", heading: "#cba6f7", link: "#89dceb" },
    ansi: ["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de", "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"] }),
  preset({ id: "gruvbox-dark", label: "Gruvbox Dark", mode: "dark", background: "#1d2021", paper: "#282828", text: "#ebdbb2", muted: "#bdae93", divider: "#3c3836",
    primary: "#fabd2f", onPrimary: "#1d2021", secondary: "#b8bb26", warning: "#fe8019", error: "#fb4934",
    syntax: { keyword: "#fb4934", string: "#b8bb26", number: "#d3869b", comment: "#928374", function: "#8ec07c", type: "#fabd2f", property: "#83a598", operator: "#fe8019", heading: "#fabd2f", link: "#83a598" },
    ansi: ["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"] }),
  preset({ id: "solarized-dark", label: "Solarized Dark", mode: "dark", background: "#00212b", paper: "#002b36", text: "#e0e6e4", muted: "#a3b3b5", divider: "#0e3b47",
    primary: "#2aa1d9", onPrimary: "#00212b", secondary: "#9aa621", warning: "#d0a21b", error: "#ef5350",
    syntax: { keyword: "#9aa621", string: "#2fb3a8", number: "#e3709d", comment: "#7f969c", function: "#3ea4e6", type: "#d0a21b", property: "#a6b5b7", operator: "#9aa621", heading: "#d0a21b", link: "#3ea4e6" },
    ansi: ["#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#93a1a1", "#839496", "#657b83", "#6c71c4", "#93a1a1", "#fdf6e3"] }),
  preset({ id: "solarized-light", label: "Solarized Light", mode: "light", background: "#eee8d5", paper: "#fdf6e3", text: "#33434a", muted: "#58696f", divider: "#ddd6c1",
    primary: "#1f6fa8", onPrimary: "#ffffff", secondary: "#5f6b00", warning: "#8a6400", error: "#b8272a",
    syntax: { keyword: "#5f6b00", string: "#1d7d75", number: "#b02a6f", comment: "#6c7d80", function: "#1f6fa8", type: "#8a6400", property: "#33434a", operator: "#5f6b00", heading: "#8a6400", link: "#1f6fa8" },
    ansi: ["#073642", "#b8272a", "#5f6b00", "#8a6400", "#1f6fa8", "#b02a6f", "#1d7d75", "#eee8d5", "#586e75", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"] }),
  preset({ id: "github-dark", label: "GitHub Dark", mode: "dark", background: "#010409", paper: "#0d1117", text: "#e6edf3", muted: "#9da7b3", divider: "#30363d",
    primary: "#58a6ff", onPrimary: "#0d1117", secondary: "#3fb950", warning: "#d29922", error: "#f85149",
    syntax: { keyword: "#ff7b72", string: "#a5d6ff", number: "#79c0ff", comment: "#8b949e", function: "#d2a8ff", type: "#ffa657", property: "#79c0ff", operator: "#ff7b72", heading: "#79c0ff", link: "#a5d6ff" },
    ansi: ["#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff", "#bc8cff", "#39c5cf", "#b1bac4", "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff"] }),
  preset({ id: "github-light", label: "GitHub Light", mode: "light", background: "#f6f8fa", paper: "#ffffff", text: "#1f2328", muted: "#59636e", divider: "#d1d9e0",
    primary: "#0969da", onPrimary: "#ffffff", secondary: "#1a7f37", warning: "#9a6700", error: "#cf222e",
    syntax: { keyword: "#cf222e", string: "#0a3069", number: "#0550ae", comment: "#59636e", function: "#8250df", type: "#953800", property: "#0550ae", operator: "#cf222e", heading: "#0550ae", link: "#0a3069" },
    ansi: ["#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"] }),
];

export const DEFAULT_THEME: Record<ThemeMode, string> = { dark: "piagent-dark", light: "piagent-light" };
export const themePreset = (id: string | null | undefined) => THEME_PRESETS.find(item => item.id === id);

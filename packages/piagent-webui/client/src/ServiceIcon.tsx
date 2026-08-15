import AutoAwesomeRounded from "@mui/icons-material/AutoAwesomeRounded";
import CloudOutlined from "@mui/icons-material/CloudOutlined";
import CodeRounded from "@mui/icons-material/CodeRounded";
import DeveloperModeRounded from "@mui/icons-material/DeveloperModeRounded";
import FolderRounded from "@mui/icons-material/FolderRounded";
import GitHub from "@mui/icons-material/GitHub";
import HubRounded from "@mui/icons-material/HubRounded";
import StorageRounded from "@mui/icons-material/StorageRounded";
import Box from "@mui/material/Box";

const BRAND_COLORS: Record<string, string> = {
  anthropic: "#d97757",
  claude: "#d97757",
  context7: "#7456f1",
  chrome: "#4285f4",
  deepseek: "#4d6bfe",
  figma: "#1e1e1e",
  gemini: "#4285f4",
  github: "#24292f",
  google: "#4285f4",
  groq: "#f55036",
  linear: "#5e6ad2",
  mistral: "#f7a000",
  notion: "#111111",
  openai: "#10a37f",
  slack: "#611f69"
};

function FigmaMark() {
  return <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">
    <path fill="#f24e1e" d="M5 2h7v7H8.5A3.5 3.5 0 0 1 5 5.5V2Z" />
    <path fill="#ff7262" d="M12 2h3.5a3.5 3.5 0 1 1 0 7H12V2Z" />
    <path fill="#a259ff" d="M5 9h7v7H8.5A3.5 3.5 0 0 1 5 12.5V9Z" />
    <circle cx="15.5" cy="12.5" r="3.5" fill="#1abcfe" />
    <path fill="#0acf83" d="M5 16h7v3.5A3.5 3.5 0 1 1 5 16Z" />
  </svg>;
}

function icon(name: string) {
  const value = name.toLowerCase();
  if (value.includes("figma")) return <FigmaMark />;
  if (value.includes("github")) return <GitHub fontSize="inherit" />;
  if (value.includes("chrome") || value.includes("devtools")) return <DeveloperModeRounded fontSize="inherit" />;
  if (value.includes("anthropic") || value.includes("claude")) return <AutoAwesomeRounded fontSize="inherit" />;
  if (value.includes("file") || value.includes("folder")) return <FolderRounded fontSize="inherit" />;
  if (value.includes("postgres") || value.includes("database") || value.includes("supabase")) return <StorageRounded fontSize="inherit" />;
  if (value.includes("code") || value.includes("context7")) return <CodeRounded fontSize="inherit" />;
  if (value.includes("google") || value.includes("drive") || value.includes("cloud")) return <CloudOutlined fontSize="inherit" />;
  return <HubRounded fontSize="inherit" />;
}

export function ServiceIcon({ name, size = 34 }: { name: string; size?: number }) {
  const normalized = name.toLowerCase();
  const brand = Object.keys(BRAND_COLORS).find((candidate) => normalized.includes(candidate));
  return <Box aria-hidden="true" sx={{ width: size, height: size, flex: `0 0 ${size}px`, display: "grid", placeItems: "center",
    borderRadius: size > 30 ? 2 : 1.4, bgcolor: brand ? BRAND_COLORS[brand] : "action.selected", color: brand ? "#fff" : "text.secondary",
    fontSize: Math.round(size * .52), border: 1, borderColor: brand ? "transparent" : "divider" }}>{icon(name)}</Box>;
}

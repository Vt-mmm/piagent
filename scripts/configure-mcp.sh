#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/configure-mcp.sh [options]

Purpose:
  Merge a safe MCP baseline into a standard MCP config file for Pi and other MCP clients.
  Secrets are never written directly; configs reference environment variables.

Options:
  --scope <global|pi-global|project|pi-project>
                                  Config target (default: global)
  --project <path>                Project path for project/pi-project scopes (default: current directory)
  --config <path>                 Explicit config path; overrides --scope/--project
  --preset <minimal|docs|browser|github|design|design-local|web|core|popular|all>
                                  MCP preset to merge (default: core)
  --replace                       Replace existing definitions for servers in the preset
  --dry-run                       Print the merged JSON without writing
  --list                          Print available presets/servers
  -h, --help

Recommended presets:
  core       Context7 docs + Chrome DevTools + GitHub
  popular    core + Playwright + Figma remote MCP
  all        popular + Figma desktop/local MCP

Examples:
  piagent-mcp --preset core --scope global --replace
  piagent-mcp --preset popular --scope project --project /path/to/repo
  piagent-mcp --preset design-local --scope project

After writing config:
  pi
  /mcp
  /mcp setup
  /mcp reconnect
USAGE
}

PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOPE="global"
PROJECT_PATH="$PWD"
CONFIG_PATH=""
PRESET="core"
REPLACE=false
DRY_RUN=false
LIST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      SCOPE="${2:-}"
      shift 2
      ;;
    --project)
      PROJECT_PATH="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG_PATH="${2:-}"
      shift 2
      ;;
    --preset)
      PRESET="${2:-}"
      shift 2
      ;;
    --replace)
      REPLACE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --list)
      LIST=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$PRESET" ]]; then
  echo "FAIL: --preset cannot be empty" >&2
  exit 2
fi

if [[ -z "$CONFIG_PATH" ]]; then
  case "$SCOPE" in
    global)
      CONFIG_PATH="${XDG_CONFIG_HOME:-"${HOME}/.config"}/mcp/mcp.json"
      ;;
    pi-global)
      CONFIG_PATH="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}/mcp.json"
      ;;
    project)
      CONFIG_PATH="$PROJECT_PATH/.mcp.json"
      ;;
    pi-project)
      CONFIG_PATH="$PROJECT_PATH/.pi/mcp.json"
      ;;
    *)
      echo "FAIL: unsupported scope: $SCOPE" >&2
      usage >&2
      exit 2
      ;;
  esac
fi

node --input-type=module - "$CONFIG_PATH" "$PRESET" "$REPLACE" "$DRY_RUN" "$LIST" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [configPath, presetName, replaceRaw, dryRunRaw, listRaw] = process.argv.slice(2);
const replace = replaceRaw === "true";
const dryRun = dryRunRaw === "true";
const listOnly = listRaw === "true";

const baselineSettings = {
  toolPrefix: "server",
  directTools: false,
  idleTimeout: 10,
  outputGuard: true
};

const servers = {
  context7: {
    description: "Official Context7 MCP server for up-to-date library/framework docs.",
    config: {
      command: "npx",
      args: ["-y", "@upstash/context7-mcp@3.2.4"],
      env: {
        CONTEXT7_API_KEY: "${CONTEXT7_API_KEY}"
      },
      lifecycle: "lazy",
      directTools: false
    }
  },
  "chrome-devtools": {
    description: "Chrome DevTools MCP for runtime browser inspection, console logs, screenshots, and performance checks.",
    config: {
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@1.6.0", "--no-performance-crux"],
      env: {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1",
        CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1"
      },
      lifecycle: "lazy",
      directTools: false
    }
  },
  playwright: {
    description: "Playwright MCP for browser automation and UI verification workflows.",
    config: {
      command: "npx",
      args: ["-y", "@playwright/mcp@0.0.78"],
      lifecycle: "lazy",
      directTools: false
    }
  },
  github: {
    description: "Official GitHub MCP server via Docker. Requires Docker and GITHUB_PERSONAL_ACCESS_TOKEN when used.",
    config: {
      command: "docker",
      args: [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "-e",
        "GITHUB_READ_ONLY=1",
        "-e",
        "GITHUB_LOCKDOWN_MODE=1",
        "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3"
      ],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      },
      lifecycle: "lazy",
      directTools: false
    }
  },
  figma: {
    description: "Figma remote MCP server. Requires Figma OAuth from the MCP panel when first used.",
    config: {
      url: "https://mcp.figma.com/mcp",
      auth: "oauth",
      lifecycle: "lazy",
      directTools: false
    }
  },
  "figma-desktop": {
    description: "Figma desktop/local MCP server. Requires Figma desktop Dev Mode MCP enabled.",
    config: {
      url: "http://127.0.0.1:3845/mcp",
      lifecycle: "lazy",
      directTools: false
    }
  }
};

const presets = {
  minimal: [],
  docs: ["context7"],
  browser: ["chrome-devtools", "playwright"],
  github: ["github"],
  design: ["figma"],
  "design-local": ["figma-desktop"],
  web: ["context7", "chrome-devtools", "playwright"],
  core: ["context7", "chrome-devtools", "github"],
  popular: ["context7", "chrome-devtools", "playwright", "github", "figma"],
  all: ["context7", "chrome-devtools", "playwright", "github", "figma", "figma-desktop"]
};

if (listOnly) {
  console.log(JSON.stringify({
    presets,
    servers: Object.fromEntries(Object.entries(servers).map(([name, value]) => [name, value.description]))
  }, null, 2));
  process.exit(0);
}

if (!Object.hasOwn(presets, presetName)) {
  console.error(`FAIL: unknown preset: ${presetName}`);
  console.error(`Available presets: ${Object.keys(presets).join(", ")}`);
  process.exit(2);
}

let current = {};
if (fs.existsSync(configPath)) {
  try {
    current = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    console.error(`FAIL: cannot parse existing MCP config: ${configPath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (!current || typeof current !== "object" || Array.isArray(current)) current = {};
if (!current.settings || typeof current.settings !== "object" || Array.isArray(current.settings)) current.settings = {};
if (!current.mcpServers || typeof current.mcpServers !== "object" || Array.isArray(current.mcpServers)) current.mcpServers = {};

current.settings = {
  ...baselineSettings,
  ...current.settings
};

const added = [];
const kept = [];
const replaced = [];
for (const name of presets[presetName]) {
  if (!Object.hasOwn(servers, name)) {
    throw new Error(`Preset ${presetName} references missing server ${name}`);
  }
  if (Object.hasOwn(current.mcpServers, name)) {
    if (replace) {
      current.mcpServers[name] = servers[name].config;
      replaced.push(name);
    } else {
      kept.push(name);
    }
  } else {
    current.mcpServers[name] = servers[name].config;
    added.push(name);
  }
}

const output = `${JSON.stringify(current, null, 2)}\n`;
const report = {
  configPath,
  preset: presetName,
  dryRun,
  replace,
  added,
  kept,
  replaced,
  serverCount: Object.keys(current.mcpServers).length
};

if (dryRun) {
  console.log(JSON.stringify(report, null, 2));
  console.log(output);
} else {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, output);
  console.log(JSON.stringify(report, null, 2));
}
NODE

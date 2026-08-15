// The servers this platform ships a pinned definition for, and the presets that
// group them. Pinned by version or digest because an MCP server is code that runs
// on the operator's machine with the operator's credentials; a floating tag would
// make every session a fresh supply-chain decision nobody is present to make.
//
// Nothing here is a secret. Every credential is referenced as an environment
// variable, so the config can be read, diffed and committed without leaking one.

/** @typedef {{description: string, config: Record<string, unknown>}} CatalogServer */

/** @type {Record<string, CatalogServer>} */
export const CATALOG_SERVERS = {
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
    description: "Figma remote MCP server. OAuth works only for clients approved in the Figma MCP Catalog.",
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

// Writing a server definition does not make it usable. What each one still needs
// from the operator is stated here so it can be printed at the moment the
// definition is written, rather than living only in a description string that
// shows up under --list.
/** @type {Record<string, string[]>} */
export const CATALOG_PREREQUISITES = {
  context7: ["optional: export CONTEXT7_API_KEY for a higher documentation quota"],
  "chrome-devtools": ["a local Chrome installation"],
  github: [
    "Docker running",
    "export GITHUB_PERSONAL_ACCESS_TOKEN with the scopes you intend to use"
  ],
  playwright: ["browsers installed on first use (npx playwright install)"],
  figma: ["Piagent approved in the Figma MCP Catalog before remote OAuth can register"],
  "figma-desktop": ["Figma desktop running with Dev Mode MCP enabled"]
};

// Variables a pinned server references but works without. Context7 answers
// without a key and the key only raises the quota, so reporting it as missing
// would put a line in front of the operator every session about something that
// is not wrong. A server somebody adds by hand has no entry here: they typed the
// reference, so it is treated as one they meant.
/** @type {Record<string, string[]>} */
export const CATALOG_OPTIONAL_ENV = {
  context7: ["CONTEXT7_API_KEY"]
};

/** @type {Record<string, string[]>} */
export const CATALOG_PRESETS = {
  minimal: [],
  docs: ["context7"],
  browser: ["chrome-devtools", "playwright"],
  github: ["github"],
  design: ["figma-desktop"],
  "design-local": ["figma-desktop"],
  web: ["context7", "chrome-devtools", "playwright"],
  core: ["context7", "chrome-devtools", "github"],
  popular: ["context7", "chrome-devtools", "playwright", "github", "figma-desktop"],
  all: ["context7", "chrome-devtools", "playwright", "github", "figma-desktop", "figma"]
};

/** @param {string} name @returns {boolean} */
export function isCatalogPreset(name) {
  return Object.hasOwn(CATALOG_PRESETS, name);
}

/**
 * The servers a preset installs, with their definitions resolved. Throws on an
 * unknown preset so a typo is refused before anything is written.
 * @param {string} name
 * @returns {{name: string, config: Record<string, unknown>, requires: string[]}[]}
 */
export function resolvePreset(name) {
  if (!isCatalogPreset(name)) {
    throw new Error(`unknown preset: ${name}. Available presets: ${Object.keys(CATALOG_PRESETS).join(", ")}`);
  }
  return CATALOG_PRESETS[name].map((serverName) => {
    const server = CATALOG_SERVERS[serverName];
    if (!server) throw new Error(`preset ${name} references missing server ${serverName}`);
    return { name: serverName, config: server.config, requires: CATALOG_PREREQUISITES[serverName] ?? [] };
  });
}

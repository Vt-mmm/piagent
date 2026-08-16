// The servers this platform ships a pinned definition for, and the presets that
// group them. Pinned by version or digest because an MCP server is code that runs
// on the operator's machine with the operator's credentials; a floating tag would
// make every session a fresh supply-chain decision nobody is present to make.
//
// Nothing here is a secret. Every credential is referenced as an environment
// variable, so the config can be read, diffed and committed without leaking one.

/** @typedef {{description: string, maturity?: "stable"|"experimental", config: Record<string, unknown>}} CatalogServer */

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
  },
  // Google's own remote servers, one per product, rather than a community server
  // holding every scope at once: a session that only needs to read a document
  // should not be one OAuth grant away from the mailbox.
  //
  // These carry no version pin because there is nothing local to pin -- the
  // endpoint is operated by Google and changes under the same URL. That is a
  // real difference from every command-based server above, where the pin is what
  // stops a floating tag becoming a supply-chain decision each session.
  // Scopes are declared read-only. Write access is one word longer to ask for
  // and cannot be taken back once an agent has used it, so the default grant is
  // the one that cannot lose anything. `clientId` is deliberately absent: every
  // operator registers their own OAuth client, and a client id baked in here
  // would be someone else's project answering for their consent screen.
  "google-drive": {
    description: "EXPERIMENTAL Developer Preview: Google Drive remote MCP server. Read-only by default.",
    maturity: "experimental",
    config: {
      url: "https://drivemcp.googleapis.com/mcp/v1",
      auth: "oauth",
      oauth: { scopes: ["https://www.googleapis.com/auth/drive.readonly"] },
      lifecycle: "lazy",
      directTools: false
    }
  },
  gmail: {
    description: "EXPERIMENTAL Developer Preview: Gmail remote MCP server. Read-only by default.",
    maturity: "experimental",
    config: {
      url: "https://gmailmcp.googleapis.com/mcp/v1",
      auth: "oauth",
      oauth: { scopes: ["https://www.googleapis.com/auth/gmail.readonly"] },
      lifecycle: "lazy",
      directTools: false
    }
  },
  "google-docs": {
    description: "EXPERIMENTAL Developer Preview: Google Docs remote MCP server. Read-only by default.",
    maturity: "experimental",
    config: {
      url: "https://docsmcp.googleapis.com/mcp/v1",
      auth: "oauth",
      oauth: {
        scopes: [
          "https://www.googleapis.com/auth/documents.readonly",
          "https://www.googleapis.com/auth/drive.readonly"
        ]
      },
      lifecycle: "lazy",
      directTools: false
    }
  },
  "google-sheets": {
    description: "EXPERIMENTAL Developer Preview: Google Sheets remote MCP server. Read-only by default.",
    maturity: "experimental",
    config: {
      url: "https://sheetsmcp.googleapis.com/mcp/v1",
      auth: "oauth",
      oauth: {
        scopes: [
          "https://www.googleapis.com/auth/spreadsheets.readonly",
          "https://www.googleapis.com/auth/drive.readonly"
        ]
      },
      lifecycle: "lazy",
      directTools: false
    }
  },
  // Converts .docx, .xlsx, .pptx and .pdf to Markdown locally. Local matters:
  // the alternative to this is uploading a document somewhere to read it, and a
  // document worth converting is usually one worth not uploading.
  markitdown: {
    description: "MarkItDown MCP. Converts local docx, xlsx, pptx, pdf and html files to Markdown. Runs offline for file: URIs.",
    config: {
      command: "uvx",
      args: ["markitdown-mcp@0.0.1a4"],
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
  "figma-desktop": ["Figma desktop running with Dev Mode MCP enabled"],
  "google-drive": [
    "a Google Cloud project with drive.googleapis.com and drivemcp.googleapis.com enabled",
    "Developer Preview: no Pi OAuth end-to-end release proof exists yet",
    "Google's supported client guides use an OAuth client id and secret; Pi's public-client/PKCE compatibility is unverified",
    "piagent-mcp add google-drive --url https://drivemcp.googleapis.com/mcp/v1 --oauth-client-id <id> --scope user"
  ],
  gmail: [
    "a Google Cloud project with gmail.googleapis.com and gmailmcp.googleapis.com enabled",
    "Developer Preview: no Pi OAuth end-to-end release proof exists yet",
    "Google's supported client guides use an OAuth client id and secret; Pi's public-client/PKCE compatibility is unverified",
    "read the warning in docs/mcp-and-tools.md first: mail is untrusted input reaching an agent that can act"
  ],
  "google-docs": [
    "a Google Cloud project with docs.googleapis.com and docsmcp.googleapis.com enabled",
    "Developer Preview: no Pi OAuth end-to-end release proof exists yet",
    "Google's supported client guides use an OAuth client id and secret; Pi's public-client/PKCE compatibility is unverified"
  ],
  "google-sheets": [
    "a Google Cloud project with sheets.googleapis.com and sheetsmcp.googleapis.com enabled",
    "Developer Preview: no Pi OAuth end-to-end release proof exists yet",
    "Google's supported client guides use an OAuth client id and secret; Pi's public-client/PKCE compatibility is unverified"
  ],
  markitdown: [
    "uv on PATH (https://docs.astral.sh/uv); the first run downloads a Python runtime and roughly 120 MB of dependencies",
    "note: markitdown-mcp is published as an alpha, so pin changes deliberately"
  ]
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

// `core` is what an install writes when nobody names a preset, and `popular` is
// what somebody picks without reading the list. Neither may reach a mailbox or a
// Drive: an install that quietly grants those is a decision the operator never
// made. The Google servers are therefore only in presets somebody has to type,
// and in `all`, which means what it says.
/** @type {Record<string, string[]>} */
export const CATALOG_PRESETS = {
  minimal: [],
  docs: ["context7"],
  browser: ["chrome-devtools", "playwright"],
  github: ["github"],
  design: ["figma-desktop"],
  "design-local": ["figma-desktop"],
  web: ["context7", "chrome-devtools", "playwright"],
  // The generic documents preset stays local. Google Workspace is Developer
  // Preview and must be selected through an explicitly named Google preset.
  documents: ["markitdown"],
  // One preset per product, because that is why Google ships four servers
  // instead of one. Bundling them back together would mean reading a
  // spreadsheet costs a grant over Drive and every document in it.
  "google-drive": ["google-drive"],
  "google-docs": ["google-docs"],
  "google-sheets": ["google-sheets"],
  "google-mail": ["gmail"],
  google: ["google-drive", "google-docs", "google-sheets"],
  "google-all": ["google-drive", "gmail", "google-docs", "google-sheets"],
  core: ["context7", "chrome-devtools", "github"],
  popular: ["context7", "chrome-devtools", "playwright", "github", "figma-desktop"],
  all: [
    "context7", "chrome-devtools", "playwright", "github", "figma-desktop", "figma",
    "markitdown", "google-drive", "gmail", "google-docs", "google-sheets"
  ]
};

/** @param {string} name @returns {boolean} */
export function isCatalogPreset(name) {
  return Object.hasOwn(CATALOG_PRESETS, name);
}

/**
 * The servers a preset installs, with their definitions resolved. Throws on an
 * unknown preset so a typo is refused before anything is written.
 * @param {string} name
 * @returns {{name: string, maturity: "stable"|"experimental", config: Record<string, unknown>, requires: string[]}[]}
 */
export function resolvePreset(name) {
  if (!isCatalogPreset(name)) {
    throw new Error(`unknown preset: ${name}. Available presets: ${Object.keys(CATALOG_PRESETS).join(", ")}`);
  }
  return CATALOG_PRESETS[name].map((serverName) => {
    const server = CATALOG_SERVERS[serverName];
    if (!server) throw new Error(`preset ${name} references missing server ${serverName}`);
    return {
      name: serverName,
      maturity: server.maturity ?? "stable",
      config: server.config,
      requires: CATALOG_PREREQUISITES[serverName] ?? []
    };
  });
}

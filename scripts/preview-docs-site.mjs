#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Serves docs-site/ locally the way Vercel serves it.
//
// The deployed site runs with `cleanUrls: true`, so every internal link points
// at /quickstart rather than /quickstart.html. A plain static file server
// answers 404 for all of them, which makes a local preview useless for
// checking navigation. This resolves the extensionless path the same way.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const siteRoot = path.join(repoRoot, "docs-site");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json"
};

function portFromArgs(argv) {
  const flag = argv.indexOf("--port");
  const raw = flag >= 0 ? argv[flag + 1] : process.env.PORT;
  if (!raw) return 4321;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return port;
}

/** Resolve a request path to a file inside the site root, or undefined. */
function resolveFile(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const candidate = path.resolve(siteRoot, `.${requested}`);
  // A traversal such as /../../.ssh/id_rsa escapes the site root; refuse it
  // rather than reading whatever it lands on.
  if (candidate !== siteRoot && !candidate.startsWith(siteRoot + path.sep)) return undefined;
  for (const file of [candidate, `${candidate}.html`, path.join(candidate, "index.html")]) {
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return undefined;
}

const port = portFromArgs(process.argv.slice(2));

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${port}`).pathname);
  } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("bad request\n");
    return;
  }
  const file = resolveFile(urlPath);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`not found: ${urlPath}\n`);
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-store"
  });
  res.end(req.method === "HEAD" ? undefined : body);
});

// Loopback only: this serves local files and has no business being reachable
// from the network.
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`docs-site preview on http://localhost:${port} (Ctrl+C to stop)\n`);
});

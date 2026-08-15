import fs from "node:fs";
import path from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MIME = new Map([
  [".css", "text/css; charset=utf-8"], [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"], [".woff2", "font/woff2"]
]);

export type StaticAsset = { body: Buffer; contentType: string };

export function loadStaticBundle(root: string): ReadonlyMap<string, StaticAsset> {
  const absoluteRoot = path.resolve(root), rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("static-root-invalid");
  const assets = new Map<string, StaticAsset>();
  let total = 0;
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name), stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("static-symlink-rejected");
      if (entry.isDirectory()) { visit(absolute); continue; }
      const relative = path.relative(absoluteRoot, absolute).split(path.sep).join("/");
      const contentType = MIME.get(path.extname(relative));
      if (!entry.isFile() || !contentType || stat.size > MAX_FILE_BYTES) throw new Error("static-asset-invalid");
      total += stat.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("static-bundle-limit");
      const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fs.fstatSync(descriptor);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("static-asset-race");
        assets.set(relative === "index.html" ? "/" : `/${relative}`, { body: fs.readFileSync(descriptor), contentType });
      } finally { fs.closeSync(descriptor); }
    }
  };
  visit(absoluteRoot);
  if (!assets.has("/")) throw new Error("static-index-missing");
  return assets;
}

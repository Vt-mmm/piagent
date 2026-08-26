import fs from "node:fs";
import path from "node:path";

function evictOldest<K, V>(map: Map<K, V>, maximum: number): void {
  while (map.size > maximum) map.delete(map.keys().next().value as K);
}

/** Session-local capability grants for immutable shared source checkouts. */
export class SourceCheckoutReadGrants {
  readonly #rootsBySession = new Map<string, Map<string, string>>();

  grant(sessionKey: string, checkoutPath: string): string {
    const canonical = fs.realpathSync.native(checkoutPath);
    if (!fs.statSync(canonical).isDirectory() || !fs.existsSync(path.join(canonical, ".git"))) {
      throw new Error("Source checkout grant requires a canonical Git worktree directory");
    }
    let roots = this.#rootsBySession.get(sessionKey);
    if (!roots) {
      roots = new Map();
      this.#rootsBySession.set(sessionKey, roots);
    }
    roots.set(canonical, canonical);
    evictOldest(roots, 8);
    evictOldest(this.#rootsBySession, 100);
    return canonical;
  }

  roots(sessionKey: string): string[] {
    return [...(this.#rootsBySession.get(sessionKey)?.values() ?? [])];
  }

  clear(sessionKey: string): void {
    this.#rootsBySession.delete(sessionKey);
  }
}

import { createHmac } from "node:crypto";

function ref(key: Buffer, namespace: string, value: string): string {
  return `${namespace}_${createHmac("sha256", key).update(value).digest("base64url").slice(0, 43)}`;
}

export function sessionRefForPath(key: Buffer, sessionPath: string): string { return ref(key, "session", sessionPath); }
export function projectRefForCwd(key: Buffer, cwd: string): string { return ref(key, "project", cwd || "unknown"); }

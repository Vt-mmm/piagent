import type { ServerResponse } from "node:http";

export const SECURITY_HEADERS = Object.freeze({
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
});

export function applySecurityHeaders(response: ServerResponse, styleNonce: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader("Content-Security-Policy", `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data:; style-src 'self'; style-src-elem 'self' 'nonce-${styleNonce}'; style-src-attr 'unsafe-inline'; script-src 'self'; connect-src 'self'`);
}

export function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.length);
  response.end(body);
}

export function errorResponse(response: ServerResponse, status: number, code: string): void {
  jsonResponse(response, status, { error: { code } });
}

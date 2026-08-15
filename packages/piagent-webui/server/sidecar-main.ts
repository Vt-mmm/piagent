import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

import { IpcReadModelClient } from "./ipc-read-model-client.ts";
import { startLoopbackServer, type LoopbackServer } from "./loopback-server.ts";

type InitMessage = {
  channel: "piagent-webui";
  type: "init";
  staticRoot: string;
  controlSocket: string;
  controlToken: string;
};

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function controlServer(socketPath: string, token: string, web: LoopbackServer): Promise<net.Server> {
  try {
    const stat = fs.lstatSync(socketPath);
    if (!stat.isSocket()) throw new Error("webui-control-path-unsafe");
    fs.unlinkSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const server = net.createServer((socket) => {
    let input = Buffer.alloc(0), settled = false;
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (settled) return;
      input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (input.length > 4_096) { settled = true; socket.end('{"ok":false,"error":"request-limit"}\n'); return; }
      const newline = input.indexOf(10);
      if (newline < 0) return;
      settled = true;
      try {
        const value = JSON.parse(input.subarray(0, newline).toString("utf8"));
        if (!value || value.action !== "launch" || typeof value.token !== "string" || !equal(value.token, token)) {
          socket.end('{"ok":false,"error":"authority-rejected"}\n'); return;
        }
        socket.end(`${JSON.stringify({ ok: true, launchUrl: web.issueLaunchUrl() })}\n`);
      } catch { socket.end('{"ok":false,"error":"invalid-request"}\n'); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  return server;
}

let closing = false, web: LoopbackServer | undefined, control: net.Server | undefined, controlPath: string | undefined;
async function close(code = 0): Promise<void> {
  if (closing) return;
  closing = true;
  await web?.close().catch(() => undefined);
  await new Promise<void>((resolve) => control ? control.close(() => resolve()) : resolve());
  if (controlPath) {
    try { if (fs.lstatSync(controlPath).isSocket()) fs.unlinkSync(controlPath); } catch { /* already removed */ }
  }
  process.exit(code);
}

process.once("message", (message: unknown) => { void (async () => {
  const init = message as Partial<InitMessage>;
  if (init.channel !== "piagent-webui" || init.type !== "init" || typeof init.staticRoot !== "string"
    || typeof init.controlSocket !== "string" || typeof init.controlToken !== "string") throw new Error("webui-sidecar-init-invalid");
  const client = new IpcReadModelClient();
  web = await startLoopbackServer({ staticRoot: init.staticRoot, readCapabilities: () => client.capabilities(), readModel: client,
    executeControl: (command) => client.executeControl(command), executeAttachment: (command) => client.executeAttachment(command),
    executeApproval: (approvalRef, decision) => client.executeApproval(approvalRef, decision) });
  controlPath = init.controlSocket;
  control = await controlServer(init.controlSocket, init.controlToken, web);
  process.send?.({ channel: "piagent-webui", type: "ready", origin: web.origin, launchUrl: web.launchUrl });
})().catch((error) => {
  process.send?.({ channel: "piagent-webui", type: "fatal", error: error instanceof Error ? error.message : "sidecar-start-failed" });
  void close(1);
}); });

process.once("disconnect", () => { void close(0); });
process.once("SIGTERM", () => { void close(0); });
process.once("SIGINT", () => { void close(0); });

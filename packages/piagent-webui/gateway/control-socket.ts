import fs from "node:fs";
import net from "node:net";

const MAX_MESSAGE_BYTES = 4_096;

export type GatewayControlRequest = { action: "health" | "issue-launch-url" | "stop" };
export type GatewayControlResponse = { ok: true; value: unknown } | { ok: false; error: string };

export async function requestGatewayControl(socketPath: string, request: GatewayControlRequest, timeoutMs = 1_500): Promise<GatewayControlResponse> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let body = "", settled = false;
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); callback(); };
    const timer = setTimeout(() => finish(() => reject(new Error("gateway-control-timeout"))), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) return finish(() => reject(new Error("gateway-control-response-limit")));
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      finish(() => {
        try { resolve(JSON.parse(body.slice(0, newline)) as GatewayControlResponse); }
        catch { reject(new Error("gateway-control-response-invalid")); }
      });
    });
    socket.once("error", (error) => finish(() => reject(error)));
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let before: fs.Stats;
  try { before = fs.lstatSync(socketPath); }
  catch { return; }
  if (!before.isSocket() || before.isSymbolicLink()) throw new Error("gateway-control-path-invalid");
  try {
    const live = await requestGatewayControl(socketPath, { action: "health" }, 500);
    if (live.ok) throw new Error("gateway-already-running");
  } catch (error) {
    if (error instanceof Error && error.message === "gateway-already-running") throw error;
  }
  const after = fs.lstatSync(socketPath);
  if (!after.isSocket() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("gateway-control-path-race");
  fs.unlinkSync(socketPath);
}

export async function startGatewayControlSocket(options: {
  socketPath: string;
  handle(request: GatewayControlRequest): Promise<GatewayControlResponse> | GatewayControlResponse;
}): Promise<{ close(): Promise<void> }> {
  await removeStaleSocket(options.socketPath);
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let body = "", finished = false;
    const fail = (error: string) => { if (finished) return; finished = true; socket.end(`${JSON.stringify({ ok: false, error })}\n`); };
    socket.on("data", (chunk) => {
      if (finished) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) return fail("request-limit");
      const newline = body.indexOf("\n");
      if (newline < 0) return;
      finished = true;
      void (async () => {
        let request: GatewayControlRequest;
        try {
          const parsed = JSON.parse(body.slice(0, newline)) as Partial<GatewayControlRequest>;
          if (!parsed || !["health", "issue-launch-url", "stop"].includes(String(parsed.action))
            || Object.keys(parsed).some((key) => key !== "action")) throw new Error("invalid");
          request = parsed as GatewayControlRequest;
        } catch { socket.end(`${JSON.stringify({ ok: false, error: "invalid-request" })}\n`); return; }
        try { socket.end(`${JSON.stringify(await options.handle(request))}\n`); }
        catch { socket.end(`${JSON.stringify({ ok: false, error: "control-failed" })}\n`); }
      })();
    });
    socket.once("error", () => { socket.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, resolve);
  });
  fs.chmodSync(options.socketPath, 0o600);
  const identity = fs.lstatSync(options.socketPath);
  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      try {
        const current = fs.lstatSync(options.socketPath);
        if (current.isSocket() && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(options.socketPath);
      } catch { /* already removed */ }
    }
  };
}

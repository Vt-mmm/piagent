import { GatewaySessionStream } from "./gateway-session-stream.ts";
import { waitForOperationStart } from "./session-operation-start.ts";

export type LaunchedSessionPrompt = {
  started: Promise<void>;
  completion: Promise<void>;
};
export type SessionSendResult = { resultCode: "started" | "queued" | "steered"; operationRef: string;
  dispatch?: () => void; cancel?: () => boolean };

/**
 * Launches host prompt work on the next event-loop turn. Gateway command
 * admission can therefore persist and return its exact operation receipt
 * before expensive synchronous Pi hooks begin, while direct runtime callers
 * can still await the observed agent start through `started`.
 */
export function launchSessionPrompt(options: {
  stream: GatewaySessionStream;
  invoke(): Promise<void> | void;
  finish(): Promise<void>;
  canInvoke(): boolean;
}): LaunchedSessionPrompt {
  const prompt = new Promise<void>((resolve, reject) => {
    setImmediate(() => {
      if (!options.canInvoke()) { reject(new Error("session-operation-cancelled-before-dispatch")); return; }
      try { Promise.resolve(options.invoke()).then(resolve, reject); }
      catch (error) { reject(error); }
    });
  });
  const observed = waitForOperationStart(options.stream, prompt);
  const lifecycle = observed.then(async (mode) => {
    if (mode === "deferred") await options.stream.settled();
    else await Promise.race([options.stream.settled(), prompt]);
  });
  const completion = lifecycle.then(options.finish, () => { options.stream.markError(); return options.finish(); });
  return { started: observed.then(() => undefined), completion };
}

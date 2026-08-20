import { GatewaySessionStream } from "./gateway-session-stream.ts";

const DEFERRED_OPERATION_START_GRACE_MS = 5_000;

export async function waitForOperationStart(
  stream: GatewaySessionStream,
  prompt: Promise<void>
): Promise<"prompt-owned" | "deferred"> {
  const started = stream.started();
  const first = await Promise.race([
    started.then(() => ({ state: "started" as const })),
    prompt.then(() => ({ state: "prompt-resolved" as const }),
      (error: unknown) => ({ state: "prompt-rejected" as const, error }))
  ]);
  if (first.state === "started") return "prompt-owned";
  if (first.state === "prompt-rejected") throw first.error;

  // Extension commands such as `/workflow` launch their agent turn through
  // `pi.sendUserMessage()`. The outer prompt resolves before that deferred turn
  // emits `agent_start`, so retain ownership until the real operation appears.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      started,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("session-operation-start-unobserved")),
          DEFERRED_OPERATION_START_GRACE_MS);
      })
    ]);
    return "deferred";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

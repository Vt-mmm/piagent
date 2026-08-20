import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";

export async function executePermissionCommand(session: any,
  permissionMode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<void> {
  const before = Array.isArray(session.messages) ? session.messages.length : 0;
  await session.prompt(`/permission ${permissionMode}`);
  const messages = Array.isArray(session.messages) ? session.messages.slice(before) : [];
  const observed = messages.reverse().find((message: any) => message?.role === "custom"
    && message.customType === "piagent-permission-profile");
  const profile = observed?.details?.permissionProfile;
  if (!profile || profile.mode !== permissionMode || profile.warning) throw new Error("session-permission-unavailable");
}

export async function executeRuntimeCommand(session: any, command: string): Promise<{
  outputs: Array<{ customType: string; content: string; truncated: boolean; redacted: boolean }>;
  modelCallObserved: boolean;
}> {
  const before = Array.isArray(session.messages) ? session.messages.length : 0;
  await session.prompt(command);
  const added = Array.isArray(session.messages) ? session.messages.slice(before) : [];
  const outputs = added.filter((message: any) => message?.role === "custom").slice(-8).map((message: any) => {
    const source = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    const bounded = source.slice(0, 12_000), redacted = redactSensitiveText(bounded);
    const rawType = String(message.customType ?? "runtime-output");
    return { customType: /^[A-Za-z0-9._-]{1,120}$/.test(rawType) ? rawType : "runtime-output", content: redacted.text,
      truncated: source.length > bounded.length, redacted: redacted.redacted };
  });
  return { outputs, modelCallObserved: added.some((message: any) => message?.role === "assistant") };
}

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import {
  PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE,
  parseServiceTierReceipt,
  type ServiceTierReceipt
} from "../../piagent-core/runtime/model/service-tier-runtime.ts";

type RuntimeCommandOutput = {
  customType: string;
  content: string;
  truncated: boolean;
  redacted: boolean;
  details?: ServiceTierReceipt;
};

export async function executePermissionCommand(session: any,
  permissionMode: "read-only" | "workspace-write" | "trusted-full-access"): Promise<void> {
  if (session.managedExecution) throw new Error("managed-permissions-controlled-by-studio");
  const before = Array.isArray(session.messages) ? session.messages.length : 0;
  await session.prompt(`/permission ${permissionMode}`);
  const messages = Array.isArray(session.messages) ? session.messages.slice(before) : [];
  const observed = messages.reverse().find((message: any) => message?.role === "custom"
    && message.customType === "piagent-permission-profile");
  const profile = observed?.details?.permissionProfile;
  if (!profile || profile.mode !== permissionMode || profile.warning) throw new Error("session-permission-unavailable");
}

export async function executeRuntimeCommand(session: any, command: string): Promise<{
  outputs: RuntimeCommandOutput[];
  modelCallObserved: boolean;
}> {
  if (session.managedExecution) throw new Error("managed-runtime-command-unavailable");
  const before = Array.isArray(session.messages) ? session.messages.length : 0;
  await session.prompt(command);
  const added = Array.isArray(session.messages) ? session.messages.slice(before) : [];
  const outputs = added.filter((message: any) => message?.role === "custom").slice(-8).map((message: any) => {
    const source = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
    // Redact all of it, then bound it: cutting first can leave the front of a credential.
    const full = redactSensitiveText(source), bounded = full.text.slice(0, 12_000), redacted = { text: bounded, redacted: full.redacted };
    const rawType = String(message.customType ?? "runtime-output");
    const details = rawType === PIAGENT_SERVICE_TIER_RECEIPT_ENTRY_TYPE
      ? parseServiceTierReceipt(message.details) : null;
    return { customType: /^[A-Za-z0-9._-]{1,120}$/.test(rawType) ? rawType : "runtime-output", content: redacted.text,
      truncated: full.text.length > bounded.length, redacted: redacted.redacted, ...(details ? { details } : {}) };
  });
  return { outputs, modelCallObserved: added.some((message: any) => message?.role === "assistant") };
}

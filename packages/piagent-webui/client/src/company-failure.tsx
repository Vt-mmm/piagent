import { type UiLocale } from "./ui-preferences.tsx";

import { companyFailureText, failureRoleText, type FailureRole } from "../../shared/company-copy.ts";

// The copy lives in shared/company-copy.ts: the company Terminal says the same.
export function companyFailureCopy(reason: string, code: string | null, locale: UiLocale): { title: string; text: string } | null {
  return companyFailureText(reason, code, locale);
}

// Kinds after which "tiếp tục" in the same conversation is the way on (once
// the cause is lifted). The others need something else first: a new
// conversation, an update. A rejected request is continued: a conversation
// too long for the model is summarised before the next one is sent.
const CONTINUABLE = new Set(["company-quota", "company-provider-limit", "company-account", "company-busy", "company-trial-limit", "company-key",
  "company-policy", "company-rejected", "company-unreachable", "company-service", "company-config-changed", "company-failed"]);
export function failureContinuable(reason: string): boolean { return CONTINUABLE.has(reason) || !reason.startsWith("company-"); }

// Who failed: a harness role, never a model name.
export function failureRole(role: FailureRole, locale: UiLocale): string { return failureRoleText(role, locale); }

import type { Workflow } from "../../contracts/generated/session-command-v1.ts";

const WORKFLOW_LABELS: Record<Workflow, readonly [vi: string, en: string]> = {
  task: ["Thực hiện task", "Implement task"],
  scout: ["Khảo sát chỉ đọc", "Read-only scout"],
  "be-to-fe": ["Backend → Frontend", "Backend → Frontend"],
  discuss: ["Làm rõ ý tưởng", "Clarify idea"],
  plan: ["Lập kế hoạch", "Plan"],
  review: ["Review thay đổi", "Review changes"],
  commit: ["Chuẩn bị commit", "Prepare commit"],
  pr: ["Chuẩn bị pull request", "Prepare pull request"],
  onboard: ["Onboard project", "Onboard project"],
  "platform-improve": ["Cải tiến Piagent", "Improve Piagent"]
};

// Labels are presentation copy only. Workflow inventory and behavior always
// arrive from the Gateway's canonical core projection.
export function workflowLabel(value: Workflow, locale: "vi" | "en"): string {
  return WORKFLOW_LABELS[value][locale === "vi" ? 0 : 1];
}

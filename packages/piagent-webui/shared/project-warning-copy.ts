// The line a member reads when Studio says their company conversation works
// in a repository that does not belong to the key's team
// ("agent-watch-project"), in the dashboard and in the company Terminal.
import type { CopyLocale } from "./company-copy.ts";

export type ProjectWarningItem = { repo: string; kind: "other_team" | "unlisted" };

export function projectWarningText(warnings: readonly ProjectWarningItem[], team: string | null | undefined, locale: CopyLocale): string {
  const repos = warnings.map(item => item.repo).join(", "), name = team ? ` ${team}` : "";
  if (warnings.some(item => item.kind === "other_team")) return locale === "vi"
    ? `${repos} thuộc team khác, không phải team${name} của key này. Admin Studio đã được báo.`
    : `${repos} belongs to another team, not this key's team${name}. Studio administrators were told.`;
  return locale === "vi"
    ? `${repos} chưa có trong danh sách repository của team${name}. Admin Studio đã được báo.`
    : `${repos} is not in the repository list of team${name}. Studio administrators were told.`;
}

// The line a member reads when Studio says their company conversation works
// in a project that does not belong to the key's team ("agent-watch-project"),
// in the dashboard and in the company Terminal. A local project (no readable
// remote) is named by its folder.
import type { CopyLocale } from "./company-copy.ts";

export type ProjectWarningItem = { repo: string; kind: "other_team" | "unlisted" | "unregistered" | "no_repository"; name?: string };

const label = (item: ProjectWarningItem) => item.name ?? item.repo;

export function projectWarningText(warnings: readonly ProjectWarningItem[], team: string | null | undefined, locale: CopyLocale): string {
  const vi = locale === "vi", name = team ? ` ${team}` : "", told = vi ? " Admin Studio đã được báo." : " Studio administrators were told.";
  const of = (kind: ProjectWarningItem["kind"]) => warnings.filter(item => item.kind === kind).map(label).join(", ");
  const parts: string[] = [];
  const other = of("other_team"), unlisted = of("unlisted"), unregistered = of("unregistered"), none = of("no_repository");
  if (other) parts.push(vi ? `${other} thuộc team khác, không phải team${name} của key này.` : `${other} belongs to another team, not this key's team${name}.`);
  if (unlisted) parts.push(vi ? `${unlisted} chưa có trong danh sách project của team${name}.` : `${unlisted} is not in the project list of team${name}.`);
  if (unregistered) parts.push(vi ? `${unregistered} chưa được đăng ký cho team${name}.` : `${unregistered} is not registered to team${name}.`);
  if (none) parts.push(vi ? `Không xác định được project của thư mục ${none}.` : `The project of folder ${none} could not be identified.`);
  return parts.join(" ") + told;
}

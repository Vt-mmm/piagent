import Alert from "@mui/material/Alert";
import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import { projectWarningText } from "../../shared/project-warning-copy.ts";
import type { UiLocale } from "./ui-preferences.tsx";

// One line when Studio says this company conversation works in a repository
// that does not belong to the key's team; its administrators see it in Logs →
// "Sai project". Nothing is blocked.
export function ProjectWarning({ session, locale }: { session: SessionRow; locale: UiLocale }) {
  const warning = session.managedProjectWarning;
  if (!warning) return null;
  return <Alert severity="warning" role="status" sx={{ maxWidth: 820, mx: "auto", mb: 1, py: 0 }}>
    {projectWarningText(warning.warnings, warning.team, locale)}</Alert>;
}

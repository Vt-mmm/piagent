import Box from "@mui/material/Box";
import SvgIcon, { type SvgIconProps } from "@mui/material/SvgIcon";
import Tooltip from "@mui/material/Tooltip";

import type { SessionRow } from "../../contracts/generated/session-catalog-v1.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

export function GitBranchIcon(props: SvgIconProps) {
  return <SvgIcon viewBox="0 0 16 16" {...props}><path d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.25 2.25 0 1 0 1.5 0V9.5h3.25a2.75 2.75 0 0 0 2.75-2.75v-1.378a2.25 2.25 0 1 0-1.5 0V6.75c0 .69-.56 1.25-1.25 1.25H5V5.372ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm7.5-9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" /></SvgIcon>;
}

export function branchTitle(branch: NonNullable<SessionRow["gitBranch"]>, locale: UiLocale): string {
  return branch.detached ? localize(locale, `Git không ở nhánh nào (detached HEAD tại ${branch.name})`, `Git is not on a branch (detached HEAD at ${branch.name})`)
    : localize(locale, `Nhánh Git của project: ${branch.name}`, `The project's Git branch: ${branch.name}`);
}

// The Git branch a conversation's project folder stands on. Detached HEAD
// shows the short commit and reads as a warning: work there belongs to no branch.
export function GitBranchLabel({ branch, locale, maxWidth = 220 }: { branch: SessionRow["gitBranch"]; locale: UiLocale; maxWidth?: number | string }) {
  if (!branch) return null;
  return <Tooltip describeChild title={branchTitle(branch, locale)}>
    <Box component="span" aria-label={branchTitle(branch, locale)} sx={{ display: "inline-flex", alignItems: "center", gap: .4, minWidth: 0, maxWidth,
      verticalAlign: "bottom", color: branch.detached ? "warning.main" : "inherit" }}>
      <GitBranchIcon sx={{ fontSize: "1.1em", flexShrink: 0 }} />
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: ".95em" }}>
        {branch.name}</Box></Box></Tooltip>;
}

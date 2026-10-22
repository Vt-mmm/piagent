import { useEffect } from "react";
import Stack from "@mui/material/Stack";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { EvidencePanels } from "./EvidencePanels.tsx";
import { RuntimeOverview, TaskDashboard } from "./App.tsx";
import { SourceWorkspace } from "./SourceWorkspace.tsx";
import type { ReviewFinding } from "./line-review.ts";
import { DocumentWorkspace } from "./DocumentWorkspace.tsx";
import { useUiPreferences } from "./ui-preferences.tsx";
import type { LiveActivity, TerminalOperationActivity } from "./live-state-view-model.ts";

export type SessionWorkspaceId = "task" | "source" | "documents" | "activity";

export function SessionAgentWorkspace({ active, snapshot, sessionRef, terminalActivities, liveActivities, refresh, findings, onSendComments }: { active: SessionWorkspaceId;
  findings?: readonly ReviewFinding[]; onSendComments?: (text: string) => void;
  snapshot: PiagentWebUICanonicalSnapshotV1; sessionRef: string; terminalActivities?: readonly TerminalOperationActivity[];
  liveActivities?: readonly LiveActivity[];
  refresh(): Promise<PiagentWebUICanonicalSnapshotV1 | undefined> }) {
  const { locale } = useUiPreferences();
  useEffect(() => {
    const saved = (event: Event) => { if ((event as CustomEvent).detail?.sessionRef === sessionRef) void refresh(); };
    window.addEventListener('piagent-workspace-saved', saved);
    return () => window.removeEventListener('piagent-workspace-saved', saved);
  }, [sessionRef, refresh]);
  if (active === "source") return <SourceWorkspace snapshot={snapshot} sessionRef={sessionRef} refreshSnapshot={refresh}
    findings={findings} onSendComments={onSendComments} />;
  if (active === "documents") return <DocumentWorkspace sessionRef={sessionRef} />;
  if (active === "activity") return <ActivityPanel snapshot={snapshot} sessionRef={sessionRef}
    terminalActivities={terminalActivities} liveActivities={liveActivities} />;
  return <Stack spacing={2.25}><RuntimeOverview snapshot={snapshot} locale={locale} />
    <TaskDashboard snapshot={snapshot} locale={locale} /><EvidencePanels snapshot={snapshot} /></Stack>;
}

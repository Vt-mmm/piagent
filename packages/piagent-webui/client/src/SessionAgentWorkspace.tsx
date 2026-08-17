import Stack from "@mui/material/Stack";

import type { PiagentWebUICanonicalSnapshotV1 } from "../../contracts/generated/snapshot-v1.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { EvidencePanels } from "./EvidencePanels.tsx";
import { RuntimeOverview, TaskDashboard } from "./App.tsx";
import { SourceWorkspace } from "./SourceWorkspace.tsx";
import { DocumentWorkspace } from "./DocumentWorkspace.tsx";
import { useUiPreferences } from "./ui-preferences.tsx";

export type SessionWorkspaceId = "task" | "source" | "documents" | "activity";

export function SessionAgentWorkspace({ active, snapshot, sessionRef, refresh }: { active: SessionWorkspaceId;
  snapshot: PiagentWebUICanonicalSnapshotV1; sessionRef: string; refresh(): Promise<PiagentWebUICanonicalSnapshotV1 | undefined> }) {
  const { locale } = useUiPreferences();
  if (active === "source") return <SourceWorkspace snapshot={snapshot} sessionRef={sessionRef} refreshSnapshot={refresh} />;
  if (active === "documents") return <DocumentWorkspace sessionRef={sessionRef} />;
  if (active === "activity") return <ActivityPanel snapshot={snapshot} sessionRef={sessionRef} />;
  return <Stack spacing={2.25}><RuntimeOverview snapshot={snapshot} locale={locale} />
    <TaskDashboard snapshot={snapshot} locale={locale} /><EvidencePanels snapshot={snapshot} /></Stack>;
}

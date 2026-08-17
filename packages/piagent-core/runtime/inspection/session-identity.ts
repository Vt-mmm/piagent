// The identity and revision shape a Pi session is addressed by.
//
// Both the in-session bridge and the Gateway have to speak it: the bridge
// because it owns one live session, the Gateway because it synthesises the same
// shape from an inspection snapshot for the many sessions it drives. The layer
// rules let extension and gateway each import server, and neither import the
// other, so this is the one place both can agree on.

type NullableRef = string | null;

export type BridgeIdentity = { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string | null;
  taskRunId: string | null; agentOperationId: string | null; toolCallId: null };

export type BridgeRevisions = { runtimeRevision: string; taskRevision: NullableRef; controlRevision: NullableRef;
  workspaceRevision: NullableRef; indexRevision: NullableRef; approvalRevision: NullableRef;
  sessionOptionRevision: NullableRef; queueRevision: NullableRef };

export type BridgeSnapshot = { state: "unbound" | "ready" | "replacement-pending" | "shutdown";
  identity: BridgeIdentity | null; revisions: BridgeRevisions | null; liveness: "idle" | "running" | "unknown";
  taskState: "none" | "active" | "pause-requested" | "paused" | "terminal" | "unknown"; eventSequence: number };

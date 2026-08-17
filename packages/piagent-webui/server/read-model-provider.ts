export type SourceView = "task" | "working-tree" | "staged";
export type StreamEvent = { cursor: string; value: unknown };
export type StreamReplay = {
  state: "current" | "truncated" | "resync-required";
  events: StreamEvent[];
  nextCursor: string;
  latestCursor: string;
  reasonCode: string | null;
};

export type WebUiReadModelProvider = {
  snapshot(): unknown | Promise<unknown>;
  sourceChanges(view: SourceView): unknown | Promise<unknown>;
  diff(view: SourceView, fileRef: string): unknown | Promise<unknown>;
  review(view: SourceView, fileRef: string): unknown | Promise<unknown>;
  sourceMutation(action: "source.stage" | "source.unstage", fileRef: string): unknown | Promise<unknown>;
  sourceRevert(fileRef: string, hunkRef: string | null): unknown | Promise<unknown>;
  commitSummary(): unknown | Promise<unknown>;
  taskIndex(): unknown | Promise<unknown>;
  taskTimeline(runRef: string): unknown | Promise<unknown>;
  recoveryHistory(runRef: string): unknown | Promise<unknown>;
  handoffHistory(runRef: string): unknown | Promise<unknown>;
  subagentTree(runRef: string): unknown | Promise<unknown>;
  releaseMonitor(): unknown | Promise<unknown>;
  documents(): unknown | Promise<unknown>;
  document(documentRef: string): unknown | Promise<unknown>;
  activity(): unknown | Promise<unknown>;
  logPreview(activityRef: string): unknown | Promise<unknown>;
  transcript(beforeCursor: string | null, limit: number): unknown | Promise<unknown>;
  queue(): unknown | Promise<unknown>;
  modelCatalog(): unknown | Promise<unknown>;
  approval(approvalRef: string): unknown | Promise<unknown>;
  replay(after: string | null, limit: number): StreamReplay | Promise<StreamReplay>;
  subscribe(listener: (event: StreamEvent) => void): () => void;
};

export class ReadModelNotFound extends Error {
  constructor() { super("read-model-ref-not-found"); }
}

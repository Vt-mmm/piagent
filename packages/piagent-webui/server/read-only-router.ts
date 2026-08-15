import type { WebUiReadModelProvider, SourceView } from "./read-model-provider.ts";

const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

export type ReadRouteResult = { handled: false } | { handled: true; status: number; value: unknown };

export async function routeReadOnlyRequest(url: URL, provider: WebUiReadModelProvider): Promise<ReadRouteResult> {
  if (url.pathname === "/api/v1/snapshot" && !url.search) return { handled: true, status: 200, value: await provider.snapshot() };
  if (url.pathname === "/api/v1/activity" && !url.search) return { handled: true, status: 200, value: await provider.activity() };
  if (url.pathname === "/api/v1/tasks" && !url.search) return { handled: true, status: 200, value: await provider.taskIndex() };
  if (url.pathname === "/api/v1/monitoring/release" && !url.search) return { handled: true, status: 200, value: await provider.releaseMonitor() };
  if (url.pathname.startsWith("/api/v1/tasks/") && url.pathname.endsWith("/timeline")) {
    const ref = url.pathname.slice("/api/v1/tasks/".length, -"/timeline".length);
    if (url.search || !OPAQUE_REF.test(ref) || ref.includes("/")) return { handled: true, status: 400, value: { error: { code: "invalid-task-run-ref" } } };
    return { handled: true, status: 200, value: await provider.taskTimeline(ref) };
  }
  if (url.pathname.startsWith("/api/v1/tasks/") && url.pathname.endsWith("/recovery-history")) {
    const ref = url.pathname.slice("/api/v1/tasks/".length, -"/recovery-history".length);
    if (url.search || !OPAQUE_REF.test(ref) || ref.includes("/")) return { handled: true, status: 400, value: { error: { code: "invalid-task-run-ref" } } };
    return { handled: true, status: 200, value: await provider.recoveryHistory(ref) };
  }
  if (url.pathname.startsWith("/api/v1/tasks/") && url.pathname.endsWith("/handoff-history")) {
    const ref = url.pathname.slice("/api/v1/tasks/".length, -"/handoff-history".length);
    if (url.search || !OPAQUE_REF.test(ref) || ref.includes("/")) return { handled: true, status: 400, value: { error: { code: "invalid-task-run-ref" } } };
    return { handled: true, status: 200, value: await provider.handoffHistory(ref) };
  }
  if (url.pathname.startsWith("/api/v1/tasks/") && url.pathname.endsWith("/subagent-tree")) {
    const ref = url.pathname.slice("/api/v1/tasks/".length, -"/subagent-tree".length);
    if (url.search || !OPAQUE_REF.test(ref) || ref.includes("/")) return { handled: true, status: 400, value: { error: { code: "invalid-task-run-ref" } } };
    return { handled: true, status: 200, value: await provider.subagentTree(ref) };
  }
  if (url.pathname === "/api/v1/chat/queue" && !url.search) return { handled: true, status: 200, value: await provider.queue() };
  if (url.pathname === "/api/v1/session-options/models" && !url.search) return { handled: true, status: 200, value: await provider.modelCatalog() };
  if (url.pathname.startsWith("/api/v1/approvals/")) {
    const ref = url.pathname.slice("/api/v1/approvals/".length);
    if (url.search || !OPAQUE_REF.test(ref) || ref.includes("/")) return { handled: true, status: 400, value: { error: { code: "invalid-approval-ref" } } };
    return { handled: true, status: 200, value: await provider.approval(ref) };
  }
  if (url.pathname === "/api/v1/transcript") {
    if ([...url.searchParams.keys()].some((key) => key !== "before" && key !== "limit")
      || url.searchParams.getAll("before").length > 1 || url.searchParams.getAll("limit").length > 1) {
      return { handled: true, status: 400, value: { error: { code: "invalid-transcript-page" } } };
    }
    const before = url.searchParams.get("before"), rawLimit = url.searchParams.get("limit"), limit = rawLimit === null ? 50 : Number(rawLimit);
    if ((before !== null && !OPAQUE_REF.test(before)) || !Number.isInteger(limit) || limit < 1 || limit > 200) {
      return { handled: true, status: 400, value: { error: { code: "invalid-transcript-page" } } };
    }
    return { handled: true, status: 200, value: await provider.transcript(before, limit) };
  }
  if (url.pathname === "/api/v1/source-changes") {
    if ([...url.searchParams.keys()].some((key) => key !== "view") || url.searchParams.getAll("view").length !== 1) return { handled: true, status: 400, value: { error: { code: "invalid-source-view" } } };
    const view = url.searchParams.get("view");
    if (!(["task", "working-tree", "staged"] as Array<string | null>).includes(view)) return { handled: true, status: 400, value: { error: { code: "invalid-source-view" } } };
    return { handled: true, status: 200, value: await provider.sourceChanges(view as SourceView) };
  }
  if (url.pathname.startsWith("/api/v1/diffs/")) {
    const ref = url.pathname.slice("/api/v1/diffs/".length);
    const view = url.searchParams.get("view");
    if (!OPAQUE_REF.test(ref) || url.searchParams.getAll("view").length !== 1
      || [...url.searchParams.keys()].some((key) => key !== "view")
      || !(view && (["task", "working-tree", "staged"] as string[]).includes(view))) {
      return { handled: true, status: 400, value: { error: { code: "invalid-diff-authority" } } };
    }
    return { handled: true, status: 200, value: await provider.diff(view as SourceView, ref) };
  }
  if (url.pathname.startsWith("/api/v1/reviews/")) {
    const ref = url.pathname.slice("/api/v1/reviews/".length);
    const view = url.searchParams.get("view");
    if (!OPAQUE_REF.test(ref) || url.searchParams.getAll("view").length !== 1
      || [...url.searchParams.keys()].some((key) => key !== "view")
      || !(view && (["task", "working-tree", "staged"] as string[]).includes(view))) {
      return { handled: true, status: 400, value: { error: { code: "invalid-review-authority" } } };
    }
    return { handled: true, status: 200, value: await provider.review(view as SourceView, ref) };
  }
  if (url.pathname.startsWith("/api/v1/source-mutations/")) {
    const ref = url.pathname.slice("/api/v1/source-mutations/".length), action = url.searchParams.get("action");
    if (!OPAQUE_REF.test(ref) || url.searchParams.getAll("action").length !== 1
      || [...url.searchParams.keys()].some((key) => key !== "action") || !["source.stage", "source.unstage"].includes(String(action))) {
      return { handled: true, status: 400, value: { error: { code: "invalid-source-mutation-authority" } } };
    }
    return { handled: true, status: 200, value: await provider.sourceMutation(action as "source.stage" | "source.unstage", ref) };
  }
  if (url.pathname.startsWith("/api/v1/source-reverts/")) {
    const ref = url.pathname.slice("/api/v1/source-reverts/".length), hunkRef = url.searchParams.get("hunkRef");
    if (!OPAQUE_REF.test(ref) || url.searchParams.getAll("hunkRef").length > 1
      || [...url.searchParams.keys()].some((key) => key !== "hunkRef") || hunkRef !== null && !OPAQUE_REF.test(hunkRef)) {
      return { handled: true, status: 400, value: { error: { code: "invalid-source-revert-authority" } } };
    }
    return { handled: true, status: 200, value: await provider.sourceRevert(ref, hunkRef) };
  }
  if (url.pathname === "/api/v1/commit-summary") {
    if (url.search) return { handled: true, status: 400, value: { error: { code: "invalid-commit-summary-request" } } };
    return { handled: true, status: 200, value: await provider.commitSummary() };
  }
  for (const [prefix, read] of [
    ["/api/v1/log-previews/", (ref: string) => provider.logPreview(ref)]
  ] as const) {
    if (!url.pathname.startsWith(prefix)) continue;
    const ref = url.pathname.slice(prefix.length);
    if (url.search || !OPAQUE_REF.test(ref)) return { handled: true, status: 400, value: { error: { code: "invalid-opaque-ref" } } };
    return { handled: true, status: 200, value: await read(ref) };
  }
  return { handled: false };
}

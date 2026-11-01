import { useEffect, useMemo, useState } from "react";

import type { TranscriptItem } from "../../contracts/generated/transcript-v1.ts";
import { readSessionTranscript } from "./api.ts";
import { activityLogGroups } from "./activity-view-model.ts";
import type { LiveActivity } from "./live-state-view-model.ts";
import { tone } from "./view-model.ts";
import { localize, type UiLocale } from "./ui-preferences.tsx";

function agentName(agent: string, locale: UiLocale): string {
  return agent === "main" ? localize(locale, "Main agent", "Main agent") : `Subagent ${agent}`;
}

function clock(at: string, locale: UiLocale): string {
  const value = new Date(at);
  return Number.isFinite(value.getTime()) ? value.toLocaleTimeString(locale === "vi" ? "vi-VN" : "en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

// Re-read while the turn runs: a stored call has no event of its own here.
const REFRESH_MS = 5_000;
export function AgentActivityLog({ sessionRef, running, live, locale, empty }: { sessionRef: string; running: boolean; live?: readonly LiveActivity[]; locale: UiLocale; empty?: string }) {
  const [items, setItems] = useState<readonly TranscriptItem[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => void readSessionTranscript(sessionRef, null, 200, controller.signal).then((value) => setItems(value.items)).catch(() => undefined);
    load();
    const timer = running ? window.setInterval(load, REFRESH_MS) : undefined;
    return () => { controller.abort(); if (timer) window.clearInterval(timer); };
  }, [sessionRef, running]);
  const groups = useMemo(() => activityLogGroups(items, live), [items, live]);
  if (!groups.length) return empty ? <div className="activity-empty">{empty}</div> : null;
  return <div className="agent-activity-log">
    {groups.map((group) => <details key={group.agent} open={group.agent === "main" || running} className="agent-activity-group">
      <summary><strong>{agentName(group.agent, locale)}</strong> <span>{group.total} {localize(locale, "lần gọi", "calls")}</span>
        {group.total > group.steps.length && <span> · {localize(locale, `hiện ${group.steps.length} gần nhất`, `showing the latest ${group.steps.length}`)}</span>}</summary>
      {group.steps.map((step) => <article key={step.key} className="activity-row">
        <span className={`activity-state tone-${tone(step.state)}`} aria-label={step.state} />
        <div className="activity-copy"><div><strong>{step.toolName}</strong></div>{step.target && <p>{step.target}</p>}</div>
        <div className="activity-result"><span>{clock(step.at, locale)}</span></div>
      </article>)}
    </details>)}
  </div>;
}

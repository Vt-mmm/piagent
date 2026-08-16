// What to do about a refusal.
//
// A blocked tool call is the only conversation most operators ever have with
// this policy, and for most of them it was one-sided: the guard states 74
// distinct refusals and three of them said what to do next. The rest ended at
// "no", which leaves the reader guessing at a rule they cannot see.
//
// Remedies are attached in one place rather than at the 29 sites that build a
// refusal, for the reason this codebase keeps arriving at: a rule applied at
// every call site is a rule that will be missed at the next one. Every decision
// leaves through `registerToolCallHook`, so it is enough to answer there, and a
// refusal added tomorrow is answered without anyone remembering to.

// Matched against the refusal text in order; the first match wins, so put the
// narrower phrase above the broader one it would otherwise be swallowed by.
const REMEDIES: Array<{ match: RegExp; remedy: string }> = [
  {
    // `grep glob targeting` and `find pattern targeting` are the same refusal
    // reached through a different tool, and matching only the shell wording left
    // two thirds of this family answering nothing.
    match: /glob can target protected path|glob targeting protected path|pattern targeting protected path/i,
    remedy: "Name the exact file instead of a pattern: a pattern is refused when any name it can match is protected."
      + " `piagent explain '<command>'` shows which name it matched."
  },
  {
    match: /builds a filename this guard cannot resolve/i,
    // This refusal already carries its own guidance, so it only gains the
    // pointer to the tool that shows the whole chain.
    remedy: "`piagent explain '<command>'` shows every step that ran and what each one saw."
  },
  {
    match: /(touches|resolves to) protected path|access to protected path|write to protected path/i,
    remedy: "Use an approved `piagent-context` projection if one is available. Direct access requires the operator"
      + " to change the protected-path policy; task scope alone does not override it."
      + " `piagent explain '<command>'` shows which pattern matched."
  },
  {
    match: /write to read-only path/i,
    remedy: "The active profile marks this path read-only. Change `readOnlyPaths` in `.pi/piagent-profile.json`"
      + " if the project really should allow writes here, then reapply the profile."
  },
  {
    match: /outside resolved filesystem scope/i,
    remedy: "Work inside the project, or widen the filesystem scope in the active profile and reapply it."
  },
  {
    match: /cannot mutate paths outside its declared scope|semantic repair must stay inside its declared task scope/i,
    remedy: "Start a new attempt with `piagent_task_start` listing this path in the scope; a running task cannot widen its own."
  },
  {
    match: /Task Implementation Contract is required/i,
    remedy: "Call `piagent_task_start` once with explicit project-relative scope, then retry."
  },
  {
    match: /Capability lock is (missing|unreadable)|does not match what this project agreed to/i,
    remedy: "Reapply the project profile to rebuild the lock: `piagent-init <project> --force-profile`."
  },
  {
    match: /runtime changed during this session/i,
    remedy: "Restart the Pi session. The lock is re-verified and re-pinned at session start, never mid-session."
  },
  {
    match: /Permission profile read-only blocked/i,
    remedy: "This session is read-only. Change the access level in Settings, or start it with a writable permission profile."
  },
  {
    match: /Tool (is not registered|registry is disabled|registry blocked)/i,
    remedy: "Enable the tool group for this profile, or use a tool the profile already allows."
  },
  {
    match: /lifecycle control blocks tool start|resume is blocked|could not enter an audited repair phase/i,
    remedy: "Resolve the task lifecycle first — resume, repair, or close the current attempt — then retry."
  },
  {
    match: /path traverses symbolic link|path resolves outside the project|path component cannot be inspected/i,
    remedy: "Use the real path inside the project. A link that leaves the project is refused rather than followed."
  },
  {
    match: /requires confirmation|requires explicit operator approval/i,
    remedy: "Approve it in the session when prompted; this is a decision the operator makes, not a defect."
  },
  {
    // The whole session is refused here, so this is the refusal most in need of
    // a next step -- and the one the narrower MCP wording used to miss.
    match: /Blocked every tool call/i,
    remedy: "Every tool call is refused while a repository config can reach an ungated server."
      + " Run `piagent-mcp doctor` to see which config stopped the session, then approve or remove those servers."
  },
  {
    match: /MCP (proxy|shell carrier|command|server)/i,
    remedy: "Check the server with `piagent-mcp doctor`, and approve it explicitly if the project should reach it."
  },
  {
    match: /is read-only; .*cannot mutate|read-only inspection allowlist/i,
    remedy: "This task was started read-only. Start a source-change task with `piagent_task_start` when the work needs to write."
  },
  {
    match: /opaque shell mutation whose write target is not statically bounded/i,
    remedy: "Use the edit, write, or apply-patch tools so the target is named, instead of a shell command that computes it."
  },
  {
    match: /Context budget blocked editing large file/i,
    remedy: "Edit a narrower range of the file, or split the change, so the edit stays inside the context budget."
  },
  {
    match: /Approval became stale/i,
    remedy: "Ask for the action again; an approval is bound to the state it was granted for and does not survive a change to it."
  },
  {
    match: /Missing capability|Capability validation failed/i,
    remedy: "Add the pack that provides it to the project profile, then reapply the profile."
  },
  {
    match: /nesting exceeds inspection depth|unsafe scope pattern/i,
    remedy: "Flatten the tool input or narrow the scope pattern: anything the guard cannot finish inspecting is refused rather than guessed at."
  },
  {
    match: /start a new attempt or a fresh task/i,
    remedy: "Start the next attempt with `piagent_task_start`; a closed attempt cannot keep mutating the project."
  }
];

// Kept out of the appended text when the refusal already ends by saying what to
// do, so a reader is never given the same instruction twice in one line.
const ALREADY_GUIDED = /Write the path out|Reapply the project profile|Restart the session|then retry\.$|Start the task first/i;

export function remedyForReason(reason: string): string | undefined {
  if (typeof reason !== "string" || reason.trim().length === 0) return undefined;
  const found = REMEDIES.find((entry) => entry.match.test(reason));
  if (!found) return undefined;
  if (ALREADY_GUIDED.test(reason) && !/glob can target|cannot resolve/i.test(reason)) return undefined;
  return found.remedy;
}

export function withRemedy<T extends { block: true; reason: string }>(decision: T): T {
  const remedy = remedyForReason(decision.reason);
  if (!remedy || decision.reason.includes(remedy)) return decision;
  return { ...decision, reason: `${decision.reason.replace(/\s+$/, "")} → ${remedy}` };
}

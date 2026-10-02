import { REVIEW_PROMPT, VERIFY_PROMPT, isCheckCommand } from './workflow.mjs';

// Each helper role runs at most this often per user message (Studio's MaxHelperCalls).
export const HELPER_CALLS = 8;

// The helpers a main agent may delegate to, in the Harness's order. Each is
// optional: only those the company Harness enables (and Agent Watch passes
// on) are offered. Scout reads the code, research also reads the web, verify
// re-checks a result with the repository's checks and primary sources,
// review judges the patch. None of them changes files.
export const HELPER_ROLES = Object.freeze(['scout', 'research', 'verify', 'review']);
export const helperRoles = manifest => HELPER_ROLES.filter(role => manifest?.harness?.configuration?.[role]);
const WIDE_READING = 'when understanding the task needs more reading than a few batches of files, such as a flow across many modules of an unfamiliar codebase';
export function helperPrompt(roles) {
  const lines = [];
  if (roles.includes('scout')) lines.push(`Use the scout helper (delegate role "scout") ${WIDE_READING}, and work from its file:line findings; do small lookups yourself.`);
  if (roles.includes('research')) lines.push(roles.includes('scout') ? 'Use the research helper (delegate role "research") for questions that need external documentation or current information (library and API docs, releases, error messages) together with the code.'
    : `Use the research helper (delegate role "research") ${WIDE_READING} or external documentation, and work from its findings; do small lookups yourself.`);
  if (roles.includes('verify')) lines.push('Before you report a non-trivial result as done, you may have the verify helper (delegate role "verify") confirm it independently: it runs the repository checks on the current code and checks claims against the code and primary sources, answering pass, fail or unverifiable with evidence.');
  return lines.length ? ' ' + lines.join(' ') : '';
}
const HELPER_USES = {
  scout: () => 'scout: before changing an area you do not know that spans more files than you can read in a few batches (where something is computed and every caller, how a flow crosses modules). It reads only the project, no web, and answers with file:line facts; your own context stays free for the change.',
  research: roles => roles.includes('scout') ? 'research: questions that need the web as well as the code: library or API documentation, releases, error messages, current information.'
    : 'research: before changing an area you do not know that spans more files than you can read in a few batches (where something is computed and every caller, how a flow crosses modules), or to read external documentation; your own context stays free for the change. It also searches the web.',
  verify: () => 'verify: an independent check of a result: it runs the repository checks on the current code (offline, and the project is read-only for its commands) and confirms claims, yours or a helper\'s, against the code and primary sources. It answers pass, fail or unverifiable per claim, with evidence.',
  review: () => 'review: an independent review of the current patch.',
};
export function delegateDescription(roles) {
  return `Hand work to a helper with its own context. Helpers read the project but cannot change files or call helpers. ${roles.map(role => HELPER_USES[role](roles)).join(' ')} A lookup that one grep or read answers stays with you. Write the task as a brief the helper can act on alone: the goal, what to find or check, where to start and what you already know or ruled out, and the answer you need (file:line facts). One call per helper runs at a time; each can be called again, up to ${HELPER_CALLS} times per user message, for example a second review after fixing what the first one found.`;
}
const RESEARCH_PROMPT = 'Research the assigned question. Read only the needed source; use web_search or web_fetch for external documentation. Answer with facts the main agent can act on: file:line, short quotes, what calls what, and what you checked and found nothing in. You cannot change files or delegate.';
const SCOUT_PROMPT = 'Scout the codebase for the assigned question. Search first (grep, find), then read only the parts that matter. Answer with facts the main agent can act on: file:line, short quotes, what calls what, and where you looked and found nothing. You have no web access: when the answer needs external documentation, say so. You cannot change files or delegate.';
export const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
// What each helper may use. Every helper's project is read-only; verify also
// runs commands there (offline, writes only to its temporary directory).
export const HELPER_SETUP = {
  scout: { web: false, commands: false, prompt: SCOUT_PROMPT, label: 'Scout' },
  research: { web: true, commands: false, prompt: RESEARCH_PROMPT, label: 'Research' },
  verify: { web: true, commands: true, prompt: VERIFY_PROMPT, label: 'Verify' },
  review: { web: false, commands: false, prompt: REVIEW_PROMPT, label: 'Review' },
};
// A repository check a helper ran counts for the run like one the main
// agent ran, when the code was the same before and after it: the helper
// cannot write, but the main agent may edit beside it in the same answer.
export function countedCheck(managed, tool) {
  if (tool.name !== 'bash') return tool;
  return { ...tool, execute: async (...args) => {
    const counted = managed.run && isCheckCommand(args[1]?.command, managed.checks.commands), before = counted ? await managed.digest() : null;
    let ok = false;
    try { const result = await tool.execute(...args); ok = true; return result; }
    finally {
      const after = counted && before !== null ? await managed.digest() : null;
      if (after !== null && after === before) await managed.run.afterTool('bash', args[1], ok, async () => after);
    }
  } };
}

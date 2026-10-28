import { REVIEW_PROMPT, VERIFY_PROMPT, BRIEF_CHECK, BRIEF_ISSUES_JSON, isCheckCommand } from './workflow.mjs';

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
const NETWORK_COMMANDS = 'run_with_network only when a command itself needs the internet or starts a local server or browser, such as end-to-end tests (the user approves each one)';
// With a research helper the main agent may still look one thing up itself:
// the Harness's workflow.main_web_lookups (0 to 5, default 0) web_search and
// web_fetch calls per member message. Anything wider is the helper's work.
export const MAIN_WEB_LOOKUPS_MAX = 5;
export function mainWebLookups(manifest) {
  const n = manifest?.harness?.configuration?.workflow?.main_web_lookups;
  return Number.isInteger(n) && n >= 0 && n <= MAIN_WEB_LOOKUPS_MAX ? n : 0;
}
// The main agent's web tools, counted against the current run's lookups.
export function limitedWebTools(tools, currentRun, limit) {
  return tools.map(tool => ({ ...tool, execute: async (...args) => {
    const run = currentRun();
    if (run && ++run.webLookups > limit) throw Error(`managed-web-lookups-spent: you used your ${limit} quick web lookup(s) for this message. Hand the rest of the web work to the research helper (delegate role "research").`);
    return tool.execute(...args);
  } }));
}
// How the main agent reaches the web. With a research helper, searching and
// reading pages happen on the helper's model, beyond a few quick lookups.
export function webPrompt(roles, lookups = 0) {
  if (!roles.includes('research'))
    return ` Shell commands run without network: use web_search for current information or documentation, web_fetch to read a public https page, and ${NETWORK_COMMANDS}.`;
  return lookups > 0
    ? ` Shell commands run without network. For one quick fact (a version, a flag, one documentation page) use web_search or web_fetch yourself, at most ${lookups} call(s) per member message; hand anything wider on the web (several sources, comparisons, news, research) to the research helper, and use ${NETWORK_COMMANDS}.`
    : ` Shell commands run without network and you have no web tools: hand anything on the web (current information, news, documentation, releases, error messages) to the research helper, and use ${NETWORK_COMMANDS}.`;
}
export function helperPrompt(roles) {
  const lines = [];
  if (roles.includes('scout')) lines.push(`Use the scout helper (delegate role "scout") ${WIDE_READING}, and work from its file:line findings; do small lookups yourself.`);
  if (roles.includes('research')) lines.push(roles.includes('scout') ? 'Use the research helper (delegate role "research") for anything on the web (current information, news, library and API docs, releases, error messages), together with the code when needed; give it the question and the answer you need, and work from its summary.'
    : `Use the research helper (delegate role "research") for anything on the web (current information, news, documentation) and ${WIDE_READING}; work from its findings and do small code lookups yourself.`);
  if (roles.includes('verify')) lines.push('Before you report a non-trivial result as done, you may have the verify helper (delegate role "verify") confirm it independently: it runs the repository checks on the current code and checks claims against the code and primary sources, answering pass, fail or unverifiable with evidence.');
  // Helpers read the member's request beside the brief and may object to it.
  if (lines.length) lines.push('A helper sees the member\'s request next to your brief and may object to the brief with evidence (brief_issues); each objection gets an id. You decide, but check each one at the place its evidence names and record your decision with resolve_objection: accepted with what you changed (a corrected brief, the plan, the code), or rejected with what you checked and why. An objection that the brief rests on a wrong premise or conflicts with the request refuses file changes until you decide it; a rejected one goes back to the helper, and a disagreement that remains goes to the member, as does a second objection from the same helper for one message.');
  // More than one helper of a role, only at the member's word (copies.mjs).
  if (lines.length) lines.push('One helper per role works on a brief. Only when the member asks for several of one role ("use 3 subagents", "dùng 2 helper"), run up to 3 in one delegate call: copies for independent answers on the same brief, or split for shares of the work, with member_words quoting the member\'s request. Never add helpers on your own.');
  return lines.length ? ' ' + lines.join(' ') : '';
}
const HELPER_USES = {
  scout: () => 'scout: before changing an area you do not know that spans more files than you can read in a few batches (where something is computed and every caller, how a flow crosses modules). It reads only the project, no web, and answers with file:line facts; your own context stays free for the change.',
  research: roles => roles.includes('scout') ? 'research: anything on the web (current information, news, library or API documentation, releases, error messages), with the code when needed. It searches and reads the pages; you get its summary with sources.'
    : 'research: anything on the web (current information, news, documentation; it searches and reads the pages, you get its summary with sources), and before changing an area you do not know that spans more files than you can read in a few batches (where something is computed and every caller, how a flow crosses modules); your own context stays free for the change.',
  verify: () => 'verify: an independent check of a result: it runs the repository checks on the current code (offline, and the project is read-only for its commands) and confirms claims, yours or a helper\'s, against the code and primary sources. It answers pass, fail or unverifiable per claim, with evidence.',
  review: () => 'review: an independent review of the current patch (this turn\'s changes, commits made in the turn included). To review work committed in earlier turns, pass since: the commit, branch or HEAD~N it started from; when this turn changed nothing, it reviews the branch\'s commits since it left the default branch. Ask once, when your change is finished, and again only after fixing blocking findings; under a required review the harness reviews the final patch and refuses your own call.',
};
export function delegateDescription(roles) {
  return `Hand work to a helper with its own context. Helpers read the project but cannot change files or call helpers. ${roles.map(role => HELPER_USES[role](roles)).join(' ')} A lookup that one grep or read answers stays with you. Write the task as a brief the helper can act on alone: the goal, what to find or check, where to start and what you already know or ruled out, and the answer you need (file:line facts). One call per helper runs at a time; each can be called again, up to ${HELPER_CALLS} times per user message, for example a second scout question on what the first answer opened.`;
}
// Scout and research end with their objections to the brief, if any.
const OBJECTIONS = `${BRIEF_CHECK} End your answer with one JSON object in a \`\`\`json block: {${BRIEF_ISSUES_JSON}}, with an empty list when the brief is sound. You cannot change files or delegate.`;
const RESEARCH_PROMPT = `Research the assigned question. Read only the needed source; use web_search or web_fetch for external documentation. Answer with facts the main agent can act on: file:line, short quotes, what calls what, and what you checked and found nothing in. ${OBJECTIONS}`;
const SCOUT_PROMPT = `Scout the codebase for the assigned question. Search first (grep, find), then read only the parts that matter. Answer with facts the main agent can act on: file:line, short quotes, what calls what, and where you looked and found nothing. You have no web access: when the answer needs external documentation, say so. ${OBJECTIONS}`;
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
    // Whether anything in the folder moved during the check (another
    // conversation's edit too: the suite ran on the whole folder); the check
    // then counts for this conversation's own code.
    const folder = async () => { try { return await (managed.folderDigest ?? managed.digest).call(managed); } catch { return null; } };
    const counted = managed.run && isCheckCommand(args[1]?.command, managed.checks.commands), before = counted ? await folder() : null;
    let ok = false;
    try { const result = await tool.execute(...args); ok = !result?.isError; return result; }
    finally {
      const after = counted && before !== null ? await folder() : null;
      if (after !== null && after === before) await managed.run.afterTool('bash', args[1], ok, () => managed.digest());
    }
  } };
}

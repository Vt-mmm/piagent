// The agent's team memory tools (memory.mjs holds what they call): search,
// ask and the knowledge pages; helpers get search and ask on their own run.
import { shareGrant, releaseGrant } from './grant-share.mjs';

export const PAGE_NAMES = ['Component map', 'Core concepts', 'Conventions and patterns', 'Key decisions and rationale', 'Initiatives and work in progress'];

// The agent's memory tools; helpers get only the search, on their own run.
// A fresh token for a role, shared with that role's requests running beside it.
export const renewer = (owner, role, verify) => {
  const lease = async () => {
    const share = shareGrant(owner, role);
    try { const grant = await share.grant; verify?.(grant); if (role === 'main') owner.grant = grant;
      return { grant, release: () => releaseGrant(owner, role, share) };
    } catch (error) { releaseGrant(owner, role, share); throw error; }
  };
  const renew = async () => { const held = await lease(); try { return held.grant; } finally { held.release(); } };
  renew.lease = lease; renew.role = role; return renew;
};
export function memoryTools(self, { pages = true, ask = false, grant = () => self.grant, renew } = {}) {
  const repository = { type: 'string', maxLength: 200, description: 'Only in a folder that holds several repositories: the repository\'s folder name. Leave it out to use the ones the question is about.' };
  const tools = [{ name: 'memory_search', label: 'Team memory',
    description: 'Search the team memory of this repository: the team rules, decisions and conventions from the team\'s earlier conversations and commits, and its knowledge pages. Use it before asking the member something the team may already have settled. Team rules always apply and override recalled notes. Notes are a record of the past: check them against the code; "claim, unverified" means an agent said it worked without a passing check, "stale" that its files changed since.',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 }, repository }, required: ['query'], additionalProperties: false },
    execute: async (_id, args) => ({ content: [{ type: 'text', text: await self.memory.search(grant(), args.query, renew, args.repository) }], details: {} }) }];
  if (ask) tools.push({ name: 'memory_ask', label: 'Ask team memory',
    description: 'Ask the team memory one question that needs a synthesized answer ("why is the eKYC order locked?", "what did we decide about refunds?"). It answers from the team\'s notes under the team rules and lists its sources; slower than memory_search (up to a minute), so use memory_search for a quick lookup. Check the answer against the code before acting on it.',
    parameters: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 2000 }, repository }, required: ['question'], additionalProperties: false },
    execute: async (_id, args) => ({ content: [{ type: 'text', text: await self.memory.ask(grant(), args.question, renew, args.repository) }], details: {} }) });
  if (pages) tools.push({ name: 'memory_page', label: 'Team knowledge page',
    description: `Read one knowledge page the team memory keeps for this repository: ${PAGE_NAMES.join(', ')}.`,
    parameters: { type: 'object', properties: { name: { type: 'string', enum: PAGE_NAMES }, repository }, required: ['name'], additionalProperties: false },
    execute: async (_id, args) => ({ content: [{ type: 'text', text: await self.memory.page(grant(), args.name, renew, args.repository) }], details: {} }) });
  return tools;
}


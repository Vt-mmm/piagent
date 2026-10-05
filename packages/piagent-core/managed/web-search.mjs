// Web search for company sessions: the provider's own search tool (Codex
// `web_search`, Claude `web_search_20250305`) through Studio with the current
// run token, so queries stay with the company accounts and are metered like
// any other request. The request carries the grant's model and effort, which
// Studio requires to match. A role on an API-key vendor model searches through
// the company search pool instead (searchThroughPool).
import { CLIENT_AGENT } from './client-agent.mjs';
import { isVendor } from './native-catalog.mjs';

const INSTRUCTIONS = 'Search the web for the request. Answer concisely with the facts found and cite every source URL. Prefer official documentation and primary sources.';

function sourceList(sources) {
  const seen = new Set(), out = [];
  for (const source of sources) {
    if (typeof source?.url !== 'string' || !/^https?:\/\//.test(source.url)) continue;
    const url = source.url.replace(/[?&]utm_source=openai$/, '');
    if (seen.has(url)) continue;
    seen.add(url); out.push({ title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : url, url });
  }
  return out.slice(0, 20);
}

function* events(text) {
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { yield JSON.parse(data); } catch { /* skip keep-alives */ }
  }
}

function parseCodex(text) {
  let output = [];
  const items = [];
  for (const event of events(text)) {
    if (event.type === 'response.output_item.done' && event.item) items.push(event.item);
    if ((event.type === 'response.completed' || event.type === 'response.done') && Array.isArray(event.response?.output)) output = event.response.output;
  }
  if (!output.length) output = items;
  // Sources the answer cites come first, then the other pages searched.
  const answer = [], cited = [], searched = [];
  for (const item of output) {
    if (item?.type === 'message') for (const part of item.content ?? []) {
      if (typeof part?.text === 'string') answer.push(part.text);
      for (const note of part?.annotations ?? []) if (note?.type === 'url_citation') cited.push(note);
    }
    if (item?.type === 'web_search_call') for (const group of [item.action?.sources, item.sources, item.results]) {
      for (const source of Array.isArray(group) ? group : []) searched.push({ url: source?.url, title: source?.title });
    }
  }
  return { answer: answer.join('\n').trim(), sources: sourceList([...cited, ...searched]) };
}

function parseClaude(text) {
  const blocks = [], sources = [];
  let current = null;
  for (const event of events(text)) {
    if (event.type === 'content_block_start') {
      current = event.content_block ?? null;
      if (current?.type === 'text') blocks.push(current.text ?? '');
      if (current?.type === 'web_search_tool_result' && Array.isArray(current.content)) for (const result of current.content) sources.push(result);
    }
    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta' && current?.type === 'text') blocks[blocks.length - 1] += event.delta.text ?? '';
      if (event.delta?.type === 'citations_delta') sources.push(event.delta.citation);
    }
  }
  return { answer: blocks.join('').trim(), sources: sourceList(sources) };
}

export async function searchThroughStudio({ provider, origin, token, roleId, model, effort, query, domains, signal, fetchImpl = fetch }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('web-search-query-invalid');
  const allowed = Array.isArray(domains) ? domains.filter((domain) => typeof domain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(domain)).slice(0, 20) : [];
  const claude = provider === 'claude';
  const body = claude
    ? { model, max_tokens: 4096, system: INSTRUCTIONS, stream: true, messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5, ...(allowed.length ? { allowed_domains: allowed } : {}) }],
        ...(effort ? { thinking: { type: 'adaptive' }, output_config: { effort } } : {}) }
    : { model, instructions: INSTRUCTIONS, stream: true, store: false, input: [{ role: 'user', content: [{ type: 'input_text', text: query }] }],
        tools: [{ type: 'web_search', ...(allowed.length ? { filters: { allowed_domains: allowed } } : {}) }],
        include: ['web_search_call.action.sources'], tool_choice: 'required', ...(effort ? { reasoning: { effort } } : {}) };
  const response = await fetchImpl(`${origin}${claude ? '/claude/v1/messages' : '/v1/responses'}`, {
    method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream', 'User-Agent': CLIENT_AGENT, 'X-Session-Id': roleId,
      ...(claude ? { 'anthropic-version': '2023-06-01' } : {}) },
    body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) {
    let code = `http-${response.status}`;
    try { code = JSON.parse(text)?.error?.code ?? code; } catch { /* not JSON */ }
    throw new Error(`web-search-failed: ${String(code).slice(0, 80)}`);
  }
  const result = claude ? parseClaude(text) : parseCodex(text);
  if (!result.answer && !result.sources.length) throw new Error('web-search-empty');
  return result;
}

// Web search from the company search pool (Studio's /v1/search): the team's
// pool keys first, then keyless providers. It takes no model or effort, so a
// role on any model can search; Studio meters it per member.
// A keyless provider's answer is its pages' text; at 4,000 characters the
// search bench lost two of 23 Parallel answers that 8,000 kept.
const POOL_ANSWER_CHARS = 8000, POOL_SNIPPET_CHARS = 500;
export async function searchThroughPool({ origin, token, roleId, query, domains, signal, fetchImpl = fetch }) {
  if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('web-search-query-invalid');
  const allowed = Array.isArray(domains) ? domains.filter((domain) => typeof domain === 'string' && /^[a-z0-9.-]{1,253}$/i.test(domain)).map((domain) => domain.toLowerCase()).slice(0, 20) : [];
  const response = await fetchImpl(`${origin}/v1/search`, {
    method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(150_000)]) : AbortSignal.timeout(150_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT, 'X-Session-Id': roleId },
    body: JSON.stringify({ query: query.trim(), max_results: 5, ...(allowed.length ? { include_domains: allowed } : {}) }) });
  const text = await response.text();
  // A Studio without the search pool: say what the member can do instead.
  if (response.status === 404) throw new Error('managed-web-search-unavailable');
  if (!response.ok) {
    let code = `http-${response.status}`;
    try { code = JSON.parse(text)?.error?.code ?? code; } catch { /* not JSON */ }
    throw new Error(`web-search-failed: ${String(code).slice(0, 80)}`);
  }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('web-search-failed: invalid_response'); }
  const results = Array.isArray(body?.results) ? body.results : [];
  const sources = sourceList(results).map((source) => {
    const hit = results.find((result) => result?.url === source.url);
    const snippet = typeof hit?.content === 'string' ? hit.content.trim().slice(0, POOL_SNIPPET_CHARS) : '';
    return snippet ? { ...source, snippet } : source;
  });
  const answer = typeof body?.answer === 'string' ? body.answer.trim().slice(0, POOL_ANSWER_CHARS) : '';
  if (!answer && !sources.length) throw new Error('web-search-empty');
  return { answer, sources, provider: typeof body?.provider === 'string' ? body.provider : 'pool' };
}

// A company role's search on its grant: the company search pool answers
// first for every role (Codex web search, the team's search keys, then
// keyless providers). A Claude or Codex role falls back to its provider's own
// search tool when the pool is missing (an older Studio) or found nothing;
// an API-key vendor model has none.
export async function searchForRole({ origin, grant, route, query, domains, signal }) {
  if (grant.provider_model_id !== route.native || grant.provider !== route.provider) throw Error('managed-route-changed');
  try {
    const pooled = await searchThroughPool({ origin, token: grant.token, roleId: grant.role_id, query, domains, signal });
    return { content: [{ type: 'text', text: searchResultText(pooled, pooled.provider) }], details: { sources: pooled.sources.length, provider: pooled.provider } };
  } catch (error) {
    if (isVendor(route.provider) || signal?.aborted) throw error;
  }
  const result = await searchThroughStudio({ provider: route.provider, origin, token: grant.token, roleId: grant.role_id,
    model: route.native, effort: grant.effort, query, domains, signal });
  return { content: [{ type: 'text', text: searchResultText(result, 'model-provider') }], details: { sources: result.sources.length, provider: route.provider } };
}

// Who answered a search, so the agent can tell the member which engine ran.
const ENGINES = { codex: "OpenAI's web search on a company Codex account", tavily: 'Tavily through the company search pool', exa: 'Exa through the company search pool', parallel: 'Parallel through the company search pool',
  'model-provider': "the model provider's own web search" };
export function searchResultText({ answer, sources }, engine) {
  return [ENGINES[engine] ? `Searched with ${ENGINES[engine]}.` : '', answer || 'No summary returned.', sources.length ? 'Sources:\n' + sources.map((source, index) => `${index + 1}. ${source.title} — ${source.url}${source.snippet ? '\n   ' + source.snippet.replace(/\s+/g, ' ') : ''}`).join('\n') : ''].filter(Boolean).join('\n\n');
}

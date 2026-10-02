// Reviewed gaps in Pi 0.87.1's bundled catalog. Never infer context/output
// limits for an unknown future model.
// Claude Sonnet 5.5, checked 2026-09-30:
// https://platform.claude.com/docs/en/models/overview
// https://platform.claude.com/docs/en/build-with-claude/effort
const sonnet55 = {
  id: 'claude-sonnet-5-5', provider: 'anthropic', api: 'anthropic-messages',
  name: 'Claude Sonnet 5.5', reasoning: true, input: ['text', 'image'],
  contextWindow: 1000000, maxTokens: 128000,
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  compat: { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true, supportsMidConvoEffort: true },
  promptCache: { short: 300, long: 3600 },
};
// GPT-6.1 Sol through Codex, checked 2026-10-01: Codex keeps the 272k window
// of its pricing tier (the API model has 1.05M); 128k output; efforts low to
// max, no none/minimal; $2/$10 per 1M, cached $0.10, doubled above 272k.
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://learn.chatgpt.com/docs/models
// https://pi.dev/models/openai-codex/gpt-6-1-sol
const sol61 = {
  id: 'gpt-6.1-sol', provider: 'openai-codex', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api',
  name: 'GPT-6.1 Sol', reasoning: true, input: ['text', 'image'],
  contextWindow: 272000, maxTokens: 128000,
  cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, tiers: [{ inputTokensAbove: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }] },
  thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  compat: { supportsOpenAIGrammarTools: true, supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
  inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000, maxBytes: 4718592, jpegQuality: 80 } } },
};
const GAPS = { anthropic: [sonnet55], 'openai-codex': [sol61] };
// Studio's providers: the Claude and Codex subscriptions, or an API-key
// vendor (DeepSeek, Kimi, GLM, MiMo, Qwen, OpenCode, Grok) whose id is Pi's
// own provider id; Studio runs vendors as OpenAI Chat Completions.
const VENDOR = /^[a-z][a-z0-9-]{1,39}$/;
export const isVendor = provider => typeof provider === 'string' && provider !== 'claude' && provider !== 'codex' && VENDOR.test(provider);
export function piProvider(provider) { return provider === 'claude' ? 'anthropic' : provider === 'codex' ? 'openai-codex' : provider; }
export function studioAPI(provider) { return provider === 'claude' ? 'anthropic-messages' : provider === 'codex' ? 'openai-responses' : 'openai-completions'; }
export function studioPath(provider) { return provider === 'claude' ? '/claude' : provider === 'codex' ? '/v1' : '/openai/v1'; }
export function nativeManagedModel(runtime, provider, id) {
  const gap = GAPS[provider]?.find(model => model.id === id);
  return runtime.getModel(provider, id) ?? (gap ? structuredClone(gap) : undefined);
}

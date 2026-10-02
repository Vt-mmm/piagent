import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { failureCode } from '../runtime/managed-failure.mjs';
import { currentPlan, unfinished, planText } from './workflow.mjs';

// One message longer than a summary part (a pasted log) keeps its start and
// end for the summary; the transcript itself is unchanged.
function clip(message, tokens) {
  const keep = tokens * 2, cut = text => text.length <= 2 * keep ? text : `${text.slice(0, keep)}\n[… ${text.length - 2 * keep} characters left out of this summary …]\n${text.slice(-keep)}`;
  if (typeof message.content === 'string') return { ...message, content: cut(message.content) };
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(part => part.type === 'text' ? { ...part, text: cut(part.text) } : part.type === 'thinking' ? { ...part, thinking: cut(part.thinking ?? '') } : part) };
}
function addUsage(a, b) {
  const sum = (x, y) => (x ?? 0) + (y ?? 0);
  return { ...a, input: sum(a.input, b.input), output: sum(a.output, b.output), cacheRead: sum(a.cacheRead, b.cacheRead), cacheWrite: sum(a.cacheWrite, b.cacheWrite),
    totalTokens: sum(a.totalTokens, b.totalTokens), cost: Object.fromEntries(Object.keys(a.cost ?? {}).map(k => [k, sum(a.cost[k], b.cost?.[k])])) };
}

// Pi summarises everything older than the kept tail in one request. A
// conversation can be longer than the window of the model a run uses now
// (the harness moved from a 1M-token model to a 272k one, or Auto fell
// back), and that request is then refused, so the conversation could never
// shrink again. Such a history is summarised in parts that fit, each part
// updating the summary of the parts before.
export async function stageCompaction(session, api, sdk) {
  const whole = session._runDefaultCompaction?.bind(session);
  if (!whole || !session._summarizationRetryCallbacks) throw Error('managed-sdk-version-unqualified');
  const { computeFileLists, formatFileOperations } = await import(pathToFileURL(path.join(sdk, 'dist/core/compaction/utils.js')));
  // An unfinished plan is kept word for word: the summary would lose its steps.
  const withPlan = result => {
    const plan = currentPlan(session.sessionManager);
    return unfinished(plan) ? { ...result, summary: `${result.summary}\n\nCurrent plan (kept verbatim; keep it up to date with update_plan):\n${planText(plan)}` } : result;
  };
  session._runDefaultCompaction = async (preparation, model, apiKey, headers, instructions, signal, env, reason) => {
    const { settings, previousSummary } = preparation, room = model.contextWindow - settings.reserveTokens;
    const history = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    const size = history.reduce((n, m) => n + api.estimateTokens(m), 0) + Math.ceil((previousSummary?.length ?? 0) / 4);
    if (size + 4096 <= room) {
      try { return withPlan(await whole(preparation, model, apiKey, headers, instructions, signal, env, reason)); }
      // Token estimates are rough, and Studio takes at most 4 MiB per body:
      // a single request refused as too large is retried in parts.
      catch (error) { if (signal?.aborted || !['upstream_request_rejected', 'request_too_large'].includes(failureCode(error?.message))) throw error; }
    }
    // Half the window per part leaves room for dense text (Vietnamese, code),
    // the previous summary and the answer.
    const budget = Math.max(8192, Math.floor(room / 2) - settings.reserveTokens), parts = [];
    for (const message of history) {
      const fitted = clip(message, budget), tokens = api.estimateTokens(fitted), part = parts.at(-1);
      if (part && part.tokens + tokens <= budget) { part.messages.push(fitted); part.tokens += tokens; }
      else parts.push({ messages: [fitted], tokens });
    }
    let summary = previousSummary, usage;
    for (const part of parts) {
      const result = await api.generateSummaryWithUsage(part.messages, model, settings.reserveTokens, apiKey, headers, signal, instructions, summary,
        session.thinkingLevel, session.agent.streamFunction, env, session.settingsManager.getRetrySettings(), session._summarizationRetryCallbacks({ source: 'compaction', reason }), undefined);
      summary = result.text; usage = usage ? addUsage(usage, result.usage) : result.usage;
    }
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    return withPlan({ summary: summary + formatFileOperations(readFiles, modifiedFiles), firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore, usage, details: { readFiles, modifiedFiles } });
  };
}

// A company answer that failed for a passing reason after Studio admitted it
// (the model's stream was cut or came back empty, the model or Studio's
// gateway did not answer, Studio could not be reached) is asked again by Pi's
// own turn retry: up to twice, 2 then 4 s apart, with the failed attempt left
// out of what the model sees. Tools run only after a whole answer, so nothing
// the agent did is repeated; the price is the request's input, billed again.
// Refusals before admission are asked again earlier, in request-stream.mjs;
// everything else (quota, key, policy, a rejected or refused request, a closed
// run) fails at once, as before. Pi decides by the words of an error, which
// for a company failure would match "rate limited" or "timeout" in sentences
// that must not be retried; here it decides by Studio's code only.
import { failureCode } from '../runtime/managed-failure.mjs';

export const TURN_RETRY_CODES = new Set(['upstream_interrupted', 'upstream_incomplete', 'upstream_timeout', 'upstream_unavailable',
  'connector_unavailable', 'connector_execution_failed', 'inference_unavailable', 'studio-unreachable']);
export const TURN_RETRY = { maxRetries: 2, baseDelayMs: 2_000 };

export function companyTurnRetryable(message) {
  return message?.stopReason === 'error' && TURN_RETRY_CODES.has(failureCode(message.errorMessage));
}

// True when the session retries company failures by code. A Pi whose session
// no longer has the hook keeps retry off rather than retrying by words.
export function enableCompanyTurnRetry(session, settings) {
  if (typeof session?._isRetryableError !== 'function') return false;
  session._isRetryableError = companyTurnRetryable;
  settings.applyOverrides({ retry: { enabled: true, ...TURN_RETRY } });
  return true;
}

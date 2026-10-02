// Why a company request failed, as one stable code and one sentence a member
// can act on. Studio answers with a machine code; the broker and this runtime
// have their own. The Terminal shows the sentence, the WebUI maps the code to
// its own copy, and nothing here names the harness model.
//
// Kinds: refused (the model's provider declined the request under its usage
// policy), quota (this key's token budget), provider-limit (the company's model
// account), account (that account must sign in again), busy (retry shortly),
// trial-limit (Studio's live-test ceiling), key (import the key again),
// policy (model or thinking not allowed),
// new-session (this conversation cannot continue), rejected (the request
// itself), unreachable (no connection to Studio), service (Studio answered
// but its model gateway failed), config-changed (key or harness changed while
// running), update (this Piagent is too old for the harness), tool (a tool's
// own failure), failed (anything else).
import { redactSensitiveText } from '../security/sensitive-data.js';

const CODES = {
  token_quota_exhausted: ['quota', "this key's token quota is used up"],
  upstream_rate_limited: ['provider-limit', "the company's model account is rate limited or out of usage at the provider"],
  account_capacity_unavailable: ['provider-limit', 'no company model account has capacity for this model right now'],
  concurrency_limit: ['busy', 'this key already runs its maximum number of requests'],
  request_rate_limit: ['busy', 'this key sends requests too fast'],
  helper_capacity_exhausted: ['busy', 'this key already runs its maximum number of subagents'],
  connector_busy: ['busy', "Studio's model gateway is at capacity"],
  operation_unavailable: ['busy', 'Studio could not check this request in time'],
  account_recovering: ['busy', 'the company model account is being checked after an earlier failure'],
  session_account_busy_retry_later: ['busy', "this conversation's model account is busy"],
  session_account_not_ready_retry_later: ['busy', "this conversation's model account is not ready yet"],
  live_trial_limit_reached: ['trial-limit', "Studio's live-test request ceiling is used up; an administrator has to raise it"],
  authentication_required: ['key', 'the company key is no longer valid'],
  invalid_run_grant: ['key', 'the company key or this run is no longer valid'],
  run_grant_required: ['key', 'this key only works through Agent Watch'],
  policy_denied: ['policy', 'this key may not use this model, thinking level or output size'],
  thinking_level_unavailable: ['policy', 'this thinking level is not available for the harness'],
  harness_model_unsupported: ['policy', 'the harness uses a model Studio cannot run'],
  harness_profile_unavailable: ['policy', 'the team has no usable harness'],
  execution_capability_unavailable: ['policy', 'no company model account can run this model'],
  session_account_unavailable_start_new_session: ['new-session', "this conversation's model account is gone"],
  run_state_conflict: ['config-changed', 'this run was closed or replaced'],
  run_recovery_pending_usage: ['busy', "an earlier request of this run is still being accounted"],
  invalid_request: ['rejected', 'Studio rejected the request as invalid'],
  upstream_request_rejected: ['rejected', 'the model rejected the request (too long or not valid for it)'],
  upstream_policy_refusal: ['refused', "the model's provider declined this request under its usage policy"],
  request_too_large: ['rejected', 'the conversation is larger than Studio accepts in one request (4 MiB)'],
  execution_precondition_failed: ['service', 'the chosen company model account changed before the request started'],
  connector_unavailable: ['service', "Studio's model gateway is not available"],
  connector_execution_failed: ['service', "Studio's model gateway failed"],
  inference_unavailable: ['service', 'Studio could not run the request'],
  managed_service_unavailable: ['service', 'Studio could not start the run'],
  upstream_interrupted: ['service', 'the model response was interrupted'],
  upstream_incomplete: ['service', 'the model returned no response'],
  upstream_timeout: ['service', 'the model did not answer in time'],
  upstream_unavailable: ['service', 'the model provider is not answering'],
  upstream_auth_required: ['account', "the company's model account has to sign in again in Studio"],
  'studio-unreachable': ['unreachable', 'Studio could not be reached'],
  'managed-broker:offline': ['unreachable', 'Agent Watch could not reach Studio'],
  'managed-broker-timeout': ['unreachable', 'Agent Watch did not answer in time'],
  'managed-broker-disconnected': ['unreachable', 'the Agent Watch helper stopped'],
  'managed-broker:serverUnavailable': ['service', 'Studio could not start the run'],
  'managed-broker:upstreamUnavailable': ['service', 'Studio could not start the run'],
  'managed-broker:invalidKey': ['key', 'the company key is no longer valid'],
  'managed-broker:permissionDenied': ['key', 'Agent Watch no longer holds a usable company key'],
  'managed-broker:keychainApprovalRequired': ['key', 'macOS has not allowed Agent Watch to read the company key'],
  'managed-broker:quotaExceeded': ['quota', "this key's token quota is used up"],
  'managed-broker:rateLimited': ['busy', 'Studio is limiting this key right now'],
  'managed-broker:identityChanged': ['config-changed', 'the key, harness or run changed in Studio'],
  'managed-broker:invalidResponse': ['config-changed', 'Studio refused to start the run with the current harness'],
  'managed-route-changed': ['config-changed', 'the harness model changed while this run was active'],
  'managed-grant-invalid': ['config-changed', 'the harness changed and this conversation still has the old one'],
  'managed-configuration-unavailable': ['config-changed', 'the key has no usable harness'],
  'managed-main-model-unavailable': ['policy', 'the harness main model is not available to this key'],
  'managed-native-catalog-update-required': ['update', 'this Piagent does not know the harness model; update Piagent'],
  'managed-session-scope-changed': ['new-session', 'this conversation belongs to another member or another Studio'],
  'managed-run-required': ['config-changed', 'no company run is active'],
  'managed-helper-unavailable': ['busy', 'this subagent is already running'],
  'managed-helper-used': ['tool', 'this subagent already ran for this message; each runs once per message'],
  'managed-helper-not-configured': ['tool', 'the company Harness does not enable this subagent'],
  'managed-helper-limit': ['tool', 'this subagent already ran 8 times for this message'],
  helper_run_limit_reached: ['tool', 'this subagent already ran 8 times for this message'],
  'managed-helper-cancelled': ['tool', 'the subagent was stopped'],
  'managed-helper-failed': ['failed', 'the subagent ended without an answer'],
  'web-search-empty': ['tool', 'the search returned nothing'],
  'managed-web-search-unavailable': ['tool', 'web search runs only on a Claude or Codex model; use web_fetch with a known address'],
  search_unavailable: ['tool', 'no web search provider answered right now; try again shortly or use web_fetch with a known address'],
  'managed-session-open-elsewhere': ['new-session', 'this conversation is running in the Piagent WebUI; continue it there or start a new one'],
  'managed-session-lease-unavailable': ['failed', 'Piagent could not record which process runs this conversation'],
  'managed-plan-required': ['tool', 'for a complex task the Harness asks for a checklist (update_plan) before the first file edit'],
  'managed-plan-invalid': ['tool', 'the checklist was not in the expected form'],
  'managed-request-failed': ['failed', 'the request could not be sent'],
  'studio-request-failed': ['failed', 'Studio answered with an error'],
};
const ROLES = { main: 'main agent', scout: 'scout subagent', research: 'research subagent', verify: 'verify subagent', review: 'review subagent' };
const REQUEST = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;
const NETWORK = /fetch failed|econnrefused|econnreset|enotfound|ehostunreach|etimedout|socket hang up|network|connection error|terminated|timed? ?out|aborted due to timeout/i;

export function failureKind(code) { return CODES[code]?.[0] ?? 'failed'; }
// Studio said no at admission, before any model account was asked: the same
// request can be asked again later, and nothing reaches the model twice. A
// failure after admission (the model's own error, an interrupted answer) is
// never in this list: replaying it could repeat billed work.
const ADMISSION_REFUSALS = new Set(['session_account_busy_retry_later', 'session_account_not_ready_retry_later',
  'concurrency_limit', 'account_capacity_unavailable', 'request_rate_limit']);
export function failureIsAdmissionRefusal(code) { return ADMISSION_REFUSALS.has(code); }
// Refused before the model did any work, for a reason that passes in seconds:
// the account's sign-in was being renewed (the provider refused the old one)
// or changed just before the request started, or the run's two-minute grant
// lapsed under the request (after the Mac slept, Studio's clock catches up
// at once), or Studio could not check the request's grant in its 5 s (many
// requests of one member at once); each ask renews the grant first. Asked
// again a few times only: an account that really has to sign in again, or a
// run that was closed, still says so.
const BRIEF_REFUSALS = new Set(['execution_precondition_failed', 'upstream_auth_required', 'invalid_run_grant', 'operation_unavailable']);
export function failureIsBriefRefusal(code) { return BRIEF_REFUSALS.has(code); }
// The words of a failure no code names, redacted, for a record nobody is
// shown; null for a named failure.
export function unnamedFailureText(raw) {
  return ['managed-request-failed', 'studio-request-failed'].includes(failureCode(raw)) ? redactSensitiveText(String(raw ?? '')).text.slice(0, 600) : null;
}
// The sentence alone, for a status line that already says who is waiting.
export function failureReason(code) { return (CODES[code] ?? CODES['managed-request-failed'])[1]; }
// A failure Studio never saw: nothing was sent, so it is not a model request.
export function failureIsLocal(code) { return code.startsWith('managed-') || code === 'studio-unreachable'; }

function known(code) { return typeof code === 'string' && Object.hasOwn(CODES, code) ? code : null; }

// The stable code inside any error text this runtime can produce or receive.
export function failureCode(raw) {
  const text = String(raw ?? '');
  const tagged = /\[([A-Za-z0-9_:.-]{1,80})\](?: \(request [0-9a-f-]{36}\))?\s*$/.exec(text)?.[1];
  if (known(tagged)) return tagged;
  const studio = /"code"\s*:\s*"([a-z0-9_]{1,80})"/.exec(text)?.[1] ?? /web-search-failed: ([a-z0-9_-]{1,80})/.exec(text)?.[1];
  if (studio === 'initial_request_limit_reached') return 'live_trial_limit_reached';
  if (known(studio)) return studio;
  const local = /(managed-broker:[A-Za-z_]{1,80}|managed-[a-z-]{1,80}|web-search-empty)/.exec(text)?.[1];
  if (known(local)) return local;
  if (studio || /\bAPI error \(\d{3}\)|^\d{3} \{/.test(text)) return 'studio-request-failed';
  // The provider declined the request itself (its usage policy), not Studio:
  // the same request is declined again, so it is said in words.
  if (/usage policy|violative|refusals-and-fallback/i.test(text)) return 'upstream_policy_refusal';
  // The provider library's words for an answer stream that ended empty: Studio
  // admitted the request and nothing came back. It is not asked again.
  if (/stream ended without a (terminal event|stop reason)|response has no body/i.test(text)) return 'upstream_incomplete';
  if (NETWORK.test(text)) return 'studio-unreachable';
  return 'managed-request-failed';
}

// "Agent Watch main agent: <what failed> [code] (request <id>)". The role says
// who failed; the model behind it is the harness's business, not the reader's.
export function describeFailure(role, raw) {
  const code = failureCode(raw), request = REQUEST.exec(String(raw ?? ''))?.[1];
  return `Agent Watch ${ROLES[role] ?? ROLES.main}: ${CODES[code][1]} [${code}]${request && !failureIsLocal(code) ? ` (request ${request})` : ''}`;
}

// What a reader of a stored error message needs: who, what kind, which code
// and Studio's request id when there is one. Null when it is not a company
// failure this module recognises the shape of.
export function parseFailure(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return null;
  const code = failureCode(text);
  const role = /^Agent Watch (main agent|(?:scout|research|verify|review) subagent): /.exec(text)?.[1]?.split(' ')[0]
    ?? /(scout|research|verify|review) subagent/.exec(text)?.[1] ?? 'main';
  const request = failureIsLocal(code) ? null : REQUEST.exec(text)?.[1] ?? null;
  return { role, code, kind: failureKind(code), requestId: request, local: failureIsLocal(code) };
}

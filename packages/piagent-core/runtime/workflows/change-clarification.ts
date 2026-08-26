const CHANGE_INTENT = /\b(?:add|build|change|correct|create|fix|implement|modify|mutate|refactor|remove|rename|repair|replace|update|write|sua|them|doi|cap nhat|xoa|tao)\b/i;
const EXPLICIT_CHANGE_REQUEST = [
  /^(?:(?:ok(?:ay|e)?|then|now|please|so|vay|bay gio|anh|em|vui long|lam on|tien hanh|tiep tuc|thuc hien)\b[\s,.:;!—–-]*)*(?:add|apply|build|change|correct|create|fix|implement|modify|mutate|refactor|remove|rename|repair|replace|update|write|sua|them|doi|cap nhat|xoa|tao)\b/i,
  /^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:add|apply|build|change|correct|create|fix|implement|modify|refactor|remove|rename|repair|replace|update|write)\b/i,
  /^(?:i\s+(?:need|want)\s+you\s+to|(?:anh|a|toi|minh)\s+(?:can|muon)\s+em)\s+(?:add|apply|build|change|correct|create|fix|implement|modify|refactor|remove|rename|repair|replace|update|write|sua|them|doi|cap nhat|xoa|tao)\b/i,
  /^(?:(?:ok(?:ay|e)?|then|now|please|so|vay|bay gio)\b[\s,.:;!—–-]*)*(?:go\s+ahead(?:\s+and|\s+with)?|proceed(?:\s+to|\s+with)?|tien\s+hanh|tiep\s+tuc|thuc\s+hien)\b.{0,40}\b(?:add|apply|build|changes?|fix|implementation|implement|modify|repair|replace|update|sua|them|doi|cap nhat|xoa|tao)\b/i,
  /\b(?:add|apply|build|change|correct|create|fix|implement|modify|mutate|refactor|remove|rename|repair|replace|update|write|sua|them|doi|cap nhat|xoa|tao)\b.{0,64}\b(?:di|nhe|luon|cho anh|giup anh|go ahead)\b/i
];
const CHANGE_CHOICE_QUESTION = [
  /\b(?:should|do|does|did|must|need|can|could|would|may)\s+(?:i|we|you|he|she|they)\b.{0,160}\b(?:or|hay)\b/i,
  /\b(?:i|we|you|a|anh|em|minh|toi|tui|chung ta)\s+(?:need\s+to|have\s+to|should|can|could|would|co\s+can|can|nen|co\s+the|phai)\b.{0,160}\b(?:or|hay)\b/i,
  /\b(?:co\s+nen|co\s+can|co\s+phai|lieu\s+co|nen|can)\b.{0,160}\b(?:or|hay)\b/i
];
const ENGLISH_YES_NO_CHANGE_QUESTION = /^(?:(?:so|then|now)\b[\s,.:;!—–-]*)*(?:should|must|do|does|did|can|could|would|may)\s+(?:i|we|you|he|she|they)\b/i;
const ENGLISH_WH_CHANGE_QUESTION = /^(?:(?:so|then|now)\b[\s,.:;!—–-]*)*(?:what|which|when|where|why|how)\b/i;
const VIETNAMESE_CHANGE_QUESTION = /\b(?:(?:a|anh|em|minh|toi|tui|chung\s+ta)\s+(?:co\s+can|can|nen|co\s+the|phai)|co\s+nen|co\s+can|co\s+phai|lieu\s+co)\b/i;

export function foldChangeIntent(value: string): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐ]/g, (character) => character === "Đ" ? "D" : "d")
    .toLowerCase();
}

export function hasChangeIntent(value: string): boolean {
  return CHANGE_INTENT.test(foldChangeIntent(value));
}

export function isExplicitChangeRequest(value: string): boolean {
  const folded = foldChangeIntent(value);
  return EXPLICIT_CHANGE_REQUEST.some((pattern) => pattern.test(folded));
}

/** Host-neutral linguistic classification; workflow authority is applied by task intake. */
export function isLightweightNonAuthorizingChangeLanguage(prompt: string): boolean {
  const text = String(prompt ?? "").trim();
  const folded = foldChangeIntent(text);
  if (!text || /^\/[a-z0-9-]+\b/i.test(text) || !CHANGE_INTENT.test(folded)) return false;
  const hasChoiceSeparator = /\b(?:or|hay)\b/i.test(folded);
  const choiceBranches = hasChoiceSeparator ? folded.split(/\b(?:or|hay)\b/i) : [];
  const mixedChangeChoice = choiceBranches.some((branch) => CHANGE_INTENT.test(branch))
    && choiceBranches.some((branch) => !CHANGE_INTENT.test(branch));
  // A punctuated change-vs-non-change choice remains a question even when its
  // change branch starts with "em fix" or ends in "sửa luôn". Two change
  // branches such as "can you fix or replace...?" remain an explicit request.
  if (mixedChangeChoice && /[?]\s*$/.test(text)) return true;
  if (isExplicitChangeRequest(folded)) return false;
  if (hasChoiceSeparator && CHANGE_CHOICE_QUESTION.some((pattern) => pattern.test(folded))) return true;
  if (ENGLISH_YES_NO_CHANGE_QUESTION.test(folded)) return true;
  return VIETNAMESE_CHANGE_QUESTION.test(folded) && (/[?]\s*$/.test(text) || /\bkhong\b[\s?.!]*$/i.test(folded));
}

export function isNonAuthorizingChangeLanguage(prompt: string): boolean {
  const text = String(prompt ?? "").trim();
  if (!text) return false;
  if (isLightweightNonAuthorizingChangeLanguage(text)) return true;
  if (isExplicitChangeRequest(text)) return false;
  const folded = foldChangeIntent(text);
  return CHANGE_INTENT.test(folded) && ENGLISH_WH_CHANGE_QUESTION.test(folded);
}

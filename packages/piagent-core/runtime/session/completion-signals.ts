function normalizeLanguageSignal(text: string): string {
  // Preserve the Vietnamese progressive phrase before removing tone marks.
  // Without this, both "đang làm" (still working) and "đáng làm" (worth doing)
  // collapse to `dang lam`, so a perfectly final heading such as
  // "Các ứng dụng đáng làm" is misclassified as an incomplete handoff.
  const progressive = text.normalize("NFC").toLowerCase().replace(/đang\s+làm/gu, " piagent_in_progress ");
  return progressive
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replaceAll("đ", "d");
}

export function looksLikeIncompleteHandoff(text: string): boolean {
  const normalized = normalizeLanguageSignal(text);
  return /\b(?:not done|not complete|not finished|still working|blocked|cannot complete|unable to complete|need clarification|tests? (?:fail|failed|failing)|verification (?:fail|failed|failing)|chua xong|chua hoan tat|chua hoan thanh|piagent_in_progress|(?:van|piagent|agent|em|toi|minh|chung toi) dang (?:lam|xu ly)|bi chan|can lam them|test (?:loi|fail))\b/.test(normalized);
}

export function looksLikeCompletionClaim(text: string): boolean {
  const normalized = normalizeLanguageSignal(text);
  if (!normalized.trim() || normalized.includes("[piagent completion gate:")) return false;
  if (looksLikeIncompleteHandoff(text)) return false;
  return /\b(?:done|completed|complete|finished|fixed|implemented|resolved|shipped|all tests pass(?:ed)?|tests? pass(?:ed)?|da xong|da sua|da fix|da hoan tat|da hoan thanh|da trien khai|test da pass|kiem tra da pass|ready\b[\s\S]{0,48}\b(?:test|review|use|ship)|san sang\b[\s\S]{0,48}\b(?:test|kiem tra|su dung))\b/.test(normalized);
}

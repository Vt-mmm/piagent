import { LONG_INPUT_CHARS } from "../runtime-limits.ts";
import { foldChangeIntent, isExplicitChangeRequest } from "./change-clarification.ts";

const INSPECTION = /\b(?:audit|check|inspect|review|tests?|verify|verification|validate|rerun|re-run|recheck|re-check|kiem tra|ra soat|xac minh|danh gia|chay lai)\b/i;
const REPAIR = "(?:address|change|correct(?:ing)?|edit|fix|patch|repair|resolve|update|cap nhat|chinh sua|khac phuc|sua)";
const ACTION = "(?:add|apply|build|create|implement|modify|mutate|refactor|remove|rename|replace|write|them|tao|xoa|doi|" + REPAIR + ")";
const PREFIX_CONDITION = /^(?:(?:please|only|chi|em|anh)\s+)*(?:if|when|neu|khi)\b/i;
const REPAIR_LEAD = new RegExp(`^(?:(?:please|only|chi|em|anh)\\s+)*${REPAIR}\\b`, "i");
const CONDITIONAL_REPAIR = [
  new RegExp(`^(?:(?:please|only|chi|em|anh)\\s+)*(?:if|when|neu|khi)\\b.*\\b${REPAIR}\\b`, "i"),
  new RegExp(`\\b${REPAIR}\\b.*\\b(?:if|when|neu|khi)\\b.*\\b(?:fail(?:s|ed|ures?|ing)?|issues?|errors?|problems?|defects?|findings?|tests?|verification|verifier|needed|necessary|required|found|detected|discovered|can|co|loi|van de)\\b`, "i"),
  new RegExp(`\\b${REPAIR}\\b.*\\b(?:as\\s+(?:needed|necessary|required)|(?:any|all|every)\\s+(?:(?:additional|remaining|new)\\s+)?(?:failures?|issues?|errors?|problems?|defects?|findings?)|whatever\\s+fails|(?:failures?|issues?|errors?|problems?|defects?|findings?)\\s+(?:(?:(?:if|when)\\s+)?(?:found|detected|discovered)|if\\s+any|(?:you|we)\\s+find)|loi|van de)\\b`, "i"),
  new RegExp(`\\b${REPAIR}\\b\\s+(?:(?:any|all|every)\\s+)?(?:failures?|issues?|errors?|problems?|defects?|findings?|failing\\s+tests?)\\b`, "i")
];
const DIRECTIVE_PREFIX = "(?:(?:you|we|the task|your task)\\s+(?:must|need to|have to)|(?:can|could|would|will)\\s+you|i\\s+(?:need|want)\\s+you\\s+to|(?:em|anh)\\s+(?:phai|can)|must|please|only|chi|em|anh|also|always|still|regardless|in any case|bat buoc)";
const DIRECTIVE_LEAD = new RegExp(`^(?:${DIRECTIVE_PREFIX}\\b[,;:]?\\s+)*`, "i");
const ACTION_SEPARATOR = new RegExp(`(?:,\\s*|\\b(?:and|then|but|va|roi|nhung|sau do)\\s+)(?=(?:${DIRECTIVE_PREFIX}\\b[,;:]?\\s+)*${ACTION}\\b)`, "i");
const NEGATED_REPAIR = /\b(?:do not|don't|must not|never|khong|dung)\s+(?:ever\s+)?(?:fix|repair|edit|change|update|sua|chinh sua|cap nhat)\b/i;

// Examples, quoted data and fenced snippets cannot make an otherwise required
// implementation optional. Keep line boundaries while masking literal text.
function instructionText(text: string): string {
  let quote = "", escaped = false, result = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote) {
      result += character === "\n" ? "\n" : " ";
      if (character === quote && !escaped) quote = "";
      escaped = character === "\\" && !escaped;
      continue;
    }
    const apostrophe = character === "'" && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[index + 1] ?? "");
    if ((character === "`" || character === '"' || character === "'") && !apostrophe) { quote = character; escaped = false; result += " "; }
    else result += character;
  }
  return result.replace(/^\s*>[^\n]*$/gm, "");
}

export type ConditionalRepairIntent = "none" | "conditional-only" | "mixed";

/** Linguistic evidence only: task scope, approval and observed failures still gate writes. */
export function classifyConditionalRepairIntent(text: string): ConditionalRepairIntent {
  if (text.length > LONG_INPUT_CHARS) return "none";
  const visible = foldChangeIntent(instructionText(text));
  if (!INSPECTION.test(visible)) return "none";
  let conditional = false, unconditional = false;
  const statements = visible.split(/(?<=[.!?;:])\s+|\n+|\b(?:but|however|nevertheless|nhung|tuy nhien)\b[,:]?\s*|(?:,|\b(?:and|then|va|roi)\b)\s*(?=(?:if|when|neu|khi)\b)/)
    .map((part) => part.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim()).filter(Boolean);
  for (const statement of statements) {
    if (PREFIX_CONDITION.test(statement) && CONDITIONAL_REPAIR.some((pattern) => pattern.test(statement)) && !NEGATED_REPAIR.test(statement)) {
      conditional = true;
      continue;
    }
    for (const clause of statement.split(ACTION_SEPARATOR)) {
      const directive = clause.trim().replace(DIRECTIVE_LEAD, "");
      const repairCommand = REPAIR_LEAD.test(directive);
      const imperative = repairCommand || isExplicitChangeRequest(directive);
      if (!imperative && NEGATED_REPAIR.test(clause)) continue;
      // Qualify the repair command itself, not a repair word inside the
      // description of a different mandatory implementation command.
      const qualified = repairCommand && CONDITIONAL_REPAIR.some((pattern) => pattern.test(clause));
      if (qualified) conditional = true;
      else if (imperative) unconditional = true;
    }
  }
  return !conditional ? "none" : unconditional ? "mixed" : "conditional-only";
}

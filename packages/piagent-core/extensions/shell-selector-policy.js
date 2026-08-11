export const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep"]);
export const SEARCH_FILE_OPTIONS = new Set(["-f", "--file", "--exclude-from", "--ignore-file"]);
export const SEARCH_GLOB_OPTIONS = new Set(["-g", "--glob", "--iglob", "--include", "--exclude", "--exclude-dir"]);
export const SEARCH_PATTERN_OPTIONS = new Set(["-e", "--regexp", "--pattern"]);

const SEARCH_EXCLUSION_OPTIONS = new Set(["--exclude", "--exclude-dir"]);
const FIND_SELECTOR_OPTIONS = new Set(["-path", "-wholename", "-name", "-iname", "-lname", "-ilname", "-regex", "-iregex"]);
const UNSAFE_FIND_ACTIONS = new Set([
  "-delete", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"
]);

export function searchSelectorIsExclusion(commandName, optionName, value) {
  if (!SEARCH_COMMANDS.has(commandName)) return false;
  if (SEARCH_EXCLUSION_OPTIONS.has(optionName)) return true;
  return ["rg", "ripgrep"].includes(commandName)
    && ["-g", "--glob", "--iglob"].includes(optionName)
    && String(value ?? "").startsWith("!");
}

export function findSelectorOption(optionName) {
  return FIND_SELECTOR_OPTIONS.has(optionName);
}

export function excludedFindSelectorValue(tokens, index, commandName, downstreamFileConsumer = false) {
  if (commandName !== "find" || tokens.some((token) => ["(", ")"].includes(token.value))) return false;
  const selector = tokens[index - 1]?.value;
  const selectorValue = tokens[index]?.value ?? "";
  if (/[$`]/.test(selectorValue)) return false;
  const unsafeTail = downstreamFileConsumer || tokens.some((token) => (
    UNSAFE_FIND_ACTIONS.has(token.value)
    || /^-exec(?:dir)?$/.test(token.value)
  ));
  if (tokens[index + 1]?.value === "-prune") return ["-path", "-wholename"].includes(selector)
    && ["-o", "-or"].includes(tokens[index + 2]?.value)
    && !unsafeTail
    && !/[*?{\[]/.test(selectorValue.slice(selectorValue.lastIndexOf("/") + 1))
    && !tokens.some((token) => ["!", "-not"].includes(token.value));
  if (!findSelectorOption(selector)) return false;
  if (unsafeTail || tokens.some((token) => ["-o", "-or", ","].includes(token.value))) return false;
  let negations = 0;
  for (let cursor = index - 2; cursor >= 0 && ["!", "-not"].includes(tokens[cursor].value); cursor -= 1) negations += 1;
  return negations % 2 === 1;
}

export function searchSelectorWithinToken(commandName, word, attachedRgOption) {
  if (!SEARCH_COMMANDS.has(commandName)) return undefined;
  const equals = word.indexOf("=");
  const option = equals > 0 ? word.slice(0, equals) : undefined;
  if (option && (SEARCH_FILE_OPTIONS.has(option) || SEARCH_GLOB_OPTIONS.has(option))) {
    return { option, value: word.slice(equals + 1) };
  }
  const grepFile = ["grep", "egrep", "fgrep"].includes(commandName) && /^-f.+/.test(word) ? word.slice(2) : undefined;
  if (grepFile !== undefined) return { option: "-f", value: grepFile };
  return ["-f", "-g"].includes(attachedRgOption?.option) ? attachedRgOption : undefined;
}

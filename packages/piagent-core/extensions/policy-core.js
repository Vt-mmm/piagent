const PATH_REDIRECT_OPERATORS = new Set(["<", ">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>"]);
const DATA_ONLY_COMMANDS = new Set(["echo", "printf"]);
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep"]);
const SEARCH_FILE_OPTIONS = new Set(["-f", "--file", "--exclude-from", "--ignore-file"]);
const SEARCH_GLOB_OPTIONS = new Set(["-g", "--glob", "--iglob", "--include", "--exclude"]);
const SEARCH_PATTERN_OPTIONS = new Set(["-e", "--regexp", "--pattern"]);
const ASSIGNMENT_BUILTINS = new Set(["export", "readonly", "declare", "typeset", "local"]);
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh"]);

// Interpreters that take a program on the command line, and the flags that
// introduce it. What follows such a flag is source code in another language, so
// none of it tokenises as a shell path — `node -e "readFileSync('.env')"` is one
// opaque argument to the shell parser. The filenames live in the string literals
// inside it, which is where this looks.
const INLINE_CODE_FLAGS = new Map([
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["nodejs", new Set(["-e", "--eval", "-p", "--print"])],
  ["deno", new Set(["eval"])],
  ["bun", new Set(["-e", "--eval"])],
  ["python", new Set(["-c"])],
  ["python2", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["ruby", new Set(["-e"])],
  ["perl", new Set(["-e", "-E"])],
  ["php", new Set(["-r"])]
]);
const SIMPLE_WRAPPERS = new Set(["sudo", "nohup", "time", "nice", "ionice", "command"]);

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

export function normalizePathCandidate(candidate) {
  if (typeof candidate !== "string") return "";
  const raw = candidate.trim().replace(/^['"]|['"]$/g, "");
  if (/^\/+$/.test(raw)) return "/";
  return candidate
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function commandBasename(command) {
  const normalized = normalizePathCandidate(command);
  if (!normalized || normalized.startsWith("$")) return normalized;
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

function segmentMatches(patternSegment, candidateSegment) {
  if (patternSegment === "*") return candidateSegment.length > 0;
  const regex = new RegExp(`^${escapeRegex(patternSegment).replace(/\*/g, "[^/]*")}$`);
  return regex.test(candidateSegment);
}

export function globMatchesPath(pattern, candidate) {
  const normalizedPattern = normalizePathCandidate(pattern);
  const normalizedCandidate = normalizePathCandidate(candidate);
  if (!normalizedPattern || !normalizedCandidate) return false;

  const patternSegments = normalizedPattern.split("/").filter(Boolean);
  const candidateSegments = normalizedCandidate.split("/").filter(Boolean);

  function match(patternIndex, candidateIndex) {
    if (patternIndex === patternSegments.length) return candidateIndex === candidateSegments.length;

    const patternSegment = patternSegments[patternIndex];
    if (patternSegment === "**") {
      if (match(patternIndex + 1, candidateIndex)) return true;
      for (let nextCandidate = candidateIndex; nextCandidate < candidateSegments.length; nextCandidate += 1) {
        if (match(patternIndex + 1, nextCandidate + 1)) return true;
      }
      return false;
    }

    if (candidateIndex >= candidateSegments.length) return false;
    if (!segmentMatches(patternSegment, candidateSegments[candidateIndex])) return false;
    return match(patternIndex + 1, candidateIndex + 1);
  }

  return match(0, 0);
}

export function matchesAnyPath(candidate, patterns) {
  const normalizedCandidate = normalizePathCandidate(candidate);
  return patterns.find((pattern) => {
    if (globMatchesPath(pattern, normalizedCandidate)) return true;
    if (pattern.endsWith("/**")) {
      const basePattern = pattern.slice(0, -3);
      return globMatchesPath(basePattern, normalizedCandidate);
    }
    return false;
  });
}

export function matchesProtectedPath(candidate, patterns) {
  const normalizedCandidate = normalizePathCandidate(candidate).toLocaleLowerCase("en-US");
  if (!normalizedCandidate) return undefined;
  return patterns.find((pattern) => {
    const normalizedPattern = normalizePathCandidate(pattern).toLocaleLowerCase("en-US");
    if (globMatchesPath(normalizedPattern, normalizedCandidate)) return true;
    if (normalizedPattern.endsWith("/**")) {
      return globMatchesPath(normalizedPattern.slice(0, -3), normalizedCandidate);
    }
    return false;
  });
}

export function splitShellSegments(command) {
  const segments = [];
  let current = "";
  let quote;
  let escaped = false;
  // A separator inside `$( )` or backticks belongs to the substitution, not to
  // the command line around it. Splitting there cut `cat $(echo x; echo .env)`
  // into two halves, and the half holding the path was re-read as a command of
  // its own — so the path was never a path to anything here.
  let substitutionDepth = 0;
  let inBackticks = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      current += char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      current += char;
      continue;
    }
    if (!quote) {
      if (char === "$" && next === "(") {
        substitutionDepth += 1;
        current += char;
        continue;
      }
      if (char === ")" && substitutionDepth > 0) {
        substitutionDepth -= 1;
        current += char;
        continue;
      }
      if (char === "`") {
        inBackticks = !inBackticks;
        current += char;
        continue;
      }
    }
    const previous = command[index - 1];
    const ampersandIsSeparator = char === "&" && next !== "&" && previous !== ">" && previous !== "<";
    // `>|` is one operator: the noclobber override. Without the same lookbehind
    // `&` already had, the `|` split the line and the redirection target became
    // a command name, so `printf x >| .env` truncated a protected file against a
    // candidate list that never contained it.
    const pipeIsSeparator = char === "|" && previous !== ">";
    const inSubstitution = substitutionDepth > 0 || inBackticks;
    if (!quote && !inSubstitution
      && (char === "\n" || char === ";" || pipeIsSeparator || ampersandIsSeparator
        || (char === "&" && next === "&") || (char === "|" && next === "|"))) {
      const segment = current.trim();
      if (segment) segments.push(segment);
      current = "";
      if ((char === "&" && next === "&") || (char === "|" && next === "|")) index += 1;
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) segments.push(tail);
  return segments.length ? segments : [command.trim()].filter(Boolean);
}

/**
 * Reads one `$'...'` ANSI-C quote and returns what the shell would pass along.
 *
 * Treating it as an ordinary single quote is not enough: the escapes inside are
 * the point of the syntax, and leaving them raw means `$'\x2eenv'` is read as
 * the literal `x2eenv` while the shell opens `.env`. The same trick reaches
 * `rm -rf $'\x2f'`, which nothing recognised as root.
 *
 * A backslash escapes the next character, the closing quote included, so `\'`
 * does not end the quote.
 *
 * @param {string[]|string} chars the segment, indexed the same way the caller
 *   indexes it, so the returned endIndex can be assigned straight back
 * @param {number} openIndex index of the `$`
 * @returns {{value: string, endIndex: number}} decoded content, and the index of
 *   the closing quote (or the last character when the quote never closes)
 */
function readAnsiCQuote(chars, openIndex) {
  let raw = "";
  let index = openIndex + 2;
  for (; index < chars.length; index += 1) {
    const char = chars[index];
    if (char === "\\" && index + 1 < chars.length) {
      raw += char + chars[index + 1];
      index += 1;
      continue;
    }
    if (char === "'") break;
    raw += char;
  }
  return { value: decodeShellDataEscapes(raw), endIndex: Math.min(index, chars.length - 1) };
}

function shellWordTokens(segment) {
  const tokens = [];
  let current = "";
  let quote;
  let escaped = false;
  let activeGlob = false;
  let unquotedVariable = false;
  let variableActive = false;
  // A space inside `$( )`, `${ }` or backticks is part of one word, not a break
  // between two. Splitting there tore `.en$(echo v)` into `.en$(echo` and `v)`,
  // so the filename being assembled was never a single token to reason about.
  let substitutionDepth = 0;
  let inBackticks = false;
  const flush = () => {
    if (!current) return;
    tokens.push({ value: current, activeGlob, unquotedVariable, variableActive });
    current = "";
    activeGlob = false;
    unquotedVariable = false;
    variableActive = false;
  };
  const chars = [...segment.trim()];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    // `$'...'` is ANSI-C quoting: the dollar opens the quote rather than naming
    // a variable, and the escapes inside it are decoded before the word is
    // passed on. Reading it as a variable left the dollar glued to the value, so
    // `cat $'.env'` produced the candidate `$.env`; reading it as a plain single
    // quote dropped the backslashes, so `cat $'\x2eenv'` produced `x2eenv`.
    // Either way the shell opened `.env` and nothing here saw a protected path.
    if (char === "$" && chars[index + 1] === "'" && !quote) {
      const ansiC = readAnsiCQuote(chars, index);
      current += ansiC.value;
      index = ansiC.endIndex;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (!quote) {
      if (char === "$" && (chars[index + 1] === "(" || chars[index + 1] === "{")) substitutionDepth += 1;
      else if ((char === ")" || char === "}") && substitutionDepth > 0) substitutionDepth -= 1;
      else if (char === "`") inBackticks = !inBackticks;
    }
    if (!quote && substitutionDepth === 0 && !inBackticks && /\s/.test(char)) {
      flush();
      continue;
    }
    if (!quote && /[*?{\[]/.test(char)) activeGlob = true;
    if ((char === "$" || char === "`") && quote !== "'") {
      variableActive = true;
      if (!quote) unquotedVariable = true;
    }
    current += char;
  }
  flush();
  return tokens;
}

export function shellWords(segment) {
  return shellWordTokens(segment).map((token) => token.value);
}

export function arrayStartsWith(items, prefix) {
  return prefix.length > 0 && prefix.every((item, index) => items[index] === item);
}

function commandRuleMatches(rule, segment, words) {
  if (rule.match === "prefix") {
    const prefix = Array.isArray(rule.value) ? rule.value : shellWords(rule.value);
    return arrayStartsWith(words, prefix);
  }
  const raw = Array.isArray(rule.value) ? rule.value.join(" ") : rule.value;
  if (rule.match === "contains") return segment.toLowerCase().includes(raw.toLowerCase());
  try {
    return new RegExp(raw, "i").test(segment);
  } catch {
    return false;
  }
}

function flagChars(word) {
  if (!word.startsWith("-") || word.startsWith("--")) return "";
  return word.slice(1);
}

function isRootOrHomeTarget(word) {
  const raw = typeof word === "string" ? word.trim().replace(/^['"]|['"]$/g, "") : "";
  if (/^\/+(?:\*)?$/.test(raw)) return true;
  if (/^~(?:\/\*)?$/.test(raw)) return true;
  if (/^\$HOME(?:\/\*)?$/.test(raw) || /^\$\{HOME\}(?:\/\*)?$/.test(raw)) return true;
  const normalized = normalizePathCandidate(word);
  return normalized === "/" || normalized === "~" || normalized === "$HOME" || normalized === "${HOME}";
}

function isAssignment(word) {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word);
}

/**
 * Whether a word is a redirection rather than a command or an argument.
 *
 * Covers the separated form (`>`, `2>`, `>|`) and the attached one (`>x`,
 * `2>>x`), which is why the pattern is anchored but not terminated.
 *
 * @param {string} word
 * @returns {boolean}
 */
function isLeadingRedirection(word) {
  return /^[0-9]*(?:>>?\|?|<>?|>&|<&)/.test(word);
}

function stripWrapper(words) {
  let current = [...words];
  let changed = true;

  while (changed && current.length > 0) {
    changed = false;
    while (current.length > 0 && isAssignment(current[0])) {
      current = current.slice(1);
      changed = true;
    }

    // A redirection may precede the command word, and the shell still runs the
    // command. Leaving it in place made `>x rm -rf /` read as a command called
    // ">x", so every rule that decides from the command word — the recursive
    // removal check, the legacy patterns — saw something it had no opinion
    // about and said nothing.
    while (current.length > 0 && isLeadingRedirection(current[0])) {
      // `> file` puts the target in the next word; `>file` carries its own.
      const attached = /^[0-9]*(?:>>?\|?|<>?|>&|<&)./.test(current[0]);
      current = current.slice(attached ? 1 : 2);
      changed = true;
    }

    const command = commandBasename(current[0] ?? "");
    if (command === "env") {
      current = current.slice(1);
      while (current.length > 0 && (current[0].startsWith("-") || isAssignment(current[0]))) {
        current = current.slice(1);
      }
      changed = true;
      continue;
    }

    if (SIMPLE_WRAPPERS.has(command)) {
      current = current.slice(1);
      while (current.length > 0 && current[0].startsWith("-")) {
        current = current.slice(1);
      }
      changed = true;
    }
  }

  if (current.length > 0) current[0] = commandBasename(current[0]);
  return current;
}

// `$(printf /)` is `/`. The destructive checks read raw words, so an operand
// nothing had expanded was compared as the literal text `$(printf /)` and
// matched no catastrophic target -- while the shell ran the removal of `/`.
//
// Two answers, because the substitutions split cleanly in two. `printf` and
// `echo` with literal arguments are pure text and can be evaluated here, so
// those resolve and the existing refusal applies to the result. Anything else
// (`$(mktemp -d)`, `$(git rev-parse --show-toplevel)`) names a path only the
// shell can produce; refusing those outright would take a common idiom away,
// and allowing them silently is how the check above was walked around. They
// become a question instead.
const STATIC_TEXT_PRODUCERS = new Set(["printf", "echo"]);

/**
 * Whether the segment contains a substitution the shell would actually run.
 *
 * Single quotes suspend it entirely, and that is lost by the time a word is
 * tokenized: `rm -rf '$(printf /)'` removes a file with a strange name, and
 * refusing it as a root removal is a refusal of something nobody asked for.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function segmentHasUnquotedSubstitution(segment) {
  if (typeof segment !== "string") return false;
  let quote;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "\\" && quote !== "'") {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && (char === "`" || (char === "$" && segment[index + 1] === "("))) return true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" || (char === "$" && segment[index + 1] === "(")) return true;
  }
  return false;
}

/**
 * Every command-substitution body in the segment, located by balance rather than
 * by pattern.
 *
 * A regex for `$(...)` cannot see nesting: against `$(printf $(printf /))` it
 * matches the inner half and reports a body of `printf /`, which is a true
 * statement about a substitution nobody asked about. Scanning with the same
 * balance rule the shell uses reports one body, `printf $(printf /)`, and that
 * body is visibly not something this process should try to evaluate.
 *
 * It cannot currently change an outcome, and that is worth stating rather than
 * leaving for the next reader to work out. Evaluation only ever succeeds for a
 * body with no parentheses in it -- the replacement pattern requires that, and
 * anything it leaves behind is caught as a substitution still present in the
 * result. On a paren-free body a pattern scan and a balance scan agree. This is
 * here so the extent of a body is right by construction rather than by that
 * argument continuing to hold.
 *
 * An unterminated substitution yields the rest of the segment as its body. It
 * needs no flag of its own: nothing replaces it, so it survives into the result
 * and is caught there as text that is still a substitution.
 *
 * @param {string} segment
 * @returns {string[]}
 */
function substitutionBodies(segment) {
  const bodies = [];
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] === "`") {
      const end = segment.indexOf("`", index + 1);
      if (end < 0) {
        bodies.push(segment.slice(index + 1));
        break;
      }
      bodies.push(segment.slice(index + 1, end));
      index = end;
      continue;
    }
    if (segment[index] === "$" && segment[index + 1] === "(") {
      const found = findBalanced(segment, index + 1, "(", ")");
      if (!found) {
        bodies.push(segment.slice(index + 2));
        break;
      }
      bodies.push(found.body);
      index = found.end;
      continue;
    }
  }
  return bodies;
}

// What a substitution body may contain for this process to claim it knows the
// output: one plain command and its literal operands, nothing else.
//
// Everything excluded here is a way for a body to produce output that reading
// its first command does not describe. `;`, `&` and `|` put a second command
// after the one being read, so `$(printf /; echo)` runs `printf /` and the
// evaluation stops at a word that is not the output. A newline is another
// separator. `$(` and a backtick nest. `<` and `>` move the output somewhere
// else. A quote or a backslash is gone by the time the word is tokenized, so
// the body being read is no longer the body the shell had. `$` on its own is a
// value this cannot resolve.
const SIMPLE_SUBSTITUTION_BODY = /^[^'"\\`;&|<>()$\n\r]*$/;

/**
 * Whether the substitutions in this segment can be evaluated here at all.
 *
 * Resolving to a wrong value and then permitting on it is worse than not
 * resolving: `$(printf '\x2f')` reaches these checks as `$(printf x2f)`
 * because quoting is applied before tokenizing, and `$(printf /; echo)` is `/`
 * however little the first command says so. One body that this cannot read
 * gives up the whole segment, because a target assembled from several of them
 * is only as knowable as its least knowable part.
 *
 * @param {string} segment
 * @returns {boolean}
 */
function substitutionsAreLiteral(segment) {
  if (typeof segment !== "string") return false;
  return substitutionBodies(segment).every((body) => SIMPLE_SUBSTITUTION_BODY.test(body));
}

/**
 * @param {string} word
 * @param {Map<string, string>} assignments
 * @param {boolean} evaluable
 * @returns {{value: string, resolved: boolean}}
 */
function resolveSubstitutionTarget(word, assignments, evaluable) {
  const substitution = /\$\(([^()]*)\)|`([^`]*)`/g;
  let resolved = true;
  // Always expanded: a variable is resolved from text in this same command and
  // has nothing to do with whether a substitution would run. A word whose `$(`
  // is inside single quotes arrives with `evaluable` unset, so the replacement
  // below leaves it exactly as written.
  const value = expandKnownShellVariables(word, assignments).replace(substitution, (match, parenthesised, backticked) => {
    const inner = (parenthesised ?? backticked ?? "").trim();
    const producer = commandBasename(shellWords(inner)[0] ?? "");
    if (!evaluable || !STATIC_TEXT_PRODUCERS.has(producer)) {
      resolved = false;
      return match;
    }
    const output = staticDataOutput(inner, assignments, producer);
    // More than one word out of a substitution is more than one operand, and
    // stitching them back into one is not what the shell does. `exact` is the
    // other half: a format this renderer does not reproduce yields a value bash
    // never printed, and permitting on that is the failure this whole path is
    // here to avoid.
    if (!output.exact || output.words.length !== 1) {
      resolved = false;
      return match;
    }
    return output.words[0];
  });
  // A substitution left in the result is one the replacement above did not
  // reach -- a nested body, or one whose shape the scanner rejected. The value
  // is not the target either way, so it is not a resolution.
  if (/\$\(|`/.test(value)) return { value, resolved: false };
  return { value, resolved };
}

/** True when the word carries a substitution this process cannot evaluate. */
function hasUnresolvedSubstitution(word, assignments, evaluable) {
  if (!/\$\(|`/.test(word)) return false;
  return !resolveSubstitutionTarget(word, assignments, evaluable).resolved;
}

function rmFinding(words, assignments, evaluable, substituting) {
  const command = commandBasename(words[0] ?? "");
  const dynamicCommand = command.startsWith("$");
  if (command !== "rm" && !dynamicCommand) return undefined;

  let recursive = false;
  let force = false;
  const targets = [];
  for (const word of words.slice(1)) {
    if (word === "--recursive") {
      recursive = true;
      continue;
    }
    if (word === "--force") {
      force = true;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      const chars = flagChars(word);
      if (chars.includes("r") || chars.includes("R")) recursive = true;
      if (chars.includes("f")) force = true;
      continue;
    }
    targets.push(word);
  }

  const resolvedTargets = targets.map((target) => resolveSubstitutionTarget(target, assignments, evaluable));
  if (resolvedTargets.some((target) => isRootOrHomeTarget(target.value)) && (recursive || force || dynamicCommand)) {
    return { action: "forbid", reason: "Refusing recursive/forced removal of root or home target." };
  }
  const opaque = substituting
    ? targets.filter((target) => hasUnresolvedSubstitution(target, assignments, evaluable))
    : [];
  if (opaque.length > 0 && (recursive || force)) {
    return {
      action: "prompt",
      reason: `Recursive/forced rm targets a path this policy cannot resolve: ${opaque.join(", ")}. `
        + "Its value is produced at run time, so what would be deleted is not knowable here. "
        + "Confirm, or run the substitution first and pass the result."
    };
  }
  return undefined;
}

function findDeleteFinding(words, assignments, evaluable, substituting) {
  if (commandBasename(words[0] ?? "") !== "find") return undefined;
  if (!words.includes("-delete")) return undefined;
  const firstTarget = words.slice(1).find((word) => !word.startsWith("-"));
  if (!firstTarget) return undefined;
  if (isRootOrHomeTarget(resolveSubstitutionTarget(firstTarget, assignments, evaluable).value)) {
    return { action: "forbid", reason: "Refusing find -delete against root or home target." };
  }
  if (substituting && hasUnresolvedSubstitution(firstTarget, assignments, evaluable)) {
    return {
      action: "prompt",
      reason: `find -delete starts from a path this policy cannot resolve: ${firstTarget}. `
        + "Its value is produced at run time, so what would be deleted is not knowable here. "
        + "Confirm, or run the substitution first and pass the result."
    };
  }
  return undefined;
}

function ddFinding(words) {
  if (commandBasename(words[0] ?? "") !== "dd") return undefined;
  const out = words.find((word) => /^of=\/dev\/(?:sd[a-z]\d*|hd[a-z]\d*|xvd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|disk\d+|rdisk\d+|mapper\/.+)$/i.test(word));
  return out ? { action: "forbid", reason: `Refusing dd write to block device ${out}.` } : undefined;
}

/**
 * @param {string[]} words
 * @param {Map<string, string>} assignments
 * @param {string} segment
 * @returns {{action: "forbid"|"prompt", reason: string}[]}
 */
function semanticCommandFindings(words, assignments, segment) {
  const normalizedWords = stripWrapper(words);
  // A word arrives here with its quotes already removed, so `'$(printf /)'` and
  // `$(printf /)` are the same three-character-longer string -- and the first
  // one is a filename with an awkward name, not a substitution. Whether the
  // segment contains one the shell would actually run is the part only the raw
  // text still knows.
  const substituting = segmentHasUnquotedSubstitution(segment);
  const evaluable = substituting && substitutionsAreLiteral(segment);
  return [
    rmFinding(normalizedWords, assignments, evaluable, substituting),
    findDeleteFinding(normalizedWords, assignments, evaluable, substituting),
    ddFinding(normalizedWords),
    xargsFinding(normalizedWords)
  ].filter(Boolean);
}

function xargsFinding(words) {
  if (commandBasename(words[0] ?? "") !== "xargs") return undefined;
  const commandIndex = words.findIndex((word, index) => index > 0 && !word.startsWith("-"));
  if (commandIndex < 0) return undefined;
  const nested = words.slice(commandIndex);
  if (commandBasename(nested[0] ?? "") !== "rm") return undefined;
  const hasRecursiveOrForce = nested.slice(1).some((word) => {
    if (word === "--recursive" || word === "--force") return true;
    if (!word.startsWith("-") || word.startsWith("--")) return false;
    const chars = flagChars(word);
    return chars.includes("r") || chars.includes("R") || chars.includes("f");
  });
  return hasRecursiveOrForce
    ? { action: "forbid", reason: "Refusing xargs with recursive/forced rm; input target is not visible to policy." }
    : undefined;
}

function legacyPatternMatchesSegment(pattern, words) {
  const patternWords = shellWords(pattern);
  return arrayStartsWith(words, patternWords);
}

// How far a command may nest interpreters before the policy stops reading, and
// how many segments it may expand to in total.
//
// The previous limit was four, and stopping there meant *not looking* rather
// than *refusing*: a payload wrapped in five layers of `bash -c` was inspected
// at every level the walk reached and then permitted on the strength of a level
// it never opened. The depth now goes far past anything a person writes by hand,
// and reaching either limit is itself grounds to refuse, so the answer to a
// command too convoluted to read is no rather than silence.
const MAX_NESTED_DEPTH = 16;
const MAX_INSPECTED_SEGMENTS = 512;

export function evaluateExecPolicyCore(command, options) {
  const policy = options.policy ?? {};
  const mode = options.mode ?? policy.execPolicy?.defaultMode ?? "enforce";
  const execPolicy = {
    bannedPrefixSuggestions: policy.execPolicy?.bannedPrefixSuggestions ?? [],
    rules: policy.execPolicy?.rules ?? []
  };
  const reasons = [];
  const pending = splitShellSegments(command).map((segment) => ({ segment, depth: 0 }));
  const segments = [];
  // Carried across segments so `D=/; rm -rf "$D"` resolves the same way the
  // path checks already resolve it.
  const assignments = new Map();

  while (pending.length > 0) {
    const { segment, depth } = pending.shift();
    const words = shellWords(segment);
    rememberLeadingShellAssignments(words, assignments);
    const matches = [];
    const warnings = [];

    for (const prefix of execPolicy.bannedPrefixSuggestions) {
      if (arrayStartsWith(words, prefix)) {
        warnings.push(`Do not persist broad approval prefix: ${prefix.join(" ")}`);
      }
    }

    for (const rule of execPolicy.rules) {
      if (!commandRuleMatches(rule, segment, words)) continue;
      matches.push(`${rule.action}:${rule.id}`);
      if (rule.action === "forbid") reasons.push(`Forbidden by exec policy ${rule.id}: ${rule.reason}`);
      if (rule.action === "prompt") reasons.push(`Prompt required by exec policy ${rule.id}: ${rule.reason}`);
    }

    for (const finding of semanticCommandFindings(words, assignments, segment)) {
      matches.push(`${finding.action}:semantic-shell-safety`);
      reasons.push(finding.reason);
    }

    for (const pattern of policy.blockedCommandPatterns ?? []) {
      if (!legacyPatternMatchesSegment(pattern, words)) continue;
      matches.push(`forbid:legacy:${pattern}`);
      reasons.push(`Blocked by legacy policy pattern: ${pattern}`);
    }

    const nested = extractNestedCommands(segment, words);
    if (nested.length > 0 && depth >= MAX_NESTED_DEPTH) {
      matches.push("forbid:nesting-depth");
      reasons.push(
        `Forbidden by exec policy nesting-depth: interpreters nest more than ${MAX_NESTED_DEPTH} levels deep, ` +
        "past the point this policy can read the command. Run it without wrapping it."
      );
    } else if (segments.length >= MAX_INSPECTED_SEGMENTS) {
      matches.push("forbid:nesting-breadth");
      reasons.push(
        `Forbidden by exec policy nesting-breadth: the command expands past ${MAX_INSPECTED_SEGMENTS} segments, ` +
        "past the point this policy can read it. Split it up."
      );
    } else {
      for (const nestedCommand of nested) {
        for (const nestedSegment of splitShellSegments(nestedCommand)) {
          pending.push({ segment: nestedSegment, depth: depth + 1 });
        }
      }
    }

    segments.push({ command: segment, words, matches, warnings });
  }

  const normalizedCommand = command.toLowerCase();
  for (const pattern of policy.requireConfirmationPatterns ?? []) {
    if (normalizedCommand.includes(String(pattern).toLowerCase())) {
      reasons.push(`Confirmation required by legacy policy pattern: ${pattern}`);
      break;
    }
  }

  // The action a check decided, not how its sentence happens to start. Reading
  // the prose meant a finding was only as strong as its first word: a new one
  // whose reason did not begin with "Refusing" or "Prompt" was recorded, shown,
  // and then counted as `allow`. The legacy confirmation patterns below push a
  // reason without a match, so the prose test stays as well.
  const actions = segments.flatMap((entry) => entry.matches);
  const hasForbid = actions.some((action) => action.startsWith("forbid:"))
    || reasons.some((reason) => reason.startsWith("Forbidden") || reason.startsWith("Blocked") || reason.startsWith("Refusing"));
  const hasPrompt = actions.some((action) => action.startsWith("prompt:"))
    || reasons.some((reason) => reason.startsWith("Prompt") || reason.startsWith("Confirmation"));
  return {
    mode,
    decision: mode === "off" ? "allow" : hasForbid ? "forbid" : hasPrompt ? "prompt" : "allow",
    reasons,
    segments
  };
}

function findBalanced(text, startIndex, openChar, closeChar) {
  let depth = 0;
  let quote;
  let escaped = false;
  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (quote) continue;
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return { end: index, body: text.slice(startIndex + 1, index) };
    }
  }
  return undefined;
}

function shellCPayloads(words) {
  const normalizedWords = stripWrapper(words);
  const rootCommand = commandBasename(normalizedWords[0] ?? "");
  const carrier = SHELL_COMMANDS.has(rootCommand) || rootCommand === "xargs" || rootCommand === "find";
  if (!carrier) return [];

  const payloads = [];
  for (let commandIndex = 0; commandIndex < normalizedWords.length; commandIndex += 1) {
    if (!SHELL_COMMANDS.has(commandBasename(normalizedWords[commandIndex] ?? ""))) continue;
    for (let index = commandIndex + 1; index < normalizedWords.length - 1; index += 1) {
      const word = normalizedWords[index];
      if (word === "-c" || (/^-[A-Za-z]+$/.test(word) && word.includes("c"))) {
        payloads.push(normalizedWords[index + 1]);
        break;
      }
    }
  }
  return payloads;
}

function extractNestedCommands(segment, words = shellWords(segment)) {
  const nested = [];
  nested.push(...shellCPayloads(words));
  const normalizedWords = stripWrapper(words);
  const rootCommand = commandBasename(normalizedWords[0] ?? "");
  if (rootCommand === "eval" && normalizedWords.length > 1) nested.push(normalizedWords.slice(1).join(" "));
  if (commandBasename(words[0] ?? "") === "env") {
    const splitIndex = words.indexOf("-S");
    if (splitIndex >= 0 && words[splitIndex + 1]) nested.push(words[splitIndex + 1]);
  }
  if (SHELL_COMMANDS.has(rootCommand)) {
    const hereStringIndex = normalizedWords.indexOf("<<<");
    if (hereStringIndex >= 0 && normalizedWords[hereStringIndex + 1]) nested.push(normalizedWords[hereStringIndex + 1]);
  }

  let quote;
  let escaped = false;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    const next = segment[index + 1];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (quote === "'") continue;
    if (char === "$" && next === "(") {
      const match = findBalanced(segment, index + 1, "(", ")");
      if (match) {
        nested.push(match.body);
        index = match.end;
      }
      continue;
    }
    if (char === "`") {
      const end = segment.indexOf("`", index + 1);
      if (end > index) {
        nested.push(segment.slice(index + 1, end));
        index = end;
      }
      continue;
    }
    if (char === "(") {
      if (quote) continue;
      const previous = segment[index - 1];
      if (previous && /[A-Za-z0-9_]/.test(previous)) continue;
      const match = findBalanced(segment, index, "(", ")");
      if (match) {
        nested.push(match.body);
        index = match.end;
      }
    }
  }

  return nested.filter((item) => typeof item === "string" && item.trim().length > 0);
}

function pathCandidateFromOption(word) {
  const atMatch = word.match(/^@(.+)$/) ?? word.match(/=@(.+)$/);
  if (atMatch) return atMatch[1];
  const equalsMatch = word.match(/^(?:--?[A-Za-z0-9-]+)=(.+)$/);
  return equalsMatch ? equalsMatch[1] : undefined;
}

function isPathLike(word) {
  if (!word || word === "-") return false;
  if (word.startsWith("http://") || word.startsWith("https://")) return false;
  return word.startsWith(".")
    || word.startsWith("/")
    || word.startsWith("~/")
    || word.startsWith("$HOME/")
    || word.includes("/")
    || word === "auth.json";
}

function isFilesystemArgument(word) {
  if (!word || word === "-") return false;
  if (word.startsWith("http://") || word.startsWith("https://")) return false;
  if (PATH_REDIRECT_OPERATORS.has(word)) return false;
  return isPathLike(word) || !word.startsWith("-");
}

/**
 * The path inside a `key=value` operand.
 *
 * The shell treats `NAME=VALUE` as an assignment only before the command word;
 * after it, the word is an operand and the command decides what it means. This
 * is only ever asked about words after the command word, so rejecting them all
 * as assignments hid `dd if=.env` and `dd of=.env` — which `ddFinding` already
 * parses to catch block-device writes, so the module knew and never said.
 *
 * @param {string} word
 * @returns {string|undefined}
 */
function operandValuePath(word) {
  const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
  if (!match) return undefined;
  const value = match[2];
  if (value.startsWith("http://") || value.startsWith("https://")) return undefined;
  return value;
}

function rememberLeadingShellAssignments(words, assignments) {
  const remember = (word) => {
    const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;
    // `a=(.env)` is an array literal, and storing it whole left the parentheses
    // glued to the value so `${a[@]}` resolved to a name no file has. Every
    // element is a path this command may reach, so the whole set is kept and any
    // subscript resolves to all of it — matching one of them is enough to refuse.
    const array = match[2].match(/^\((.*)\)$/);
    const value = array ? array[1].trim() : match[2];
    assignments.set(match[1], expandKnownShellVariables(value, assignments));
  };
  let start = 0;
  while (start < words.length && isAssignment(words[start])) start += 1;
  if (start === words.length) {
    for (const word of words) remember(word);
    return;
  }
  if (!ASSIGNMENT_BUILTINS.has(commandBasename(words[start] ?? ""))) return;
  for (const word of words.slice(start + 1)) remember(word);
}

/**
 * Applies one parameter-expansion operator to a value the assignments already
 * resolved.
 *
 * These are the operators that rewrite a known value into a different string.
 * Without them `V=q.env; cat ${V#q}` produced the candidate `${V#q}`, which
 * matches no protected pattern while the shell opens `.env`. Patterns are
 * treated as literals rather than as shell globs: matching less is safe here,
 * because a word this cannot resolve is refused by `unresolvedPathExpansions`
 * rather than assumed harmless.
 *
 * @param {string} operator the characters between the name and the argument
 * @param {string} argument
 * @param {string} value the resolved value of the variable
 * @returns {string|undefined} the rewritten value, or undefined when this
 *   operator is not modelled
 */
function applyParameterOperator(operator, argument, value) {
  switch (operator) {
    case ":+":
    case "+":
      return value ? argument : "";
    case "#":
      return value.startsWith(argument) ? value.slice(argument.length) : value;
    case "##": {
      return value.startsWith(argument) ? value.slice(argument.length) : value;
    }
    case "%":
    case "%%":
      return value.endsWith(argument) ? value.slice(0, -argument.length || undefined) : value;
    default:
      return undefined;
  }
}

function expandKnownShellVariables(value, assignments, resolving = new Set(), depth = 0) {
  if (depth >= 8) return String(value ?? "");
  return String(value ?? "").replace(
    // Three shapes: `${NAME<op><arg>}`, `${NAME}` with the `:-`/`:=` default,
    // and bare `$NAME`. The operator group is deliberately narrow — anything it
    // does not name stays unexpanded, and unexpanded is what gets refused.
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?(?:(:?[-=+]|#{1,2}|%{1,2}|\/{1,2})([^{}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced, operator, argument, plain) => {
      const name = braced ?? plain;
      const resolved = assignments.get(name);
      // The value is recursed with `name` marked so `F=$G; G=$F` terminates. An
      // operator's argument is separate text that merely mentions the same name,
      // so it keeps the outer set -- `${V:+$V}` is the value, not a cycle.
      const recur = (next) => expandKnownShellVariables(next, assignments, resolving, depth + 1);

      if (resolved === undefined || resolving.has(name)) {
        // `${VAR:-default}` states what it becomes when the variable is unset,
        // which is the usual case here since nothing in the segment assigned it.
        // Leaving the expression whole meant `cat .${X:-env}` produced the
        // candidate `.${X:-env}` — the one form that says where it points was
        // the one form nothing read.
        if (operator === ":-" || operator === "-" || operator === ":=" || operator === "=") {
          return expandKnownShellVariables(argument, assignments, resolving, depth + 1);
        }
        return match;
      }

      const expanded = expandKnownShellVariables(resolved, assignments, new Set([...resolving, name]), depth + 1);
      if (operator === undefined) return expanded;
      if (operator === ":-" || operator === "-" || operator === ":=" || operator === "=") return expanded;

      if (operator === "/" || operator === "//") {
        const separator = argument.indexOf("/");
        const pattern = separator >= 0 ? argument.slice(0, separator) : argument;
        const replacement = separator >= 0 ? argument.slice(separator + 1) : "";
        if (!pattern) return expanded;
        return operator === "//"
          ? expanded.split(pattern).join(recur(replacement))
          : expanded.replace(pattern, recur(replacement));
      }

      const applied = applyParameterOperator(operator, recur(argument), expanded);
      return applied === undefined ? match : applied;
    }
  );
}

function executableArgumentTokens(tokens, words, commandName) {
  const commandIndex = words.findIndex((word) => commandBasename(word) === commandName);
  return commandIndex >= 0 ? tokens.slice(commandIndex + 1) : tokens.slice(1);
}

function quotedShellLiterals(segment) {
  const literals = [];
  for (let index = 0; index < segment.length; index += 1) {
    const quote = segment[index];
    if (quote !== "'" && quote !== '"') continue;
    let value = "";
    let escaped = false;
    for (index += 1; index < segment.length; index += 1) {
      const char = segment[index];
      if (escaped) {
        value += `\\${char}`;
        escaped = false;
        continue;
      }
      if (char === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (char === quote) break;
      value += char;
    }
    literals.push(value);
  }
  return literals;
}

function decodeShellDataEscapes(value) {
  const controlIndex = value.indexOf("\\c");
  const bounded = controlIndex >= 0 ? value.slice(0, controlIndex) : value;
  return bounded.replace(/\\(?:x([0-9A-Fa-f]{1,2})|0([0-7]{1,3})|([0-7]{1,3})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|([abefnrtv\\'\"]))/g,
    (match, hex, zeroOctal, octal, shortUnicode, longUnicode, simple) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (zeroOctal || octal) return String.fromCodePoint(Number.parseInt(zeroOctal ?? octal, 8));
      if (shortUnicode || longUnicode) {
        const codePoint = Number.parseInt(shortUnicode ?? longUnicode, 16);
        return codePoint <= 0x10FFFF ? String.fromCodePoint(codePoint) : match;
      }
      return {
        a: "\u0007",
        b: "\b",
        e: "\u001B",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
        "\\": "\\",
        "'": "'",
        '"': '"'
      }[simple] ?? match;
    });
}

function escapedLiteralCandidates(segment) {
  const candidates = [];
  for (const literal of quotedShellLiterals(segment)) {
    const decoded = decodeShellDataEscapes(literal);
    candidates.push(...decoded.split(/\s+/).filter(Boolean));
  }
  return candidates;
}

function shellDataTokens(segment) {
  const tokens = [];
  let current = "";
  let quote;
  let tokenStarted = false;
  let variableActive = false;
  const flush = () => {
    if (!tokenStarted) return;
    tokens.push({ value: current, variableActive });
    current = "";
    tokenStarted = false;
    variableActive = false;
  };

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    const next = segment[index + 1];
    if (quote === "'") {
      tokenStarted = true;
      if (char === "'") quote = undefined;
      else current += char;
      continue;
    }
    if (quote === '"') {
      tokenStarted = true;
      if (char === '"') {
        quote = undefined;
      } else if (char === "\\" && next !== undefined && /[$`"\\\n]/.test(next)) {
        current += next;
        index += 1;
      } else {
        if (char === "$" && next !== undefined) variableActive = true;
        current += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    tokenStarted = true;
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      current += next;
      index += 1;
      continue;
    }
    if (char === "$" && next !== undefined) variableActive = true;
    current += char;
  }
  flush();
  return tokens;
}

function renderStaticPrintf(format, values) {
  let valueIndex = 0;
  let rendered = "";
  const decodedFormat = decodeShellDataEscapes(format);
  const conversion = /%(?:\d+\$)?[-+#0 ']*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlL]?[bcdeEfgGiosuxXaA]/g;
  let cursor = 0;
  for (const match of decodedFormat.matchAll(conversion)) {
    if (rendered.length > 8192 || valueIndex >= 32) break;
    const start = match.index ?? 0;
    rendered += decodedFormat.slice(cursor, start).replace(/%%/g, "%");
    const specifier = match[0].slice(-1);
    const argument = values[valueIndex] ?? "";
    rendered += specifier === "b" ? decodeShellDataEscapes(argument) : argument;
    valueIndex += 1;
    cursor = start + match[0].length;
  }
  rendered += decodedFormat.slice(cursor).replace(/%%/g, "%");
  return rendered.slice(0, 8192);
}

// Whether this renderer reproduces what bash prints, for this format and this
// many arguments.
//
// `%s` with no flags, width, precision or positional argument is the only
// conversion whose output is its argument unchanged. A width pads it (`%5s /`
// is four spaces and a slash), a precision truncates it (`%.0s` prints
// nothing), `*` consumes an argument as the width instead of printing it, `%q`
// requotes, `%b` decodes escapes, and every numeric conversion reformats. This
// renderer substitutes the raw argument for all of them, so what it returns for
// any of those is a value bash never printed.
//
// `%%` is excluded because the collapse happens after substitution here rather
// than before, and bash reuses the format while arguments remain, which this
// does not -- so more arguments than conversions is not reproduced either. A
// format with no conversions at all is printed once with the extra arguments
// ignored, which this does match.
function printfFormatIsExact(format, values) {
  if (!format.includes("%")) return true;
  const conversions = format.match(/%s/g) ?? [];
  if (conversions.length === 0) return false;
  if ((format.match(/%/g) ?? []).length !== conversions.length) return false;
  return values.length <= conversions.length;
}

/** The literal text of a printf format, with every conversion removed. */
function printfFormatLiterals(format) {
  return format.replace(/%(?:\d+\$)?[-+#0 ']*(?:\d+|\*)?(?:\.(?:\d+|\*))?[hlL]?[A-Za-z]/g, " ");
}

/**
 * What a `printf` or `echo` prints, as far as this process can tell.
 *
 * `words` is what it prints and nothing else, so a caller deciding whether to
 * permit a command can only use it when `exact` is set. `candidates` is wider on
 * purpose: it adds the format's own literal text and the raw arguments, because
 * a caller looking for a protected path wants every string that could reach the
 * output. `printf %.0s.env x` prints `.env`, and reading only the substituted
 * argument returned `x.env` -- a name matching no protected pattern, which is
 * the wrong direction for that check to be wrong in.
 *
 * @returns {{words: string[], candidates: string[], exact: boolean}}
 */
function staticDataOutput(segment, assignments, producerCommand) {
  const empty = { words: [], candidates: [], exact: false };
  const tokens = shellDataTokens(segment);
  const commandIndex = tokens.findIndex((token) => commandBasename(token.value) === producerCommand);
  if (commandIndex < 0) return empty;
  const args = tokens.slice(commandIndex + 1).map((token) => token.variableActive
    ? expandKnownShellVariables(token.value, assignments)
    : token.value);
  let output = "";
  let exact = false;
  const extra = [];
  if (producerCommand === "echo") {
    let argumentIndex = 0;
    let escapes = false;
    while (argumentIndex < args.length && /^-[eEn]+$/.test(args[argumentIndex])) {
      if (args[argumentIndex].slice(1).includes("e")) escapes = true;
      if (args[argumentIndex].slice(1).includes("E")) escapes = false;
      argumentIndex += 1;
    }
    output = args.slice(argumentIndex).join(" ");
    // Whether `echo` interprets escapes without `-e` is shell- and
    // build-dependent, so a command that turns them on is read but not trusted
    // to the exact byte.
    exact = !escapes;
    if (escapes) output = decodeShellDataEscapes(output);
  } else if (producerCommand === "printf" && args.length > 0) {
    output = renderStaticPrintf(args[0], args.slice(1));
    exact = printfFormatIsExact(args[0], args.slice(1));
    extra.push(printfFormatLiterals(args[0]), ...args.slice(1));
  }
  const words = output.split(/\s+/).filter(Boolean);
  const candidates = [...words, ...extra.flatMap((item) => item.split(/\s+/)).filter(Boolean)];
  return { words, candidates: [...new Set(candidates)], exact };
}

function staticDataOutputCandidates(segment, assignments, producerCommand) {
  return staticDataOutput(segment, assignments, producerCommand).candidates;
}

function echoEscapeMode(words, commandIndex) {
  for (const word of words.slice(commandIndex + 1)) {
    if (!/^-[eEn]+$/.test(word)) break;
    if (word.slice(1).includes("e")) return true;
  }
  return false;
}

const RG_VALUE_SHORT_OPTIONS = new Set(["A", "B", "C", "E", "e", "f", "g", "j", "M", "m", "r", "t", "T"]);

function attachedRgShortOption(word) {
  if (!/^-[^-]/.test(word)) return undefined;
  const cluster = word.slice(1);
  for (let index = 0; index < cluster.length; index += 1) {
    const option = cluster[index];
    if (!RG_VALUE_SHORT_OPTIONS.has(option)) continue;
    const value = cluster.slice(index + 1);
    return value ? { option: `-${option}`, value } : undefined;
  }
  return undefined;
}

function xargsPipelineInputCandidates(command) {
  const segments = splitShellSegments(command);
  const candidates = [];
  const assignments = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    const producerTokens = shellWordTokens(segments[index]);
    const producerWords = producerTokens.map((token) => token.value);
    rememberLeadingShellAssignments(producerWords, assignments);
    if (index + 1 >= segments.length) continue;
    const consumerWords = shellWords(segments[index + 1]);
    const consumerCommand = commandBasename(stripWrapper(consumerWords)[0] ?? "");
    if (consumerCommand !== "xargs") continue;
    const producerCommand = commandBasename(stripWrapper(producerWords)[0] ?? "");
    if (!DATA_ONLY_COMMANDS.has(producerCommand)) continue;
    const commandIndex = producerWords.findIndex((word) => commandBasename(word) === producerCommand);
    for (const token of producerTokens.slice(commandIndex + 1)) {
      const word = token.variableActive ? expandKnownShellVariables(token.value, assignments) : token.value;
      if (word.startsWith("-") || word === "%s" || word === "%s\\n") continue;
      candidates.push(word);
    }
    if (producerCommand === "printf" || (producerCommand === "echo" && echoEscapeMode(producerWords, commandIndex))) {
      candidates.push(...escapedLiteralCandidates(segments[index]));
    }
    candidates.push(...staticDataOutputCandidates(segments[index], assignments, producerCommand));
  }
  return candidates;
}

function extractAttachedRedirectionPaths(segment) {
  const paths = [];
  let quote;
  let escaped = false;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (quote || (char !== "<" && char !== ">")) continue;

    const next = segment[index + 1];
    if (char === "<" && next === "<") {
      while (segment[index + 1] === "<") index += 1;
      continue;
    }
    // `>&` duplicates a file descriptor only when a digit or `-` follows it.
    // `>&word` with anything else redirects both streams to a file called
    // `word`, so skipping the whole form meant `printf x >& .env` truncated a
    // protected file while the scan moved past it.
    if (next === "&") {
      let after = index + 2;
      while (/\s/.test(segment[after] ?? "")) after += 1;
      const target = segment[after] ?? "";
      if (target === "" || target === "-" || /[0-9]/.test(target)) {
        index += 1;
        continue;
      }
      index += 1;
    }

    if ((char === ">" && (next === ">" || next === "|")) || (char === "<" && next === ">")) index += 1;
    let cursor = index + 1;
    while (/\s/.test(segment[cursor] ?? "")) cursor += 1;
    if (!segment[cursor] || segment[cursor] === "&" || segment[cursor] === "-") continue;

    let target = "";
    let targetQuote;
    let targetEscaped = false;
    // Whitespace and `|` inside `$( )` or backticks belong to the target word.
    // Ending at the first space split `> .en$(echo v)` into a target of
    // `.en$(echo`, a name that matches nothing and hides the one being written.
    let targetSubstitution = 0;
    let targetBackticks = false;
    for (; cursor < segment.length; cursor += 1) {
      const targetChar = segment[cursor];
      if (targetEscaped) {
        target += targetChar;
        targetEscaped = false;
        continue;
      }
      if (targetChar === "\\") {
        targetEscaped = true;
        continue;
      }
      // A redirection target is a word like any other, so it can be written in
      // ANSI-C quoting too. `printf x >$'.env'` used to yield the target
      // `$.env`, which matches nothing, while the shell truncated `.env`.
      if (targetChar === "$" && segment[cursor + 1] === "'" && !targetQuote) {
        const ansiC = readAnsiCQuote(segment, cursor);
        target += ansiC.value;
        cursor = ansiC.endIndex;
        continue;
      }
      if ((targetChar === "'" || targetChar === '"') && !targetQuote) {
        targetQuote = targetChar;
        continue;
      }
      if (targetQuote === targetChar) {
        targetQuote = undefined;
        continue;
      }
      if (!targetQuote) {
        if (targetChar === "$" && (segment[cursor + 1] === "(" || segment[cursor + 1] === "{")) targetSubstitution += 1;
        else if ((targetChar === ")" || targetChar === "}") && targetSubstitution > 0) targetSubstitution -= 1;
        else if (targetChar === "`") targetBackticks = !targetBackticks;
      }
      const insideSubstitution = targetSubstitution > 0 || targetBackticks;
      if (!targetQuote && !insideSubstitution && (/\s/.test(targetChar) || /[;&|<>]/.test(targetChar))) break;
      target += targetChar;
    }
    if (target) paths.push(target);
    index = Math.max(index, cursor - 1);
  }

  return paths;
}

export function extractShellPathCandidates(command) {
  const candidates = [...xargsPipelineInputCandidates(command)];
  const assignments = new Map();
  const addCandidate = (candidate, variableActive = true) => {
    if (typeof candidate !== "string" || !candidate) return;
    candidates.push(variableActive ? expandKnownShellVariables(candidate, assignments) : candidate);
  };
  const pending = splitShellSegments(command).map((segment) => ({ segment, depth: 0 }));
  while (pending.length > 0) {
    const { segment, depth } = pending.shift();
    const tokens = shellWordTokens(segment);
    const words = tokens.map((token) => token.value);
    rememberLeadingShellAssignments(words, assignments);
    const commandName = commandBasename(stripWrapper(words)[0] ?? "");
    for (const redirectPath of extractAttachedRedirectionPaths(segment)) addCandidate(redirectPath);

    const inlineFlags = INLINE_CODE_FLAGS.get(commandName);
    if (inlineFlags) {
      for (let index = 0; index < words.length - 1; index += 1) {
        if (!inlineFlags.has(words[index])) continue;
        for (const literal of quotedShellLiterals(words[index + 1])) addCandidate(literal);
      }
    }

    if (!DATA_ONLY_COMMANDS.has(commandName) || depth > 0) {
      const argumentTokens = executableArgumentTokens(tokens, words, commandName);
      // `printf %.0s.env x` prints `.env`: the conversion eats the argument and
      // the rest of the format is the output. Reading only the substituted
      // argument produced `x.env`, a name matching no protected pattern, so the
      // file the command actually names went unseen. Inside the data-only guard
      // with everything else -- a `printf` of its own prints to stdout, and its
      // format is text until something downstream opens it.
      if (commandName === "printf") {
        for (const literal of printfFormatLiterals(argumentTokens[0]?.value ?? "").split(/\s+/)) addCandidate(literal);
      }
      let searchPatternPending = SEARCH_COMMANDS.has(commandName);
      for (let index = 0; index < argumentTokens.length; index += 1) {
        const word = argumentTokens[index].value;
        if (word === "<<" || word === "<<<") {
          if (commandName === "xargs" && word === "<<<" && argumentTokens[index + 1]) {
            const input = argumentTokens[index + 1];
            addCandidate(input.value, input.variableActive);
          }
          index += 1;
          continue;
        }
        if (PATH_REDIRECT_OPERATORS.has(word) && argumentTokens[index + 1]) {
          const target = argumentTokens[index + 1];
          addCandidate(target.value, target.variableActive);
          index += 1;
          continue;
        }
        if (/^(?:\d*)>>?/.test(word) || /^&>>?/.test(word)) {
          const pathPart = word.replace(/^(?:\d*|&)>>?/, "");
          if (pathPart) addCandidate(pathPart, argumentTokens[index].variableActive);
          continue;
        }
        const optionEquals = word.indexOf("=");
        const optionName = optionEquals > 0 ? word.slice(0, optionEquals) : word;
        const inlineOptionValue = optionEquals > 0 ? word.slice(optionEquals + 1) : undefined;
        if (SEARCH_COMMANDS.has(commandName) && SEARCH_PATTERN_OPTIONS.has(optionName)) {
          searchPatternPending = false;
          if (inlineOptionValue === undefined) index += 1;
          continue;
        }
        const attachedGrepFile = ["grep", "egrep", "fgrep"].includes(commandName) && /^-f.+/.test(word)
          ? word.slice(2)
          : undefined;
        if (attachedGrepFile) {
          addCandidate(attachedGrepFile, argumentTokens[index].variableActive);
          searchPatternPending = false;
          continue;
        }
        const attachedRgOption = ["rg", "ripgrep"].includes(commandName) ? attachedRgShortOption(word) : undefined;
        if (attachedRgOption?.option === "-e") {
          searchPatternPending = false;
          continue;
        }
        if (attachedRgOption?.option === "-f") {
          addCandidate(attachedRgOption.value, argumentTokens[index].variableActive);
          searchPatternPending = false;
          continue;
        }
        if (attachedRgOption?.option === "-g") {
          addCandidate(attachedRgOption.value, argumentTokens[index].variableActive);
          continue;
        }
        if (SEARCH_COMMANDS.has(commandName) && (SEARCH_FILE_OPTIONS.has(optionName) || SEARCH_GLOB_OPTIONS.has(optionName))) {
          if (inlineOptionValue !== undefined) {
            addCandidate(inlineOptionValue, argumentTokens[index].variableActive);
          } else {
            const target = argumentTokens[index + 1];
            if (target) addCandidate(target.value, target.variableActive);
            index += 1;
          }
          if (SEARCH_FILE_OPTIONS.has(optionName) && (optionName === "-f" || optionName === "--file")) searchPatternPending = false;
          continue;
        }
        const optionPath = pathCandidateFromOption(word);
        if (optionPath) {
          addCandidate(optionPath, argumentTokens[index].variableActive);
          continue;
        }
        if (word.startsWith("-")) continue;
        if (searchPatternPending) {
          searchPatternPending = false;
          continue;
        }
        const operandPath = operandValuePath(word);
        if (operandPath) {
          addCandidate(operandPath, argumentTokens[index].variableActive);
          continue;
        }
        if (isFilesystemArgument(word)) addCandidate(word, argumentTokens[index].variableActive);
      }
    }
    if (depth < MAX_NESTED_DEPTH) {
      for (const nestedCommand of extractNestedCommands(segment, words)) {
        for (const nestedSegment of splitShellSegments(nestedCommand)) {
          pending.push({ segment: nestedSegment, depth: depth + 1 });
        }
      }
    }
  }
  return [...new Set(candidates.map(normalizePathCandidate).filter(Boolean))];
}

export function extractShellGlobCandidates(command) {
  const candidates = [];
  const assignments = new Map();
  const pending = splitShellSegments(command).map((segment) => ({ segment, depth: 0 }));
  while (pending.length > 0) {
    const { segment, depth } = pending.shift();
    const tokens = shellWordTokens(segment);
    const words = tokens.map((token) => token.value);
    rememberLeadingShellAssignments(words, assignments);
    const commandName = commandBasename(stripWrapper(words)[0] ?? "");

    // A redirection target is a file whatever the command does with its
    // arguments, so it is read before the data-only skip below rather than
    // inside it: `printf pwned > .en*` truncates whatever `.en*` matches, and
    // `printf` being a data-only command says nothing about that. Read through
    // the same scanner the path candidates use, so the operator prefix is off
    // and `>|`, `>&` and ANSI-C quoting are already handled.
    for (const redirectPath of extractAttachedRedirectionPaths(segment)) {
      const expanded = expandKnownShellVariables(redirectPath, assignments);
      if (/[*?{\[]/.test(expanded)) candidates.push(expanded);
    }

    if (!DATA_ONLY_COMMANDS.has(commandName) || depth > 0) {
      const argumentTokens = executableArgumentTokens(tokens, words, commandName);
      let searchPatternPending = SEARCH_COMMANDS.has(commandName);
      for (let index = 0; index < argumentTokens.length; index += 1) {
        const token = argumentTokens[index];
        if (token.value === "<<" || token.value === "<<<") {
          if (commandName === "xargs" && token.value === "<<<" && argumentTokens[index + 1]) {
            const input = argumentTokens[index + 1];
            const expanded = expandKnownShellVariables(input.value, assignments);
            if (input.activeGlob || (input.unquotedVariable && /[*?{\[]/.test(expanded))) candidates.push(expanded);
          }
          index += 1;
          continue;
        }
        if (PATH_REDIRECT_OPERATORS.has(token.value)) {
          const target = argumentTokens[index + 1];
          if (target) {
            const expanded = expandKnownShellVariables(target.value, assignments);
            if (target.activeGlob || (target.unquotedVariable && /[*?{\[]/.test(expanded))) candidates.push(expanded);
          }
          index += 1;
          continue;
        }
        const optionEquals = token.value.indexOf("=");
        const optionName = optionEquals > 0 ? token.value.slice(0, optionEquals) : token.value;
        const inlineOptionValue = optionEquals > 0 ? token.value.slice(optionEquals + 1) : undefined;
        if (SEARCH_COMMANDS.has(commandName) && SEARCH_PATTERN_OPTIONS.has(optionName)) {
          searchPatternPending = false;
          if (inlineOptionValue === undefined) index += 1;
          continue;
        }
        const attachedRgOption = ["rg", "ripgrep"].includes(commandName) ? attachedRgShortOption(token.value) : undefined;
        if (attachedRgOption?.option === "-e") {
          searchPatternPending = false;
          continue;
        }
        if (attachedRgOption?.option === "-f") {
          searchPatternPending = false;
          continue;
        }
        if (attachedRgOption?.option === "-g") {
          const expanded = token.variableActive
            ? expandKnownShellVariables(attachedRgOption.value, assignments)
            : attachedRgOption.value;
          candidates.push(expanded);
          continue;
        }
        if (SEARCH_COMMANDS.has(commandName) && (SEARCH_FILE_OPTIONS.has(optionName) || SEARCH_GLOB_OPTIONS.has(optionName))) {
          const target = inlineOptionValue === undefined ? argumentTokens[index + 1] : undefined;
          const targetValue = inlineOptionValue ?? target?.value;
          if (targetValue !== undefined) {
            const targetVariableActive = inlineOptionValue === undefined ? target?.variableActive : token.variableActive;
            const expanded = targetVariableActive ? expandKnownShellVariables(targetValue, assignments) : targetValue;
            if (SEARCH_GLOB_OPTIONS.has(optionName) || target?.activeGlob || (target?.unquotedVariable && /[*?{\[]/.test(expanded))) {
              candidates.push(expanded);
            }
          }
          if (SEARCH_FILE_OPTIONS.has(optionName) && (optionName === "-f" || optionName === "--file")) searchPatternPending = false;
          if (inlineOptionValue === undefined) index += 1;
          continue;
        }
        if (token.value.startsWith("-")) continue;
        if (searchPatternPending) {
          searchPatternPending = false;
          continue;
        }
        const expanded = expandKnownShellVariables(token.value, assignments);
        if (token.activeGlob || (token.unquotedVariable && /[*?{\[]/.test(expanded))) candidates.push(expanded);
      }
    }
    if (depth < MAX_NESTED_DEPTH) {
      for (const nestedCommand of extractNestedCommands(segment, words)) {
        for (const nestedSegment of splitShellSegments(nestedCommand)) pending.push({ segment: nestedSegment, depth: depth + 1 });
      }
    }
  }
  return [...new Set(candidates.map(normalizePathCandidate).filter(Boolean))];
}

/**
 * Words in a file position whose final path segment this module could not
 * resolve to a name.
 *
 * Modelling one more expansion operator each time one is reported is a losing
 * game: bash has a dozen of them, plus arrays, plus command substitution, and
 * each unmodelled form reads as "this word names no protected path" — the one
 * answer that is never safe to guess. So the rule is inverted here. A word that
 * still holds an expansion where its filename lives is *unresolved*, and an
 * unresolved filename is refused rather than assumed harmless.
 *
 * Two conditions narrow it to words that are filenames being assembled, rather
 * than to every word holding an expansion.
 *
 * Only the last path segment counts. `$HOME/notes.txt` names a known file in an
 * unknown directory, and every protected pattern that could match it is anchored
 * on the basename anyway, so flagging it would refuse ordinary work for nothing.
 *
 * And the expansion has to be *concatenated with literal text*. A word that is
 * nothing but an expansion — `$(date)`, `${MESSAGE}` — is as likely to be a
 * commit message as a path, and a pure substitution is already followed into by
 * `extractNestedCommands`, which reads `cat $(echo .env)` correctly. What that
 * cannot do is put the pieces back together: `.en$(echo v)` and `$(echo .)env`
 * are filenames half-written in plain sight, and only a rule about the joining
 * sees them.
 *
 * Quoting decides whether a `$` is an expansion at all, so this reads the
 * tokenizer's own verdict rather than looking for the character — `cat '$F'`
 * passes a literal and is not flagged.
 *
 * @param {string} command
 * @returns {string[]} the unresolved words, in the order they appear
 */
// Strip the expansions out; whatever text is left is the literal part the author
// wrote around them. Literal text plus an expansion is a filename being
// assembled; an expansion on its own is a value.
function hasLiteralAroundExpansion(basename) {
  const literal = basename.replace(/\$\{[^{}]*\}|\$\([^()]*\)|`[^`]*`/g, "");
  return literal.length > 0 && literal !== basename;
}

export function unresolvedPathExpansions(command) {
  const unresolved = [];
  const assignments = new Map();
  const pending = splitShellSegments(command).map((segment) => ({ segment, depth: 0 }));

  while (pending.length > 0) {
    const { segment, depth } = pending.shift();
    const tokens = shellWordTokens(segment);
    const words = tokens.map((token) => token.value);
    rememberLeadingShellAssignments(words, assignments);
    const commandName = commandBasename(stripWrapper(words)[0] ?? "");
    // A redirection target is a file the shell creates whatever the command is,
    // so it is read before the data-only skip below.
    for (const redirectPath of extractAttachedRedirectionPaths(segment)) {
      const expanded = expandKnownShellVariables(redirectPath, assignments);
      const basename = expanded.slice(expanded.lastIndexOf("/") + 1);
      if (hasLiteralAroundExpansion(basename)) unresolved.push(redirectPath);
    }
    // `echo ${a[@]}` prints a name, it does not open one.
    if (!DATA_ONLY_COMMANDS.has(commandName) || depth > 0) {
      for (const token of executableArgumentTokens(tokens, words, commandName)) {
        if (!token.variableActive) continue;
        if (token.value.startsWith("-")) continue;
        // `dd if=.en$(echo v)` hides a filename in an operand value. Reading the
        // key as literal text would refuse every `TAG=build$(date +%s)` too, so
        // the value is taken on its own and only when it is shaped like a path.
        const operandValue = operandValuePath(token.value);
        const word = operandValue ?? token.value;
        if (operandValue !== undefined
          && !operandValue.includes("/")
          && !operandValue.startsWith(".")) continue;
        if (word.startsWith("-")) continue;
        const expanded = expandKnownShellVariables(word, assignments);
        const basename = expanded.slice(expanded.lastIndexOf("/") + 1);
        if (hasLiteralAroundExpansion(basename)) unresolved.push(token.value);
      }
    }
    if (depth < MAX_NESTED_DEPTH) {
      for (const nestedCommand of extractNestedCommands(segment, words)) {
        for (const nestedSegment of splitShellSegments(nestedCommand)) {
          pending.push({ segment: nestedSegment, depth: depth + 1 });
        }
      }
    }
  }
  return unresolved;
}

export function findProtectedPathInCommand(command, protectedPatterns) {
  for (const candidate of extractShellPathCandidates(command)) {
    const pattern = matchesProtectedPath(candidate, protectedPatterns);
    if (pattern) return { candidate, pattern };
  }
  return undefined;
}

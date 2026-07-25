const PATH_REDIRECT_OPERATORS = new Set(["<", ">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>"]);
const DATA_ONLY_COMMANDS = new Set(["echo", "printf"]);
const SEARCH_COMMANDS = new Set(["grep", "egrep", "fgrep", "rg", "ripgrep"]);
const SEARCH_FILE_OPTIONS = new Set(["-f", "--file", "--exclude-from", "--ignore-file"]);
const SEARCH_GLOB_OPTIONS = new Set(["-g", "--glob", "--iglob", "--include", "--exclude"]);
const SEARCH_PATTERN_OPTIONS = new Set(["-e", "--regexp", "--pattern"]);
const ASSIGNMENT_BUILTINS = new Set(["export", "readonly", "declare", "typeset", "local"]);
const SHELL_COMMANDS = new Set(["bash", "sh", "zsh"]);
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
    const previous = command[index - 1];
    const ampersandIsSeparator = char === "&" && next !== "&" && previous !== ">" && previous !== "<";
    if (!quote && (char === "\n" || char === ";" || char === "|" || ampersandIsSeparator || (char === "&" && next === "&") || (char === "|" && next === "|"))) {
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

function shellWordTokens(segment) {
  const tokens = [];
  let current = "";
  let quote;
  let escaped = false;
  let activeGlob = false;
  let unquotedVariable = false;
  let variableActive = false;
  const flush = () => {
    if (!current) return;
    tokens.push({ value: current, activeGlob, unquotedVariable, variableActive });
    current = "";
    activeGlob = false;
    unquotedVariable = false;
    variableActive = false;
  };
  for (const char of segment.trim()) {
    if (escaped) {
      current += char;
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
    if (!quote && /\s/.test(char)) {
      flush();
      continue;
    }
    if (!quote && /[*?{\[]/.test(char)) activeGlob = true;
    if (char === "$" && quote !== "'") {
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

function stripWrapper(words) {
  let current = [...words];
  let changed = true;

  while (changed && current.length > 0) {
    changed = false;
    while (current.length > 0 && isAssignment(current[0])) {
      current = current.slice(1);
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

function rmFinding(words) {
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

  if (targets.some(isRootOrHomeTarget) && (recursive || force || dynamicCommand)) {
    return "Refusing recursive/forced removal of root or home target.";
  }
  return undefined;
}

function findDeleteFinding(words) {
  if (commandBasename(words[0] ?? "") !== "find") return undefined;
  if (!words.includes("-delete")) return undefined;
  const firstTarget = words.slice(1).find((word) => !word.startsWith("-"));
  if (firstTarget && isRootOrHomeTarget(firstTarget)) {
    return "Refusing find -delete against root or home target.";
  }
  return undefined;
}

function ddFinding(words) {
  if (commandBasename(words[0] ?? "") !== "dd") return undefined;
  const out = words.find((word) => /^of=\/dev\/(?:sd[a-z]\d*|hd[a-z]\d*|xvd[a-z]\d*|nvme\d+n\d+(?:p\d+)?|disk\d+|rdisk\d+|mapper\/.+)$/i.test(word));
  return out ? `Refusing dd write to block device ${out}.` : undefined;
}

function semanticCommandFindings(words) {
  const normalizedWords = stripWrapper(words);
  return [
    rmFinding(normalizedWords),
    findDeleteFinding(normalizedWords),
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
  return hasRecursiveOrForce ? "Refusing xargs with recursive/forced rm; input target is not visible to policy." : undefined;
}

function legacyPatternMatchesSegment(pattern, words) {
  const patternWords = shellWords(pattern);
  return arrayStartsWith(words, patternWords);
}

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

  while (pending.length > 0) {
    const { segment, depth } = pending.shift();
    const words = shellWords(segment);
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

    for (const finding of semanticCommandFindings(words)) {
      matches.push("forbid:semantic-shell-safety");
      reasons.push(finding);
    }

    for (const pattern of policy.blockedCommandPatterns ?? []) {
      if (!legacyPatternMatchesSegment(pattern, words)) continue;
      matches.push(`forbid:legacy:${pattern}`);
      reasons.push(`Blocked by legacy policy pattern: ${pattern}`);
    }

    segments.push({ command: segment, words, matches, warnings });
    if (depth < 4) {
      for (const nestedCommand of extractNestedCommands(segment, words)) {
        for (const nestedSegment of splitShellSegments(nestedCommand)) {
          pending.push({ segment: nestedSegment, depth: depth + 1 });
        }
      }
    }
  }

  const normalizedCommand = command.toLowerCase();
  for (const pattern of policy.requireConfirmationPatterns ?? []) {
    if (normalizedCommand.includes(String(pattern).toLowerCase())) {
      reasons.push(`Confirmation required by legacy policy pattern: ${pattern}`);
      break;
    }
  }

  const hasForbid = reasons.some((reason) => reason.startsWith("Forbidden") || reason.startsWith("Blocked") || reason.startsWith("Refusing"));
  const hasPrompt = reasons.some((reason) => reason.startsWith("Prompt") || reason.startsWith("Confirmation"));
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
  if (isAssignment(word)) return false;
  return isPathLike(word) || !word.startsWith("-");
}

function rememberLeadingShellAssignments(words, assignments) {
  const remember = (word) => {
    const match = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) assignments.set(match[1], expandKnownShellVariables(match[2], assignments));
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

function expandKnownShellVariables(value, assignments, resolving = new Set(), depth = 0) {
  if (depth >= 8) return String(value ?? "");
  return String(value ?? "").replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, plain) => {
    const name = braced ?? plain;
    const resolved = assignments.get(name);
    if (resolved === undefined || resolving.has(name)) return match;
    const nextResolving = new Set(resolving);
    nextResolving.add(name);
    return expandKnownShellVariables(resolved, assignments, nextResolving, depth + 1);
  });
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

function staticDataOutputCandidates(segment, assignments, producerCommand) {
  const tokens = shellDataTokens(segment);
  const commandIndex = tokens.findIndex((token) => commandBasename(token.value) === producerCommand);
  if (commandIndex < 0) return [];
  const args = tokens.slice(commandIndex + 1).map((token) => token.variableActive
    ? expandKnownShellVariables(token.value, assignments)
    : token.value);
  let output = "";
  if (producerCommand === "echo") {
    let argumentIndex = 0;
    let escapes = false;
    while (argumentIndex < args.length && /^-[eEn]+$/.test(args[argumentIndex])) {
      if (args[argumentIndex].slice(1).includes("e")) escapes = true;
      if (args[argumentIndex].slice(1).includes("E")) escapes = false;
      argumentIndex += 1;
    }
    output = args.slice(argumentIndex).join(" ");
    if (escapes) output = decodeShellDataEscapes(output);
  } else if (producerCommand === "printf" && args.length > 0) {
    output = renderStaticPrintf(args[0], args.slice(1));
  }
  return output.split(/\s+/).filter(Boolean);
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
    if (next === "&") {
      index += 1;
      continue;
    }

    if ((char === ">" && (next === ">" || next === "|")) || (char === "<" && next === ">")) index += 1;
    let cursor = index + 1;
    while (/\s/.test(segment[cursor] ?? "")) cursor += 1;
    if (!segment[cursor] || segment[cursor] === "&" || segment[cursor] === "-") continue;

    let target = "";
    let targetQuote;
    let targetEscaped = false;
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
      if ((targetChar === "'" || targetChar === '"') && !targetQuote) {
        targetQuote = targetChar;
        continue;
      }
      if (targetQuote === targetChar) {
        targetQuote = undefined;
        continue;
      }
      if (!targetQuote && (/\s/.test(targetChar) || /[;&|<>]/.test(targetChar))) break;
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
    if (!DATA_ONLY_COMMANDS.has(commandName) || depth > 0) {
      const argumentTokens = executableArgumentTokens(tokens, words, commandName);
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
        if (isFilesystemArgument(word)) addCandidate(word, argumentTokens[index].variableActive);
      }
    }
    if (depth < 4) {
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
    if (depth < 4) {
      for (const nestedCommand of extractNestedCommands(segment, words)) {
        for (const nestedSegment of splitShellSegments(nestedCommand)) pending.push({ segment: nestedSegment, depth: depth + 1 });
      }
    }
  }
  return [...new Set(candidates.map(normalizePathCandidate).filter(Boolean))];
}

export function findProtectedPathInCommand(command, protectedPatterns) {
  for (const candidate of extractShellPathCandidates(command)) {
    const pattern = matchesProtectedPath(candidate, protectedPatterns);
    if (pattern) return { candidate, pattern };
  }
  return undefined;
}

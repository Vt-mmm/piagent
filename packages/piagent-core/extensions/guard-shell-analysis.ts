import path from "node:path";

import type { ExternalActionPolicyConfig } from "./guard-types.ts";

// Classification of shell commands and external actions: what a command is
// about to reach, and whether that needs a human. This is the part of the guard
// that reasons about command text rather than about the filesystem, and it is
// pure — every function here takes what it needs and returns a decision, so a
// case can be argued about without a session, a project, or a policy file.
//
// The policy is passed in already resolved. These functions deliberately do not
// read a BasePolicy: taking the narrow config keeps the rules here independent
// of where the policy came from.

const MAX_SHELL_ARG_COUNT = 256;
const MAX_SHELL_ARG_CHARS = 16_384;
const MAX_SHELL_COMMAND_CHARS = 131_072;

export function normalizeActionToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function actionTextMatchesAny(text: string, tokens: string[]): boolean {
  const normalized = normalizeActionToken(text);
  if (!normalized) return false;
  return tokens.some((token) => {
    const normalizedToken = normalizeActionToken(token);
    return normalizedToken.length > 0
      && new RegExp(`(?:^|-)${normalizedToken}(?:-|$)`).test(normalized);
  });
}

export type ActionClassification = {
  decision: "safe-read" | "confirm";
  kind: "safe" | "write" | "ambiguous";
  action: string;
};

export function actionTokens(value: string): string[] {
  return normalizeActionToken(value).split("-").filter(Boolean);
}

export function classifyActionTokenSequence(tokens: string[], config: Required<ExternalActionPolicyConfig>): ActionClassification {
  const writeTokens = new Set(config.writeVerbs.map(normalizeActionToken));
  const safeTokens = new Set(config.safeVerbs.map(normalizeActionToken));
  const matches = tokens
    .map((token, index) => ({ token, index, write: writeTokens.has(token), safe: safeTokens.has(token) }))
    .filter((item) => item.write || item.safe);
  const first = matches[0];
  if (!first) return { decision: "confirm", kind: "ambiguous", action: "unknown" };
  if (first.write) return { decision: "confirm", kind: "write", action: first.token };

  // A safe prefix is not enough for compound/ambiguous names such as
  // get_update_file. Keep the small set of established read resources whose
  // noun also happens to be a configured write verb (for example get_release).
  const safeReadResourceCollisions = new Set(["release", "run"]);
  const laterWrite = matches.find((item) => item.index > first.index
    && item.write
    && !safeReadResourceCollisions.has(item.token));
  if (laterWrite) return { decision: "confirm", kind: "write", action: laterWrite.token };
  return { decision: "safe-read", kind: "safe", action: first.token };
}

export function classifyExplicitActionValues(values: string[], config: Required<ExternalActionPolicyConfig>): ActionClassification | undefined {
  if (values.length === 0) return undefined;
  const classifications = values.map((value) => classifyActionTokenSequence(actionTokens(value), config));
  return classifications.find((item) => item.kind === "write")
    ?? classifications.find((item) => item.kind === "ambiguous")
    ?? classifications[0];
}

export function classifyToolNameAction(toolName: string, provider: string, config: Required<ExternalActionPolicyConfig>): ActionClassification {
  let tokens = actionTokens(toolName);
  if (tokens[0] === "mcp") tokens = tokens.slice(1);
  const providerTokens = actionTokens(provider);
  const providerIndex = tokens.findIndex((token, index) => providerTokens.every((providerToken, offset) => tokens[index + offset] === providerToken));
  if (providerIndex >= 0) tokens = tokens.slice(providerIndex + providerTokens.length);

  return classifyActionTokenSequence(tokens, config);
}

const GH_COMMAND_GROUPS = new Set([
  "alias", "api", "auth", "cache", "codespace", "config", "extension", "gist", "gpg-key",
  "issue", "label", "org", "pr", "project", "release", "repo", "ruleset", "run", "secret",
  "ssh-key", "variable", "workflow"
]);
const GH_SAFE_ACTIONS = new Set([
  "browse", "checks", "completion", "diff", "fetch", "find", "get", "help", "inspect", "list",
  "read", "search", "show", "status", "version", "view"
]);

export function executableBasename(value: string): string {
  return path.posix.basename(value.replace(/\\/g, "/")).toLowerCase();
}

export function externalCommandName(value: string, names: Set<string>, aliases: Map<string, string>): string | undefined {
  const direct = executableBasename(value);
  if (names.has(direct)) return direct;
  const variable = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/);
  const alias = variable ? aliases.get(variable[1] ?? variable[2]) : undefined;
  return alias && names.has(alias) ? alias : undefined;
}

export function externalExecutableIndex(
  words: string[],
  names: Set<string>,
  aliases: Map<string, string>
): number | undefined {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;

  const controlPrefixes = new Set(["!", "{", "(", "then", "do", "elif", "else"]);
  const nonExecutingCommands = new Set([
    "cat", "echo", "egrep", "fgrep", "grep", "printf", "rg", "ripgrep", "test", "[", "true", "false"
  ]);
  while (index < words.length) {
    const command = executableBasename(words[index]);
    if (externalCommandName(words[index], names, aliases)) return index;
    if (controlPrefixes.has(command)) {
      index += 1;
      continue;
    }
    const ripgrepPreprocessor = ["rg", "ripgrep"].includes(command) && hasOption(words.slice(index + 1), ["--pre"]);
    if (nonExecutingCommands.has(command) && !ripgrepPreprocessor) return undefined;
    if (["command", "exec", "nohup", "time"].includes(command)) {
      index += 1;
      while (index < words.length && words[index].startsWith("-")) {
        const option = words[index];
        index += ["-a", "-f", "-o", "--format", "--output"].includes(option) ? 2 : 1;
      }
      continue;
    }
    if (command === "env") {
      index += 1;
      while (index < words.length) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
          index += 1;
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir"].includes(words[index])) {
          index += 2;
          continue;
        }
        if (words[index].startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (command === "sudo") {
      index += 1;
      while (index < words.length) {
        const option = words[index];
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir"].includes(option)) {
          index += 2;
          continue;
        }
        if (option.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (command === "nice") {
      index += 1;
      if (["-n", "--adjustment"].includes(words[index])) index += 2;
      else if (words[index]?.startsWith("--adjustment=") || /^-\d+$/.test(words[index] ?? "")) index += 1;
      continue;
    }
    if (command === "find") {
      const execIndex = words.findIndex((word, nestedIndex) => nestedIndex > index && ["-exec", "-execdir"].includes(word));
      if (execIndex < 0) return undefined;
      const nested = words.findIndex((word, nestedIndex) => nestedIndex > execIndex && externalCommandName(word, names, aliases));
      return nested >= 0 ? nested : undefined;
    }
    if (["xargs", "npx", "bunx"].includes(command) || (command === "pnpm" && words[index + 1] === "dlx")) {
      const nested = words.findIndex((word, nestedIndex) => nestedIndex > index && externalCommandName(word, names, aliases));
      return nested >= 0 ? nested : undefined;
    }
    // Unknown wrappers and shell constructs fail closed when they carry a
    // literal external executable later in the same semantic segment.
    const nested = words.findIndex((word, nestedIndex) => nestedIndex > index && externalCommandName(word, names, aliases));
    return nested >= 0 ? nested : undefined;
  }
  return undefined;
}

export function containsDynamicShellExpansion(value: string): boolean {
  return /(?:\$\(|`|\$\{|\$[A-Za-z0-9_@*#?$!-])/.test(value);
}

export function assignmentEndIndex(words: string[], startIndex: number): number {
  let commandSubstitutionDepth = 0;
  let parameterExpansionDepth = 0;
  let insideBackticks = false;
  for (let index = startIndex; index < words.length; index += 1) {
    const equalsIndex = index === startIndex ? words[index].indexOf("=") : -1;
    const value = equalsIndex >= 0 ? words[index].slice(equalsIndex + 1) : words[index];
    for (let charIndex = 0; charIndex < value.length; charIndex += 1) {
      const char = value[charIndex];
      const next = value[charIndex + 1];
      if (char === "`") {
        insideBackticks = !insideBackticks;
        continue;
      }
      if (insideBackticks) continue;
      if (char === "$" && next === "(") {
        commandSubstitutionDepth += 1;
        charIndex += 1;
        continue;
      }
      if (commandSubstitutionDepth > 0 && char === "(") commandSubstitutionDepth += 1;
      else if (commandSubstitutionDepth > 0 && char === ")") commandSubstitutionDepth -= 1;
      if (char === "$" && next === "{") {
        parameterExpansionDepth += 1;
        charIndex += 1;
        continue;
      }
      if (parameterExpansionDepth > 0 && char === "{") parameterExpansionDepth += 1;
      else if (parameterExpansionDepth > 0 && char === "}") parameterExpansionDepth -= 1;
    }
    if (commandSubstitutionDepth === 0 && parameterExpansionDepth === 0 && !insideBackticks) return index + 1;
  }
  return words.length;
}

export function dynamicExecutableIndex(
  words: string[],
  names: Set<string>,
  aliases: Map<string, string>
): number | undefined {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
    // shellWords intentionally exposes nested command text as separate words;
    // consume the balanced assignment value before looking for an executable.
    index = assignmentEndIndex(words, index);
  }

  const controlPrefixes = new Set(["!", "{", "(", "then", "do", "elif", "else"]);
  const nonExecutingCommands = new Set([
    "cat", "echo", "egrep", "fgrep", "grep", "printf", "rg", "ripgrep", "test", "[", "true", "false"
  ]);
  while (index < words.length) {
    const word = words[index];
    const command = executableBasename(word);
    if (externalCommandName(word, names, aliases)) return undefined;
    if (containsDynamicShellExpansion(word)) return index;
    if (controlPrefixes.has(command)) {
      index += 1;
      continue;
    }
    const ripgrepPreprocessor = ["rg", "ripgrep"].includes(command) && hasOption(words.slice(index + 1), ["--pre"]);
    if (nonExecutingCommands.has(command) && !ripgrepPreprocessor) return undefined;
    if (["command", "exec", "nohup", "time"].includes(command)) {
      index += 1;
      while (index < words.length && words[index].startsWith("-")) {
        const option = words[index];
        index += ["-a", "-f", "-o", "--format", "--output"].includes(option) ? 2 : 1;
      }
      continue;
    }
    if (command === "env") {
      index += 1;
      while (index < words.length) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
          index += 1;
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir"].includes(words[index])) {
          index += 2;
          continue;
        }
        if (words[index].startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (command === "sudo") {
      index += 1;
      while (index < words.length) {
        const option = words[index];
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt", "-C", "--close-from", "-D", "--chdir"].includes(option)) {
          index += 2;
          continue;
        }
        if (option.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (command === "nice") {
      index += 1;
      if (["-n", "--adjustment"].includes(words[index])) index += 2;
      else if (words[index]?.startsWith("--adjustment=") || /^-\d+$/.test(words[index] ?? "")) index += 1;
      continue;
    }
    if (command === "find") {
      const execIndex = words.findIndex((candidate, nestedIndex) => nestedIndex > index && ["-exec", "-execdir"].includes(candidate));
      if (execIndex < 0) return undefined;
      const nested = dynamicExecutableIndex(words.slice(execIndex + 1), names, aliases);
      return nested === undefined ? undefined : execIndex + 1 + nested;
    }
    if (["xargs", "npx", "bunx"].includes(command) || (command === "pnpm" && words[index + 1] === "dlx")) {
      let nestedIndex = index + (command === "pnpm" ? 2 : 1);
      const optionsWithValues = new Set([
        "-a", "--arg-file", "-d", "--delimiter", "-E", "--eof", "-I", "--replace", "-L", "--max-lines",
        "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "-p", "--package"
      ]);
      while (nestedIndex < words.length) {
        const option = words[nestedIndex];
        if (option === "--") {
          nestedIndex += 1;
          break;
        }
        if (optionsWithValues.has(option)) {
          nestedIndex += 2;
          continue;
        }
        if (option.startsWith("-")) {
          nestedIndex += 1;
          continue;
        }
        break;
      }
      const nested = dynamicExecutableIndex(words.slice(nestedIndex), names, aliases);
      return nested === undefined ? undefined : nestedIndex + nested;
    }
    return undefined;
  }
  return undefined;
}

export function inspectOptionValues(words: string[], shortName: string, longName: string): {
  found: boolean;
  missing: boolean;
  values: string[];
} {
  const result = { found: false, missing: false, values: [] as string[] };
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if ((shortName && word === shortName) || word === longName) {
      result.found = true;
      const value = words[index + 1];
      if (!value || value.startsWith("-")) result.missing = true;
      else {
        result.values.push(value);
        index += 1;
      }
      continue;
    }
    if (word.startsWith(`${longName}=`)) {
      result.found = true;
      const value = word.slice(longName.length + 1);
      if (value) result.values.push(value);
      else result.missing = true;
      continue;
    }
    if (shortName.length === 2 && word.startsWith(shortName) && word.length > shortName.length) {
      result.found = true;
      result.values.push(word.slice(shortName.length));
    }
  }
  return result;
}

export function hasOption(words: string[], names: string[]): boolean {
  return words.some((word) => names.some((name) => word === name || word.startsWith(`${name}=`)
    || (name.length === 2 && word.startsWith(name) && word.length > name.length)));
}

export function ghApiRequiresConfirmation(words: string[]): boolean {
  const methods = inspectOptionValues(words, "-X", "--method");
  if (methods.missing || methods.values.some((method) => !["GET", "HEAD"].includes(method.toUpperCase()))) return true;
  const carriesFields = hasOption(words, ["-f", "-F", "--field", "--raw-field", "--input"]);
  return carriesFields && !(methods.values.length > 0 && methods.values.every((method) => method.toUpperCase() === "GET"));
}

export function ghRequiresConfirmation(words: string[]): boolean {
  const args = words.slice(1);
  if (hasOption(args, ["-h", "--help", "--version"])) return false;
  const positionals: string[] = [];
  const optionsWithValues = new Set(["-R", "--repo", "--hostname"]);
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (optionsWithValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    positionals.push(normalizeActionToken(word));
    if (positionals.length >= 2) break;
  }
  const group = positionals[0] ?? "";
  if (group === "api") return ghApiRequiresConfirmation(args.slice(1));
  if (["search", "status", "browse", "completion", "help", "version"].includes(group)) return false;
  const action = GH_COMMAND_GROUPS.has(group) ? positionals[1] : group;
  return !action || !GH_SAFE_ACTIONS.has(action);
}

export function curlRequiresConfirmation(words: string[]): boolean {
  const args = words.slice(1);
  const methods = inspectOptionValues(args, "-X", "--request");
  if (methods.missing || methods.values.some((method) => !["GET", "HEAD"].includes(method.toUpperCase()))) return true;
  if (hasOption(args, ["-K", "--config", "-T", "--upload-file", "-F", "--form", "--form-string", "--json"])) return true;
  const quoteCommands = inspectOptionValues(args, "-Q", "--quote");
  if (quoteCommands.missing) return true;
  const safeQuoteCommands = /^(?:[+-])?(?:CWD|FEAT|HELP|NOOP|PWD|STAT|SYST)\b/i;
  if (quoteCommands.values.some((command) => !safeQuoteCommands.test(command.trim()))) return true;
  const carriesData = hasOption(args, ["-d", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode"]);
  const forceGet = hasOption(args, ["-G", "--get"]);
  return carriesData && !forceGet;
}

export function wgetRequiresConfirmation(words: string[]): boolean {
  const args = words.slice(1);
  const methods = inspectOptionValues(args, "", "--method");
  if (methods.missing || methods.values.some((method) => !["GET", "HEAD"].includes(method.toUpperCase()))) return true;
  return hasOption(args, ["-e", "--execute", "--config", "--post-data", "--post-file", "--body-data", "--body-file", "--upload-file"]);
}

export function findShellExternalConfirmationReason(
  segments: Array<{ command: string; words: string[] }>,
  externalActionPolicy: Required<ExternalActionPolicyConfig>
): string | undefined {
  if (externalActionPolicy.defaultMode !== "enforce") return undefined;
  const names = new Set(["gh", "curl", "wget"]);
  const aliases = new Map<string, string>();
  for (const segment of segments) {
    for (const word of segment.words) {
      const assignment = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (!assignment) continue;
      const executable = executableBasename(assignment[2]);
      if (names.has(executable)) aliases.set(assignment[1], executable);
    }
  }
  for (const segment of segments) {
    const dynamicIndex = dynamicExecutableIndex(segment.words, names, aliases);
    if (dynamicIndex !== undefined) {
      return `External command requires confirmation: dynamic executable in ${segment.command}`;
    }
    const index = externalExecutableIndex(segment.words, names, aliases);
    if (index === undefined) continue;
    const invocation = segment.words.slice(index);
    const command = externalCommandName(invocation[0], names, aliases);
    if (!command) continue;
    const requiresConfirmation = command === "gh"
      ? ghRequiresConfirmation(invocation)
      : command === "curl"
        ? curlRequiresConfirmation(invocation)
        : wgetRequiresConfirmation(invocation);
    if (requiresConfirmation) return `External command requires confirmation: ${command} in ${segment.command}`;
  }
  return undefined;
}

export function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function normalizeShellCommandForPolicy(command: string): string {
  const collapsed = command.replace(/\\(?:\r\n|\n)/g, "");
  let normalized = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < collapsed.length; index += 1) {
    const char = collapsed[index];
    if (escaped) {
      normalized += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      normalized += char;
      escaped = true;
      continue;
    }
    if ((char === "'" || char === '"') && !quote) {
      quote = char;
      normalized += char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      normalized += char;
      continue;
    }
    const previous = collapsed[index - 1];
    const beginsShellWord = index === 0 || /\s/.test(previous) || /[;&|(){}]/.test(previous);
    if (!quote && char === "#" && beginsShellWord) {
      while (index < collapsed.length && collapsed[index] !== "\n") index += 1;
      if (collapsed[index] === "\n") normalized += "\n";
      continue;
    }
    normalized += char;
  }
  return normalized;
}

export function extractShellCommandInput(input: Record<string, unknown>): { command?: string; reason?: string } {
  const hasCommand = Object.hasOwn(input, "command");
  const hasCmd = Object.hasOwn(input, "cmd");
  const hasArgs = Object.hasOwn(input, "args");
  if (hasCommand && typeof input.command !== "string") {
    return { reason: "command must be a string" };
  }
  if (hasCmd && typeof input.cmd !== "string") {
    return { reason: "cmd must be a string" };
  }

  const command = hasCommand ? input.command as string : undefined;
  const cmd = hasCmd ? input.cmd as string : undefined;
  if (command !== undefined && cmd !== undefined && command !== cmd) {
    return { reason: "conflicting command and cmd values" };
  }

  let args: string[] = [];
  if (hasArgs) {
    if (!Array.isArray(input.args) || !input.args.every((arg) => typeof arg === "string")) {
      return { reason: "args must be an array of strings" };
    }
    if (input.args.length > MAX_SHELL_ARG_COUNT) {
      return { reason: `too many args: ${input.args.length} > ${MAX_SHELL_ARG_COUNT}` };
    }
    if (input.args.some((arg) => arg.length > MAX_SHELL_ARG_CHARS)) {
      return { reason: `shell arg exceeds ${MAX_SHELL_ARG_CHARS} characters` };
    }
    args = input.args;
  }

  const baseCommand = command ?? cmd;
  if (baseCommand !== undefined && (!baseCommand.trim() || baseCommand.length > MAX_SHELL_COMMAND_CHARS)) {
    return { reason: `shell command must contain 1-${MAX_SHELL_COMMAND_CHARS} characters` };
  }
  if (baseCommand === undefined && args.length === 0) {
    return { reason: "shell command input is missing or unsupported" };
  }

  const combined = [baseCommand?.trim(), ...args.map(quoteShellArgument)].filter((item): item is string => Boolean(item)).join(" ");
  if (combined.length > MAX_SHELL_COMMAND_CHARS) {
    return { reason: `combined shell command exceeds ${MAX_SHELL_COMMAND_CHARS} characters` };
  }
  return { command: combined };
}

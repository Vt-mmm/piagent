import {
  extractAttachedRedirectionPaths,
  normalizePathCandidate,
  redirectionTargetWords,
  shellWords,
  splitShellSegments
} from "./policy-core.js";

const MANY_TARGET_COMMANDS = new Set(["mkdir", "prename", "rename", "rm", "rmdir", "tee", "touch", "truncate"]);
const SOURCE_DESTINATION_COMMANDS = new Set(["cp", "install", "ln", "mv"]);
const SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh"]);
const FIND_FILE_OUTPUT_ACTIONS = new Set(["-fprint", "-fprint0", "-fprintf", "-fls"]);

function commandName(value) {
  return String(value ?? "").split("/").at(-1)?.toLowerCase() ?? "";
}

function expandAssignments(value, assignments) {
  return String(value ?? "").replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, plain) => (
    assignments.get(braced ?? plain) ?? match
  ));
}

function executableWords(words) {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  while (["command", "env", "nohup", "sudo", "time"].includes(commandName(words[index]))) {
    index += 1;
    while (index < words.length && words[index].startsWith("-")) index += 1;
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  }
  return words.slice(index);
}

function redirectionTargets(words) {
  const targets = [];
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index];
    const match = token.match(/^\d*(>>?|>\|)(.*)$/);
    if (!match || /^\d+$/.test(match[2])) continue;
    const target = match[2] || words[index + 1];
    if (target && !/^&?\d+$/.test(target)) targets.push(target);
  }
  return targets;
}

export function shellHasFileWriteRedirection(command) {
  return splitShellSegments(String(command ?? "")).some((segment) => (
    extractAttachedRedirectionPaths(segment)
      .filter((redirect) => redirect.writesFile)
      .flatMap(redirectionTargetWords)
      .length > 0
  ));
}

/** Return only statically visible write destinations; unknown values remain
 * literal candidates so the task-scope guard rejects them fail closed. */
export function extractShellWritePathCandidates(command) {
  const candidates = [];
  const assignments = new Map();
  const pending = splitShellSegments(String(command ?? "")).map((segment) => ({ segment, depth: 0 }));
  const add = (value) => {
    const normalized = normalizePathCandidate(expandAssignments(value, assignments));
    if (normalized) candidates.push(normalized);
  };
  for (const line of String(command ?? "").split(/\r?\n/)) {
    const marker = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/)
      ?? line.match(/^\*\*\* Move to:\s*(.+?)\s*$/);
    if (marker?.[1]) add(marker[1]);
  }
  while (pending.length > 0) {
    const { segment, depth } = pending.shift();
    const words = shellWords(segment);
    for (const word of words) {
      const assignment = word.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (assignment) assignments.set(assignment[1], expandAssignments(assignment[2], assignments));
    }
    for (const target of redirectionTargets(words)) add(target);
    const executable = executableWords(words);
    const name = commandName(executable[0]);
    const operands = executable.slice(1).filter((word) => word && !word.startsWith("-") && !/^[<>]/.test(word));
    if (MANY_TARGET_COMMANDS.has(name)) for (const operand of operands) add(operand);
    // These commands can derive a destination from a source basename, target a
    // directory selected by -t/--target-directory, and (for mv) remove the
    // source. Returning every visible operand is intentionally conservative:
    // an exact-path repair grant must reject any ungranted source/directory
    // before the command can change the tree.
    else if (SOURCE_DESTINATION_COMMANDS.has(name)) {
      for (const operand of operands) add(operand);
      for (const word of executable.slice(1)) {
        const attachedTarget = word.match(/^--target-directory=(.+)$/)?.[1]
          ?? (word !== "-T" ? word.match(/^-t(.+)$/)?.[1] : undefined);
        if (attachedTarget) add(attachedTarget);
      }
    }
    else if (["chmod", "chown"].includes(name)) for (const operand of operands.slice(1)) add(operand);
    else if (name === "sed" && executable.some((word) => /^-[^-]*i/.test(word) || word === "--in-place" || word.startsWith("--in-place="))) {
      for (const operand of operands.slice(1)) add(operand);
    } else if (name === "dd") {
      for (const word of executable.slice(1)) if (word.startsWith("of=")) add(word.slice(3));
    } else if (name === "find") {
      for (let index = 1; index < executable.length - 1; index += 1) {
        if (FIND_FILE_OUTPUT_ACTIONS.has(executable[index])) add(executable[index + 1]);
      }
    }
    if (depth < 16 && SHELL_INTERPRETERS.has(name)) {
      const commandIndex = executable.findIndex((word) => word === "-c" || word === "-lc");
      if (commandIndex >= 0 && executable[commandIndex + 1]) {
        for (const nested of splitShellSegments(executable[commandIndex + 1])) pending.push({ segment: nested, depth: depth + 1 });
      }
    }
  }
  return [...new Set(candidates)];
}

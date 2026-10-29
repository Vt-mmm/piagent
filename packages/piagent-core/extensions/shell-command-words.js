// How a simple command's words name what runs, shared by policy-core.js and
// the handoff policy (runtime/policy/handoff-policy.mjs).

// Shell words that open a compound statement: the command follows them.
// `if true; then rm -rf /; fi` splits into `then rm -rf /`, which runs rm.
export const CONTROL_PREFIXES = new Set(["!", "{", "(", "if", "then", "do", "elif", "else", "while", "until"]);

// Git's global options come before the subcommand: `git -C api push` and
// `git -c core.hooksPath=x --no-pager push` push as `git push` does. Without
// this a rule written as "git push" matched only the plain spelling.
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--list-cmds"]);
export function gitSubcommandWords(words) {
  if (String(words[0] ?? "").split("/").pop() !== "git") return words;
  let index = 1;
  while (index < words.length && words[index].startsWith("-")) {
    index += GIT_OPTIONS_WITH_VALUE.has(words[index]) ? 2 : 1;
  }
  return ["git", ...words.slice(index)];
}

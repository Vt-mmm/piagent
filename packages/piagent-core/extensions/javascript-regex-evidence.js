function lexicalTail(chunks, limit) {
  let tail = "";
  for (let index = chunks.length - 1; index >= 0 && tail.length < limit; index -= 1) {
    const chunk = String(chunks[index] ?? "");
    tail = chunk.slice(-(limit - tail.length)) + tail;
  }
  return tail;
}

/**
 * Classify a slash from already-sanitized lexical output. When a control
 * parenthesis opener lies outside the bounded tail, ambiguity erases evidence
 * instead of exposing a regex payload as executable source.
 */
export function regexCanStartAfterLexicalChunks(chunks, limit = 4_096) {
  const prefix = lexicalTail(chunks, limit).replace(/\s+$/u, "");
  if (!prefix) return true;
  const previous = prefix.at(-1);
  if (/[([{,:;=!?&|+*%^~<>-]/u.test(previous)) return true;
  if (previous === "}") return true;
  if (previous === ")") {
    let depth = 0;
    for (let index = prefix.length - 1; index >= 0; index -= 1) {
      if (prefix[index] === ")") depth += 1;
      else if (prefix[index] === "(" && --depth === 0) {
        return /\b(?:catch|for|if|while|with)\s*$/u.test(prefix.slice(0, index));
      }
    }
    return true;
  }
  return /\b(?:await|case|delete|do|else|in|instanceof|new|of|return|throw|typeof|void|yield)$/u.test(prefix);
}

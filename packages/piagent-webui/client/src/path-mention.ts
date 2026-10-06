// An @ mention being typed in a composer, and what picking a suggestion
// writes, as in Pi's terminal: @path, or @"path with spaces". The @ starts a
// word, so an email address never opens the menu.
export type Mention = { start: number; end: number; query: string; quoted: boolean };

export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const quoted = /(^|[\s(])@"([^"\n]*)$/.exec(before);
  if (quoted) {
    const start = quoted.index + quoted[1].length;
    return { start, end: text[caret] === "\"" ? caret + 1 : caret, query: quoted[2], quoted: true };
  }
  const plain = /(^|[\s(])@([^\s"]*)$/.exec(before);
  if (!plain) return null;
  const start = plain.index + plain[1].length;
  return { start, end: caret + (/^[^\s"]*/.exec(text.slice(caret))?.[0].length ?? 0), query: plain[2], quoted: false };
}

// A file ends the mention with a space; a folder stays open for the next
// name, with the caret inside its quotes when it has them.
export function applyMention(text: string, mention: Mention, suggestion: { value: string; kind: "file" | "directory" }): { text: string; caret: number } {
  const quoted = mention.quoted || /\s/.test(suggestion.value);
  const token = quoted ? `@"${suggestion.value}"` : `@${suggestion.value}`;
  const folder = suggestion.kind === "directory", after = text.slice(mention.end);
  const space = folder || /^\s/.test(after) ? "" : " ";
  return { text: text.slice(0, mention.start) + token + space + after,
    caret: mention.start + token.length + space.length - (folder && quoted ? 1 : 0) };
}

// A command being typed: a / that starts the message, up to the first space,
// as Pi reads /name and /skill:name.
export function commandAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  if (!/^\/[^\s/]*$/.test(before)) return null;
  return { start: 0, end: caret + (/^[^\s]*/.exec(text.slice(caret))?.[0].length ?? 0), query: before.slice(1), quoted: false };
}

export function applyCommand(text: string, mention: Mention, command: { kind: "command" | "skill"; name: string }): { text: string; caret: number } {
  const token = command.kind === "skill" ? `/skill:${command.name}` : `/${command.name}`, after = text.slice(mention.end);
  const space = /^\s/.test(after) ? "" : " ";
  return { text: token + space + after, caret: token.length + 1 };
}

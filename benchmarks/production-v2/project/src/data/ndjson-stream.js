export function parseNdjsonChunks(chunks) {
  return chunks.flatMap((chunk) => Buffer.from(chunk).toString("utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

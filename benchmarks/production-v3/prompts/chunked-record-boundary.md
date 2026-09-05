Replace the naive implementation in `src/data/ndjson-stream.js` while
preserving `parseNdjsonChunks(chunks)`.

Each input chunk must be a `Uint8Array`; reject any non-`Uint8Array` chunk with
`TypeError`.
Decode UTF-8 incrementally so a multi-byte character may cross any chunk
boundary. Parse non-empty NDJSON
records separated by LF or CRLF, including a final record without a newline,
and preserve record order. Empty physical lines are ignored. Invalid UTF-8 or
invalid JSON must throw. Do not mutate the chunk array or its buffers and do
not add dependencies. Run the configured verification.

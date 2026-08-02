Replace the naive parser in `src/data/csv.js` with a dependency-free CSV parser.

Support comma-separated fields, quoted commas, escaped double quotes (`""`),
CRLF or LF records, empty fields, and a final record without a newline. Newlines
inside quoted fields must be preserved. Throw `SyntaxError` for an unterminated
quoted field. Preserve `parseCsv(input)` and run the configured verification.

Fix configuration resolution in `src/platform/config.js`.

For each key, precedence is CLI, environment, file, then defaults. A value is
absent only when it is `undefined`; valid values such as `false`, `0`, an empty
string, and `null` must not fall through. Do not mutate any input object and
preserve `resolveConfig`. Run the configured verification.

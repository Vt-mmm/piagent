Repair the v1-to-v2 settings migration in `src/data/migration.js`.

Preserve intentional falsey values (`false`, `0`, and an empty string). Defaults
are `enabled: true`, `retryLimit: 3`, and `label: "default"` only when the
corresponding v1 field is nullish. A v2 input must be returned as an independent
copy. Do not mutate input or change the API. Verify the project.

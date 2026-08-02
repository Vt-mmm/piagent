Repair `parseArgs(argv)` in `src/platform/args.js`.

Support `--name value`, `--name=value`, and boolean `--flag`. The first standalone
`--` ends flag parsing and every later token is positional even if it starts
with dashes. A flag followed by another flag is boolean true. Repeated flags
use the last value. Do not mutate argv or change the return shape. Verify the
project.

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--")) flags[value.slice(2)] = argv[++index] ?? true;
    else positional.push(value);
  }
  return { flags, positional };
}

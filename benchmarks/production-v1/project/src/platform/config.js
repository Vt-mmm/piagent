export function resolveConfig(cli = {}, environment = {}, file = {}, defaults = {}) {
  return {
    port: cli.port || environment.port || file.port || defaults.port,
    debug: cli.debug || environment.debug || file.debug || defaults.debug,
    label: cli.label || environment.label || file.label || defaults.label
  };
}

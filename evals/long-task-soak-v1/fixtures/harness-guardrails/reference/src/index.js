import { loadConfig, ConfigError } from './config.js';
import { createServer } from './server.js';

let config;
try {
  config = loadConfig();
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  for (const problem of error.problems) console.error(`config: ${problem}`);
  process.exit(1);
}
createServer(config).listen(config.port, () => {
  if (config.logLevel === 'debug') console.log(`kho-api listening on ${config.port}`);
});

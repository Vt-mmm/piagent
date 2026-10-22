import { createServer } from './server.js';

const port = Number(process.env.PORT || 8080);
createServer().listen(port, () => {
  if ((process.env.LOG_LEVEL || 'info') === 'debug') console.log(`kho-api listening on ${port}`);
});

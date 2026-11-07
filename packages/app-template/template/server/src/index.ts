/**
 * @file server/src/index.ts
 * @description
 *   Bootstrap: load config fail-fast, start listening. All wiring lives in
 *   app.ts (tested); this file is the process shell.
 */
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const app = createApp({ config });

const server = createServer(app);
server.listen(config.port, () => {
  console.log(`{{APP_SLUG}} server listening on :${config.port} (${config.nodeEnv})`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
// PLACEHOLDER (F00) — delete in the next feature
// Entry of dist/server.js: `node server.js [--port n]`.

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PRODUCT_NAME } from '../shared/product.ts';
import { startServer } from './server.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '0' } } });
const server = await startServer({
  port: Number(values.port),
  webRoot: fileURLToPath(new URL('./web/', import.meta.url)),
});
console.log(`${PRODUCT_NAME} placeholder running at ${server.url}`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

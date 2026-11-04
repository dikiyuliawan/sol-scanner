import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from './lib/handler.mjs';
import { createDb } from './db.mjs';

export { DEX_DOCS, validMint, number, normalizeMarket, fetchMarket, createMarketProvider, applyDeepResult } from './lib/handler.mjs';
export { createHandler };

/**
 * Router lokal (npm start). Handler yang sama dipakai oleh Vercel
 * (api/index.js), jadi perilaku lokal dan produksi identik.
 */
export function createServer(options = {}) {
  return http.createServer(createHandler(options));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const db = await createDb();
  const server = createServer({ db });
  server.listen(port, '127.0.0.1', () => console.log(`Solana scanner read-only: http://127.0.0.1:${port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

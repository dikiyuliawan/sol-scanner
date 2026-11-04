import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHandler } from './lib/handler.mjs';
import { createDb } from './db.mjs';

export { DEX_DOCS, validMint, number, normalizeMarket, fetchMarket, createMarketProvider, applyDeepResult } from './lib/handler.mjs';
export { createHandler };

/**
 * Router lokal (npm start) dan fungsi serverless Vercel memakai handler yang
 * sama persis. Vercel mendeteksi berkas root `server.mjs` sebagai fungsi
 * (pola "server file"), jadi `export default` di bawah ini wajib ada — tanpanya
 * cold start mati dengan FUNCTION_INVOCATION_FAILED.
 */
export function createServer(options = {}) {
  return http.createServer(createHandler(options));
}

/** Default export = handler Vercel. DB dibuat sekali per cold start. */
let vercelHandler = null;
export default async function handler(req, res) {
  if (!vercelHandler) vercelHandler = createHandler({ db: await createDb() });
  return vercelHandler(req, res);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer({ db: await createDb() });
  server.listen(port, '127.0.0.1', () => console.log(`Solana scanner read-only: http://127.0.0.1:${port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

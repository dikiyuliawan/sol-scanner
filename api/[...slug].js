import { createDb } from '../db.mjs';
import { createHandler } from '../lib/handler.mjs';

/**
 * Satu-satunya fungsi serverless: router yang sama dipakai oleh `npm start`.
 * Handler dibuat sekali per cold start; cache dan limiter bertahan hanya
 * selama instance hangat — itu perilaku yang jujur untuk serverless.
 */
const db = await createDb();
const handler = createHandler({ db });
export default handler;

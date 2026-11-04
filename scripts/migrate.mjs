#!/usr/bin/env node
/**
 * Terapkan skema ke Turso (satu kali, dari mesin Anda):
 *   TURSO_DATABASE_URL=libsql://....turso.io TURSO_AUTH_TOKEN=... node scripts/migrate.mjs
 *
 * Tidak menghapus atau memindahkan data apa pun; CREATE TABLE IF NOT EXISTS.
 */
import { createClient } from '@libsql/client';
import { SCHEMA_STATEMENTS } from '../db.mjs';

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !url.startsWith('libsql://')) {
  console.error('TURSO_DATABASE_URL harus diset (libsql://…).');
  process.exit(1);
}
if (!authToken) {
  console.error('TURSO_AUTH_TOKEN harus diset.');
  process.exit(1);
}

const client = createClient({ url, authToken });
for (const statement of SCHEMA_STATEMENTS) await client.execute(statement);
console.log('Skema Turso diterapkan:', SCHEMA_STATEMENTS.length, 'statement.');

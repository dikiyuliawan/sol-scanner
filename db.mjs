import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Lapisan penyimpanan ganda:
 *   - Turso / libSQL (produksi Vercel): dipakai bila TURSO_DATABASE_URL +
 *     TURSO_AUTH_TOKEN diset, atau file secara eksplisit diawali 'turso:'.
 *   - node:sqlite bawaan Node (lokal, :memory: untuk tes): fallback tanpa
 *     konfigurasi apa pun.
 *
 * Kedua backend mengekspos fasad yang sama (semua metode async), termasuk
 * antrean job deep scan yang tersimpan di tabel `jobs`.
 */

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

let createClient = null;
try {
  ({ createClient } = await import('@libsql/client'));
} catch {
  createClient = null;
}

export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS tokens (
    mint TEXT PRIMARY KEY,
    symbol TEXT,
    name TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    tags_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    taken_at TEXT NOT NULL,
    price REAL,
    liquidity_usd REAL,
    market_cap REAL,
    fdv REAL,
    volume_24h REAL,
    score INTEGER,
    grade TEXT,
    json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_snapshots_mint ON snapshots(mint, taken_at DESC)',
  `CREATE TABLE IF NOT EXISTS discover_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    preset TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    candidates INTEGER,
    accepted INTEGER,
    rejected INTEGER,
    json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS watchlist (
    mint TEXT PRIMARY KEY,
    added_at TEXT NOT NULL,
    note TEXT,
    snapshot_json TEXT,
    status TEXT NOT NULL DEFAULT 'watching'
  )`,
  `CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    entry_low REAL,
    entry_high REAL,
    invalidation REAL,
    targets_json TEXT,
    rr REAL,
    status TEXT NOT NULL,
    setup TEXT,
    json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_plans_mint ON plans(mint, created_at DESC)',
  // Antrean deep scan yang diproses per permintaan /api/jobs/:id (satu token
  // per panggilan), supaya fungsi serverless tidak perlu berjalan >60 detik.
  `CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    mint TEXT NOT NULL,
    snapshot_id INTEGER,
    context_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    result_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_jobs_job ON jobs(job_id, position)',
  // Meta satu run deep scan (dipakai oleh poll /api/jobs/:id untuk mengembalikan
  // cache discover yang tepat dan nilai refresh).
  `CREATE TABLE IF NOT EXISTS job_meta (
    job_id TEXT PRIMARY KEY,
    preset TEXT NOT NULL,
    cache_key TEXT,
    refresh INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`
];

export const SCHEMA = SCHEMA_STATEMENTS.join(';\n') + ';\n';

// Retensi berbasis jumlah baris: tabel dibatasi agar tidak tumbuh tanpa
// batas, tetapi data historis tidak dihapus begitu saja berdasarkan usia —
// forward-test justru membutuhkan snapshot lama.
const RETENTION = { snapshots: 5_000, plans: 2_000, runs: 500 };

function unavailable(reason) {
  return { available: false, reason, close() {} };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------- Backend: node:sqlite (lokal / tes) ---------- */

function openSqlite(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  for (const statement of SCHEMA_STATEMENTS) db.exec(statement);
  db.prepare('DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)').run(RETENTION.snapshots);
  db.prepare('DELETE FROM plans WHERE id NOT IN (SELECT id FROM plans ORDER BY id DESC LIMIT ?)').run(RETENTION.plans);
  db.prepare('DELETE FROM discover_runs WHERE id NOT IN (SELECT id FROM discover_runs ORDER BY id DESC LIMIT ?)').run(RETENTION.runs);

  const stmt = sql => db.prepare(sql);
  return {
    close() { try { db.close(); } catch { /* sudah tertutup */ } },
    async recordDiscoverRun({ startedAt, preset, configHash, candidates, accepted, rejected, payload }) {
      const result = stmt('INSERT INTO discover_runs (started_at, preset, config_hash, candidates, accepted, rejected, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(startedAt, preset, configHash, candidates, accepted, rejected, JSON.stringify(payload ?? {}));
      return Number(result.lastInsertRowid);
    },
    async persistSnapshots({ at, rows }) {
      db.exec('BEGIN');
      try {
        const ids = new Map();
        for (const row of rows) {
          stmt(`INSERT INTO tokens (mint, symbol, name, first_seen, last_seen, tags_json) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, last_seen = excluded.last_seen, tags_json = excluded.tags_json`)
            .run(row.mint, row.symbol ?? null, row.name ?? null, at, at, JSON.stringify(row.tags ?? []));
          const result = stmt('INSERT INTO snapshots (mint, taken_at, price, liquidity_usd, market_cap, fdv, volume_24h, score, grade, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(row.mint, at, row.price ?? null, row.liquidityUsd ?? null, row.marketCap ?? null, row.fdv ?? null, row.volume24h ?? null, row.score ?? null, row.grade ?? null, JSON.stringify(row.payload ?? {}));
          ids.set(row.mint, Number(result.lastInsertRowid));
        }
        db.exec('COMMIT');
        return ids;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* transaksi sudah berakhir */ }
        throw error;
      }
    },
    async updateSnapshotScore(id, { score, grade, payload }) {
      if (id === null || id === undefined) return false;
      const row = stmt('SELECT json FROM snapshots WHERE id = ?').get(id);
      if (!row) return false;
      const existing = safeParse(row.json) ?? {};
      const merged = { ...existing, ...(payload ?? {}), scoreStage: payload?.scoreStage ?? existing.scoreStage ?? 'deep' };
      stmt('UPDATE snapshots SET score = ?, grade = ?, json = ? WHERE id = ?')
        .run(score ?? null, grade ?? null, JSON.stringify(merged), id);
      return true;
    },
    async upsertToken({ mint, symbol, name, tags, at }) {
      stmt(`INSERT INTO tokens (mint, symbol, name, first_seen, last_seen, tags_json) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, last_seen = excluded.last_seen, tags_json = excluded.tags_json`)
        .run(mint, symbol ?? null, name ?? null, at, at, JSON.stringify(tags ?? []));
    },
    async addWatch({ mint, note, snapshot, at }) {
      stmt(`INSERT INTO watchlist (mint, added_at, note, snapshot_json, status) VALUES (?, ?, ?, ?, 'watching')
            ON CONFLICT(mint) DO UPDATE SET note = excluded.note, snapshot_json = excluded.snapshot_json`)
        .run(mint, at, note ?? null, JSON.stringify(snapshot ?? {}));
    },
    async removeWatch(mint) {
      return Number(stmt('DELETE FROM watchlist WHERE mint = ?').run(mint).changes);
    },
    async listWatch() {
      return stmt('SELECT mint, added_at, note, snapshot_json, status FROM watchlist ORDER BY added_at DESC').all()
        .map(row => ({ mint: row.mint, addedAt: row.added_at, note: row.note, snapshot: safeParse(row.snapshot_json), status: row.status }));
    },
    async recordPlan({ mint, createdAt, plan }) {
      stmt('INSERT INTO plans (mint, created_at, entry_low, entry_high, invalidation, targets_json, rr, status, setup, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(mint, createdAt, plan.entryLow ?? null, plan.entryHigh ?? null, plan.invalidation ?? null, JSON.stringify(plan.targets ?? []), plan.riskReward ?? null, plan.status ?? 'no_plan', plan.setup ?? null, JSON.stringify(plan));
    },
    async latestPlan(mint) {
      const row = stmt('SELECT json FROM plans WHERE mint = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(mint);
      return row ? safeParse(row.json) : null;
    },
    async recentRuns(limit = 10) {
      return stmt('SELECT id, started_at, preset, config_hash, candidates, accepted, rejected FROM discover_runs ORDER BY id DESC LIMIT ?').all(limit)
        .map(row => ({ id: row.id, startedAt: row.started_at, preset: row.preset, configHash: row.config_hash, candidates: row.candidates, accepted: row.accepted, rejected: row.rejected }));
    },
    async snapshotHistory(mint, limit = 50) {
      return stmt('SELECT taken_at, price, liquidity_usd, market_cap, volume_24h, score, grade, json FROM snapshots WHERE mint = ? ORDER BY id DESC LIMIT ?').all(mint, limit)
        .map(row => {
          const payload = safeParse(row.json) ?? {};
          return { takenAt: row.taken_at, price: row.price, liquidityUsd: row.liquidity_usd, marketCap: row.market_cap, volume24h: row.volume_24h, score: row.score, grade: row.grade, scoreStage: payload.scoreStage ?? 'initial' };
        });
    },
    async allSnapshots() {
      return stmt('SELECT mint, taken_at, price, liquidity_usd, market_cap, fdv, volume_24h, score, grade, json FROM snapshots ORDER BY mint, taken_at').all()
        .map(row => {
          const payload = safeParse(row.json) ?? {};
          return { mint: row.mint, takenAt: row.taken_at, price: row.price, liquidityUsd: row.liquidity_usd, marketCap: row.market_cap, fdv: row.fdv, volume24h: row.volume_24h, score: row.score, grade: row.grade, scoreStage: payload.scoreStage ?? 'initial' };
        });
    },
    async createJobItems(jobId, items) {
      const at = nowIso();
      for (const [position, item] of items.entries()) {
        stmt('INSERT INTO jobs (job_id, position, mint, snapshot_id, context_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(jobId, position, item.mint, item.snapshotId ?? null, item.context ? JSON.stringify(item.context) : null, 'pending', at);
      }
    },
    async setJobMeta(jobId, { preset, cacheKey, refresh }) {
      stmt('INSERT INTO job_meta (job_id, preset, cache_key, refresh, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET preset = excluded.preset, cache_key = excluded.cache_key, refresh = excluded.refresh')
        .run(jobId, preset, cacheKey ?? null, refresh ? 1 : 0, nowIso());
    },
    async jobMeta(jobId) {
      const row = stmt('SELECT preset, cache_key, refresh, created_at FROM job_meta WHERE job_id = ?').get(jobId);
      return row ? { preset: row.preset, cacheKey: row.cache_key ?? null, refresh: row.refresh === 1, createdAt: row.created_at } : null;
    },
    async claimJobItem(jobId) {
      // Satu token per panggilan; UPDATE ... RETURNING menjamin hanya satu
      // peminta yang dapat mengerjakan token yang sama.
      const row = stmt(`UPDATE jobs SET status = 'processing', updated_at = ?
                        WHERE id = (SELECT id FROM jobs WHERE job_id = ? AND status = 'pending' ORDER BY position LIMIT 1)
                        RETURNING id, position, mint, snapshot_id, context_json`).get(nowIso(), jobId);
      return row ? { id: Number(row.id), position: row.position, mint: row.mint, snapshotId: row.snapshot_id ?? null, context: safeParse(row.context_json) } : null;
    },
    async completeJobItem(id, { ok, result, error }) {
      const r = stmt('UPDATE jobs SET status = ?, error = ?, result_json = ?, updated_at = ? WHERE id = ?')
        .run(ok ? 'done' : 'failed', ok ? null : String(error ?? 'unknown'), ok && result ? JSON.stringify({ ok: true, mint: result.mint, result }) : null, nowIso(), id);
      return Number(r.changes ?? 0);
    },
    async failJobItem(id, error) {
      stmt('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run('failed', String(error ?? 'unknown'), nowIso());
    },
    async reapStaleJobItems(jobId, olderThanMs = 90_000) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      return Number(stmt(`UPDATE jobs SET status = 'failed', error = 'kadaluarsa' WHERE job_id = ? AND status = 'processing' AND updated_at < ?`).run(jobId, cutoff).changes);
    },
    async cancelJob(jobId) {
      return Number(stmt(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'pending'`).run(nowIso(), jobId).changes);
    },
    async jobSummary(jobId) {
      const counts = stmt(`SELECT
                             COUNT(*) AS total,
                             SUM(CASE WHEN status IN ('done', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS settled,
                             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
                           FROM jobs WHERE job_id = ?`).get(jobId);
      const total = Number(counts?.total ?? 0);
      if (total === 0) return null;
      const settled = Number(counts?.settled ?? 0);
      const failures = Number(counts?.failures ?? 0);
      const rows = stmt('SELECT mint, status, error, result_json FROM jobs WHERE job_id = ? ORDER BY position').all(jobId);
      const results = [];
      for (const row of rows) {
        if (row.status === 'done' && row.result_json) results.push(safeParse(row.result_json));
        else if (row.status === 'failed') results.push({ ok: false, mint: row.mint, reason: row.error ?? 'deep scan gagal' });
      }
      return { total, completed: settled, failures, status: settled >= total ? 'done' : (settled > 0 ? 'running' : 'queued'), results };
    }
  };
}

/* ---------- Backend: Turso / libSQL (produksi Vercel) ---------- */

async function openTurso({ url, authToken }) {
  const client = createClient({ url, authToken });
  for (const statement of SCHEMA_STATEMENTS) await client.execute(statement);
  const batchStmts = [
    ['DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT ?)', RETENTION.snapshots],
    ['DELETE FROM plans WHERE id NOT IN (SELECT id FROM plans ORDER BY id DESC LIMIT ?)', RETENTION.plans],
    ['DELETE FROM discover_runs WHERE id NOT IN (SELECT id FROM discover_runs ORDER BY id DESC LIMIT ?)', RETENTION.runs]
  ];
  for (const [sql, value] of batchStmts) await client.execute({ sql, args: [value] });

  const rowsOf = result => result.rows.map(row => ({ ...row }));
  return {
    close() { try { client.close(); } catch { /* sudah tertutup */ } },
    async recordDiscoverRun({ startedAt, preset, configHash, candidates, accepted, rejected, payload }) {
      const result = await client.execute({ sql: 'INSERT INTO discover_runs (started_at, preset, config_hash, candidates, accepted, rejected, json) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [startedAt, preset, configHash, candidates, accepted, rejected, JSON.stringify(payload ?? {})] });
      return Number(result.lastInsertRowid);
    },
    async persistSnapshots({ at, rows }) {
      const statements = [];
      for (const row of rows) {
        statements.push({ sql: `INSERT INTO tokens (mint, symbol, name, first_seen, last_seen, tags_json) VALUES (?, ?, ?, ?, ?, ?)
                               ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, last_seen = excluded.last_seen, tags_json = excluded.tags_json`,
          args: [row.mint, row.symbol ?? null, row.name ?? null, at, at, JSON.stringify(row.tags ?? [])] });
        statements.push({ sql: 'INSERT INTO snapshots (mint, taken_at, price, liquidity_usd, market_cap, fdv, volume_24h, score, grade, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          args: [row.mint, at, row.price ?? null, row.liquidityUsd ?? null, row.marketCap ?? null, row.fdv ?? null, row.volume24h ?? null, row.score ?? null, row.grade ?? null, JSON.stringify(row.payload ?? {})] });
      }
      try {
        const results = await client.batch(statements, 'write');
        const ids = new Map();
        // Setiap tx menyisipkan tepat satu row token + satu row snapshot;
        // id snapshot terdapat pada statement INSERT berikutnya.
        let idIndex = 1;
        for (const row of rows) {
          ids.set(row.mint, Number(results[idIndex].lastInsertRowid));
          idIndex += 2;
        }
        return ids;
      } catch (error) {
        // client.batch mode 'write' berjalan dalam satu transaksi: gagal =
        // semuanya rollback, tidak ada setengah data tercatat.
        throw error;
      }
    },
    async updateSnapshotScore(id, { score, grade, payload }) {
      if (id === null || id === undefined) return false;
      const row = await client.execute({ sql: 'SELECT json FROM snapshots WHERE id = ?', args: [id] });
      if (!row.rows.length) return false;
      const existing = safeParse(row.rows[0].json) ?? {};
      const merged = { ...existing, ...(payload ?? {}), scoreStage: payload?.scoreStage ?? existing.scoreStage ?? 'deep' };
      await client.execute({ sql: 'UPDATE snapshots SET score = ?, grade = ?, json = ? WHERE id = ?', args: [score ?? null, grade ?? null, JSON.stringify(merged), id] });
      return true;
    },
    async upsertToken({ mint, symbol, name, tags, at }) {
      await client.execute({ sql: `INSERT INTO tokens (mint, symbol, name, first_seen, last_seen, tags_json) VALUES (?, ?, ?, ?, ?, ?)
                                   ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, last_seen = excluded.last_seen, tags_json = excluded.tags_json`,
        args: [mint, symbol ?? null, name ?? null, at, at, JSON.stringify(tags ?? [])] });
    },
    async addWatch({ mint, note, snapshot, at }) {
      await client.execute({ sql: `INSERT INTO watchlist (mint, added_at, note, snapshot_json, status) VALUES (?, ?, ?, ?, 'watching')
                                   ON CONFLICT(mint) DO UPDATE SET note = excluded.note, snapshot_json = excluded.snapshot_json`, args: [mint, at, note ?? null, JSON.stringify(snapshot ?? {})] });
    },
    async removeWatch(mint) {
      const result = await client.execute({ sql: 'DELETE FROM watchlist WHERE mint = ?', args: [mint] });
      return Number(result.rowsAffected ?? 0);
    },
    async listWatch() {
      const result = await client.execute('SELECT mint, added_at, note, snapshot_json, status FROM watchlist ORDER BY added_at DESC');
      return rowsOf(result).map(row => ({ mint: row.mint, addedAt: row.added_at, note: row.note, snapshot: safeParse(row.snapshot_json), status: row.status }));
    },
    async recordPlan({ mint, createdAt, plan }) {
      await client.execute({ sql: 'INSERT INTO plans (mint, created_at, entry_low, entry_high, invalidation, targets_json, rr, status, setup, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [mint, createdAt, plan.entryLow ?? null, plan.entryHigh ?? null, plan.invalidation ?? null, JSON.stringify(plan.targets ?? []), plan.riskReward ?? null, plan.status ?? 'no_plan', plan.setup ?? null, JSON.stringify(plan)] });
    },
    async latestPlan(mint) {
      const result = await client.execute({ sql: 'SELECT json FROM plans WHERE mint = ? ORDER BY created_at DESC, id DESC LIMIT 1', args: [mint] });
      return result.rows.length ? safeParse(result.rows[0].json) : null;
    },
    async recentRuns(limit = 10) {
      const result = await client.execute({ sql: 'SELECT id, started_at, preset, config_hash, candidates, accepted, rejected FROM discover_runs ORDER BY id DESC LIMIT ?', args: [limit] });
      return rowsOf(result).map(row => ({ id: row.id, startedAt: row.started_at, preset: row.preset, configHash: row.config_hash, candidates: row.candidates, accepted: row.accepted, rejected: row.rejected }));
    },
    async snapshotHistory(mint, limit = 50) {
      const result = await client.execute({ sql: 'SELECT taken_at, price, liquidity_usd, market_cap, volume_24h, score, grade, json FROM snapshots WHERE mint = ? ORDER BY id DESC LIMIT ?', args: [mint, limit] });
      return rowsOf(result).map(row => {
        const payload = safeParse(row.json) ?? {};
        return { takenAt: row.taken_at, price: row.price, liquidityUsd: row.liquidity_usd, marketCap: row.market_cap, volume24h: row.volume_24h, score: row.score, grade: row.grade, scoreStage: payload.scoreStage ?? 'initial' };
      });
    },
    async allSnapshots() {
      const result = await client.execute('SELECT mint, taken_at, price, liquidity_usd, market_cap, fdv, volume_24h, score, grade, json FROM snapshots ORDER BY mint, taken_at');
      return rowsOf(result).map(row => {
        const payload = safeParse(row.json) ?? {};
        return { mint: row.mint, takenAt: row.taken_at, price: row.price, liquidityUsd: row.liquidity_usd, marketCap: row.market_cap, fdv: row.fdv, volume24h: row.volume_24h, score: row.score, grade: row.grade, scoreStage: payload.scoreStage ?? 'initial' };
      });
    },
    async createJobItems(jobId, items) {
      const at = nowIso();
      const statements = items.map((item, position) => ({
        sql: 'INSERT INTO jobs (job_id, position, mint, snapshot_id, context_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        args: [jobId, position, item.mint, item.snapshotId ?? null, item.context ? JSON.stringify(item.context) : null, 'pending', at]
      }));
      if (statements.length) await client.batch(statements, 'write');
    },
    async setJobMeta(jobId, { preset, cacheKey, refresh }) {
      await client.execute({
        sql: 'INSERT INTO job_meta (job_id, preset, cache_key, refresh, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET preset = excluded.preset, cache_key = excluded.cache_key, refresh = excluded.refresh',
        args: [jobId, preset, cacheKey ?? null, refresh ? 1 : 0, nowIso()]
      });
    },
    async jobMeta(jobId) {
      const result = await client.execute({ sql: 'SELECT preset, cache_key, refresh, created_at FROM job_meta WHERE job_id = ?', args: [jobId] });
      const row = result.rows[0];
      return row ? { preset: row.preset, cacheKey: row.cache_key ?? null, refresh: row.refresh === 1, createdAt: row.created_at } : null;
    },
    async claimJobItem(jobId) {
      const result = await client.execute({
        sql: `UPDATE jobs SET status = 'processing', updated_at = ?
              WHERE id = (SELECT id FROM jobs WHERE job_id = ? AND status = 'pending' ORDER BY position LIMIT 1)
              RETURNING id, position, mint, snapshot_id, context_json`,
        args: [nowIso(), jobId]
      });
      const row = result.rows[0];
      return row ? { id: Number(row.id), position: Number(row.position), mint: row.mint, snapshotId: row.snapshot_id ?? null, context: safeParse(row.context_json) } : null;
    },
    async completeJobItem(id, { ok, result, error }) {
      const response = await client.execute({
        sql: 'UPDATE jobs SET status = ?, error = ?, result_json = ?, updated_at = ? WHERE id = ?',
        args: [ok ? 'done' : 'failed', ok ? null : String(error ?? 'unknown'), ok && result ? JSON.stringify({ ok: true, mint: result.mint, result }) : null, nowIso(), id]
      });
      return Number(response.rowsAffected ?? 0);
    },
    async failJobItem(id, error) {
      await client.execute({ sql: "UPDATE jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", args: [String(error ?? 'unknown'), nowIso(), id] });
    },
    async reapStaleJobItems(jobId, olderThanMs = 90_000) {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const result = await client.execute({ sql: "UPDATE jobs SET status = 'failed', error = 'kadaluarsa' WHERE job_id = ? AND status = 'processing' AND updated_at < ?", args: [jobId, cutoff] });
      return Number(result.rowsAffected ?? 0);
    },
    async cancelJob(jobId) {
      const result = await client.execute({ sql: "UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status = 'pending'", args: [nowIso(), jobId] });
      return Number(result.rowsAffected ?? 0);
    },
    async jobSummary(jobId) {
      const counts = await client.execute({
        sql: `SELECT COUNT(*) AS total,
                     SUM(CASE WHEN status IN ('done', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS settled,
                     SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
              FROM jobs WHERE job_id = ?`,
        args: [jobId]
      });
      const total = Number(counts.rows[0]?.total ?? 0);
      if (total === 0) return null;
      const settled = Number(counts.rows[0]?.settled ?? 0);
      const failures = Number(counts.rows[0]?.failures ?? 0);
      const rows = await client.execute({ sql: 'SELECT mint, status, error, result_json FROM jobs WHERE job_id = ? ORDER BY position', args: [jobId] });
      const results = [];
      for (const row of rowsOf(rows)) {
        if (row.status === 'done' && row.result_json) results.push(safeParse(row.result_json));
        else if (row.status === 'failed') results.push({ ok: false, mint: row.mint, reason: row.error ?? 'deep scan gagal' });
      }
      return { total, completed: settled, failures, status: settled >= total ? 'done' : (settled > 0 ? 'running' : 'queued'), results };
    }
  };
}

/* ---------- Factory ---------- */

export async function createDb(file = 'data/scanner.db') {
  const url = process.env.TURSO_DATABASE_URL;
  // Turso/libSQL: aktif bila TURSO_DATABASE_URL diset (libsql://…, https://…,
  // file:…, :memory:). `:memory:` sebagai argumen createDb tetap memaksa
  // node:sqlite lokal supaya tes tidak menyentuh database nyata.
  const wantsTurso = typeof url === 'string' && url.length > 0 && file !== ':memory:';
  try {
    if (wantsTurso) {
      if (!createClient) return unavailable('@libsql/client tidak terpasang; Turso tidak dapat dipakai.');
      return { available: true, reason: null, ...(await openTurso({ url, authToken: process.env.TURSO_AUTH_TOKEN })) };
    }
    if (!DatabaseSync) {
      return unavailable('node:sqlite tidak tersedia pada runtime ini; watchlist dan histori dinonaktifkan (mode stateless).');
    }
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    const backend = openSqlite(file);
    return { available: true, reason: null, ...backend };
  } catch (error) {
    // Gagal membuka/membuat database (direktori read-only, file rusak,
    // Turso tidak terjangkau): mode stateless, jangan crash.
    return unavailable(`Penyimpanan gagal dibuka (${error?.message ?? 'kesalahan tidak dikenal'}); watchlist dan histori dinonaktifkan (mode stateless).`);
  }
}

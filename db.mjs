import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  symbol TEXT,
  name TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  tags_json TEXT
);
CREATE TABLE IF NOT EXISTS snapshots (
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
);
CREATE INDEX IF NOT EXISTS idx_snapshots_mint ON snapshots(mint, taken_at DESC);
CREATE TABLE IF NOT EXISTS discover_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  preset TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  candidates INTEGER,
  accepted INTEGER,
  rejected INTEGER,
  json TEXT
);
CREATE TABLE IF NOT EXISTS watchlist (
  mint TEXT PRIMARY KEY,
  added_at TEXT NOT NULL,
  note TEXT,
  snapshot_json TEXT,
  status TEXT NOT NULL DEFAULT 'watching'
);
CREATE TABLE IF NOT EXISTS plans (
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
);
CREATE INDEX IF NOT EXISTS idx_plans_mint ON plans(mint, created_at DESC);
`;

export function createDb(file = 'data/scanner.db') {
  if (!DatabaseSync) {
    return {
      available: false,
      reason: 'node:sqlite tidak tersedia pada runtime ini; watchlist dan histori dinonaktifkan (mode stateless).',
      close() {}
    };
  }
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const stmt = sql => db.prepare(sql);

  return {
    available: true,
    reason: null,
    close() { try { db.close(); } catch { /* sudah tertutup */ } },
    recordDiscoverRun({ startedAt, preset, configHash, candidates, accepted, rejected, payload }) {
      const result = stmt('INSERT INTO discover_runs (started_at, preset, config_hash, candidates, accepted, rejected, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(startedAt, preset, configHash, candidates, accepted, rejected, JSON.stringify(payload ?? {}));
      return Number(result.lastInsertRowid);
    },
    recordSnapshot({ mint, takenAt, price, liquidityUsd, marketCap, fdv, volume24h, score, grade, payload }) {
      const result = stmt('INSERT INTO snapshots (mint, taken_at, price, liquidity_usd, market_cap, fdv, volume_24h, score, grade, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(mint, takenAt, price ?? null, liquidityUsd ?? null, marketCap ?? null, fdv ?? null, volume24h ?? null, score ?? null, grade ?? null, JSON.stringify(payload ?? {}));
      return Number(result.lastInsertRowid);
    },
    /**
     * Ganti skor/grade snapshot dengan hasil final deep scan. Tanpa ini
     * backtest memakai grade yang berbeda dari yang dilihat pengguna.
     */
    updateSnapshotScore(id, { score, grade, payload }) {
      if (id === null || id === undefined) return false;
      const row = stmt('SELECT json FROM snapshots WHERE id = ?').get(id);
      if (!row) return false;
      const existing = safeParse(row.json) ?? {};
      const merged = { ...existing, ...(payload ?? {}), scoreStage: payload?.scoreStage ?? existing.scoreStage ?? 'deep' };
      stmt('UPDATE snapshots SET score = ?, grade = ?, json = ? WHERE id = ?')
        .run(score ?? null, grade ?? null, JSON.stringify(merged), id);
      return true;
    },
    upsertToken({ mint, symbol, name, tags, at }) {
      stmt(`INSERT INTO tokens (mint, symbol, name, first_seen, last_seen, tags_json) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(mint) DO UPDATE SET symbol = excluded.symbol, name = excluded.name, last_seen = excluded.last_seen, tags_json = excluded.tags_json`)
        .run(mint, symbol ?? null, name ?? null, at, at, JSON.stringify(tags ?? []));
    },
    addWatch({ mint, note, snapshot, at }) {
      stmt(`INSERT INTO watchlist (mint, added_at, note, snapshot_json, status) VALUES (?, ?, ?, ?, 'watching')
            ON CONFLICT(mint) DO UPDATE SET note = excluded.note, snapshot_json = excluded.snapshot_json`)
        .run(mint, at, note ?? null, JSON.stringify(snapshot ?? {}));
    },
    removeWatch(mint) {
      return Number(stmt('DELETE FROM watchlist WHERE mint = ?').run(mint).changes);
    },
    listWatch() {
      return stmt('SELECT mint, added_at, note, snapshot_json, status FROM watchlist ORDER BY added_at DESC').all()
        .map(row => ({ mint: row.mint, addedAt: row.added_at, note: row.note, snapshot: safeParse(row.snapshot_json), status: row.status }));
    },
    recordPlan({ mint, createdAt, plan }) {
      stmt('INSERT INTO plans (mint, created_at, entry_low, entry_high, invalidation, targets_json, rr, status, setup, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(mint, createdAt, plan.entryLow ?? null, plan.entryHigh ?? null, plan.invalidation ?? null, JSON.stringify(plan.targets ?? []), plan.riskReward ?? null, plan.status ?? 'no_plan', plan.setup ?? null, JSON.stringify(plan));
    },
    latestPlan(mint) {
      const row = stmt('SELECT json FROM plans WHERE mint = ? ORDER BY created_at DESC LIMIT 1').get(mint);
      return row ? safeParse(row.json) : null;
    },
    recentRuns(limit = 10) {
      return stmt('SELECT id, started_at, preset, config_hash, candidates, accepted, rejected FROM discover_runs ORDER BY id DESC LIMIT ?').all(limit)
        .map(row => ({ id: row.id, startedAt: row.started_at, preset: row.preset, configHash: row.config_hash, candidates: row.candidates, accepted: row.accepted, rejected: row.rejected }));
    },
    snapshotHistory(mint, limit = 50) {
      return stmt('SELECT taken_at, price, liquidity_usd, market_cap, volume_24h, score, grade, json FROM snapshots WHERE mint = ? ORDER BY id DESC LIMIT ?').all(mint, limit)
        .map(row => {
          const payload = safeParse(row.json) ?? {};
          return {
            takenAt: row.taken_at, price: row.price, liquidityUsd: row.liquidity_usd, marketCap: row.market_cap,
            volume24h: row.volume_24h, score: row.score, grade: row.grade, scoreStage: payload.scoreStage ?? 'initial'
          };
        });
    },
    /** Semua snapshot, untuk backtest forward-test offline. */
    allSnapshots() {
      return stmt('SELECT mint, taken_at, price, liquidity_usd, market_cap, fdv, volume_24h, score, grade, json FROM snapshots ORDER BY mint, taken_at').all()
        .map(row => {
          const payload = safeParse(row.json) ?? {};
          return {
            mint: row.mint,
            takenAt: row.taken_at,
            price: row.price,
            liquidityUsd: row.liquidity_usd,
            marketCap: row.market_cap,
            fdv: row.fdv,
            volume24h: row.volume_24h,
            score: row.score,
            grade: row.grade,
            // Tahap skor: 'initial' = sebelum deep scan, 'deep' = setelah
            // deep scan. Campuran keduanya harus terlihat di laporan.
            scoreStage: payload.scoreStage ?? 'initial'
          };
        });
    }
  };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

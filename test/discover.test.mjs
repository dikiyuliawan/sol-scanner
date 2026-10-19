import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.mjs';
import { createDb } from '../db.mjs';
import { createJobs } from '../jobs.mjs';
import { createDiscovery } from '../discover.mjs';

const MINT = 'TokenMint1111111111111111111111111111111111';
const POOL = 'Poo1111111111111111111111111111111111111111';
const NOW = 1_800_000_000_000;

function jupiterToken(overrides = {}) {
  return {
    mint: MINT, symbol: 'EX', name: 'Example', isVerified: true, tags: ['verified'],
    organicScore: 72, organicLabel: 'high', holderCount: 5000, liquidityUsd: 900_000,
    tokenProgram: 'Tokenkeg', audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 20 },
    stats: { '1h': { numNetBuyers: 50 }, '6h': {}, '24h': {}, '5m': {} },
    ...overrides
  };
}

function fakeSources({ jupiterTokens = [jupiterToken()], pool = null, candles = [], security = null } = {}) {
  return {
    jupiter: {
      async topOrganic() { return { status: 'available', source: 'Jupiter', tokens: jupiterTokens, fetchedAt: new Date(NOW).toISOString() }; },
      async topTrending() { return { status: 'available', source: 'Jupiter', tokens: jupiterTokens, fetchedAt: new Date(NOW).toISOString() }; }
    },
    dexscreener: {
      async batch(mints) {
        const pools = new Map();
        if (pool) for (const mint of mints) if (mint === MINT) pools.set(mint, pool);
        return { status: 'available', source: 'DEX Screener', pools, fetchedAt: new Date(NOW).toISOString() };
      }
    },
    gecko: {
      async trending() { return { status: 'available', source: 'GeckoTerminal', pools: [], fetchedAt: new Date(NOW).toISOString() }; },
      async newPools() { return { status: 'available', source: 'GeckoTerminal', pools: [], fetchedAt: new Date(NOW).toISOString() }; },
      async candles() { return { status: 'available', source: 'GeckoTerminal', candles, meta: null, fetchedAt: new Date(NOW).toISOString() }; }
    },
    goplus: {
      async security() { return security ?? { status: 'unknown', source: 'GoPlus', security: null, fetchedAt: null, reason: 'tidak tersedia' }; }
    }
  };
}

const healthyPool = {
  poolAddress: POOL, dex: 'raydium', baseMint: MINT, quoteMint: 'So11111111111111111111111111111111111111112',
  baseSymbol: 'EX', quoteSymbol: 'SOL', priceUsd: 0.5, liquidityUsd: 500_000, marketCap: 5_000_000, fdv: 6_000_000,
  createdAt: NOW - 72 * 3_600_000,
  change: { m5: 0, h1: 1.2, h6: 3, h24: 9 },
  volume: { m5: 100, h1: 20_000, h6: 120_000, h24: 500_000 },
  txns: { h24: { buys: 800, sells: 600 } },
  source: 'DEX Screener', fetchedAt: new Date(NOW).toISOString()
};

function hourlyCandles() {
  const currentStart = Math.floor(NOW / 1000 / 3600) * 3600;
  return Array.from({ length: 120 }, (_, index) => {
    const close = 0.4 + index * 0.001;
    return [currentStart - (120 - index) * 3600, close - 0.001, close + 0.002, close - 0.002, close, 10_000];
  });
}

async function withServer(t, server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('discover menggabungkan universe, menjalankan gate, dan mengembalikan baris ter-rank', async () => {
  const sources = fakeSources({ pool: healthyPool });
  const db = createDb(':memory:');
  const discovery = createDiscovery({ ...sources, db, clock: () => NOW });
  const result = await discovery({ preset: 'balanced', limit: 10, skipDeep: true });
  assert.equal(result.preset.name, 'balanced');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].mint, MINT);
  assert.equal(result.rows[0].rank, 1);
  assert.ok(Number.isInteger(result.rows[0].score));
  assert.equal(result.configHash.length, 12);
  assert.ok(result.runId > 0);
  assert.equal(result.universe.evaluated, 1, 'kandidat dengan data pasar dihitung terpisah');
  assert.equal(result.deepScanPending.length, 0, 'skipDeep tidak boleh menjadwalkan job');
  db.close();
});

test('preset yang mewajibkan keamanan memverifikasi GoPlus sebelum gate final', async () => {
  const agedPool = { ...healthyPool, createdAt: NOW - 200 * 3_600_000 };
  const sources = fakeSources({
    pool: agedPool,
    security: { status: 'available', source: 'GoPlus', fetchedAt: new Date(NOW).toISOString(), security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 18, holderCount: 6000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } }
  });
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'conservative', limit: 10, skipDeep: true });
  assert.equal(result.rows.length, 1, 'preset ketat tidak lagi selalu kosong');
  assert.equal(result.rows[0].safety.status, 'available');
  assert.ok(result.warnings.some(reason => /GoPlus diverifikasi/.test(reason)));
});

test('preset ketat tanpa GoPlus menolak dengan safety_unknown, bukan menganggap aman', async () => {
  const agedPool = { ...healthyPool, createdAt: NOW - 200 * 3_600_000 };
  const sources = fakeSources({ pool: agedPool });
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'conservative', limit: 10, skipDeep: true });
  assert.equal(result.rows.length, 0);
  assert.ok(result.rejected.some(item => item.rejections.some(rejection => rejection.code === 'safety_unknown')));
});

test('discover mencatat warning ketika salah satu sumber gagal, tanpa hasil palsu', async () => {
  const sources = fakeSources({ pool: healthyPool });
  sources.jupiter.topOrganic = async () => ({ status: 'unknown', source: 'Jupiter', tokens: [], reason: 'Jupiter top organic: HTTP 429' });
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'balanced', skipDeep: true });
  assert.ok(result.warnings.some(reason => /HTTP 429/.test(reason)));
  assert.equal(result.rows.length, 1, 'masih ada kandidat dari trending/dex');
});

test('Gecko fallback pool mempertahankan timestamp dan provenance saat DEX tidak mengembalikan pool', async () => {
  const sources = fakeSources();
  const geckoPool = { ...healthyPool, source: 'GeckoTerminal', createdAt: NOW - 72 * 3_600_000 };
  sources.gecko.trending = async () => ({ status: 'available', source: 'GeckoTerminal', pools: [{ ...geckoPool, mint: MINT }], reason: null });
  sources.dexscreener.batch = async () => ({ status: 'available', pools: new Map(), reason: null });

  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'balanced', skipDeep: true });
  assert.equal(result.rows.length, 1, JSON.stringify(result.rejected));
  assert.equal(result.rows[0].market.source, 'GeckoTerminal');
  assert.equal(result.rows[0].market.ageHours, 72);
});

test('deep scan melengkapi struktur dan rencana entry lewat job', async t => {
  const sources = fakeSources({
    pool: healthyPool,
    candles: hourlyCandles(),
    security: { status: 'available', source: 'GoPlus', fetchedAt: new Date(NOW).toISOString(), security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 18, holderCount: 6000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } }
  });
  const db = createDb(':memory:');
  const jobs = createJobs({ clock: () => NOW });
  const server = createServer({ ...sources, db, jobs, clock: () => NOW });
  const base = await withServer(t, server);
  const data = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  assert.ok(data.jobId);
  await new Promise(resolve => setTimeout(resolve, 120));
  const job = await (await fetch(`${base}/api/jobs/${data.jobId}`)).json();
  assert.equal(job.status, 'done');
  assert.equal(job.results[0].ok, true);
  assert.equal(job.results[0].result.structure.trend, 'uptrend');
  assert.ok(['plan', 'no_plan'].includes(job.results[0].result.entryPlan.status));
  assert.equal(job.results[0].result.safety.status, 'available');
  db.close();
});

test('discover mengembalikan cached true pada permintaan kedua dalam 60 detik', async t => {
  const sources = fakeSources({ pool: healthyPool });
  const db = createDb(':memory:');
  const server = createServer({ ...sources, db, clock: () => NOW });
  const base = await withServer(t, server);
  const first = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  const second = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.equal(first.rows[0].mint, second.rows[0].mint);
  assert.ok(first.jobId, 'deep scan should expose a pollable job');
  assert.equal(second.jobId, first.jobId, 'cached response must preserve the original deep-scan job');
  assert.equal(second.jobTotal, first.jobTotal);
  const jobResponse = await fetch(`${base}/api/jobs/${second.jobId}`);
  assert.equal(jobResponse.status, 200, 'job id returned by cached response remains pollable');
  db.close();
});

test('discover menolak preset tidak dikenal dengan fallback balanced', async t => {
  const sources = fakeSources({ pool: healthyPool });
  const server = createServer({ ...sources, db: createDb(':memory:'), clock: () => NOW });
  const base = await withServer(t, server);
  const data = await (await fetch(`${base}/api/discover?preset=ngawur`)).json();
  assert.equal(data.preset.name, 'balanced');
});

test('watchlist POST/GET/DELETE memakai SQLite lokal dan menolak mint invalid', async t => {
  const sources = fakeSources({ pool: healthyPool });
  const db = createDb(':memory:');
  const server = createServer({ ...sources, db, clock: () => NOW });
  const base = await withServer(t, server);

  const empty = await (await fetch(`${base}/api/watchlist`)).json();
  assert.deepEqual(empty.items, []);

  const crossOrigin = await fetch(`${base}/api/watchlist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ mint: MINT, note: 'cross-origin attempt' })
  });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual((await (await fetch(`${base}/api/watchlist`)).json()).items, [], 'rejected cross-origin request must not mutate local state');

  const added = await fetch(`${base}/api/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mint: MINT, note: 'uji', snapshot: { symbol: 'EX' } }) });
  assert.equal(added.status, 200);
  const list = await (await fetch(`${base}/api/watchlist`)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].mint, MINT);
  assert.equal(list.items[0].snapshot.symbol, 'EX');

  const invalid = await fetch(`${base}/api/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mint: 'bad' }) });
  assert.equal(invalid.status, 400);

  const removed = await (await fetch(`${base}/api/watchlist/${MINT}`, { method: 'DELETE' })).json();
  assert.equal(removed.removed, 1);
  assert.equal(removed.items.length, 0);
  db.close();
});

test('riwayat snapshot tersimpan per mint dan dapat dibaca kembali', async t => {
  const sources = fakeSources({ pool: healthyPool });
  const db = createDb(':memory:');
  const server = createServer({ ...sources, db, clock: () => NOW });
  const base = await withServer(t, server);
  await (await fetch(`${base}/api/discover?preset=balanced&limit=5`)).json();
  const history = await (await fetch(`${base}/api/history?mint=${MINT}`)).json();
  assert.equal(history.snapshots.length, 1);
  assert.equal(history.snapshots[0].score >= 0, true);
  assert.ok(history.snapshots[0].takenAt);
  db.close();
});

test('config endpoint mengekspos hash, preset, dan status storage', async t => {
  const server = createServer({ ...fakeSources(), db: createDb(':memory:'), clock: () => NOW });
  const base = await withServer(t, server);
  const data = await (await fetch(`${base}/api/config`)).json();
  assert.equal(data.configHash.length, 12);
  assert.ok(data.presets.balanced);
  assert.equal(data.storage.available, true);
});

test('job tidak dikenal menghasilkan 404, bukan hasil kosong', async t => {
  const server = createServer({ ...fakeSources(), db: createDb(':memory:'), clock: () => NOW });
  const base = await withServer(t, server);
  assert.equal((await fetch(`${base}/api/jobs/tidak-ada`)).status, 404);
});

test('db tanpa node:sqlite tetap melaporkan mode stateless, bukan crash', async () => {
  const db = createDb(':memory:');
  assert.equal(typeof db.available, 'boolean');
  db.close();
});

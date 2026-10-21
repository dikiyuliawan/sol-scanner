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
      async topTrending() { return { status: 'available', source: 'Jupiter', tokens: jupiterTokens, fetchedAt: new Date(NOW).toISOString() }; },
      async recent() { return { status: 'available', source: 'Jupiter', tokens: jupiterTokens, fetchedAt: new Date(NOW).toISOString() }; }
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

/* ---------------- sumber universe dan kesegaran data ---------------- */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Index(value) {
  let text = '';
  let number = value + 1;
  while (number > 0) { text = BASE58[number % 58] + text; number = Math.floor(number / 58); }
  return text;
}
function universeToken(index) {
  // Panjang base58 harus 32-44 karakter dan hanya memakai karakter base58
  // supaya lolos validasi mint.
  return { mint: `TokenMint${base58Index(index)}${'1'.repeat(26)}`, symbol: `T${index}`, isVerified: true, tags: ['verified'], organicScore: 70, organicLabel: 'high', holderCount: 5000, liquidityUsd: 900_000, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 12 }, stats: { '1h': {}, '6h': {}, '24h': {}, '5m': {} } };
}

test('semua sumber universe berkontribusi pada kandidat yang dievaluasi', async () => {
  const organic = Array.from({ length: 40 }, (_, index) => universeToken(index));
  const trending = Array.from({ length: 20 }, (_, index) => universeToken(100 + index));
  const organic24 = Array.from({ length: 20 }, (_, index) => universeToken(200 + index));
  const recent = Array.from({ length: 20 }, (_, index) => universeToken(300 + index));
  const geckoPools = Array.from({ length: 20 }, (_, index) => ({ ...universeToken(400 + index), liquidityUsd: undefined }));
  const sources = {
    jupiter: {
      async topOrganic(interval) { return { status: 'available', source: 'Jupiter', tokens: interval === '24h' ? organic24 : organic, fetchedAt: new Date(NOW).toISOString() }; },
      async topTrending() { return { status: 'available', source: 'Jupiter', tokens: trending, fetchedAt: new Date(NOW).toISOString() }; },
      async recent() { return { status: 'available', source: 'Jupiter', tokens: recent, fetchedAt: new Date(NOW).toISOString() }; }
    },
    dexscreener: {
      async batch(mints) {
        const pools = new Map();
        for (const mint of mints) pools.set(mint, { ...healthyPool, baseMint: mint, baseSymbol: 'EX' });
        return { status: 'available', source: 'DEX Screener', pools, fetchedAt: new Date(NOW).toISOString() };
      }
    },
    gecko: {
      async trending(page) { return { status: 'available', source: 'GeckoTerminal', pools: geckoPools.map(pool => ({ ...pool, poolAddress: `Pool${page}${pool.mint.slice(0, 12)}` })), fetchedAt: new Date(NOW).toISOString() }; },
      async newPools() { return { status: 'available', source: 'GeckoTerminal', pools: geckoPools.map(pool => ({ ...pool, poolAddress: `New${pool.mint.slice(0, 12)}` })), fetchedAt: new Date(NOW).toISOString() }; },
      async candles() { return { status: 'available', source: 'GeckoTerminal', candles: [], meta: null, fetchedAt: new Date(NOW).toISOString() }; }
    },
    goplus: { async security() { return { status: 'unknown', source: 'GoPlus', security: null, fetchedAt: null, reason: 'tidak tersedia' }; } }
  };
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'balanced', skipDeep: true });
  const breakdown = result.universe.sources;
  assert.ok(Object.keys(breakdown).length >= 5, `semua sumber harus berkontribusi: ${JSON.stringify(breakdown)}`);
  for (const [label, count] of Object.entries(breakdown)) {
    assert.ok(count > 0, `sumber ${label} tidak boleh nol: ${JSON.stringify(breakdown)}`);
  }
  const selected = new Set(result.rows.map(row => row.mint));
  assert.ok(selected.has(trending[0].mint), 'kandidat dari daftar trending harus masuk');
  assert.ok(selected.has(organic24[0].mint), 'kandidat dari daftar organic 24 jam harus masuk');
  assert.ok(selected.has(recent[0].mint), 'kandidat dari daftar token terbaru harus masuk');
});

test('sumber yang mengembalikan daftar kosong menghasilkan warning', async () => {
  const sources = fakeSources({ pool: healthyPool });
  sources.jupiter.topTrending = async () => ({ status: 'available', source: 'Jupiter', tokens: [], fetchedAt: new Date(NOW).toISOString() });
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'balanced', skipDeep: true });
  assert.ok(result.warnings.some(reason => /trending 1 jam tidak mengembalikan token apa pun/.test(reason)), result.warnings.join(' | '));
});

test('preset ketat tanpa kandidat yang lolos gate awal tetap menjelaskan diri', async () => {
  const sources = fakeSources({ pool: { ...healthyPool, liquidityUsd: 1000 } });
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'conservative', skipDeep: true });
  assert.ok(result.warnings.some(reason => /tidak ada kandidat yang lolos gate awal/.test(reason)), result.warnings.join(' | '));
});

test('deep scan memakai pool utama provider dan memperbarui data pasar baris', async t => {
  const sources = fakeSources({
    pool: healthyPool,
    candles: hourlyCandles(),
    security: { status: 'available', source: 'GoPlus', fetchedAt: new Date(NOW).toISOString(), security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 18, holderCount: 6000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } }
  });
  sources.dexscreener.mainPool = async () => ({
    status: 'available', source: 'DEX Screener', fetchedAt: new Date(NOW).toISOString(),
    pool: { ...healthyPool, poolAddress: 'Poo2222222222222222222222222222222222222222', liquidityUsd: 900_000, priceUsd: 0.6 },
    reason: null
  });
  const db = createDb(':memory:');
  const server = createServer({ ...sources, db, jobs: createJobs({ clock: () => NOW }), clock: () => NOW });
  const base = await withServer(t, server);
  const data = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  await new Promise(resolve => setTimeout(resolve, 150));
  const job = await (await fetch(`${base}/api/jobs/${data.jobId}`)).json();
  const result = job.results[0].result;
  assert.equal(result.market.poolAddress, 'Poo2222222222222222222222222222222222222222');
  assert.equal(result.market.liquidityUsd, 900_000);
  assert.equal(result.poolCheck.replaced, true);
  db.close();
});

test('snapshot memakai skor final setelah deep scan, bukan skor awal', async t => {
  const sources = fakeSources({
    pool: healthyPool,
    candles: hourlyCandles(),
    security: { status: 'available', source: 'GoPlus', fetchedAt: new Date(NOW).toISOString(), security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 18, holderCount: 6000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } }
  });
  const db = createDb(':memory:');
  const server = createServer({ ...sources, db, jobs: createJobs({ clock: () => NOW }), clock: () => NOW });
  const base = await withServer(t, server);
  const data = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  await new Promise(resolve => setTimeout(resolve, 150));
  const job = await (await fetch(`${base}/api/jobs/${data.jobId}`)).json();
  const history = await (await fetch(`${base}/api/history?mint=${MINT}`)).json();
  assert.equal(history.snapshots[0].scoreStage, 'deep');
  assert.equal(history.snapshots[0].score, job.results[0].result.score);
  assert.equal(history.snapshots[0].grade, job.results[0].result.grade);
  db.close();
});

test('cache discover mengembalikan hasil final deep scan pada permintaan berikutnya', async t => {
  const sources = fakeSources({
    pool: healthyPool,
    candles: hourlyCandles(),
    security: { status: 'available', source: 'GoPlus', fetchedAt: new Date(NOW).toISOString(), security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 18, holderCount: 6000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } }
  });
  const server = createServer({ ...sources, db: createDb(':memory:'), jobs: createJobs({ clock: () => NOW }), clock: () => NOW });
  const base = await withServer(t, server);
  const first = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  await new Promise(resolve => setTimeout(resolve, 150));
  const job = await (await fetch(`${base}/api/jobs/${first.jobId}`)).json();
  const second = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  assert.equal(second.cached, true);
  assert.equal(second.rows[0].score, job.results[0].result.score, 'cache harus mengembalikan skor final');
  assert.equal(second.rows[0].grade, job.results[0].result.grade);
});

test('refresh=1 melewati cache discover dan cache sumber', async t => {
  let batches = 0;
  const sources = fakeSources({ pool: healthyPool });
  const original = sources.dexscreener.batch.bind(sources.dexscreener);
  sources.dexscreener.batch = async (...args) => { batches += 1; return original(...args); };
  const server = createServer({ ...sources, db: createDb(':memory:'), clock: () => NOW });
  const base = await withServer(t, server);
  await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  const cached = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  assert.equal(cached.cached, true);
  assert.equal(batches, 1);
  const refreshed = await (await fetch(`${base}/api/discover?preset=balanced&refresh=1`)).json();
  assert.equal(refreshed.cached, undefined);
  assert.equal(refreshed.refreshed, true);
  assert.equal(batches, 2, 'refresh harus mengambil data pasar baru');
});

/* ---------------- kedalaman antrean dan verifikasi holder ---------------- */

function multiTokenSources({ count = 6, candles = [], security = null } = {}) {
  const tokens = Array.from({ length: count }, (_, index) => ({ ...universeToken(index), symbol: `T${index}` }));
  const sources = fakeSources({ jupiterTokens: tokens, candles, security });
  sources.dexscreener.batch = async mints => {
    const pools = new Map();
    for (const mint of mints) pools.set(mint, { ...healthyPool, baseMint: mint, baseSymbol: 'EX' });
    return { status: 'available', source: 'DEX Screener', pools, fetchedAt: new Date(NOW).toISOString() };
  };
  return sources;
}

test('deep scan mencakup semua baris yang lolos gate, bukan hanya empat teratas', async () => {
  const sources = multiTokenSources({
    count: 6,
    candles: hourlyCandles(),
    security: { status: 'available', source: 'GoPlus', fetchedAt: new Date(NOW).toISOString(), security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 18, holderCount: 6000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } }
  });
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'balanced' });
  assert.equal(result.rows.length, 6);
  assert.equal(result.deepScanPending.length, 6, 'semua baris harus masuk antrean deep scan');
});

test('kandidat tanpa jumlah holder Jupiter diverifikasi lewat GoPlus agar tidak gugur sebagai unknown', async () => {
  const geckoToken = { ...universeToken(900), symbol: 'GK', holderCount: undefined, liquidityUsd: undefined };
  const sources = fakeSources({ pool: healthyPool });
  sources.jupiter.topOrganic = async () => ({ status: 'available', source: 'Jupiter', tokens: [], fetchedAt: new Date(NOW).toISOString() });
  sources.jupiter.topTrending = async () => ({ status: 'available', source: 'Jupiter', tokens: [], fetchedAt: new Date(NOW).toISOString() });
  sources.jupiter.recent = async () => ({ status: 'available', source: 'Jupiter', tokens: [], fetchedAt: new Date(NOW).toISOString() });
  sources.gecko.newPools = async () => ({ status: 'available', source: 'GeckoTerminal', pools: [{ ...geckoToken, poolAddress: 'GeckoPool11111111111111111111111111111111111' }], fetchedAt: new Date(NOW).toISOString() });
  sources.gecko.trending = async () => ({ status: 'available', source: 'GeckoTerminal', pools: [], fetchedAt: new Date(NOW).toISOString() });
  sources.dexscreener.batch = async mints => {
    const pools = new Map();
    for (const mint of mints) pools.set(mint, { ...healthyPool, baseMint: mint, baseSymbol: 'GK' });
    return { status: 'available', source: 'DEX Screener', pools, fetchedAt: new Date(NOW).toISOString() };
  };
  let verified = null;
  sources.goplus.security = async mint => {
    verified = mint;
    return { status: 'available', source: 'GoPlus', fetchedAt: new Date(NOW).toISOString(), security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 20, holderCount: 5000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } };
  };
  // Pool baru hanya diambil untuk preset yang menerima likuiditas tipis.
  const result = await createDiscovery({ ...sources, clock: () => NOW })({ preset: 'degen', skipDeep: true });
  assert.equal(verified, geckoToken.mint, 'kandidat tanpa holder Jupiter harus diverifikasi lewat GoPlus');
  assert.equal(result.rows.length, 1, 'dengan jumlah holder dari GoPlus kandidat bisa lolos gate');
  assert.ok(result.warnings.some(reason => /GoPlus diverifikasi/.test(reason)), result.warnings.join(' | '));
  assert.ok(result.universe.sources['GeckoTerminal pool baru'] > 0, 'sumber pool baru harus dievaluasi pada preset degen');
});

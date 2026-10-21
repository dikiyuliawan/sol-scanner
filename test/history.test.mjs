import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryProvider, normalizeHistory, entryContext } from '../history.mjs';
import { analyzeCandles } from '../signals.mjs';
import { createGeckoSource } from '../sources/gecko.mjs';
import { createServer } from '../server.mjs';

const MINT = 'So11111111111111111111111111111111111111112';
const QUOTE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
const NOW = 1_800_000_000_000;
const primary = { address: POOL, baseMint: MINT, quoteMint: QUOTE, liquidityUsd: 100000, ageHours: 25 };
// Fixture sintetis HANYA untuk tes, tidak pernah ditampilkan sebagai pasar nyata.
function rows(now = NOW) {
  const start = Math.floor(now / 900000) * 900;
  return Array.from({ length: 21 }, (_, i) => [start - (21 - i) * 900, 100 + i, 101 + i, 99 + i, 100 + i, 100]);
}
const payload = (data = rows()) => ({ data: { attributes: { ohlcv_list: data } }, meta: { base: { address: MINT }, quote: { address: QUOTE } } });
const sourceShape = (data = rows()) => ({ candles: data, meta: { base: { address: MINT }, quote: { address: QUOTE } } });
const reply = data => new Response(JSON.stringify(data), { status: 200 });

/** Klien GeckoTerminal palsu dengan kontrak yang sama dengan sumber asli. */
function fakeGecko({ data = rows(), status = 'available', reason = null } = {}) {
  const calls = [];
  return {
    calls,
    async candles(pool, mint, options) {
      calls.push({ pool, mint, options });
      if (status !== 'available') return { status, source: 'GeckoTerminal', fetchedAt: new Date(NOW).toISOString(), candles: [], meta: null, reason };
      return { status: 'available', source: 'GeckoTerminal', fetchedAt: new Date(NOW).toISOString(), candles: data, meta: { base: { address: MINT }, quote: { address: QUOTE } }, reason: null };
    }
  };
}

test('SMA20 tepat memakai 20 candle terakhir, bukan 21; baseline resistance mengecualikan latest', () => {
  const r = analyzeCandles(rows(), { now: NOW });
  assert.equal(r.metrics.sma20Usd, 110.5);
  assert.equal(r.metrics.previousHighUsd, 120);
  assert.equal(r.metrics.previousLowUsd, 99);
  assert.equal(r.metrics.relativeVolume, 1);
});

test('identitas mint, pasangan token, dan skema harus cocok', () => {
  assert.equal(normalizeHistory(sourceShape(), MINT, primary, NOW).status, 'available');
  const reversed = sourceShape();
  [reversed.meta.base, reversed.meta.quote] = [reversed.meta.quote, reversed.meta.base];
  assert.equal(normalizeHistory(reversed, MINT, primary, NOW).status, 'available');
  for (const raw of [{}, { ...sourceShape(), meta: {} }, { ...sourceShape(), meta: { base: { address: MINT }, quote: { address: 'different' } } }]) {
    assert.throws(() => normalizeHistory(raw, MINT, primary, NOW), /Identitas|Pasangan/);
  }
  assert.throws(() => normalizeHistory({ ...sourceShape(), candles: undefined }, MINT, primary, NOW), /ohlcv_list/);
});

test('request candle 15m USD memakai token eksplisit, versi header, dan tidak mengikuti redirect', async () => {
  let observed;
  const gecko = createGeckoSource({ minGapMs: 0, interactiveWaitMs: 0, clock: () => NOW, fetcher: async (url, options) => { observed = { url, options }; return reply(payload()); } });
  const history = createHistoryProvider({ gecko, clock: () => NOW });
  const r = await history(MINT, primary);
  assert.equal(r.status, 'available');
  assert.equal(r.poolAddress, POOL);
  assert.equal(r.tokenAddress, MINT);
  assert.equal(r.fetchedAt, new Date(NOW).toISOString());
  assert.equal(r.historyCached, false);
  const url = new URL(observed.url);
  assert.equal(url.origin, 'https://api.geckoterminal.com');
  assert.equal(url.pathname, `/api/v2/networks/solana/pools/${POOL}/ohlcv/minute`);
  assert.equal(url.searchParams.get('token'), MINT);
  assert.equal(url.searchParams.get('aggregate'), '15');
  assert.equal(url.searchParams.get('include_empty_intervals'), 'true');
  assert.equal(url.searchParams.get('currency'), 'usd');
  assert.equal(observed.options.headers.Accept, 'application/json;version=20230203');
  assert.equal(observed.options.redirect, 'error');
});

test('pool hilang/invalid tidak memicu jaringan dan tidak memilih fallback', async () => {
  const gecko = fakeGecko();
  const history = createHistoryProvider({ gecko, clock: () => NOW });
  for (const p of [null, {}, { address: 'bad/../pool' }]) assert.equal((await history(MINT, p)).status, 'unknown');
  assert.equal(gecko.calls.length, 0);
});

test('cache candle 60 detik mempertahankan fetchedAt dan mengambil ulang setelah TTL', async () => {
  let now = NOW, calls = 0;
  const gecko = fakeGecko();
  const original = gecko.candles.bind(gecko);
  gecko.candles = async (...args) => { calls += 1; return original(...args); };
  const history = createHistoryProvider({ gecko, clock: () => now });
  const first = await history(MINT, primary);
  now += 30000;
  const second = await history(MINT, primary);
  assert.equal(second.historyCached, true);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(second.candleAgeSeconds, first.candleAgeSeconds + 30);
  now += 31000;
  const third = await history(MINT, primary);
  assert.equal(third.historyCached, false);
  assert.equal(calls, 2);
});

test('permintaan serentak untuk pool sama digabung', async () => {
  let calls = 0;
  const gecko = fakeGecko();
  const original = gecko.candles.bind(gecko);
  gecko.candles = async (...args) => { calls += 1; return original(...args); };
  const history = createHistoryProvider({ gecko, clock: () => NOW });
  const result = await Promise.all([history(MINT, primary), history(MINT, primary)]);
  assert.equal(calls, 1);
  assert.deepEqual(result[0], result[1]);
});

test('HTTP 429 memicu cooldown, tidak membuat sinyal atau fetchedAt palsu', async () => {
  let calls = 0, now = NOW;
  const gecko = createGeckoSource({ minGapMs: 0, interactiveWaitMs: 0, clock: () => now, fetcher: async () => { calls += 1; return new Response('limited', { status: 429 }); } });
  const history = createHistoryProvider({ gecko, clock: () => now });
  const first = await history(MINT, primary);
  assert.equal(first.status, 'unknown');
  assert.equal(first.fetchedAt, null);
  assert.match(first.reason, /HTTP 429/);
  const second = await history(MINT, primary);
  assert.match(second.reason, /cooldown/);
  assert.equal(calls, 1);
  now += 61000;
  await history(MINT, primary);
  assert.equal(calls, 2);
});

test('batas laju GeckoTerminal dipakai bersama, bukan dihitung per modul', async () => {
  let calls = 0;
  const gecko = createGeckoSource({ minGapMs: 0, interactiveWaitMs: 0, clock: () => NOW, fetcher: async () => { calls += 1; return reply(payload()); } });
  const history = createHistoryProvider({ gecko, clock: () => NOW });
  // Alamat pool harus base58 yang sah (tanpa '0', 'O', 'I', dan 'l').
  const safe = 'ABCDEFGHJKLM';
  for (let i = 0; i < 8; i += 1) await history(MINT, { ...primary, address: `${'1'.repeat(32)}${safe[i]}` });
  const r = await history(MINT, primary);
  assert.equal(r.status, 'unknown');
  assert.match(r.reason, /Batas lokal/);
  assert.equal(calls, 6);
});

test('error HTTP, timeout, JSON invalid, metadata hilang menjadi unknown bukan breakout', async () => {
  for (const fetcher of [async () => new Response('', { status: 404 }), async () => { throw new DOMException('timeout', 'TimeoutError'); }, async () => new Response('{'), async () => reply({ data: payload().data })]) {
    const gecko = createGeckoSource({ clock: () => NOW, fetcher });
    const r = await createHistoryProvider({ gecko, clock: () => NOW })(MINT, primary);
    assert.equal(r.status, 'unknown');
    assert.equal(r.watch.state, 'unknown');
    assert.equal(r.fetchedAt, null);
  }
});

test('riwayat stale/short/gap tetap unknown walau HTTP berhasil; fetchedAt bukan freshness candle', async () => {
  const variants = [rows(NOW - 3600000), rows().slice(-10), rows().filter((_, i) => i !== 5)];
  for (const data of variants) {
    const gecko = fakeGecko({ data });
    const r = await createHistoryProvider({ gecko, clock: () => NOW })(MINT, primary);
    assert.equal(r.status, 'unknown');
    assert.equal(r.watch.state, 'unknown');
    assert.equal(r.fetchedAt, new Date(NOW).toISOString());
  }
});

test('konteks entry tidak menyulap teknikal tersedia menjadi token aman', () => {
  const r = entryContext({ primary: { ...primary, liquidityUsd: 100, ageHours: 1 } }, { status: 'unknown' }, { watch: { title: 'Breakout watch' } });
  assert.match(r.title, /bukan keputusan buy/);
  assert.equal(r.cautions.length, 3);
  assert.match(r.cautions[0], /belum terverifikasi/);
});

test('scan HTTP menggabungkan history dan entryContext, cache tidak menghapus timestamp sumber', async t => {
  let calls = 0;
  const historyData = { ...normalizeHistory(sourceShape(), MINT, primary, NOW), fetchedAt: new Date(NOW).toISOString() };
  const server = createServer({ market: async () => ({ status: 'available', primary, pairs: [] }), risk: async () => ({ status: 'unknown' }), history: async (mint, p) => { assert.equal(mint, MINT); assert.equal(p.address, POOL); calls += 1; return historyData; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/scan?mint=${MINT}`;
  const first = await (await fetch(url)).json(), second = await (await fetch(url)).json();
  assert.deepEqual(first.history, historyData);
  assert.equal(second.cached, true);
  assert.equal(second.history.fetchedAt, first.history.fetchedAt);
  assert.equal(calls, 1);
  assert.match(first.entryContext.title, /bukan keputusan buy/);
});

test('volume tepat 1,5x memenuhi watch; close tepat resistance belum breakout', () => {
  const base = rows().map(r => [r[0], 100, 101, 99, 100, 100]);
  base[20] = [base[20][0], 100, 102, 99, 102, 150];
  assert.equal(analyzeCandles(base, { now: NOW }).watch.state, 'breakout');
  base[20] = [base[20][0], 100, 101, 99, 101, 150];
  assert.equal(analyzeCandles(base, { now: NOW }).watch.state, 'near_resistance');
});

test('range dan below-support bukan perintah transaksi; baseline volume nol unknown', () => {
  const data = rows().map(r => [r[0], 100, 110, 90, 100, 0]);
  let r = analyzeCandles(data, { now: NOW });
  assert.equal(r.watch.state, 'range');
  assert.equal(r.metrics.relativeVolume, null);
  assert.equal(r.signals.find(s => s.title === 'Konteks volume').level, 'unknown');
  data[20] = [data[20][0], 100, 101, 88, 89, 1];
  r = analyzeCandles(data, { now: NOW });
  assert.equal(r.watch.state, 'below_support');
});

test('hasil turunan overflow tidak menghasilkan watch palsu', () => {
  const data = rows().map(r => [r[0], 1e308, 1e308, 1e308, 1e308, 100]);
  const r = analyzeCandles(data, { now: NOW });
  assert.equal(r.status, 'unknown');
  assert.equal(r.metrics, null);
  assert.equal(r.watch.state, 'unknown');
});

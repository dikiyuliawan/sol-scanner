import test from 'node:test';
import assert from 'node:assert/strict';
import { createJupiterSource, normalizeJupiterToken } from '../sources/jupiter.mjs';
import { createDexScreenerSource, normalizeBatchPair } from '../sources/dexscreener.mjs';
import { createGeckoSource, normalizeTrendingPool } from '../sources/gecko.mjs';
import { createGoPlusSource, normalizeGoPlus } from '../sources/goplus.mjs';

const reply = data => new Response(JSON.stringify(data), { status: 200 });
const MINT = 'TokenMint1111111111111111111111111111111111';
const POOL = 'Poo1111111111111111111111111111111111111111';

test('normalizeJupiterToken mempertahankan audit, organic, dan statistik per interval', () => {
  const token = normalizeJupiterToken({
    id: MINT, symbol: 'EX', name: 'Example', isVerified: true, tags: ['verified'], organicScore: 81.5, organicScoreLabel: 'high',
    holderCount: 4200, liquidity: 750000, usdPrice: 0.42, mcap: 4000000, fdv: 5200000, tokenProgram: 'Tokenkeg',
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 18.2, devMints: 1 },
    stats1h: { priceChange: 1.2, buyVolume: 1000, sellVolume: 900, numNetBuyers: 42 }
  }, '2026-01-01T00:00:00.000Z');
  assert.equal(token.mint, MINT);
  assert.equal(token.organicLabel, 'high');
  assert.equal(token.audit.topHoldersPercentage, 18.2);
  assert.equal(token.stats['1h'].numNetBuyers, 42);
  assert.equal(normalizeJupiterToken({ nope: true }), null);
});

test('jupiter source memakai limit 100 dan menandai kegagalan sebagai unknown', async () => {
  let observed;
  const source = createJupiterSource({ clock: () => 1_800_000_000_000, fetcher: async (url) => { observed = url; return reply([{ id: MINT, symbol: 'EX' }]); } });
  const result = await source.topOrganic('1h', 500);
  assert.equal(result.status, 'available');
  assert.equal(result.tokens.length, 1);
  assert.match(observed, /toporganicscore\/1h\?limit=100$/);
  assert.equal(result.fetchedAt, new Date(1_800_000_000_000).toISOString());

  const failing = createJupiterSource({ fetcher: async () => new Response('', { status: 500 }) });
  const failed = await failing.topOrganic('1h', 10);
  assert.equal(failed.status, 'unknown');
  assert.match(failed.reason, /HTTP 500/);
});

test('jupiter source menolak interval yang tidak dikenal tanpa memanggil jaringan', async () => {
  let calls = 0;
  const source = createJupiterSource({ fetcher: async () => { calls += 1; return reply([]); } });
  await assert.rejects(() => source.topOrganic('7h', 10), /Interval/);
  assert.equal(calls, 0);
});

test('normalizeBatchPair mengabaikan chain lain dan mempertahankan nilai kosong sebagai null', () => {
  assert.equal(normalizeBatchPair({ chainId: 'ethereum' }), null);
  const pair = normalizeBatchPair({
    chainId: 'solana', pairAddress: POOL, dexId: 'raydium',
    baseToken: { address: MINT, symbol: 'EX' }, quoteToken: { address: 'SOL', symbol: 'SOL' },
    priceUsd: '0.5', liquidity: {}, volume: { h24: '1000' }, txns: {}, pairCreatedAt: 1_700_000_000_000
  }, 'now');
  assert.equal(pair.liquidityUsd, null);
  assert.equal(pair.volume.h24, 1000);
  assert.equal(pair.txns.h24, null);
  assert.equal(pair.priceUsd, 0.5);
});

test('dex batch memilih satu pool terbaik per mint dan memakai satu request', async () => {
  let calls = 0;
  const source = createDexScreenerSource({ clock: () => 1_800_000_000_000, fetcher: async () => {
    calls += 1;
    return reply([
      { chainId: 'solana', pairAddress: 'low', dexId: 'orca', baseToken: { address: MINT }, quoteToken: { address: 'SOL' }, liquidity: { usd: 1000 } },
      { chainId: 'solana', pairAddress: 'high', dexId: 'raydium', baseToken: { address: MINT }, quoteToken: { address: 'SOL' }, liquidity: { usd: 9000 } }
    ]);
  } });
  const result = await source.batch([MINT, MINT]);
  assert.equal(calls, 1);
  assert.equal(result.status, 'available');
  assert.equal(result.pools.get(MINT).poolAddress, 'high');
});

test('dex batch memecah daftar menjadi beberapa request 30 mint', async () => {
  const requested = [];
  const source = createDexScreenerSource({ fetcher: async url => { requested.push(url); return reply([]); } });
  const mints = Array.from({ length: 45 }, (_, index) => `Mint${String(index).padStart(6, '0')}`);
  const result = await source.batch(mints);
  assert.equal(requested.length, 2, '45 mint menjadi 2 request');
  assert.equal(requested[0].split('/').at(-1).split(',').length, 30);
  assert.equal(requested[1].split('/').at(-1).split(',').length, 15);
  assert.equal(result.requested, 45);
  assert.equal(result.batches, 2);

  const failing = createDexScreenerSource({ fetcher: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  const failed = await failing.batch([MINT]);
  assert.equal(failed.status, 'unknown');
  assert.match(failed.reason, /batas waktu/);
});

test('normalizeTrendingPool membaca hubungan token dan volume', () => {
  const createdAt = '2024-01-01T00:00:00.000Z';
  const pool = normalizeTrendingPool({
    attributes: { address: POOL, name: 'EX / SOL', pool_created_at: createdAt, reserve_in_usd: '250000', fdv_usd: '1000000', volume_usd: { h24: '50000' }, price_change_percentage: { h1: '2.5' } },
    relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: 'solana_SOL' } } }
  }, 'now');
  assert.equal(pool.mint, MINT);
  assert.equal(pool.liquidityUsd, 250000);
  assert.equal(pool.volume.h24, 50000);
  assert.equal(pool.change.h1, 2.5);
  assert.equal(pool.createdAt, Date.parse(createdAt));
  assert.equal(pool.source, 'GeckoTerminal');
  assert.equal(normalizeTrendingPool({ attributes: {} }, 'now'), null);
});

test('gecko candle menolak pool tidak valid tanpa memanggil jaringan', async () => {
  let calls = 0;
  const source = createGeckoSource({ fetcher: async () => { calls += 1; return reply({}); } });
  const result = await source.candles('bad/../pool', MINT);
  assert.equal(result.status, 'unknown');
  assert.equal(calls, 0);
});

test('gecko candle meminta timeframe dan token yang eksplisit', async () => {
  let observed;
  const source = createGeckoSource({ fetcher: async (url, options) => { observed = { url, options }; return reply({ data: { attributes: { ohlcv_list: [[1, 1, 1, 1, 1, 1]] } }, meta: {} }); } });
  const result = await source.candles(POOL, MINT, { granularity: 'hour', aggregate: 1, limit: 200 });
  assert.equal(result.status, 'available');
  const url = new URL(observed.url);
  assert.equal(url.pathname, `/api/v2/networks/solana/pools/${POOL}/ohlcv/hour`);
  assert.equal(url.searchParams.get('aggregate'), '1');
  assert.equal(url.searchParams.get('token'), MINT);
  assert.equal(url.searchParams.get('include_empty_intervals'), 'true');
  assert.equal(observed.options.headers.Accept, 'application/json;version=20230203');
});

test('gecko 429 memicu cooldown dan request berikutnya tidak menembak origin', async () => {
  let calls = 0, now = 1_800_000_000_000;
  const source = createGeckoSource({ clock: () => now, fetcher: async () => { calls += 1; return new Response('', { status: 429, headers: { 'retry-after': '60' } }); } });
  const first = await source.trending(1);
  assert.equal(first.status, 'unknown');
  const second = await source.trending(2);
  assert.match(second.reason, /cooldown|Batas/);
  assert.equal(calls, 1);
  now += 61_000;
  await source.trending(3);
  assert.equal(calls, 2);
});

test('normalizeGoPlus menjumlahkan top10 dan mendeteksi transfer fee/hook', () => {
  const record = normalizeGoPlus({
    mintable: { status: '0' }, freezable: { status: '0' }, non_transferable: '0',
    transfer_fee: {}, transfer_hook: [], metadata_mutable: { status: '0' },
    holder_count: '5000',
    holders: Array.from({ length: 12 }, (_, index) => ({ percent: String(index < 10 ? 0.02 : 0.01) })),
    lp_holders: [{ percent: '0.30' }, { percent: '0.20' }],
    trusted_token: 1
  }, 'now');
  assert.equal(record.mintable, false);
  assert.equal(record.freezable, false);
  assert.equal(record.top10Pct, 20);
  assert.equal(record.lpHolderPct, 50);
  assert.equal(record.transferFee, false);
  assert.equal(record.transferHook, false);
  assert.equal(record.holderCount, 5000);
});

test('normalizeGoPlus menghitung sepuluh holder terbesar walau respons tidak terurut', () => {
  const record = normalizeGoPlus({
    holders: [...Array(10).fill({ percent: '0.01' }), { percent: '0.20' }, { percent: '0.20' }]
  }, 'now');
  assert.equal(record.top10Pct, 48);
});

test('goplus source memetakan record, unknown bila tidak ada, dan validasi mint', async () => {
  const source = createGoPlusSource({ clock: () => 1_800_000_000_000, fetcher: async () => reply({ code: 1, result: { [MINT]: { mintable: { status: '0' }, freezable: { status: '0' }, non_transferable: '0', transfer_fee: {}, transfer_hook: [], holders: [], holder_count: '10' } } }) });
  const result = await source.security(MINT);
  assert.equal(result.status, 'available');
  assert.equal(result.security.mintable, false);

  const empty = createGoPlusSource({ fetcher: async () => reply({ code: 1, result: {} }) });
  const missing = await empty.security(MINT);
  assert.equal(missing.status, 'unknown');
  assert.match(missing.reason, /bukan bukti aman/);

  let calls = 0;
  const invalid = createGoPlusSource({ fetcher: async () => { calls += 1; return reply({}); } });
  assert.equal((await invalid.security('bad')).status, 'unknown');
  assert.equal(calls, 0);
});

test('goplus marks a returned record with missing contract controls as partial', async () => {
  const source = createGoPlusSource({ fetcher: async () => reply({ code: 1, result: { [MINT]: { mintable: { status: '0' }, freezable: { status: '0' } } } }) });
  const result = await source.security(MINT);
  assert.equal(result.status, 'partial');
  assert.equal(result.security.transferFee, null);
  assert.equal(result.security.transferHook, null);
});

test('goplus source menangani timeout sebagai unknown tanpa melempar', async () => {
  const source = createGoPlusSource({ fetcher: async () => { throw new DOMException('timeout', 'TimeoutError'); } });
  const result = await source.security(MINT);
  assert.equal(result.status, 'unknown');
  assert.match(result.reason, /batas waktu/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createDexScreenerSource, normalizeBatchPair, resolveForMint, pickMainPool, betterPool } from '../sources/dexscreener.mjs';
import { createGoPlusSource, normalizeGoPlus } from '../sources/goplus.mjs';
import { createJupiterSource } from '../sources/jupiter.mjs';
import { createCache } from '../lib/cache.mjs';
import { createLimiter } from '../lib/limiter.mjs';
import { evaluateGates } from '../screen/gates.mjs';
import { scoreCandidate } from '../screen/score.mjs';
import { getPreset } from '../config.mjs';
import { rotate } from '../discover.mjs';

const MINT = 'TokenMint1111111111111111111111111111111111';
const OTHER = 'OtherMint111111111111111111111111111111111';
const SOL = 'So11111111111111111111111111111111111111112';
const NOW = 1_800_000_000_000;
const reply = data => new Response(JSON.stringify(data), { status: 200 });
const balanced = getPreset('balanced');

function pair(overrides = {}) {
  return {
    chainId: 'solana', pairAddress: 'pair-1', dexId: 'raydium',
    baseToken: { address: MINT, symbol: 'EX' }, quoteToken: { address: SOL, symbol: 'SOL' },
    priceUsd: '0.5', marketCap: '5000000', fdv: '6000000', priceChange: { h24: '9' },
    liquidity: { usd: '500000' }, volume: { h24: '500000' }, txns: { h24: { buys: 800, sells: 600 } },
    pairCreatedAt: NOW - 72 * 3600000,
    ...overrides
  };
}

test('harga dan valuasi milik token base, bukan token quote', () => {
  const normalized = normalizeBatchPair(pair(), 'now');
  const asBase = resolveForMint(normalized, MINT);
  assert.equal(asBase.targetIsBase, true);
  assert.equal(asBase.priceUsd, 0.5);
  assert.equal(asBase.marketCap, 5000000);
  assert.equal(asBase.change.h24, 9);

  const asQuote = resolveForMint(normalized, SOL);
  assert.equal(asQuote.targetIsBase, false);
  assert.equal(asQuote.priceUsd, null, 'harga base tidak boleh dipakai sebagai harga quote');
  assert.equal(asQuote.marketCap, null);
  assert.equal(asQuote.fdv, null);
  assert.equal(asQuote.change.h24, null);
  assert.equal(asQuote.liquidityUsd, 500000, 'likuiditas pool tetap milik kedua token');
});

test('pool utama yang dipilih adalah pool dengan mint sebagai base token', () => {
  const base = resolveForMint(normalizeBatchPair(pair({ pairAddress: 'base', liquidity: { usd: '1000' } }), 'now'), MINT);
  const quote = resolveForMint(normalizeBatchPair(pair({ pairAddress: 'quote', baseToken: { address: OTHER, symbol: 'OTH' }, quoteToken: { address: MINT, symbol: 'EX' }, liquidity: { usd: '9000' } }), 'now'), MINT);
  assert.equal(betterPool(base, quote), true, 'pool base menang walau likuiditasnya lebih kecil');
  assert.equal(pickMainPool([quote, base], MINT).poolAddress, 'base');
});

test('batch DEX Screener tidak pernah mengatribusikan harga token base ke mint yang jadi quote', async () => {
  const source = createDexScreenerSource({ clock: () => NOW, fetcher: async () => reply([
    pair({ pairAddress: 'quote-side', baseToken: { address: OTHER, symbol: 'OTH' }, quoteToken: { address: MINT, symbol: 'EX' }, priceUsd: '999', marketCap: '88888888', priceChange: { h24: '77' } })
  ]) });
  const result = await source.batch([MINT]);
  const pool = result.pools.get(MINT);
  assert.equal(pool.targetIsBase, false);
  assert.equal(pool.priceUsd, null, 'harga 999 milik token lain tidak boleh muncul');
  assert.equal(pool.marketCap, null);
  assert.equal(pool.change.h24, null);
  assert.equal(pool.liquidityUsd, 500000);
});

test('batch memilih pool base walau ada pool quote yang lebih likuid', async () => {
  const source = createDexScreenerSource({ clock: () => NOW, fetcher: async () => reply([
    pair({ pairAddress: 'quote-side', baseToken: { address: OTHER, symbol: 'OTH' }, quoteToken: { address: MINT, symbol: 'EX' }, liquidity: { usd: '9000000' } }),
    pair({ pairAddress: 'base-side', liquidity: { usd: '500000' } })
  ]) });
  const result = await source.batch([MINT]);
  const pool = result.pools.get(MINT);
  assert.equal(pool.poolAddress, 'base-side');
  assert.equal(pool.priceUsd, 0.5);
});

test('mainPool membaca pool utama provider untuk satu mint', async () => {
  let observed = '';
  const source = createDexScreenerSource({ clock: () => NOW, fetcher: async url => { observed = url; return reply([pair({ pairAddress: 'real-main' })]); } });
  const result = await source.mainPool(MINT);
  assert.equal(result.status, 'available');
  assert.equal(result.pool.poolAddress, 'real-main');
  assert.match(observed, /token-pairs\/v1\/solana/);
});

test('cache dapat dilewati untuk sampling baru tanpa kehilangan single-flight', async () => {
  let calls = 0;
  const cache = createCache({ ttlMs: 60_000, clock: () => NOW });
  const producer = async () => { calls += 1; return calls; };
  const first = await cache.resolve('k', producer);
  const cached = await cache.resolve('k', producer);
  assert.equal(cached.cached, true);
  assert.equal(cached.value, first.value);
  const bypassed = await cache.resolve('k', producer, { bypass: true });
  assert.equal(bypassed.cached, false);
  assert.equal(bypassed.value, 2, 'cache dilewati dan nilai baru diambil');
  assert.equal(calls, 2);
});

test('hasil negatif GoPlus tidak di-cache sehingga token baru tidak terkunci unknown', async () => {
  let calls = 0;
  const source = createGoPlusSource({ clock: () => NOW, fetcher: async () => { calls += 1; return reply({ code: 1, result: {} }); } });
  const first = await source.security(MINT);
  assert.equal(first.status, 'unknown');
  const second = await source.security(MINT);
  assert.equal(second.status, 'unknown');
  assert.equal(calls, 2, 'record yang tidak ada tidak boleh bertahan di cache');
});

test('transfer fee dan hook boolean false dibaca sebagai tidak ada, bukan unknown', () => {
  const record = normalizeGoPlus({ mintable: { status: '0' }, freezable: { status: '0' }, non_transferable: '0', transfer_fee: false, transfer_hook: false }, 'now');
  assert.equal(record.transferFee, false);
  assert.equal(record.transferHook, false);
  assert.notEqual(record.transferFee, null);
});

test('gate konsentrasi memakai satu sumber dan tidak berubah karena sumber lain datang', () => {
  const candidate = {
    mint: MINT, now: NOW,
    jupiter: { holderCount: 5000, organicScore: 70, organicLabel: 'high', audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15 } },
    market: { pool: { poolAddress: 'p', liquidityUsd: 500000, volume: { h24: 500000 }, marketCap: 5000000, fdv: 5000000, createdAt: NOW - 72 * 3600000, change: { h24: 5 } } },
    safety: { status: 'unknown', security: null },
    structure: null
  };
  const before = evaluateGates(candidate, balanced);
  assert.equal(before.passed, true);
  assert.equal(before.rejections.some(item => item.code === 'concentration_high'), false);

  // GoPlus arrived with a much larger reading; it must not flip the gate.
  const withGoPlus = { ...candidate, safety: { status: 'available', security: { mintable: false, freezable: false, nonTransferable: false, transferFee: false, transferHook: false, top10Pct: 65, holderCount: 5000 } } };
  const after = evaluateGates(withGoPlus, balanced);
  assert.equal(after.passed, true, 'gate tidak boleh berubah karena pembaca kedua punya definisi berbeda');
  assert.ok(after.warnings.some(item => item.code === 'concentration_goplus_high'), 'pembaca kedua tetap dilaporkan');
  assert.match(after.warnings.find(item => item.code === 'concentration_goplus_high').reason, /65.0%/);
});

test('gate konsentrasi menolak kalau sumber gate sendiri melewati ambang', () => {
  const candidate = {
    mint: MINT, now: NOW,
    jupiter: { holderCount: 5000, organicScore: 70, organicLabel: 'high', audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 80 } },
    market: { pool: { poolAddress: 'p', liquidityUsd: 500000, volume: { h24: 500000 }, marketCap: 5000000, fdv: 5000000, createdAt: NOW - 72 * 3600000, change: { h24: 5 } } },
    safety: { status: 'unknown', security: null },
    structure: null
  };
  const gates = evaluateGates(candidate, balanced);
  assert.ok(gates.rejections.some(item => item.code === 'concentration_high'));
  assert.match(gates.rejections.find(item => item.code === 'concentration_high').reason, /Jupiter/);
});

test('bukti konsentrasi menyebut sumber yang benar dan tidak menukar GoPlus dengan Jupiter', () => {
  const candidate = {
    mint: MINT, now: NOW,
    jupiter: { holderCount: 5000, organicScore: 70, organicLabel: 'high', audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15 } },
    market: { pool: { poolAddress: 'p', source: 'DEX Screener', liquidityUsd: 500000, volume: { h24: 500000 }, marketCap: 5000000, fdv: 5000000, createdAt: NOW - 72 * 3600000, change: { h24: 5 } } },
    safety: { status: 'available', security: { mintable: false, freezable: false, nonTransferable: false, transferFee: false, transferHook: false, top10Pct: 65, holderCount: 5000 } },
    structure: null
  };
  const scored = scoreCandidate(candidate, balanced);
  const safety = scored.components.find(item => item.key === 'safety');
  const primary = safety.evidence.find(item => item.metric === 'Top 10 holder');
  const secondary = safety.evidence.find(item => item.metric === 'Top 10 holder (pembaca kedua)');
  assert.equal(primary.source, 'Jupiter');
  assert.equal(primary.value, '15.0%');
  assert.equal(secondary.source, 'GoPlus (termasuk wallet exchange/program)');
  assert.equal(secondary.value, '65.0%');
});

test('evidence likuiditas menyebut sumber pool sebenarnya', () => {
  const candidate = {
    mint: MINT, now: NOW,
    jupiter: { holderCount: 5000, organicScore: 70, organicLabel: 'high', audit: { topHoldersPercentage: 15 } },
    market: { pool: { poolAddress: 'p', source: 'GeckoTerminal', liquidityUsd: 500000, volume: { h24: 500000 }, marketCap: 5000000, fdv: 5000000, createdAt: NOW - 72 * 3600000, change: { h24: 5 } } },
    safety: { status: 'unknown', security: null },
    structure: null
  };
  const scored = scoreCandidate(candidate, balanced);
  const liquidity = scored.components.find(item => item.key === 'liquidity');
  assert.equal(liquidity.evidence.find(item => item.metric === 'Likuiditas pool').source, 'GeckoTerminal');
});

test('market cap yang tidak dilaporkan memberi peringatan, bukan lolos diam-diam', () => {
  const candidate = {
    mint: MINT, now: NOW,
    jupiter: { holderCount: 5000, organicScore: 70, organicLabel: 'high', audit: { topHoldersPercentage: 15 } },
    market: { pool: { poolAddress: 'p', liquidityUsd: 500000, volume: { h24: 500000 }, marketCap: null, fdv: null, createdAt: NOW - 72 * 3600000, change: { h24: 5 } } },
    safety: { status: 'unknown', security: null },
    structure: null
  };
  const gates = evaluateGates(candidate, balanced);
  assert.ok(gates.warnings.some(item => item.code === 'mcap_unknown'));
});

/* ---------------- kesegaran universe dan antrean ---------------- */

test('limiter menunggu slot tersedia alih-alih menolak', async () => {
  let now = 0;
  const limiter = createLimiter({ clock: () => now, sleep: async () => { now += 1000; } });
  assert.equal(limiter.tryTake('x', 2).ok, true);
  assert.equal(limiter.tryTake('x', 2).ok, true);
  const decision = await limiter.wait('x', 2, 60_000, { maxWaitMs: 10_000 });
  assert.equal(decision.ok, true, 'slot harus tersedia setelah jendela bergeser');
});

test('limiter wait menyisakan kuota untuk permintaan interaktif', async () => {
  let now = 0;
  const limiter = createLimiter({ clock: () => now, sleep: async () => { now += 1000; } });
  // Latar memakai 8 dari 10 slot; dua slot sisanya untuk interaktif.
  for (let i = 0; i < 8; i += 1) await limiter.wait('gecko', 10, 60_000, { reserve: 2, maxWaitMs: 50 });
  assert.equal(limiter.tryTake('gecko', 10).ok, true, 'permintaan interaktif masih mendapat slot');
  assert.equal(limiter.tryTake('gecko', 10).ok, true, 'slot kedua untuk interaktif');
  assert.equal(limiter.tryTake('gecko', 10).ok, false, 'slot kesembilan sudah dipakai latar');
});

test('rotasi daftar membuat potongan berbeda antar jendela waktu', async () => {
  const list = Array.from({ length: 20 }, (_, index) => ({ mint: `M${index}` }));
  const window0 = rotate(list, 0);
  const window1 = rotate(list, 1);
  assert.deepEqual(window0.slice(0, 5), list.slice(0, 5), 'posisi teratas tetap dipakai');
  assert.notDeepEqual(window0, window1, 'jendela berikutnya harus mengambil potongan berbeda');
  assert.equal(window0.length, list.length);
  assert.equal(new Set(window0.map(item => item.mint)).size, list.length, 'rotasi tidak boleh mengubah token');
});

test('rotasi mengembalikan daftar yang sama untuk jendela yang sama', () => {
  const list = Array.from({ length: 20 }, (_, index) => ({ mint: `M${index}` }));
  assert.deepEqual(rotate(list, 3), rotate(list, 3));
});

/* ---------------- ketahanan terhadap penyedia yang diblokir ---------------- */

test('pemutus arus menjeda penyedia yang gagal berulang dan menyebut penyebabnya', async () => {
  let now = 0;
  const source = createJupiterSource({ clock: () => now, fetcher: async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); } });
  const first = await source.topOrganic('1h', 10);
  assert.equal(first.status, 'unknown');
  assert.match(first.reason, /ECONNRESET/, 'kode penyebab jaringan ikut dilaporkan');

  // Setelah beberapa kegagalan berturut-turut, provider dijeda.
  for (let i = 0; i < 3; i += 1) await source.topOrganic('1h', 10);
  const blocked = await source.topOrganic('1h', 10);
  assert.match(blocked.reason, /tidak dapat dihubungi/, 'pesan harus menyebut penyedia sedang diblokir');
  assert.match(blocked.reason, /jeda \d+ detik/);
});

test('request gagal/network diulang sekali, sedangkan jawaban 4xx tidak diulang', async () => {
  let calls = 0;
  const source = createJupiterSource({ clock: () => 1_800_000_000_000, fetcher: async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
    return new Response(JSON.stringify([{ id: MINT }]), { status: 200 });
  } });
  const result = await source.topOrganic('1h', 10);
  assert.equal(result.status, 'available');
  assert.equal(calls, 2, 'kegagalan jaringan diulang sekali lalu berhasil');

  let badCalls = 0;
  const failing = createJupiterSource({ clock: () => 1_800_000_000_000, fetcher: async () => { badCalls += 1; return new Response('', { status: 400 }); } });
  await failing.topOrganic('1h', 10);
  assert.equal(badCalls, 1, 'jawaban 4xx tidak boleh diulang');
});

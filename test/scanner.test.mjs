import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, fetchMarket, normalizeMarket, number, validMint } from '../server.mjs';

const WSOL = 'So11111111111111111111111111111111111111112';
const ALL_ONES = '11111111111111111111111111111111';
const MINT = 'TokenMint1111111111111111111111111111111111';

function pool(overrides = {}) {
  return {
    chainId: 'solana',
    pairAddress: 'pair-1',
    dexId: 'raydium',
    baseToken: { address: MINT, name: 'Example Token', symbol: 'EX', ...overrides.baseToken },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL', symbol: 'SOL', ...overrides.quoteToken },
    priceUsd: '2.5',
    marketCap: '1000000',
    fdv: '1200000',
    priceChange: { h24: '3.2' },
    liquidity: { usd: '75000' },
    volume: { h24: '12000' },
    txns: { h24: { buys: 10, sells: 4 } },
    pairCreatedAt: 1_700_000_000_000,
    ...overrides
  };
}

test('validMint menerima WSOL dan alamat base58 32 byte berupa semua angka 1', () => {
  assert.equal(validMint(WSOL), true);
  assert.equal(validMint(ALL_ONES), true);
});

test('validMint menolak input tidak valid, karakter 0/O, panjang berlebih, dan injection', () => {
  for (const value of [null, undefined, 42, '', '0', 'O'.repeat(32), '1'.repeat(45), `${ALL_ONES}/../../etc/passwd`, `${ALL_ONES};alert(1)`]) {
    assert.equal(validMint(value), false, `seharusnya invalid: ${String(value)}`);
  }
});

test('number membedakan nilai tidak tersedia dari angka nol', () => {
  assert.equal(number(null), null);
  assert.equal(number(undefined), null);
  assert.equal(number('   '), null);
  assert.equal(number(0), 0);
  assert.equal(number('0'), 0);
  assert.equal(number('12.5'), 12.5);
  assert.equal(number('Infinity'), null);
});

test('normalizeMarket memilih pool base Solana paling likuid dan mengabaikan pool tak terkait/chain lain', () => {
  const now = 1_700_100_000_000;
  const low = pool({ pairAddress: 'base-lower', liquidity: { usd: 60_000 } });
  const high = pool({ pairAddress: 'base-primary', liquidity: { usd: 90_000 } });
  const quoteOnly = pool({
    pairAddress: 'quote-only',
    baseToken: { address: 'OtherBase11111111111111111111111111111111', name: 'Other', symbol: 'OTH' },
    quoteToken: { address: MINT, name: 'Example Token', symbol: 'EX' },
    liquidity: { usd: 200_000 },
    priceUsd: '999', marketCap: '888888'
  });
  const unrelated = pool({ baseToken: { address: 'Unrelated1111111111111111111111111111111' }, quoteToken: { address: 'AlsoOther11111111111111111111111111111111' } });
  const otherChain = pool({ chainId: 'ethereum', pairAddress: 'wrong-chain', liquidity: { usd: 999_999 } });

  const result = normalizeMarket([low, quoteOnly, unrelated, otherChain, high], MINT, now);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.pairs.map(p => p.address), ['quote-only', 'base-primary', 'base-lower']);
  assert.equal(result.primary.address, 'base-primary');
  assert.equal(result.primary.targetIsBase, true);
  assert.equal(result.primary.priceUsd, 2.5);
  assert.equal(result.pairs.some(p => p.address === 'wrong-chain' || p.address === unrelated.pairAddress), false);
  assert.equal(result.pairs[0].targetIsBase, false);
  assert.equal(result.pairs[0].priceUsd, null);
  assert.equal(result.pairs[0].marketCap, null);
  assert.equal(result.pairs[0].fdv, null);
  assert.equal(result.pairs[0].change24h, null);
});

test('normalizeMarket mempertahankan missing sebagai unknown, bukan nol, dan memberi sinyal ambang lokal', () => {
  const now = 1_700_100_000_000;
  const sparseYoung = pool({
    pairAddress: 'sparse',
    priceUsd: undefined,
    marketCap: undefined,
    liquidity: {},
    volume: {},
    txns: {},
    pairCreatedAt: now - 2 * 60 * 60 * 1000
  });
  const result = normalizeMarket([sparseYoung], MINT, now);
  assert.equal(result.primary.priceUsd, null);
  assert.equal(result.primary.marketCap, null);
  assert.equal(result.primary.liquidityUsd, null);
  assert.equal(result.primary.volume24h, null);
  assert.equal(result.primary.buys24h, null);
  assert.equal(result.primary.ageHours, 2);
  assert.equal(result.signals.find(s => s.title === 'Likuiditas unknown')?.level, 'unknown');
  assert.equal(result.signals.find(s => s.title === 'Pool berusia di bawah 24 jam')?.level, 'warning');

  const thinOld = pool({
    liquidity: { usd: 49_999 },
    pairCreatedAt: now - 25 * 60 * 60 * 1000
  });
  const thresholdResult = normalizeMarket([thinOld], MINT, now);
  assert.equal(thresholdResult.signals.find(s => s.title === 'Likuiditas pool tipis')?.level, 'warning');
  assert.equal(thresholdResult.signals.find(s => s.title === 'Usia pool teramati')?.level, 'info');
});

test('normalizeMarket menangani daftar kosong dan skema yang salah', () => {
  const empty = normalizeMarket([], MINT);
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.pairs, []);
  assert.equal(empty.primary, null);
  assert.equal(empty.signals[0]?.level, 'unknown');
  assert.throws(() => normalizeMarket({ pairs: [] }, MINT), /Skema respons bukan daftar pool/);
});

test('normalizeMarket menandai mint quote-only tanpa mengatribusikan harga/valuasi base', () => {
  const quoteOnly = pool({
    baseToken: { address: 'DifferentBase111111111111111111111111111111' },
    quoteToken: { address: MINT, symbol: 'EX' },
    priceUsd: '42', marketCap: '900000', fdv: '950000'
  });
  const result = normalizeMarket([quoteOnly], MINT);
  assert.equal(result.status, 'available');
  assert.equal(result.primary, null);
  assert.equal(result.pairs[0].priceUsd, null);
  assert.equal(result.pairs[0].marketCap, null);
  assert.equal(result.signals[0].level, 'unknown');
  assert.match(result.signals[0].title, /Harga token unknown/);
});

test('fetchMarket merapikan HTTP 429, timeout, dan skema malformed menjadi status unknown', async (t) => {
  const cases = [
    ['429', async () => new Response('rate limited', { status: 429 }), /HTTP 429/],
    ['timeout', async () => { throw new DOMException('request timed out', 'TimeoutError'); }, /batas waktu 10 detik/],
    ['malformed schema', async () => new Response('{"unexpected":true}', { status: 200 }), /Skema respons bukan daftar pool/]
  ];
  for (const [label, fetcher, reasonPattern] of cases) {
    await t.test(label, async () => {
      const result = await fetchMarket(MINT, fetcher);
      assert.equal(result.status, 'unknown');
      assert.equal(result.primary, null);
      assert.deepEqual(result.pairs, []);
      assert.match(result.reason, reasonPattern);
      assert.match(result.endpoint, new RegExp(`/solana/${MINT}$`));
    });
  }
});

async function withServer(t, server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('createServer menolak mint invalid dan method non-GET, serta membatasi static path', async t => {
  const base = await withServer(t, createServer({ market: async () => ({}), risk: async () => ({}) }));
  const invalid = await fetch(`${base}/api/scan?mint=0`);
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /base58/);

  const method = await fetch(`${base}/api/health`, { method: 'POST' });
  assert.equal(method.status, 405);
  assert.match((await method.json()).error, /Hanya GET/);

  for (const path of ['/not-a-static-file', '/%2e%2e/server.mjs', '/..%2fserver.mjs']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
  }
});

test('createServer mengembalikan hasil scan injected dan memakai cache untuk scan berulang', async t => {
  let marketCalls = 0;
  let riskCalls = 0;
  const marketData = { status: 'available', pairs: [], primary: null, source: 'mock' };
  const riskData = { status: 'unknown', score: null };
  const base = await withServer(t, createServer({
    market: async mint => { marketCalls++; return { ...marketData, requestedMint: mint }; },
    risk: async mint => { riskCalls++; return { ...riskData, requestedMint: mint }; }
  }));

  const firstResponse = await fetch(`${base}/api/scan?mint=${MINT}`);
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(first.mint, MINT);
  assert.equal(first.cached, false);
  assert.deepEqual(first.market, { ...marketData, requestedMint: MINT });
  assert.deepEqual(first.risk, { ...riskData, requestedMint: MINT });
  assert.match(first.disclaimer, /Read-only/);
  assert.ok(Number.isFinite(Date.parse(first.checkedAt)));

  const secondResponse = await fetch(`${base}/api/scan?mint=${MINT}`);
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(second.cached, true);
  assert.equal(second.mint, MINT);
  assert.equal(marketCalls, 1);
  assert.equal(riskCalls, 1);
});

test('createServer meneruskan hasil pasar partial/unknown tanpa mengubahnya menjadi angka atau sukses semu', async t => {
  const partialMarket = {
    status: 'unknown', source: 'DEX Screener', pairs: [], primary: null,
    reason: 'Data pasar unknown: HTTP 429. Coba lagi nanti.', signals: []
  };
  const partialRisk = { status: 'unknown', score: null, reason: 'Sumber risiko tidak tersedia.' };
  const base = await withServer(t, createServer({ market: async () => partialMarket, risk: async () => partialRisk }));
  const response = await fetch(`${base}/api/scan?mint=${MINT}`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.market, partialMarket);
  assert.deepEqual(result.risk, partialRisk);
  assert.equal(result.market.status, 'unknown');
  assert.equal(result.risk.score, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates } from '../screen/gates.mjs';
import { estimateSlippage, gradeFor, scoreCandidate } from '../screen/score.mjs';
import { mergeUniverse, rankCandidates } from '../screen/rank.mjs';
import { getPreset, EXCLUDED_MINTS } from '../config.mjs';

const NOW = 1_800_000_000_000;
const balanced = getPreset('balanced');

function candidate(overrides = {}) {
  const pool = {
    poolAddress: 'Pool111111111111111111111111111111111111111',
    dex: 'raydium',
    baseMint: 'TokenMint1111111111111111111111111111111111',
    quoteMint: 'So11111111111111111111111111111111111111112',
    baseSymbol: 'EX',
    quoteSymbol: 'SOL',
    priceUsd: 0.5,
    liquidityUsd: 500_000,
    marketCap: 5_000_000,
    fdv: 6_000_000,
    createdAt: NOW - 72 * 3_600_000,
    change: { m5: 0.1, h1: 1.5, h6: 4, h24: 12 },
    volume: { m5: 1000, h1: 50_000, h6: 200_000, h24: 600_000 },
    txns: { h24: { buys: 1200, sells: 900 } },
    ...(overrides.pool ?? {})
  };
  const jupiter = {
    mint: 'TokenMint1111111111111111111111111111111111',
    symbol: 'EX', name: 'Example',
    tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    isVerified: true, tags: ['verified'],
    organicScore: 70, organicLabel: 'high',
    holderCount: 5000, liquidityUsd: 900_000,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 22, devMints: 1 },
    stats: { '1h': { numNetBuyers: 60, buyOrganicVolume: 3000, buyVolume: 10_000, priceChange: 1.5 }, '6h': {}, '24h': {}, '5m': {} },
    ...(overrides.jupiter ?? {})
  };
  return {
    mint: 'TokenMint1111111111111111111111111111111111',
    now: NOW,
    jupiter,
    market: { pool, status: 'available' },
    safety: { status: 'unknown', security: null },
    structure: null,
    notionalUsd: 500,
    ...overrides
  };
}

test('gates meloloskan kandidat sehat dan mencatat safety unknown sebagai warning', () => {
  const gates = evaluateGates(candidate(), balanced);
  assert.equal(gates.passed, true, JSON.stringify(gates.rejections));
  assert.ok(gates.warnings.some(warning => warning.code === 'safety_unknown'));
});

test('gates menolak likuiditas tipis, pool baru, dan turnover ekstrem', () => {
  const thin = evaluateGates(candidate({ pool: { liquidityUsd: 10_000 } }), balanced);
  assert.ok(thin.rejections.some(item => item.code === 'liquidity_low'));
  const young = evaluateGates(candidate({ pool: { createdAt: NOW - 3_600_000 } }), balanced);
  assert.ok(young.rejections.some(item => item.code === 'pool_too_new'));
  const wash = evaluateGates(candidate({ pool: { volume: { h24: 90_000_000, h1: 1 } } }), balanced);
  assert.ok(wash.rejections.some(item => item.code === 'turnover_high'));
});

test('balanced memakai ambang lebih ketat dan gate menolak penurunan tajam 24 jam', () => {
  assert.equal(balanced.minPoolAgeHours, 48);
  assert.equal(balanced.maxTop10Pct, 30);
  assert.equal(balanced.maxFdvToMcap, 1.5);
  assert.equal(balanced.maxTurnover, 10);
  const falling = evaluateGates(candidate({ pool: { change: { h24: -31 } } }), balanced);
  assert.ok(falling.rejections.some(item => item.code === 'price_change_24h_low'));
  const withinLimit = evaluateGates(candidate({ pool: { change: { h24: -30 } } }), balanced);
  assert.ok(!withinLimit.rejections.some(item => item.code === 'price_change_24h_low'));
});

test('likuiditas minimum Degen selaras dengan batas slippage untuk notional default', () => {
  const degen = getPreset('degen');
  assert.equal(degen.minLiquidityUsd, 60_000);
  assert.ok(estimateSlippage(degen.minLiquidityUsd, 500) <= 2);
});

test('gates menolak mint authority aktif dan transfer fee', () => {
  const mintable = evaluateGates(candidate({ safety: { status: 'available', security: { mintable: true, freezable: false, top10Pct: 20, holderCount: 5000 } } }), balanced);
  assert.ok(mintable.rejections.some(item => item.code === 'mintable'));
  const fee = evaluateGates(candidate({ safety: { status: 'available', security: { mintable: false, freezable: false, transferFee: { fee: 5 }, top10Pct: 20, holderCount: 5000 } } }), balanced);
  assert.ok(fee.rejections.some(item => item.code === 'transfer_fee'));
});

test('GoPlus record parsial tidak mengubah kontrol kontrak unknown menjadi aman', () => {
  const partial = { status: 'partial', security: { mintable: false, freezable: false, nonTransferable: null, transferFee: false, transferHook: false, top10Pct: 20, holderCount: 5000 } };
  const permissive = evaluateGates(candidate({ safety: partial }), balanced);
  assert.equal(permissive.passed, true);
  assert.ok(permissive.warnings.some(item => item.code === 'safety_unknown'));
  const partialScore = scoreCandidate(candidate({ safety: partial }), balanced);
  assert.equal(partialScore.grade, 'C');
  assert.ok(partialScore.penalties.some(item => item.code === 'safety_unknown'));

  const strict = evaluateGates(candidate({ safety: partial }), { ...balanced, allowUnknownSafety: false });
  assert.ok(strict.rejections.some(item => item.code === 'safety_unknown'));

  const hazardousPartial = evaluateGates(candidate({ safety: { ...partial, security: { ...partial.security, mintable: true } } }), balanced);
  assert.ok(hazardousPartial.rejections.some(item => item.code === 'mintable'));
});

test('gates menolak aset dasar, tag stable, dan konsentrasi holder tinggi', () => {
  const base = evaluateGates(candidate({ mint: [...EXCLUDED_MINTS][0] }), balanced);
  assert.ok(base.rejections.some(item => item.code === 'excluded_mint'));
  const stable = evaluateGates(candidate({ jupiter: { ...candidate().jupiter, tags: ['stable'] } }), balanced);
  assert.ok(stable.rejections.some(item => item.code === 'excluded_tag'));
  const concentrated = evaluateGates(candidate({ jupiter: { ...candidate().jupiter, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 80 } } }), balanced);
  assert.ok(concentrated.rejections.some(item => item.code === 'concentration_high'));
});

test('preset conservative mewajibkan verifikasi dan pool lebih tua', () => {
  const conservative = getPreset('conservative');
  const unverified = evaluateGates(candidate({ jupiter: { ...candidate().jupiter, isVerified: false } }), conservative);
  assert.ok(unverified.rejections.some(item => item.code === 'unverified'));
  const young = evaluateGates(candidate({ pool: { createdAt: NOW - 48 * 3_600_000 } }), conservative);
  assert.ok(young.rejections.some(item => item.code === 'pool_too_new'));
});

test('estimasi slippage naik saat likuiditas turun dan null untuk input tidak valid', () => {
  assert.ok(estimateSlippage(100_000, 500) > estimateSlippage(1_000_000, 500));
  assert.equal(estimateSlippage(null, 500), null);
  assert.equal(estimateSlippage(100_000, 0), null);
});

test('gradeFor membatasi grade C saat safety unknown', () => {
  assert.equal(gradeFor(90), 'A');
  assert.equal(gradeFor(90, { safetyUnknown: true }), 'C');
  assert.equal(gradeFor(65), 'B');
  assert.equal(gradeFor(30), 'D');
  assert.equal(gradeFor(null), 'unknown');
});

test('scoreCandidate mengeluarkan komponen struktur yang belum dianalisis, bukan memberinya nilai netral', () => {
  const scored = scoreCandidate(candidate(), balanced);
  assert.ok(Number.isInteger(scored.score));
  assert.equal(scored.grade, 'C', 'safety unknown membatasi grade');
  assert.ok(scored.penalties.some(penalty => penalty.code === 'safety_unknown'));
  assert.equal(scored.components.length, 5);
  assert.ok(scored.components.every(component => component.weight > 0));
  const structure = scored.components.find(component => component.key === 'structure');
  assert.equal(structure.score, null, 'struktur tidak diberi nilai netral');
  assert.ok(scored.confidence < 1, 'kepercayaan turun saat ada komponen yang tidak terukur');
  assert.ok(scored.missingComponents.includes('structure'));
});

test('scoreCandidate dengan struktur tersedia menaikkan kepercayaan ke 1', () => {
  const scored = scoreCandidate(candidate({ structure: { status: 'available', trend: 'uptrend', rsi14: 55, atrPct: 3, distanceToHighPct: 1, higherHigh: true, higherLow: true } }), balanced);
  assert.equal(scored.confidence, 1);
  assert.equal(scored.missingComponents.length, 0);
});

test('scoreCandidate memberi skor lebih tinggi saat safety tersedia', () => {
  const withSafety = scoreCandidate(candidate({ safety: { status: 'available', security: { mintable: false, freezable: false, nonTransferable: false, top10Pct: 18, holderCount: 6000, lpHolderPct: 40, transferFee: false, transferHook: false, metadataMutable: false } } }), balanced);
  const without = scoreCandidate(candidate(), balanced);
  assert.ok(withSafety.score > without.score);
  assert.notEqual(withSafety.grade, 'C');
});

test('skor likuiditas mengikuti preset sehingga token yang sama berbeda antar-preset', () => {
  const degen = getPreset('degen');
  const balancedScore = scoreCandidate(candidate(), balanced);
  const degenScore = scoreCandidate(candidate(), degen);
  const liquidityOf = scored => scored.components.find(component => component.key === 'liquidity').score;
  assert.ok(liquidityOf(degenScore) > liquidityOf(balancedScore), 'preset lebih longgar menilai likuiditas lebih tinggi');
  assert.notEqual(balancedScore.score, degenScore.score, 'total skor token yang sama harus berbeda antar-preset');
});

test('skor komponen disimpan desimal agar selisih antar-preset tidak hilang', () => {
  const scored = scoreCandidate(candidate(), balanced);
  const liquidity = scored.components.find(component => component.key === 'liquidity');
  assert.ok(Number.isInteger(scored.score), 'total tetap bilangan bulat');
  assert.ok(liquidity.score % 1 !== 0 || Number.isInteger(liquidity.score), 'komponen boleh desimal');
  assert.ok(liquidity.score >= 0 && liquidity.score <= 100);
});

test('rankCandidates mengurutkan skor dan memisahkan yang digugurkan', () => {
  const good = candidate();
  const bad = candidate({ mint: 'Bad1111111111111111111111111111111111111111', pool: { liquidityUsd: 1000 } });
  const result = rankCandidates([bad, good], { preset: balanced, limit: 10 });
  assert.equal(result.accepted, 1);
  assert.equal(result.rejectedCount, 1);
  assert.equal(result.ranked[0].rank, 1);
  assert.equal(result.ranked[0].mint, good.mint);
  assert.equal(result.rejected[0].rejections[0].code, 'liquidity_low');
});

test('mergeUniverse menggabungkan sumber dan memilih pool paling likuid', () => {
  const merged = mergeUniverse([
    { mint: 'A', source: 'Jupiter', jupiter: { symbol: 'A' } },
    { mint: 'A', source: 'GeckoTerminal', pool: { liquidityUsd: 100 } },
    { mint: 'A', source: 'GeckoTerminal', pool: { liquidityUsd: 900 } },
    { mint: 'B', source: 'Jupiter' },
    { mint: null, source: 'Jupiter' }
  ]);
  assert.equal(merged.length, 2);
  const a = merged.find(item => item.mint === 'A');
  assert.deepEqual(a.sources, ['Jupiter', 'GeckoTerminal']);
  assert.equal(a.pool.liquidityUsd, 900);
});

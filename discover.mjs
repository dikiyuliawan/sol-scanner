import { CONFIG_HASH, DISCOVERY, ENTRY, EXCLUDED_MINTS, getPreset } from './config.mjs';
import { mergeUniverse, rankCandidates } from './screen/rank.mjs';
import { evaluateGates } from './screen/gates.mjs';
import { estimateSlippage } from './screen/score.mjs';
import { analyzeStructure, parseCandles } from './analysis/candles.mjs';
import { buildEntryPlan } from './analysis/entryplan.mjs';

// Symbol tidak diserialkan ke JSON: bukti lengkap hanya untuk job internal.
export const DISCOVERY_CONTEXT = Symbol('discoveryContext');
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/**
 * Discovery: universe murah dari Jupiter + Gecko, pre-filter di memori,
 * lalu satu request batch DEX Screener. Deep scan (Gecko 1h + GoPlus)
 * dijalankan terpisah untuk shortlist saja.
 */
export function createDiscovery({ jupiter, dexscreener, gecko, goplus, db = null, clock = Date.now } = {}) {
  return async function discover({ preset: presetName = 'balanced', limit = DISCOVERY.resultLimit, skipDeep = false } = {}) {
    const startedAt = new Date(clock()).toISOString();
    const preset = getPreset(presetName);
    const now = clock();
    const warnings = [];

    const [organic1h, trending1h, organic24h, geckoTrending] = await Promise.all([
      jupiter.topOrganic('1h', DISCOVERY.universeLimit),
      jupiter.topTrending('1h', DISCOVERY.universeLimit),
      jupiter.topOrganic('24h', DISCOVERY.universeLimit),
      // Hanya satu panggilan Gecko di fase discovery: sisanya disimpan untuk
      // candle shortlist, karena batas publiknya yang paling ketat.
      gecko.trending(1)
    ]);

    for (const result of [organic1h, trending1h, organic24h, geckoTrending]) {
      if (result.status !== 'available') warnings.push(result.reason);
    }

    const entries = [];
    for (const result of [organic1h, trending1h, organic24h]) {
      for (const token of result.tokens) entries.push({ mint: token.mint, source: result.source, jupiter: token });
    }
    for (const pool of geckoTrending.pools) {
      if (pool.mint) entries.push({ mint: pool.mint, source: geckoTrending.source, pool });
    }
    const universe = mergeUniverse(entries).filter(item => base58(item.mint) && !EXCLUDED_MINTS.has(item.mint));

    // Pre-filter murah tanpa request tambahan: likuiditas Jupiter dan label organic.
    const prefiltered = universe.filter(item => {
      const liquidity = item.jupiter?.liquidityUsd ?? item.pool?.liquidityUsd ?? null;
      return liquidity === null || liquidity >= preset.minLiquidityUsd * 0.8;
    }).slice(0, DISCOVERY.maxCandidatesForMarket);

    const market = await dexscreener.batch(prefiltered.map(item => item.mint));
    if (market.status !== 'available') warnings.push(market.reason);

    const candidates = prefiltered.map(item => {
      const pool = market.pools?.get(item.mint) ?? item.pool ?? null;
      return {
        mint: item.mint,
        now,
        jupiter: item.jupiter,
        market: { pool, status: pool ? 'available' : 'empty' },
        safety: { status: 'unknown', security: null },
        structure: null,
        notionalUsd: ENTRY.notionalUsd
      };
    });
    // Kandidat yang benar-benar punya data pasar. Sebelumnya `checked` bisa
    // jauh lebih besar dari angka ini karena batch DEX Screener terpotong 30.
    const evaluated = candidates.filter(candidate => candidate.market?.pool).length;

    // Preset yang mewajibkan keamanan kontrak memverifikasi kandidat teratas
    // lewat GoPlus sebelum gate final. Tanpa langkah ini, keamanan selalu
    // `unknown` saat ranking sehingga preset ketat selalu mengembalikan nol.
    let gatedCandidates = candidates;
    if (!preset.allowUnknownSafety && goplus) {
      const relaxed = { ...preset, allowUnknownSafety: true };
      const preliminary = candidates
        .filter(candidate => evaluateGates(candidate, relaxed).passed)
        .sort((a, b) => (b.market?.pool?.liquidityUsd ?? 0) - (a.market?.pool?.liquidityUsd ?? 0))
        .slice(0, DISCOVERY.verifySafetyTop);
      if (preliminary.length) {
        const verified = new Map();
        // Sekuensial: sumber GoPlus mengatur jarak antar-panggilan sendiri
        // (300 ms) dan batas 20/menit.
        for (const candidate of preliminary) verified.set(candidate.mint, await goplus.security(candidate.mint));
        gatedCandidates = candidates.map(candidate => verified.has(candidate.mint) ? { ...candidate, safety: verified.get(candidate.mint) } : candidate);
        const known = [...verified.values()].filter(item => item.status === 'available').length;
        warnings.push(known
          ? `Preset mewajibkan keamanan: GoPlus diverifikasi untuk ${known}/${preliminary.length} kandidat teratas sebelum gate final.`
          : `Preset mewajibkan keamanan, tetapi GoPlus tidak tersedia (0/${preliminary.length}); kandidat ditolak, bukan dianggap aman.`);
      }
    }

    const ranking = rankCandidates(gatedCandidates, { preset, limit });
    const runId = db ? db.recordDiscoverRun({ startedAt, preset: preset.name, configHash: CONFIG_HASH, candidates: universe.length, accepted: ranking.accepted, rejected: ranking.rejectedCount, payload: { warnings } }) : null;

    const rows = ranking.ranked.map(candidate => serializeCandidate(candidate, preset, warnings));
    return {
      runId,
      startedAt,
      finishedAt: new Date(clock()).toISOString(),
      preset: { name: preset.name, label: preset.label, description: preset.description },
      configHash: CONFIG_HASH,
      universe: { total: universe.length, checked: prefiltered.length, evaluated, accepted: ranking.accepted, rejected: ranking.rejectedCount },
      warnings,
      rows,
      [DISCOVERY_CONTEXT]: new Map(ranking.ranked.map(candidate => [candidate.mint, candidate])),
      rejected: ranking.rejected,
      deepScanPending: !skipDeep ? rows.filter(row => row.score !== null).slice(0, DISCOVERY.deepScanTokens).map(row => row.mint) : []
    };
  };
}

export function serializeCandidate(candidate, preset, warnings = []) {
  const pool = candidate.market?.pool ?? null;
  const jupiter = candidate.jupiter ?? null;
  const safety = candidate.safety ?? null;
  const ageHours = pool?.createdAt ? (candidate.now - pool.createdAt) / 3_600_000 : null;
  const turnover = pool?.liquidityUsd && pool?.volume?.h24 ? pool.volume.h24 / pool.liquidityUsd : null;
  const slippage = estimateSlippage(pool?.liquidityUsd, candidate.notionalUsd ?? ENTRY.notionalUsd);

  return {
    rank: candidate.rank,
    mint: candidate.mint,
    symbol: jupiter?.symbol ?? pool?.baseSymbol ?? null,
    name: jupiter?.name ?? null,
    icon: jupiter?.icon ?? null,
    score: candidate.scoring.score,
    grade: candidate.scoring.grade,
    confidence: candidate.scoring.confidence,
    components: candidate.scoring.components,
    penalties: candidate.scoring.penalties,
    gates: candidate.gates,
    flags: [...(candidate.gates?.warnings ?? [])],
    market: {
      poolAddress: pool?.poolAddress ?? null,
      dex: pool?.dex ?? null,
      quoteSymbol: pool?.quoteSymbol ?? null,
      priceUsd: pool?.priceUsd ?? null,
      liquidityUsd: pool?.liquidityUsd ?? null,
      volume24h: pool?.volume?.h24 ?? null,
      volume6h: pool?.volume?.h6 ?? null,
      volume1h: pool?.volume?.h1 ?? null,
      turnover,
      marketCap: pool?.marketCap ?? null,
      fdv: pool?.fdv ?? null,
      change: pool?.change ?? null,
      ageHours,
      slippagePct: slippage,
      source: pool?.source ?? 'DEX Screener',
      fetchedAt: pool?.fetchedAt ?? null
    },
    safety: {
      status: safety?.status ?? 'unknown',
      mintable: safety?.security?.mintable ?? null,
      freezable: safety?.security?.freezable ?? null,
      transferFee: safety?.security?.transferFee ?? null,
      transferHook: safety?.security?.transferHook ?? null,
      top10Pct: safety?.security?.top10Pct ?? jupiter?.audit?.topHoldersPercentage ?? null,
      holderCount: safety?.security?.holderCount ?? jupiter?.holderCount ?? null,
      lpHolderPct: safety?.security?.lpHolderPct ?? null,
      source: safety?.source ?? 'GoPlus (belum dipanggil)',
      reason: safety?.reason ?? null
    },
    organic: {
      score: jupiter?.organicScore ?? null,
      label: jupiter?.organicLabel ?? null,
      verified: jupiter?.isVerified ?? null,
      tags: jupiter?.tags ?? [],
      holderCount: jupiter?.holderCount ?? null,
      liquidityUsd: jupiter?.liquidityUsd ?? null,
      source: 'Jupiter'
    },
    structure: candidate.structure ? {
      status: candidate.structure.status,
      trend: candidate.structure.trend,
      rsi14: candidate.structure.rsi14,
      atrPct: candidate.structure.atrPct,
      distanceToHighPct: candidate.structure.distanceToHighPct,
      higherHigh: candidate.structure.higherHigh,
      higherLow: candidate.structure.higherLow,
      change24hPct: candidate.structure.change24hPct,
      timeframe: candidate.structure.timeframe
    } : null,
    entryPlan: candidate.entryPlan ?? null,
    warnings
  };
}

/** Deep scan: hanya untuk shortlist, memakai budget Gecko/GoPlus. */
export function createDeepScan({ gecko, goplus, clock = Date.now } = {}) {
  return async function deepScan(candidate) {
    const pool = candidate.market?.pool ?? null;
    if (!pool?.poolAddress) {
      return { ...candidate, structure: null, entryPlan: { status: 'no_plan', setup: 'unknown', reason: 'Alamat pool tidak tersedia.' } };
    }
    const [candles, safety] = await Promise.all([
      gecko.candles(pool.poolAddress, candidate.mint, { granularity: 'hour', aggregate: 1, limit: 200 }),
      goplus.security(candidate.mint)
    ]);
    const parsed = parseCandles(candles.candles, { intervalSeconds: 3600, now: clock() });
    const structure = parsed.candles.length
      ? { ...analyzeStructure(parsed.candles, { intervalSeconds: 3600 }), dropped: parsed.dropped }
      : { status: 'unknown', reason: candles.reason ?? 'Candle 1 jam tidak tersedia.', trend: null };
    const slippage = estimateSlippage(pool.liquidityUsd, ENTRY.notionalUsd);
    const entryPlan = buildEntryPlan(structure, { slippagePct: slippage });
    return { ...candidate, safety, structure, entryPlan, candleSource: { source: 'GeckoTerminal', fetchedAt: candles.fetchedAt, reason: candles.reason } };
  };
}

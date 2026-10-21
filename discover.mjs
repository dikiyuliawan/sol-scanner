import { CONFIG_HASH, DISCOVERY, ENTRY, EXCLUDED_MINTS, getPreset } from './config.mjs';
import { mergeUniverse, rankCandidates } from './screen/rank.mjs';
import { evaluateGates } from './screen/gates.mjs';
import { estimateSlippage } from './screen/score.mjs';
import { concentrationFor, secondaryConcentration } from './screen/provenance.mjs';
import { analyzeStructure, parseCandles } from './analysis/candles.mjs';
import { buildEntryPlan } from './analysis/entryplan.mjs';

// Symbol tidak diserialkan ke JSON: bukti lengkap hanya untuk job internal.
export const DISCOVERY_CONTEXT = Symbol('discoveryContext');
const base58 = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

/**
 * Susun daftar kandidat dengan round-robin antar sumber. Kalau sumber
 * digabung berurutan, sumber pertama akan memakai seluruh kuota dan sumber
 * lain tidak pernah sampai dievaluasi.
 */
function interleave(groups) {
  const output = [];
  const longest = Math.max(0, ...groups.map(group => group.length));
  for (let index = 0; index < longest; index += 1) {
    for (const group of groups) if (group[index]) output.push(group[index]);
  }
  return output;
}

/**
 * Geser potongan dari daftar ranking yang bergerak lambat. Posisi teratas
 * tetap dipakai supaya kandidat terbaik tidak hilang dari run; sisanya
 * bergeser setiap jendela waktu sehingga refresh berikutnya tidak selalu
 * menghasilkan token yang sama.
 */
export function rotate(list, windowIndex) {
  if (!list.length) return list;
  const head = list.slice(0, DISCOVERY.rotateHeadFixed);
  const tail = list.slice(DISCOVERY.rotateHeadFixed);
  if (!tail.length) return list;
  const offset = (windowIndex * DISCOVERY.rotateStep) % tail.length;
  return head.concat(tail.slice(offset), tail.slice(0, offset));
}

/**
 * Discovery: universe murah dari Jupiter + Gecko, pre-filter di memori,
 * lalu satu request batch DEX Screener. Deep scan (Gecko 1h + GoPlus)
 * dijalankan terpisah untuk shortlist saja.
 */
export function createDiscovery({ jupiter, dexscreener, gecko, goplus, db = null, clock = Date.now } = {}) {
  return async function discover({ preset: presetName = 'balanced', limit = DISCOVERY.resultLimit, skipDeep = false, refresh = false } = {}) {
    const startedAt = new Date(clock()).toISOString();
    const preset = getPreset(presetName);
    const now = clock();
    const warnings = [];

    const [organic1h, trending1h, organic24h, jupiterRecent, geckoTrending] = await Promise.all([
      jupiter.topOrganic('1h', DISCOVERY.universeLimit, { refresh }),
      jupiter.topTrending('1h', DISCOVERY.universeLimit, { refresh }),
      jupiter.topOrganic('24h', DISCOVERY.universeLimit, { refresh }),
      // Daftar token terbaru: tidak ada overlap dengan daftar ranking, jadi
      // ini sumber yang benar-benar memberi kandidat baru setiap run.
      jupiter.recent(DISCOVERY.universeLimit, { refresh }),
      // GeckoTerminal hanya boleh satu request di fase discovery: batas
      // publiknya sekitar 4-5 request per menit dan sisanya dipakai untuk
      // candle deep scan.
      gecko.trending(1, { refresh })
    ]);

    // Pool baru GeckoTerminal biasanya sangat tipis, jadi hanya berguna
    // untuk preset yang memang menerima likuiditas tipis. Memanggilnya
    // untuk preset lain hanya memboroskan satu slot Gecko.
    const geckoNewPools = preset.minLiquidityUsd <= DISCOVERY.newPoolsMaxMinLiquidityUsd
      ? await gecko.newPools(1, { refresh })
      : null;

    // Setiap sumber dicatat terpisah: sumber yang kosong atau gagal
    // harus terlihat, bukan hilang diam-diam dari run. Urutan daftar adalah
    // urutan prioritas: sumber paling segar lebih dulu supaya tidak pernah
    // terpotong oleh batas kandidat.
    const windowIndex = Math.floor(clock() / DISCOVERY.rotateWindowMs);
    const groups = [
      { label: 'Jupiter token terbaru', result: jupiterRecent, items: jupiterRecent.tokens.map(token => ({ mint: token.mint, source: jupiterRecent.source, jupiter: token })) },
      { label: 'Jupiter top organic 1 jam', result: organic1h, items: rotate(organic1h.tokens.map(token => ({ mint: token.mint, source: organic1h.source, jupiter: token })), windowIndex) },
      { label: 'Jupiter trending 1 jam', result: trending1h, items: rotate(trending1h.tokens.map(token => ({ mint: token.mint, source: trending1h.source, jupiter: token })), windowIndex) },
      { label: 'Jupiter top organic 24 jam', result: organic24h, items: rotate(organic24h.tokens.map(token => ({ mint: token.mint, source: organic24h.source, jupiter: token })), windowIndex) },
      { label: 'GeckoTerminal trending pools', result: geckoTrending, items: geckoTrending.pools.filter(pool => pool.mint).map(pool => ({ mint: pool.mint, source: geckoTrending.source, pool })) }
    ];
    if (geckoNewPools) {
      groups.unshift({ label: 'GeckoTerminal pool baru', result: geckoNewPools, items: geckoNewPools.pools.filter(pool => pool.mint).map(pool => ({ mint: pool.mint, source: geckoNewPools.source, pool })) });
    }
    for (const group of groups) {
      if (group.result.status !== 'available') {
        warnings.push(group.result.reason);
      } else if (!group.items.length) {
        warnings.push(`${group.label} tidak mengembalikan token apa pun pada run ini; sumber ini tidak berkontribusi pada kandidat.`);
      }
    }
    // Sumber yang gagal seluruhnya menghasilkan run kosong. Itu harus
    // dinyatakan secara eksplisit, bukan terlihat seperti "semua kandidat
    // gugur gate".
    if (groups.every(group => group.result.status !== 'available')) {
      warnings.push('Semua sumber data gagal diambil, jadi tidak ada kandidat yang bisa dinilai pada run ini. Periksa koneksi lalu jalankan Discover lagi.');
    }

    const groupLabels = new Map();
    for (const group of groups) {
      for (const item of group.items) {
        if (!groupLabels.has(item.mint)) groupLabels.set(item.mint, new Set());
        groupLabels.get(item.mint).add(group.label);
      }
    }

    const entries = interleave(groups.map(group => group.items));
    const universe = mergeUniverse(entries).filter(item => base58(item.mint) && !EXCLUDED_MINTS.has(item.mint));

    // Pre-filter murah tanpa request tambahan: likuiditas Jupiter dan label organic.
    const prefiltered = universe.filter(item => {
      const liquidity = item.jupiter?.liquidityUsd ?? item.pool?.liquidityUsd ?? null;
      return liquidity === null || liquidity >= preset.minLiquidityUsd * 0.8;
    }).slice(0, DISCOVERY.maxCandidatesForMarket);

    // Kontribusi per sumber untuk kandidat yang benar-benar dievaluasi.
    const sourceBreakdown = {};
    for (const item of prefiltered) {
      for (const label of groupLabels.get(item.mint) ?? []) sourceBreakdown[label] = (sourceBreakdown[label] ?? 0) + 1;
    }

    const market = await dexscreener.batch(prefiltered.map(item => item.mint), { refresh });
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

    // Verifikasi GoPlus sebelum gate final untuk dua kebutuhan:
    // 1. preset yang mewajibkan keamanan (allowUnknownSafety:false) — tanpa
    //    ini keamanan selalu `unknown` saat ranking sehingga preset ketat
    //    selalu mengembalikan nol hasil,
    // 2. kandidat tanpa jumlah holder dari Jupiter (mis. kandidat dari
    //    GeckoTerminal) — tanpa verifikasi, gate akan menolaknya sebagai
    //    unknown dan sumber yang paling segar jadi tidak pernah muncul.
    let gatedCandidates = candidates;
    if (goplus) {
      const toVerify = new Map();
      if (!preset.allowUnknownSafety) {
        const relaxed = { ...preset, allowUnknownSafety: true };
        const preliminary = candidates
          .filter(candidate => evaluateGates(candidate, relaxed).passed)
          .sort((a, b) => (b.market?.pool?.liquidityUsd ?? 0) - (a.market?.pool?.liquidityUsd ?? 0))
          .slice(0, DISCOVERY.verifySafetyTop);
        for (const candidate of preliminary) toVerify.set(candidate.mint, candidate);
      }
      // Kandidat tanpa data holder, diurutkan dari sumber paling segar.
      const byMint = new Map(candidates.map(candidate => [candidate.mint, candidate]));
      for (const group of groups) {
        for (const item of group.items) {
          if (toVerify.size >= DISCOVERY.verifySafetyTop + DISCOVERY.verifyHolderTop) break;
          const candidate = byMint.get(item.mint);
          if (candidate && !candidate.jupiter?.holderCount) toVerify.set(candidate.mint, candidate);
        }
      }
      if (toVerify.size) {
        const verified = new Map();
        // Sekuensial: sumber GoPlus mengatur jarak antar-panggilan sendiri
        // (300 ms) dan batas 20/menit.
        for (const candidate of toVerify.values()) verified.set(candidate.mint, await goplus.security(candidate.mint, { refresh }));
        gatedCandidates = candidates.map(candidate => verified.has(candidate.mint) ? { ...candidate, safety: verified.get(candidate.mint) } : candidate);
        const known = [...verified.values()].filter(item => item.status === 'available').length;
        const holderKnown = [...verified.values()].filter(item => item.security?.holderCount).length;
        if (known) {
          warnings.push(preset.allowUnknownSafety
            ? `GoPlus diverifikasi untuk ${known}/${toVerify.size} kandidat; ${holderKnown} di antaranya punya jumlah holder.${holderKnown ? '' : ' Yang tanpa jumlah holder tetap ditolak gate sebagai unknown, bukan dianggap aman.'}`
            : `Preset mewajibkan keamanan: GoPlus diverifikasi untuk ${known}/${toVerify.size} kandidat; ${holderKnown} di antaranya punya jumlah holder.${holderKnown ? '' : ' Yang tanpa jumlah holder tetap ditolak gate sebagai unknown, bukan dianggap aman.'}`);
        } else {
          warnings.push(preset.allowUnknownSafety
            ? `GoPlus tidak tersedia untuk ${toVerify.size} kandidat; jumlah holder tetap unknown dan kandidat ditolak, bukan dianggap aman.`
            : `Preset mewajibkan keamanan, tetapi GoPlus tidak tersedia (0/${toVerify.size}); kandidat ditolak, bukan dianggap aman.`);
        }
      } else if (!preset.allowUnknownSafety) {
        warnings.push('Preset mewajibkan keamanan, tetapi tidak ada kandidat yang lolos gate awal sehingga GoPlus tidak dipanggil. Tidak ada kandidat yang bisa dinyatakan aman pada preset ini.');
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
      universe: {
        total: universe.length,
        checked: prefiltered.length,
        evaluated,
        accepted: ranking.accepted,
        rejected: ranking.rejectedCount,
        sources: sourceBreakdown
      },
      warnings,
      rows,
      [DISCOVERY_CONTEXT]: new Map(ranking.ranked.map(candidate => [candidate.mint, candidate])),
      rejected: ranking.rejected,
      // Deep scan mencakup semua baris yang lolos gate (0 = semua). Job
      // berjalan di belakang dengan tempo, jadi respons tidak menunggu.
      deepScanPending: !skipDeep
        ? rows.filter(row => row.score !== null)
          .slice(0, DISCOVERY.deepScanTokens > 0 ? DISCOVERY.deepScanTokens : rows.length)
          .map(row => row.mint)
        : []
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
  const concentration = concentrationFor(candidate);
  const secondary = secondaryConcentration(candidate);
  const goPlusTop10 = safety?.security?.top10Pct ?? null;
  const jupiterTop10 = jupiter?.audit?.topHoldersPercentage ?? null;

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
      fetchedAt: pool?.fetchedAt ?? null,
      // Pool dengan mint sebagai quote token tidak boleh mengatribusikan
      // harga dan valuasi milik token base.
      targetIsBase: pool?.targetIsBase ?? null
    },
    safety: {
      status: safety?.status ?? 'unknown',
      mintable: safety?.security?.mintable ?? null,
      freezable: safety?.security?.freezable ?? null,
      transferFee: safety?.security?.transferFee ?? null,
      transferHook: safety?.security?.transferHook ?? null,
      top10Pct: concentration.value,
      top10Source: concentration.source,
      top10PctGoPlus: goPlusTop10,
      top10PctJupiter: jupiterTop10,
      top10Secondary: secondary ? secondary.value : null,
      holderCount: safety?.security?.holderCount ?? jupiter?.holderCount ?? null,
      lpHolderPct: safety?.security?.lpHolderPct ?? null,
      source: safety?.source ?? 'GoPlus (belum dipanggil)',
      fetchedAt: safety?.fetchedAt ?? null,
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
      timeframe: candidate.structure.timeframe,
      // Waktu penutupan candle dan harga close yang dipakai struktur: tanpa
      // ini pengguna tidak tahu berapa lama angka entry plan sudah tua.
      close: candidate.structure.close ?? null,
      lastClosedAt: candidate.structure.lastClosedAt ?? null,
      candles: candidate.structure.candles ?? null
    } : null,
    entryPlan: candidate.entryPlan ?? null,
    warnings
  };
}

/** Deep scan: hanya untuk shortlist, memakai budget Gecko/GoPlus. */
export function createDeepScan({ gecko, goplus, dexscreener = null, clock = Date.now, paceMs = DISCOVERY.deepScanPaceMs } = {}) {
  let lastFinishedAt = 0;
  let lastClock = null;
  /**
   * Tempo antar token, diukur dari akhir token sebelumnya. Clock beku
   * (khas tes) berarti tidak ada waktu nyata yang lewat, jadi jeda dilewati.
   */
  const pace = async () => {
    const now = clock();
    const frozen = lastClock !== null && now === lastClock;
    lastClock = now;
    if (!frozen && lastFinishedAt) {
      const gap = paceMs - (now - lastFinishedAt);
      if (gap > 0) await new Promise(resolve => setTimeout(resolve, gap));
    }
  };

  return async function deepScan(candidate, { refresh = false } = {}) {
    await pace();
    try {
      return await analyse(candidate, refresh);
    } finally {
      lastFinishedAt = clock();
    }
  };

  async function analyse(candidate, refresh) {
    let pool = candidate.market?.pool ?? null;
    let poolCheck = null;

    // Endpoint batch DEX Screener hanya mengembalikan satu pool per token,
    // dan pool itu belum tentu yang paling likuid. Sebelum candle dibaca,
    // pool utama dicek ulang satu kali per token shortlist (satu request),
    // supaya struktur, entry plan, dan angka pasar berasal dari pool yang
    // sama dan sama-sama milik mint yang diperiksa.
    if (dexscreener?.mainPool && pool) {
      const checked = await dexscreener.mainPool(candidate.mint, { refresh });
      poolCheck = { status: checked.status, fetchedAt: checked.fetchedAt, reason: checked.reason ?? null, replaced: false };
      if (checked.status === 'available' && checked.pool) {
        const samePool = checked.pool.poolAddress === pool.poolAddress;
        if (!samePool) poolCheck.replaced = true;
        pool = checked.pool;
      }
    }

    if (!pool?.poolAddress) {
      return { ...candidate, market: { pool: null }, structure: null, entryPlan: { status: 'no_plan', setup: 'unknown', reason: 'Alamat pool tidak tersedia.' }, poolCheck };
    }
    const [candles, safety] = await Promise.all([
      // Permintaan latar: menunggu slot Gecko yang tersedia alih-alih gagal
      // dan berubah menjadi "unknown" karena kuota habis.
      gecko.candles(pool.poolAddress, candidate.mint, { granularity: 'hour', aggregate: 1, limit: 200, refresh, background: true }),
      goplus.security(candidate.mint, { refresh, background: true })
    ]);
    const parsed = parseCandles(candles.candles, { intervalSeconds: 3600, now: clock() });
    const structure = parsed.candles.length
      ? { ...analyzeStructure(parsed.candles, { intervalSeconds: 3600 }), dropped: parsed.dropped }
      : { status: 'unknown', reason: candles.reason ?? 'Candle 1 jam tidak tersedia.', trend: null };
    const slippage = estimateSlippage(pool.liquidityUsd, ENTRY.notionalUsd);
    const entryPlan = buildEntryPlan(structure, { slippagePct: slippage });
    return {
      ...candidate,
      market: { ...candidate.market, pool },
      safety,
      structure,
      entryPlan,
      poolCheck,
      candleSource: { source: 'GeckoTerminal', fetchedAt: candles.fetchedAt, reason: candles.reason, lastClosedAt: structure.lastClosedAt ?? null }
    };
  };
}

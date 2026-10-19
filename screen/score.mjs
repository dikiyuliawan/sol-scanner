import { GRADE_THRESHOLDS, SCORE_WEIGHTS } from '../config.mjs';

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));

/** Interpolasi linear: x <= lo → 0, x >= hi → 100. */
function ramp(value, lo, hi) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (hi === lo) return value >= hi ? 100 : 0;
  return clamp(((value - lo) / (hi - lo)) * 100);
}

/** Puncak di tengah: nilai di luar [lo, hi] menurun. */
function band(value, lo, goodLo, goodHi, hi) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (value < lo || value > hi) return 0;
  if (value >= goodLo && value <= goodHi) return 100;
  if (value < goodLo) return clamp(((value - lo) / (goodLo - lo)) * 100);
  return clamp(((hi - value) / (hi - goodHi)) * 100);
}

function avg(values) {
  const known = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (!known.length) return null;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

function component(key, label, weight, score, evidence, note = null) {
  // Skor komponen disimpan sebagai desimal (bukan dibulatkan ke integer) agar
  // perbedaan antar-preset tidak hilang sebelum dirata-ratakan. Pembulatan
  // hanya dilakukan pada total akhir.
  const value = score === null ? null : Math.round(clamp(score) * 10) / 10;
  return { key, label, weight, score: value, points: value === null ? 0 : Math.round(value * weight / 100 * 10) / 10, evidence, note };
}

export function scoreSafety(candidate) {
  const { safety, jupiter } = candidate;
  const s = safety?.status === 'available' ? safety.security : null;
  const audit = jupiter?.audit ?? null;
  const evidence = [];
  let score = 100;

  const mintable = s ? s.mintable : (audit?.mintAuthorityDisabled === true ? false : null);
  const freezable = s ? s.freezable : (audit?.freezeAuthorityDisabled === true ? false : null);
  evidence.push({ metric: 'Mint authority', value: mintable === null ? 'unknown' : mintable ? 'aktif' : 'mati', source: s ? 'GoPlus' : 'Jupiter' });
  evidence.push({ metric: 'Freeze authority', value: freezable === null ? 'unknown' : freezable ? 'aktif' : 'mati', source: s ? 'GoPlus' : 'Jupiter' });

  if (mintable === null || freezable === null) {
    score -= 45;
    evidence.push({ metric: 'Kelengkapan data keamanan', value: 'tidak lengkap', source: 'GoPlus/Jupiter' });
  }
  if (mintable === true) score -= 100;
  if (freezable === true) score -= 100;

  const top10 = s?.top10Pct ?? audit?.topHoldersPercentage ?? null;
  evidence.push({ metric: 'Top 10 holder', value: top10 === null ? 'unknown' : `${top10.toFixed(1)}%`, source: s?.top10Pct !== undefined ? 'GoPlus' : 'Jupiter' });
  const concentration = top10 === null ? null : ramp(60 - top10, 0, 50);
  if (concentration !== null) score -= (100 - concentration) * 0.5;
  else score -= 20;

  if (s) {
    if (s.transferFee) score -= 100;
    if (s.transferHook) score -= 100;
    if (s.nonTransferable) score -= 100;
    if (s.metadataMutable === true) score -= 5;
    evidence.push({ metric: 'Transfer fee / hook', value: s.transferFee ? 'fee' : s.transferHook ? 'hook' : 'tidak ada', source: 'GoPlus' });
    evidence.push({ metric: 'LP holder teridentifikasi', value: s.lpHolderPct === null ? 'unknown' : `${s.lpHolderPct.toFixed(1)}%`, source: 'GoPlus' });
  } else {
    evidence.push({ metric: 'Transfer fee / hook', value: 'unknown', source: 'GoPlus tidak tersedia' });
  }
  if (jupiter?.isVerified) {
    evidence.push({ metric: 'Verifikasi token', value: 'verified', source: 'Jupiter' });
  }

  return component('safety', 'Keamanan kontrak & distribusi', SCORE_WEIGHTS.safety, score, evidence);
}

export function scoreLiquidity(candidate, preset) {
  const pool = candidate.market?.pool;
  if (!pool) return component('liquidity', 'Likuiditas & eksekusi', SCORE_WEIGHTS.liquidity, null, [], 'Pool tidak tersedia.');
  const evidence = [];
  // Kurva relatif preset: likuiditas dianggap "penuh" pada 20x ambang minimum
  // preset, sehingga preset yang lebih longgar menilai token yang sama lebih
  // tinggi. Sebelumnya patokan atas dikunci di USD 5 juta untuk semua preset,
  // sehingga skor nyaris tidak berubah antar-preset.
  const liqScore = ramp(pool.liquidityUsd, preset.minLiquidityUsd, preset.minLiquidityUsd * 20);
  evidence.push({ metric: 'Likuiditas pool', value: pool.liquidityUsd === null ? 'unknown' : `$${Math.round(pool.liquidityUsd).toLocaleString('en-US')}`, source: 'DEX Screener' });

  const turnover = pool.liquidityUsd && pool.volume?.h24 ? pool.volume.h24 / pool.liquidityUsd : null;
  const turnoverScore = band(turnover, preset.minTurnover, 0.5, 4, preset.maxTurnover);
  evidence.push({ metric: 'Turnover 24 jam', value: turnover === null ? 'unknown' : `${turnover.toFixed(2)}x`, source: 'DEX Screener' });

  const slippage = estimateSlippage(pool.liquidityUsd, candidate.notionalUsd ?? 500);
  const slippageScore = slippage === null ? null : ramp(5 - slippage, 0, 4.5);
  evidence.push({ metric: `Estimasi slippage $${candidate.notionalUsd ?? 500}`, value: slippage === null ? 'unknown' : `${slippage.toFixed(2)}%`, source: 'estimasi lokal dari likuiditas' });

  const parts = [liqScore, turnoverScore, slippageScore].filter(value => value !== null);
  return component('liquidity', 'Likuiditas & eksekusi', SCORE_WEIGHTS.liquidity, parts.length ? avg(parts) : null, evidence,
    slippage !== null && slippage > 2 ? 'Estimasi slippage di atas 2%; kualitas eksekusi buruk.' : null);
}

/** Estimasi kasar constant-product: impact ≈ notional / (likuiditas/2), plus fee 0,3%. */
export function estimateSlippage(liquidityUsd, notionalUsd) {
  if (!Number.isFinite(liquidityUsd) || liquidityUsd <= 0 || !Number.isFinite(notionalUsd) || notionalUsd <= 0) return null;
  return (notionalUsd / (liquidityUsd / 2)) * 100 + 0.3;
}

export function scoreMomentum(candidate) {
  const pool = candidate.market?.pool;
  const stats = candidate.jupiter?.stats ?? {};
  if (!pool) return component('momentum', 'Momentum & akselerasi volume', SCORE_WEIGHTS.momentum, null, [], 'Pool tidak tersedia.');
  const evidence = [];
  const change1h = pool.change?.h1 ?? stats['1h']?.priceChange ?? null;
  const change6h = pool.change?.h6 ?? stats['6h']?.priceChange ?? null;
  const change24h = pool.change?.h24 ?? stats['24h']?.priceChange ?? null;
  evidence.push({ metric: 'Perubahan 1j / 6j / 24j', value: `${signedPct(change1h)} / ${signedPct(change6h)} / ${signedPct(change24h)}`, source: 'DEX Screener' });

  // Konsistensi arah: positif di semua horizon lebih baik daripada spike 24 jam saja.
  const signs = [change1h, change6h, change24h];
  const positive = signs.filter(value => value !== null && value > 0).length;
  const consistency = signs.every(value => value === null) ? null : (positive / signs.filter(value => value !== null).length) * 100;

  const vol1h = pool.volume?.h1 ?? null, vol6h = pool.volume?.h6 ?? null, vol24h = pool.volume?.h24 ?? null;
  const accel = vol1h !== null && vol6h !== null && vol6h > 0 ? vol1h / (vol6h / 6) : null;
  evidence.push({ metric: 'Volume 1j vs rata-rata 6j', value: accel === null ? 'unknown' : `${accel.toFixed(2)}x`, source: 'DEX Screener' });
  const accelScore = band(accel, 0, 1.2, 4, 12);

  const buys = pool.txns?.h24?.buys ?? null, sells = pool.txns?.h24?.sells ?? null;
  const buyRatio = buys !== null && sells !== null && buys + sells > 0 ? buys / (buys + sells) : null;
  evidence.push({ metric: 'Rasio buy 24 jam', value: buyRatio === null ? 'unknown' : `${(buyRatio * 100).toFixed(1)}%`, source: 'DEX Screener' });
  const buyScore = band(buyRatio, 0.2, 0.45, 0.62, 0.9);

  const netBuyers = stats['1h']?.numNetBuyers ?? stats['6h']?.numNetBuyers ?? null;
  evidence.push({ metric: 'Net buyer 1j', value: netBuyers === null ? 'unknown' : String(netBuyers), source: 'Jupiter' });
  const netScore = netBuyers === null ? null : ramp(netBuyers, -50, 150);

  const vol24Score = ramp(vol24h, 0, 2_000_000);
  const parts = [consistency, accelScore, buyScore, netScore, vol24Score].filter(value => value !== null);
  return component('momentum', 'Momentum & akselerasi volume', SCORE_WEIGHTS.momentum, parts.length ? avg(parts) : null, evidence);
}

function signedPct(value) {
  return value === null || value === undefined ? 'unknown' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function fmt(value, digits = 2, suffix = '') {
  return value === null || value === undefined ? 'unknown' : `${value.toFixed(digits)}${suffix}`;
}

export function scoreStructure(candidate) {
  const structure = candidate.structure;
  if (!structure) {
    return component('structure', 'Struktur & kualitas entry', SCORE_WEIGHTS.structure, null,
      [{ metric: 'Struktur candle 1j', value: 'belum dianalisis', source: 'deep scan belum berjalan' }],
      'Struktur belum dianalisis; komponen ini dikeluarkan dari skor, bukan diberi nilai netral.');
  }
  if (structure.status !== 'available') {
    return component('structure', 'Struktur & kualitas entry', SCORE_WEIGHTS.structure, null,
      [{ metric: 'Struktur candle 1j', value: structure.reason ?? 'unknown', source: 'GeckoTerminal' }],
      'Struktur tidak dapat dinilai; komponen ini dikeluarkan dari skor, bukan diberi nilai netral.');
  }
  const evidence = [
    { metric: 'Tren 1j (EMA20/EMA50)', value: structure.trend ?? 'unknown', source: 'GeckoTerminal' },
    { metric: 'Jarak ke high 20 periode', value: fmt(structure.distanceToHighPct, 2, '%'), source: 'GeckoTerminal' },
    { metric: 'ATR14', value: fmt(structure.atrPct, 2, '%'), source: 'GeckoTerminal' },
    { metric: 'RSI14', value: fmt(structure.rsi14, 1), source: 'GeckoTerminal' },
    { metric: 'Higher high / higher low', value: `${structure.higherHigh === true ? 'ya' : structure.higherHigh === false ? 'tidak' : 'unknown'} / ${structure.higherLow === true ? 'ya' : structure.higherLow === false ? 'tidak' : 'unknown'}`, source: 'GeckoTerminal' }
  ];
  const trendScore = structure.trend === 'uptrend' ? 100 : structure.trend === 'sideways' ? 55 : structure.trend === 'downtrend' ? 10 : null;
  // Di dekat high = peluang breakout, tetapi terlalu dekat setelah lonjakan = mengejar.
  const proximity = structure.distanceToHighPct === null ? null : band(structure.distanceToHighPct, -20, -3, 1.5, 12);
  const rsiScore = structure.rsi14 === null ? null : band(structure.rsi14, 15, 40, 65, 88);
  const atrScore = structure.atrPct === null ? null : band(structure.atrPct, 0.2, 1, 6, 20);
  const sequence = structure.higherHigh && structure.higherLow ? 100 : structure.higherLow ? 65 : structure.higherHigh ? 45 : 20;
  const parts = [trendScore, proximity, rsiScore, atrScore, sequence].filter(value => value !== null);
  return component('structure', 'Struktur & kualitas entry', SCORE_WEIGHTS.structure, parts.length ? avg(parts) : null, evidence);
}

export function scoreOrganic(candidate) {
  const jupiter = candidate.jupiter;
  if (!jupiter) return component('organic', 'Organic attention', SCORE_WEIGHTS.organic, null, [], 'Jupiter tidak tersedia.');
  const evidence = [
    { metric: 'Organic score', value: jupiter.organicScore === null ? 'unknown' : `${jupiter.organicScore.toFixed(1)} (${jupiter.organicLabel ?? '?'})`, source: 'Jupiter' }
  ];
  const score = ramp(jupiter.organicScore, 30, 95);
  const stats = jupiter.stats?.['1h'] ?? jupiter.stats?.['6h'] ?? null;
  let organicRatio = null;
  if (stats?.buyOrganicVolume !== null && stats?.buyVolume) {
    organicRatio = stats.buyOrganicVolume / stats.buyVolume;
    evidence.push({ metric: 'Porsi volume buy organik (1j)', value: `${(organicRatio * 100).toFixed(1)}%`, source: 'Jupiter' });
  }
  if (stats?.numOrganicBuyers !== null && stats?.numTraders) {
    evidence.push({ metric: 'Organic buyer / trader', value: `${stats.numOrganicBuyers} / ${stats.numTraders}`, source: 'Jupiter' });
  }
  const parts = [score, organicRatio === null ? null : ramp(organicRatio, 0, 0.5)].filter(value => value !== null);
  return component('organic', 'Organic attention', SCORE_WEIGHTS.organic, parts.length ? avg(parts) : null, evidence);
}

export function penaltiesFor(candidate, preset) {
  const penalties = [];
  const pool = candidate.market?.pool;
  if (!pool) return penalties;
  const ageHours = pool.createdAt ? (candidate.now - pool.createdAt) / 3_600_000 : null;
  if (ageHours !== null && ageHours < 24) penalties.push({ code: 'young_pool', points: 8, reason: `Pool ${ageHours.toFixed(1)} jam; riwayat pendek.` });
  if (pool.marketCap && pool.fdv && pool.fdv / pool.marketCap > 2) {
    penalties.push({ code: 'fdv_gap', points: 5, reason: `FDV ${(pool.fdv / pool.marketCap).toFixed(2)}x market cap.` });
  }
  if (pool.change?.h24 != null && pool.change.h24 > 150) penalties.push({ code: 'pump_24h', points: 8, reason: `Sudah naik ${pool.change.h24.toFixed(0)}% dalam 24 jam.` });
  if (candidate.safety?.status !== 'available') penalties.push({ code: 'safety_unknown', points: 10, reason: 'Keamanan kontrak unknown; grade dibatasi C.' });
  if (pool.liquidityUsd !== null && pool.liquidityUsd < preset.minLiquidityUsd * 1.5) {
    penalties.push({ code: 'liquidity_thin', points: 4, reason: 'Likuiditas hanya sedikit di atas ambang minimum.' });
  }
  return penalties;
}

export function gradeFor(score, { safetyUnknown = false } = {}) {
  if (score === null) return 'unknown';
  let grade = score >= GRADE_THRESHOLDS.A ? 'A' : score >= GRADE_THRESHOLDS.B ? 'B' : score >= GRADE_THRESHOLDS.C ? 'C' : 'D';
  if (safetyUnknown && (grade === 'A' || grade === 'B')) grade = 'C';
  return grade;
}

export function scoreCandidate(candidate, preset) {
  const components = [
    scoreSafety(candidate),
    scoreLiquidity(candidate, preset),
    scoreMomentum(candidate),
    scoreStructure(candidate),
    scoreOrganic(candidate)
  ];
  const penalties = penaltiesFor(candidate, preset);
  const scored = components.filter(item => item.score !== null);
  const totalWeight = scored.reduce((sum, item) => sum + item.weight, 0);
  const weighted = scored.reduce((sum, item) => sum + item.score * item.weight, 0);
  const base = totalWeight ? weighted / totalWeight : null;
  const penaltyPoints = penalties.reduce((sum, item) => sum + item.points, 0);
  const score = base === null ? null : Math.round(clamp(base - penaltyPoints));
  const safetyUnknown = candidate.safety?.status !== 'available';
  return {
    score,
    grade: gradeFor(score, { safetyUnknown }),
    components,
    penalties,
    missingComponents: components.filter(item => item.score === null).map(item => item.key),
    weightsCovered: totalWeight,
    // Kepercayaan = porsi bobot yang benar-benar terukur. Skor dari 50% bobot
    // tidak boleh diperlakukan sama dengan skor dari 100% bobot.
    confidence: totalWeight / 100
  };
}

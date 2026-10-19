import { ENTRY } from '../config.mjs';

/**
 * Rencana entry diturunkan dari struktur 1 jam. Semua angka adalah
 * skenario, bukan perintah. Jika R:R tidak memenuhi ambang, hasilnya
 * `no_plan` dan tidak dipaksa tampil.
 */
export function buildEntryPlan(structure, {
  notionalUsd = ENTRY.notionalUsd,
  maxSlippagePct = ENTRY.maxSlippagePct,
  minRiskReward = ENTRY.minRiskReward,
  bankrollUsd = ENTRY.paperBankrollUsd,
  riskPerTradePct = ENTRY.riskPerTradePct,
  slippagePct = null
} = {}) {
  if (!structure || structure.status !== 'available') {
    return { status: 'no_plan', reason: 'Struktur 1 jam belum tersedia; rencana entry tidak dibuat.', setup: 'unknown' };
  }
  const { close, atr14, ema20, high20, low20, trend, rsi14 } = structure;
  if (![close, atr14, ema20, high20, low20].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    return { status: 'no_plan', reason: 'Nilai struktur tidak lengkap; rencana entry tidak dibuat.', setup: 'unknown' };
  }
  if (slippagePct !== null && slippagePct > maxSlippagePct) {
    return {
      status: 'no_plan',
      setup: 'illiquid',
      reason: `Estimasi slippage ${slippagePct.toFixed(2)}% untuk $${notionalUsd} melewati batas ${maxSlippagePct}%. Eksekusi tidak layak pada ukuran ini.`,
      slippagePct
    };
  }

  const zoneHalf = atr14 * ENTRY.zoneAtrMultiple;
  const extensionPct = ((close - ema20) / ema20) * 100;
  const pullbackDepthPct = high20 > low20 ? ((close - low20) / (high20 - low20)) * 100 : null;

  let setup, entryLow, entryHigh, rationale;
  if (trend === 'uptrend' && extensionPct > ENTRY.extendedPct) {
    setup = 'extended';
    rationale = `Harga ${extensionPct.toFixed(1)}% di atas EMA20 1 jam; tunggu pullback, jangan mengejar.`;
    entryLow = ema20 - zoneHalf;
    entryHigh = ema20 + zoneHalf;
  } else if (trend === 'uptrend' && close <= high20) {
    setup = 'trend_pullback';
    rationale = `Tren naik, harga belum menembus high 20 jam (${high20.toPrecision(6)}). Zona entry di sekitar EMA20 1 jam.`;
    entryLow = Math.max(ema20 - zoneHalf, low20);
    entryHigh = Math.min(ema20 + zoneHalf, close * 1.005);
  } else if (close > high20) {
    setup = 'breakout_retest';
    rationale = `Harga di atas high 20 jam (${high20.toFixed(6)}); rencana menunggu retest level tersebut, bukan membeli di puncak.`;
    entryLow = high20 * 0.995;
    entryHigh = high20 * 1.01;
  } else if (trend === 'sideways') {
    setup = 'range_breakout';
    rationale = 'Tren sideways; hanya breakout di atas high 20 jam yang memberi skenario jelas.';
    entryLow = high20 * 0.995;
    entryHigh = high20 * 1.01;
  } else {
    setup = 'downtrend';
    rationale = 'Tren 1 jam menurun; tidak ada skenario entry long yang jelas dari struktur ini.';
    entryLow = ema20 - zoneHalf;
    entryHigh = ema20 + zoneHalf;
  }

  const entryMid = (entryLow + entryHigh) / 2;
  // Invalidasi = satu ATR di bawah zona entry. Bukan level struktural yang
  // bisa jauh (low20 sering sangat dalam), sehingga risiko tetap terukur dan
  // tidak menggelembung di pasar berombak.
  const invalidation = entryLow - atr14 * ENTRY.stopAtrMultiple;
  const risk = entryMid - invalidation;
  if (!(risk > 0)) {
    return { status: 'no_plan', setup, reason: 'Invalidasi tidak berada di bawah zona entry; rencana tidak valid.', slippagePct };
  }

  // Target memakai level nyata, bukan kelipatan R. Rentang dibatasi 1–6 ATR
  // agar proyeksi measured-move tidak melonjak pada rentang 20 jam yang ekstrem.
  const rangeRaw = high20 - low20;
  const range = Math.min(Math.max(rangeRaw, atr14), atr14 * 6);
  const entriesAboveHigh = entryMid >= high20;
  const targets = entriesAboveHigh
    ? [high20 + range * 0.5, high20 + range, high20 + range * 1.5]
    : [high20, high20 + range * 0.5, high20 + range];
  const [target1, target2, target3] = targets;
  const riskReward = (target1 - entryMid) / risk;

  const positionUsd = bankrollUsd * (riskPerTradePct / 100) / (risk / entryMid);
  const plan = {
    status: riskReward >= minRiskReward && setup !== 'downtrend' ? 'plan' : 'no_plan',
    setup,
    rationale,
    entryLow,
    entryHigh,
    entryMid,
    invalidation,
    targets: [target1, target2, target3],
    riskReward: Number(riskReward.toFixed(2)),
    minRiskReward,
    riskPct: Number(((risk / entryMid) * 100).toFixed(2)),
    positionUsd: Number(positionUsd.toFixed(2)),
    notionalUsd,
    slippagePct,
    trend,
    rsi14,
    pullbackDepthPct: Number(pullbackDepthPct.toFixed(1)),
    extensionPct: Number(extensionPct.toFixed(2)),
    note: 'Rencana skenario dari candle 1 jam yang sudah tutup. Target adalah level/proyeksi measured-move, bukan janji. R:R tinggi tidak berarti peluang tinggi. Bukan perintah buy; invalidasi bukan stop-order otomatis.'
  };
  if (plan.status === 'no_plan' && !plan.reason) {
    plan.reason = setup === 'downtrend'
      ? 'Tren menurun; skenario long tidak didukung struktur.'
      : riskReward < minRiskReward
        ? `R:R ${plan.riskReward} ke target terdekat (${target1.toPrecision(6)}) di bawah ambang ${minRiskReward}; menunggu level yang lebih baik.`
        : 'Rencana tidak memenuhi syarat.';
  }
  return plan;
}

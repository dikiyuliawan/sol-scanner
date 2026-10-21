import { EXCLUDED_MINTS, EXCLUDED_TAGS } from '../config.mjs';
import { labelRank } from '../sources/jupiter.mjs';
import { concentrationFor, secondaryConcentration } from './provenance.mjs';

const SEVERITY_ORDER = { reject: 0, warn: 1, info: 2 };

function check(list, code, ok, reason, severity = 'reject') {
  if (ok) return;
  list.push({ code, severity, reason });
}

/**
 * Hard gate fail-closed: nilai unknown tidak pernah dianggap lulus tanpa
 * catatan. `allowUnknownSafety` hanya menurunkan grade, tidak menghapus
 * peringatan.
 */
export function evaluateGates(candidate, preset) {
  const rejections = [];
  const warnings = [];
  const { mint, jupiter, market, safety } = candidate;
  const pool = market?.pool ?? null;
  const audit = jupiter?.audit ?? null;

  check(rejections, 'excluded_mint', !EXCLUDED_MINTS.has(mint), 'Mint adalah aset dasar (SOL/USDC/USDT), bukan kandidat entry.');
  const tags = jupiter?.tags ?? [];
  const excludedTag = tags.find(tag => EXCLUDED_TAGS.has(tag));
  check(rejections, 'excluded_tag', !excludedTag, `Token bertag ${excludedTag ?? '?'} (stable/wrapped/major), bukan kandidat entry.`);
  check(rejections, 'market_missing', Boolean(pool), 'DEX Screener tidak mengembalikan pool Solana untuk mint ini.');

  if (pool) {
    check(rejections, 'liquidity_low', pool.liquidityUsd !== null && pool.liquidityUsd >= preset.minLiquidityUsd,
      `Likuiditas pool USD ${pool.liquidityUsd ?? 'unknown'} di bawah ambang ${preset.minLiquidityUsd}.`);
    check(rejections, 'volume_low', pool.volume?.h24 !== null && pool.volume?.h24 >= preset.minVolume24hUsd,
      `Volume 24 jam USD ${pool.volume?.h24 ?? 'unknown'} di bawah ambang ${preset.minVolume24hUsd}.`);

    const ageHours = pool.createdAt ? (candidate.now - pool.createdAt) / 3_600_000 : null;
    check(rejections, 'pool_too_new', ageHours !== null && ageHours >= preset.minPoolAgeHours,
      `Usia pool ${ageHours === null ? 'unknown' : `${ageHours.toFixed(1)} jam`} di bawah ambang ${preset.minPoolAgeHours} jam.`);

    const turnover = pool.liquidityUsd && pool.volume?.h24 ? pool.volume.h24 / pool.liquidityUsd : null;
    check(rejections, 'turnover_low', turnover !== null && turnover >= preset.minTurnover,
      `Turnover 24 jam ${turnover === null ? 'unknown' : `${turnover.toFixed(2)}x`} di bawah ambang ${preset.minTurnover}x.`);
    check(rejections, 'turnover_high', turnover === null || turnover <= preset.maxTurnover,
      `Turnover 24 jam ${turnover === null ? 'unknown' : `${turnover.toFixed(2)}x`} di atas ambang ${preset.maxTurnover}x; volume dicurigai wash/turnover ekstrem.`);

    if (pool.marketCap !== null && pool.marketCap !== undefined) {
      check(rejections, 'mcap_low', pool.marketCap >= preset.minMarketCapUsd,
        `Market cap USD ${pool.marketCap} di bawah ambang ${preset.minMarketCapUsd}.`);
    } else {
      // Gate market cap tidak bisa dihitung. Ini dicatat sebagai peringatan,
      // bukan lolos diam-diam: ambang pasar minimum tidak dievaluasi.
      warnings.push({ code: 'mcap_unknown', severity: 'warn', reason: 'Market cap tidak dilaporkan sumber untuk pool ini; gate market cap tidak dievaluasi. Unknown bukan berarti cukup.' });
    }
    if (pool.marketCap && pool.fdv) {
      const ratio = pool.fdv / pool.marketCap;
      check(rejections, 'fdv_ratio', ratio <= preset.maxFdvToMcap,
        `FDV/market cap ${ratio.toFixed(2)}x di atas ambang ${preset.maxFdvToMcap}x; suplai belum beredar besar.`);
    }
    if (pool.change?.h24 != null) {
      check(rejections, 'price_change_24h_low', pool.change.h24 >= preset.minPriceChange24hPct,
        `Perubahan 24 jam ${pool.change.h24.toFixed(1)}% di bawah batas ${preset.minPriceChange24hPct}%; hindari token yang sedang jatuh tajam.`);
      check(rejections, 'pump_24h', pool.change.h24 <= preset.maxPriceChange24hPct,
        `Perubahan 24 jam +${pool.change.h24.toFixed(1)}% melewati ambang ${preset.maxPriceChange24hPct}%; hindari mengejar.`);
    }
  }

  const holderCount = safety?.security?.holderCount ?? jupiter?.holderCount ?? null;
  check(rejections, 'holders_low', holderCount !== null && holderCount >= preset.minHolderCount,
    `Jumlah holder ${holderCount ?? 'unknown'} di bawah ambang ${preset.minHolderCount}.`);

  const concentration = concentrationFor(candidate);
  check(rejections, 'concentration_high', concentration.value !== null && concentration.value <= preset.maxTop10Pct,
    `Top 10 holder ${concentration.value === null ? 'unknown' : `${concentration.value.toFixed(1)}%`} (${concentration.source ?? 'sumber tidak diketahui'}) melewati ambang ${preset.maxTop10Pct}%.`);
  // Pembaca kedua dari sumber lain ditampilkan sebagai peringatan, bukan
  // sebagai sumber gate: definisi holder keduanya berbeda dan tidak boleh
  // diperlakukan sebagai angka yang sama.
  const secondary = secondaryConcentration(candidate);
  if (secondary && secondary.value > preset.maxTop10Pct) {
    warnings.push({
      code: 'concentration_goplus_high',
      severity: 'warn',
      reason: `Top 10 menurut GoPlus ${secondary.value.toFixed(1)}% (termasuk wallet exchange/program) melewati ambang ${preset.maxTop10Pct}%. Gate memakai angka ${concentration.source} ${concentration.value.toFixed(1)}% yang memakai definisi holder lebih sempit. Selisih ini adalah perbedaan definisi, bukan bukti aman.`
    });
  }

  // Explicit hazards always reject; missing controls remain unknown even when
  // GoPlus returned a partial token record.
  if (safety?.security) {
    const s = safety.security;
    check(rejections, 'mintable', s.mintable !== true, 'Mint authority masih aktif (mintable); suplai dapat ditambah.');
    check(rejections, 'freezable', s.freezable !== true, 'Freeze authority masih aktif; token dapat dibekukan.');
    check(rejections, 'transfer_fee', !s.transferFee, 'Token-2022 memiliki transfer fee.');
    check(rejections, 'transfer_hook', !s.transferHook, 'Token-2022 memiliki transfer hook.');
    check(rejections, 'non_transferable', s.nonTransferable !== true, 'Token tidak dapat ditransfer.');
    const missing = ['mintable', 'freezable', 'transferFee', 'transferHook', 'nonTransferable'].filter(key => s[key] == null);
    if (missing.length) {
      const reason = `Kontrol kontrak GoPlus unknown: ${missing.join(', ')}; field yang tidak tersedia bukan bukti aman.`;
      if (preset.allowUnknownSafety) warnings.push({ code: 'safety_unknown', severity: 'warn', reason });
      else rejections.push({ code: 'safety_unknown', severity: 'reject', reason });
    }
  } else {
    // GoPlus tidak tersedia: audit Jupiter hanya pembanding, bukan pengganti.
    if (!preset.allowUnknownSafety) {
      rejections.push({ code: 'safety_unknown', severity: 'reject', reason: 'Keamanan kontrak GoPlus tidak tersedia dan preset ini mewajibkan verifikasi.' });
    } else {
      const auditNote = audit?.mintAuthorityDisabled === true && audit?.freezeAuthorityDisabled === true
        ? ' Audit Jupiter menyebut mint/freeze authority mati, tetapi itu bukan pengganti pemeriksaan GoPlus.'
        : '';
      warnings.push({ code: 'safety_unknown', severity: 'warn', reason: `Keamanan kontrak unknown karena GoPlus tidak tersedia.${auditNote} Grade dibatasi C; unknown bukan risiko rendah.` });
    }
  }

  if (preset.requireVerified && jupiter && jupiter.isVerified !== true) {
    rejections.push({ code: 'unverified', severity: 'reject', reason: 'Token belum terverifikasi dan preset ini mewajibkannya.' });
  }
  if (jupiter?.organicLabel && labelRank(jupiter.organicLabel) < labelRank(preset.minOrganicLabel)) {
    rejections.push({ code: 'organic_low', severity: 'reject', reason: `Organic score ${jupiter.organicLabel} di bawah ambang ${preset.minOrganicLabel}.` });
  }

  // Peringatan yang tidak menggugurkan kandidat, tetapi harus terlihat.
  if (pool?.createdAt) {
    const ageHours = (candidate.now - pool.createdAt) / 3_600_000;
    if (ageHours < 24) warnings.push({ code: 'young_pool', severity: 'warn', reason: `Pool berusia ${ageHours.toFixed(1)} jam; riwayat pendek.` });
  }
  if (pool?.marketCap && pool.fdv && pool.fdv / pool.marketCap > 2) {
    warnings.push({ code: 'fdv_gap', severity: 'warn', reason: `FDV ${(pool.fdv / pool.marketCap).toFixed(2)}x market cap; banyak suplai belum beredar.` });
  }
  if (safety?.security?.metadataMutable === true) {
    warnings.push({ code: 'metadata_mutable', severity: 'warn', reason: 'Metadata token masih dapat diubah.' });
  }
  if (safety?.security?.lpHolderPct === null) {
    warnings.push({ code: 'lp_unknown', severity: 'warn', reason: 'Status kunci/burn LP unknown; likuiditas tidak membuktikan LP terkunci.' });
  }

  const sort = list => list.slice().sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  return { passed: rejections.length === 0, rejections: sort(rejections), warnings: sort(warnings) };
}

#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createDb } from './db.mjs';
import { CONFIG_HASH } from './config.mjs';

/**
 * Forward-test offline dari snapshot yang sudah dicatat scanner sendiri.
 *
 * Ini BUKAN backtest historis penuh: scanner baru mencatat snapshot saat
 * discovery dijalankan, jadi jarak antar-snapshot tidak seragam dan bergantung
 * pada kapan pengguna menjalankannya. Semua keterbatasan dicetak bersama hasil
 * agar angka tidak dibaca sebagai bukti edge.
 *
 * Sejak versi ini laporan menjawab tiga pertanyaan yang tidak bisa dijawab
 * laporan lama:
 *  1. Apakah kandidat pernah mencapai 2x / 5x / 10x dalam horizon panjang?
 *     (`peakReturnPct`, bukan hanya return di titik horizon)
 *  2. Apakah token "hampir lolos" (digugurkan gate) justru yang multi-bag?
 *     (kolom cohort `accepted` vs `near-miss`)
 *  3. Gate mana yang paling sering membuang token yang kemudian multi-bag?
 *     (tabel atribusi gate)
 *
 * Pemakaian:
 *   npm run backtest                    # baca data/scanner.db
 *   node backtest.mjs --input snap.json # baca JSON rekaman
 *   node backtest.mjs --horizon 168     # horizon jam, dapat diulang
 */

export const DEFAULT_HORIZONS = [1, 6, 24, 72, 168, 720];
export const MULTIPLES = [2, 5, 10];

export function parseArgs(argv) {
  const args = { input: null, db: 'data/scanner.db', horizons: DEFAULT_HORIZONS, minReturnPct: 10 };
  const horizons = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${token} membutuhkan nilai.`);
      index += 1;
      return next;
    };
    if (token === '--input') args.input = value();
    else if (token === '--db') args.db = value();
    else if (token === '--horizon') {
      const horizon = Number(value());
      if (!Number.isFinite(horizon) || horizon <= 0) throw new Error('--horizon harus berupa angka positif dan finite.');
      horizons.push(horizon);
    }
    else if (token === '--min-return') {
      const minReturnPct = Number(value());
      if (!Number.isFinite(minReturnPct)) throw new Error('--min-return harus berupa angka finite.');
      args.minReturnPct = minReturnPct;
    }
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`Opsi tidak dikenal: ${token}. Jalankan dengan --help untuk melihat daftar opsi.`);
  }
  if (horizons.length) args.horizons = [...new Set(horizons)];
  return args;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rate(values, predicate) {
  if (!values.length) return null;
  return round((values.filter(predicate).length / values.length) * 100);
}

/** Kelipatan puncak: return +100% = 2x. */
function multipleOf(returnPct) {
  return 1 + returnPct / 100;
}

/**
 * Pasangkan snapshot pertama sebagai entry dengan snapshot terdekat pada tiap
 * horizon. Return dihitung dari harga; baris tanpa harga valid dilewati.
 *
 * `peakReturnPct` adalah harga tertinggi yang tercatat ANTARA entry dan exit.
 * Inilah angka yang relevan untuk perburuan multi-bagger: token bisa menyentuh
 * 5x lalu kembali turun, dan return titik-horizon saja akan menyembunyikannya.
 * Tetap keterbatasan: puncak hanya terlihat kalau kebetulan ada snapshot di
 * dekat puncak; jarak snapshot tidak seragam.
 */
export function pairReturns(records, { horizons = DEFAULT_HORIZONS } = {}) {
  const byMint = new Map();
  for (const record of records) {
    const price = Number(record.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const at = Date.parse(record.takenAt);
    if (!Number.isFinite(at)) continue;
    if (!byMint.has(record.mint)) byMint.set(record.mint, []);
    byMint.get(record.mint).push({
      at,
      price,
      score: record.score ?? null,
      grade: record.grade ?? null,
      scoreStage: record.scoreStage ?? 'initial',
      nearMiss: record.nearMiss === true,
      preset: record.preset ?? null,
      gateCodes: Array.isArray(record.gateCodes) ? record.gateCodes : []
    });
  }

  const observations = [];
  let unpaired = 0;
  for (const [mint, series] of byMint) {
    series.sort((a, b) => a.at - b.at);
    const entry = series[0];
    for (const horizon of horizons) {
      const targetAt = entry.at + horizon * 3_600_000;
      // Ambil snapshot pertama yang setidaknya mencapai horizon.
      const exitIndex = series.findIndex(point => point.at >= targetAt);
      if (exitIndex === -1) { unpaired += 1; continue; }
      const exit = series[exitIndex];
      // Puncak di dalam jendela entry..exit (termasuk exit).
      let peak = entry;
      for (const point of series.slice(0, exitIndex + 1)) {
        if (point.price > peak.price) peak = point;
      }
      const returnPct = (exit.price / entry.price - 1) * 100;
      const peakReturnPct = (peak.price / entry.price - 1) * 100;
      observations.push({
        mint,
        horizon,
        grade: entry.grade,
        score: entry.score,
        scoreStage: entry.scoreStage,
        cohort: entry.nearMiss ? 'near-miss' : 'accepted',
        preset: entry.preset,
        gateCodes: entry.gateCodes,
        entryPrice: entry.price,
        exitPrice: exit.price,
        elapsedHours: (exit.at - entry.at) / 3_600_000,
        returnPct,
        peakReturnPct,
        peakMultiple: multipleOf(peakReturnPct),
        hoursToPeak: (peak.at - entry.at) / 3_600_000
      });
    }
  }
  return { observations, unpaired, mints: byMint.size };
}

export function summarize(observations, { minReturnPct = 10 } = {}) {
  const buckets = new Map();
  for (const item of observations) {
    const cohort = item.cohort ?? 'accepted';
    const preset = item.preset ?? 'unknown';
    // Preset ikut jadi kunci: ambang dan bobot tiap preset berbeda, jadi
    // menggabungkannya membuat kalibrasi per preset tidak mungkin dilakukan.
    const key = `${item.horizon}|${item.grade ?? 'unknown'}|${item.scoreStage ?? 'initial'}|${cohort}|${preset}`;
    if (!buckets.has(key)) buckets.set(key, { horizon: item.horizon, grade: item.grade ?? 'unknown', scoreStage: item.scoreStage ?? 'initial', cohort, preset, returns: [], peaks: [] });
    buckets.get(key).returns.push(item.returnPct);
    buckets.get(key).peaks.push(item.peakReturnPct ?? item.returnPct);
  }
  return [...buckets.values()]
    .map(bucket => {
      const peaks = bucket.peaks;
      return {
        horizon: bucket.horizon,
        grade: bucket.grade,
        scoreStage: bucket.scoreStage,
        cohort: bucket.cohort,
        preset: bucket.preset,
        count: bucket.returns.length,
        medianReturnPct: round(median(bucket.returns)),
        meanReturnPct: round(bucket.returns.reduce((sum, value) => sum + value, 0) / bucket.returns.length),
        winRatePct: rate(bucket.returns, value => value > 0),
        hitRatePct: rate(bucket.returns, value => value >= minReturnPct),
        medianPeakReturnPct: round(median(peaks)),
        bestPeakReturnPct: peaks.length ? round(Math.max(...peaks)) : null,
        ...Object.fromEntries(MULTIPLES.map(multiple => [
          `pct${multiple}x`,
          rate(peaks, value => multipleOf(value) >= multiple)
        ]))
      };
    })
    .sort((a, b) => a.horizon - b.horizon || a.cohort.localeCompare(b.cohort) || a.preset.localeCompare(b.preset) || a.grade.localeCompare(b.grade) || a.scoreStage.localeCompare(b.scoreStage));
}

/**
 * Atribusi gate: untuk tiap kode gate yang menggugurkan kandidat near-miss,
 * berapa banyak yang kemudian mencapai kelipatan tertentu. Gate dengan
 * persentase multi-bag tinggi adalah gate yang paling merugikan untuk tujuan
 * scanner ini, dan itu kandidat pertama untuk dilonggarkan.
 */
export function gateAttribution(observations, { minMultiple = 2 } = {}) {
  const buckets = new Map();
  for (const item of observations) {
    if ((item.cohort ?? 'accepted') !== 'near-miss') continue;
    for (const code of new Set(item.gateCodes ?? [])) {
      if (!buckets.has(code)) buckets.set(code, { code, returns: [], peaks: [] });
      buckets.get(code).returns.push(item.returnPct);
      buckets.get(code).peaks.push(item.peakReturnPct ?? item.returnPct);
    }
  }
  return [...buckets.values()]
    .map(bucket => ({
      code: bucket.code,
      count: bucket.returns.length,
      medianReturnPct: round(median(bucket.returns)),
      medianPeakReturnPct: round(median(bucket.peaks)),
      bestPeakReturnPct: bucket.peaks.length ? round(Math.max(...bucket.peaks)) : null,
      pctReachedMultiple: rate(bucket.peaks, value => multipleOf(value) >= minMultiple),
      minMultiple
    }))
    .sort((a, b) => (b.pctReachedMultiple ?? -1) - (a.pctReachedMultiple ?? -1) || b.count - a.count);
}

function round(value) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(2));
}

function printReport({ records, result, summary, attribution, minMultiple, args, source }) {
  console.log('Backtest forward-test (snapshot yang dicatat scanner sendiri)');
  console.log(`Sumber            : ${source}`);
  console.log(`Config hash       : ${CONFIG_HASH}`);
  console.log(`Snapshot          : ${records.length}`);
  console.log(`Mint unik         : ${result.mints}`);
  console.log(`Observasi return  : ${result.observations.length} (belum berpasangan: ${result.unpaired})`);
  console.log(`Ambang hit        : >= ${args.minReturnPct}%`);
  console.log('');

  const peakHeader = 'peak median %';
  if (!summary.length) {
    console.log('Belum ada pasangan snapshot yang cukup. Jalankan discovery beberapa kali');
    console.log('dengan jarak minimal sepanjang horizon, lalu ulangi perintah ini.');
  } else {
    console.log(`horizon | cohort     | preset     | grade | tahap      | n   | median % | ${peakHeader.padEnd(13)} | win %  | hit %  |   2x % |   5x % |  10x %`);
    console.log('--------|------------|------------|-------|------------|-----|----------|---------------|--------|--------|--------|--------|-------');
    for (const row of summary) {
      console.log(`${String(row.horizon).padStart(6)}h | ${(row.cohort ?? 'accepted').padEnd(10)} | ${(row.preset ?? 'unknown').padEnd(10)} | ${row.grade.padEnd(5)} | ${(row.scoreStage ?? 'initial').padEnd(10)} | ${String(row.count).padStart(3)} | ${String(row.medianReturnPct).padStart(8)} | ${String(row.medianPeakReturnPct).padStart(13)} | ${String(row.winRatePct).padStart(6)} | ${String(row.hitRatePct).padStart(6)} | ${String(row.pct2x).padStart(6)} | ${String(row.pct5x).padStart(6)} | ${String(row.pct10x).padStart(6)}`);
    }
  }

  console.log('');
  if (!attribution.length) {
    console.log(`Atribusi gate: belum ada snapshot near-miss (token yang digugurkan gate).`);
  } else {
    console.log(`Atribusi gate near-miss: gate mana yang membuang kandidat yang kemudian mencapai ${minMultiple}x+ (peak)`);
    console.log('gate                          | n   | median % | peak median % | peak terbaik % |  capai >=mult %');
    console.log('------------------------------|-----|----------|---------------|----------------|----------------');
    for (const row of attribution) {
      console.log(`${row.code.padEnd(29)} | ${String(row.count).padStart(3)} | ${String(row.medianReturnPct).padStart(8)} | ${String(row.medianPeakReturnPct).padStart(13)} | ${String(row.bestPeakReturnPct).padStart(14)} | ${String(row.pctReachedMultiple).padStart(15)}`);
    }
  }

  console.log('');
  console.log('Batas yang harus dibaca bersama angka di atas:');
  console.log('- Tahap skor: "deep" = skor final setelah deep scan (struktur 1 jam dan GoPlus), "initial" = skor ranking awal yang belum dianalisis struktur. Campuran keduanya tidak sebanding; lihat kolom tahap skor.');
  console.log('- Cohort: "accepted" = lolos gate saat dicatat, "near-miss" = digugurkan gate tetapi tetap dicatat berskor. Membandingkan keduanya menunjukkan apakah gate membuang kandidat terbaik.');
  console.log('- Kolom "peak" = harga tertinggi yang TERCATAT antara entry dan exit, bukan puncak sebenarnya di pasar. Multi-bagger bisa terlewat bila tidak ada snapshot di dekat puncak.');
  console.log('- Jarak snapshot tidak seragam; return diukur pada snapshot pertama yang mencapai horizon, bukan tepat di horizon.');
  console.log('- Tidak ada biaya transaksi, slippage, atau penalti pajak. Multi-bagger kotor bukan profit bersih.');
  console.log('- Kandidat yang tidak dicatat ulang tetap hilang (bias seleksi: token yang terus menarik perhatian lebih sering tercatat).');
  console.log('- Atribusi gate hanya menghitung near-miss yang tercatat; gate yang menggugurkan token sebelum snapshot tidak terlihat.');
  console.log('- Ukuran sampel kecil. Angka ini mengukur konsistensi data, bukan membuktikan edge.');
  console.log('- Snapshot hanya ada bila discovery dijalankan; kemunculan kandidat bukan rekomendasi.');
}

async function loadRecords(args) {
  if (args.input) {
    const parsed = JSON.parse(await readFile(args.input, 'utf8'));
    if (Array.isArray(parsed)) return { records: parsed, source: args.input };
    if (parsed && Array.isArray(parsed.snapshots)) return { records: parsed.snapshots, source: args.input };
    throw new Error('Format input tidak dikenal: diharapkan array snapshot atau objek { "snapshots": [...] }.');
  }
  const db = await createDb(args.db);
  if (!db.available) throw new Error(db.reason);
  try {
    return { records: await db.allSnapshots(), source: args.db };
  } finally {
    await db.close();
  }
}

function printHelp() {
  console.log(`Pemakaian: npm run backtest -- [opsi]

  --input <file>   Baca snapshot dari JSON, bukan SQLite
  --db <file>      Path SQLite (default data/scanner.db)
  --horizon <jam>  Satu horizon dalam jam (bisa diulang; default ${DEFAULT_HORIZONS.join(', ')})
  --min-return <n> Ambang persen untuk kolom hit (default 10)
  --help           Tampilkan bantuan ini

Contoh JSON: [{ "mint": "...", "takenAt": "2026-01-01T00:00:00.000Z", "price": 0.5, "score": 72, "grade": "B", "nearMiss": false, "gateCodes": [] }]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const { records, source } = await loadRecords(args);
  const result = pairReturns(records, { horizons: args.horizons });
  const summary = summarize(result.observations, { minReturnPct: args.minReturnPct });
  const minMultiple = 2;
  const attribution = gateAttribution(result.observations, { minMultiple });
  printReport({ records, result, summary, attribution, minMultiple, args, source });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Backtest gagal: ${error.message}`);
    process.exitCode = 1;
  });
}
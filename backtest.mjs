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
 * Pemakaian:
 *   npm run backtest                    # baca data/scanner.db
 *   node backtest.mjs --input snap.json # baca JSON rekaman
 *   node backtest.mjs --horizon 24      # horizon jam (default 24)
 */

export const DEFAULT_HORIZONS = [1, 6, 24, 72];

export function parseArgs(argv) {
  const args = { input: null, db: 'data/scanner.db', horizons: DEFAULT_HORIZONS, minReturnPct: 10 };
  const horizons = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--input') args.input = argv[++index];
    else if (token === '--db') args.db = argv[++index];
    else if (token === '--horizon') {
      const horizon = Number(argv[++index]);
      if (!Number.isFinite(horizon) || horizon <= 0) throw new Error('--horizon harus berupa angka positif dan finite.');
      horizons.push(horizon);
    }
    else if (token === '--min-return') {
      const minReturnPct = Number(argv[++index]);
      if (!Number.isFinite(minReturnPct)) throw new Error('--min-return harus berupa angka finite.');
      args.minReturnPct = minReturnPct;
    }
    else if (token === '--help' || token === '-h') args.help = true;
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

/**
 * Pasangkan snapshot pertama sebagai entry dengan snapshot terdekat pada tiap
 * horizon. Return dihitung dari harga; baris tanpa harga valid dilewati.
 */
export function pairReturns(records, { horizons = DEFAULT_HORIZONS } = {}) {
  const byMint = new Map();
  for (const record of records) {
    const price = Number(record.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const at = Date.parse(record.takenAt);
    if (!Number.isFinite(at)) continue;
    if (!byMint.has(record.mint)) byMint.set(record.mint, []);
    byMint.get(record.mint).push({ at, price, score: record.score ?? null, grade: record.grade ?? null });
  }

  const observations = [];
  let unpaired = 0;
  for (const [mint, series] of byMint) {
    series.sort((a, b) => a.at - b.at);
    const entry = series[0];
    for (const horizon of horizons) {
      const targetAt = entry.at + horizon * 3_600_000;
      const after = series.filter(point => point.at >= targetAt);
      if (!after.length) { unpaired += 1; continue; }
      // Ambil snapshot pertama yang setidaknya mencapai horizon.
      const exit = after[0];
      observations.push({
        mint,
        horizon,
        grade: entry.grade,
        score: entry.score,
        entryPrice: entry.price,
        exitPrice: exit.price,
        elapsedHours: (exit.at - entry.at) / 3_600_000,
        returnPct: (exit.price / entry.price - 1) * 100
      });
    }
  }
  return { observations, unpaired, mints: byMint.size };
}

export function summarize(observations, { minReturnPct = 10 } = {}) {
  const buckets = new Map();
  for (const item of observations) {
    const key = `${item.horizon}|${item.grade ?? 'unknown'}`;
    if (!buckets.has(key)) buckets.set(key, { horizon: item.horizon, grade: item.grade ?? 'unknown', returns: [] });
    buckets.get(key).returns.push(item.returnPct);
  }
  return [...buckets.values()]
    .map(bucket => ({
      horizon: bucket.horizon,
      grade: bucket.grade,
      count: bucket.returns.length,
      medianReturnPct: round(median(bucket.returns)),
      meanReturnPct: round(bucket.returns.reduce((sum, value) => sum + value, 0) / bucket.returns.length),
      winRatePct: round((bucket.returns.filter(value => value > 0).length / bucket.returns.length) * 100),
      hitRatePct: round((bucket.returns.filter(value => value >= minReturnPct).length / bucket.returns.length) * 100)
    }))
    .sort((a, b) => a.horizon - b.horizon || a.grade.localeCompare(b.grade));
}

function round(value) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(2));
}

function printReport({ records, result, summary, args, source }) {
  console.log('Backtest forward-test (snapshot yang dicatat scanner sendiri)');
  console.log(`Sumber            : ${source}`);
  console.log(`Config hash       : ${CONFIG_HASH}`);
  console.log(`Snapshot          : ${records.length}`);
  console.log(`Mint unik         : ${result.mints}`);
  console.log(`Observasi return  : ${result.observations.length} (belum berpasangan: ${result.unpaired})`);
  console.log(`Ambang hit        : >= ${args.minReturnPct}%`);
  console.log('');
  if (!summary.length) {
    console.log('Belum ada pasangan snapshot yang cukup. Jalankan discovery beberapa kali');
    console.log('dengan jarak minimal sepanjang horizon, lalu ulangi perintah ini.');
  } else {
    console.log('horizon | grade | n | median % | mean % | win % | hit %');
    console.log('--------|-------|---|----------|--------|-------|------');
    for (const row of summary) {
      console.log(`${String(row.horizon).padStart(6)}h | ${row.grade.padEnd(5)} | ${String(row.count).padStart(1)} | ${String(row.medianReturnPct).padStart(8)} | ${String(row.meanReturnPct).padStart(6)} | ${String(row.winRatePct).padStart(5)} | ${String(row.hitRatePct).padStart(4)}`);
    }
  }
  console.log('');
  console.log('Batas yang harus dibaca bersama angka di atas:');
  console.log('- Jarak snapshot tidak seragam; return diukur pada snapshot pertama yang mencapai horizon, bukan tepat di horizon.');
  console.log('- Tidak ada biaya transaksi, slippage, atau penalti pajak.');
  console.log('- Kandidat yang tidak dicatat ulang tetap hilang (bias seleksi: token yang terus menarik perhatian lebih sering tercatat).');
  console.log('- Ukuran sampel kecil. Angka ini mengukur konsistensi data, bukan membuktikan edge.');
  console.log('- Snapshot hanya ada bila discovery dijalankan; kemunculan kandidat bukan rekomendasi.');
}

async function loadRecords(args) {
  if (args.input) {
    const parsed = JSON.parse(await readFile(args.input, 'utf8'));
    const records = Array.isArray(parsed) ? parsed : parsed.snapshots ?? [];
    return { records, source: args.input };
  }
  const db = createDb(args.db);
  if (!db.available) throw new Error(db.reason);
  try {
    return { records: db.allSnapshots(), source: args.db };
  } finally {
    db.close();
  }
}

function printHelp() {
  console.log(`Pemakaian: npm run backtest -- [opsi]

  --input <file>   Baca snapshot dari JSON, bukan SQLite
  --db <file>      Path SQLite (default data/scanner.db)
  --horizon <jam>  Satu horizon dalam jam (bisa diulang)
  --min-return <n> Ambang persen untuk kolom hit (default 10)
  --help           Tampilkan bantuan ini

Contoh JSON: [{ "mint": "...", "takenAt": "2026-01-01T00:00:00.000Z", "price": 0.5, "score": 72, "grade": "B" }]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const { records, source } = await loadRecords(args);
  const result = pairReturns(records, { horizons: args.horizons });
  const summary = summarize(result.observations, { minReturnPct: args.minReturnPct });
  printReport({ records, result, summary, args, source });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Backtest gagal: ${error.message}`);
    process.exitCode = 1;
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { gateAttribution, median, pairReturns, parseArgs, summarize } from '../backtest.mjs';

const day = index => new Date(Date.UTC(2026, 0, 1 + index)).toISOString();

test('median menangani jumlah ganjil, genap, dan kosong', () => {
  assert.equal(median([]), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('parseArgs memakai default dan menimpa horizon', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.db, 'data/scanner.db');
  assert.equal(defaults.minReturnPct, 10);
  assert.deepEqual(defaults.horizons, [1, 6, 24, 72, 168, 720], 'default mencakup horizon multi-bagger 7d/30d');
  const custom = parseArgs(['--horizon', '12', '--min-return', '25', '--input', 'x.json']);
  assert.deepEqual(custom.horizons, [12]);
  assert.equal(custom.minReturnPct, 25);
  assert.equal(custom.input, 'x.json');
});

test('parseArgs mempertahankan beberapa horizon unik dan menolak parameter non-finite/tidak positif', () => {
  const custom = parseArgs(['--horizon', '12', '--horizon', '24', '--horizon', '12']);
  assert.deepEqual(custom.horizons, [12, 24]);
  assert.throws(() => parseArgs(['--horizon', '0']), /angka positif/);
  assert.throws(() => parseArgs(['--horizon', '-1']), /angka positif/);
  assert.throws(() => parseArgs(['--horizon', 'Infinity']), /angka positif/);
  assert.throws(() => parseArgs(['--min-return', 'NaN']), /angka finite/);
});

test('pairReturns memasangkan snapshot pertama dengan snapshot yang mencapai horizon', () => {
  const records = [
    { mint: 'A', takenAt: day(0), price: 1.0, score: 70, grade: 'B' },
    { mint: 'A', takenAt: day(1), price: 1.1, score: 72, grade: 'B' },
    { mint: 'A', takenAt: day(3), price: 1.5, score: 60, grade: 'C' }
  ];
  const result = pairReturns(records, { horizons: [24, 72] });
  assert.equal(result.mints, 1);
  assert.equal(result.observations.length, 2);
  const day24 = result.observations.find(item => item.horizon === 24);
  assert.ok(Math.abs(day24.returnPct - 10) < 1e-9);
  const day72 = result.observations.find(item => item.horizon === 72);
  assert.ok(Math.abs(day72.returnPct - 50) < 1e-9);
  assert.equal(day72.grade, 'B', 'grade diambil dari snapshot entry, bukan exit');
});

test('pairReturns melewati baris tanpa harga valid dan menandai yang belum berpasangan', () => {
  const records = [
    { mint: 'B', takenAt: day(0), price: 0, grade: 'A' },
    { mint: 'C', takenAt: day(0), price: 2, grade: 'A' },
    { mint: 'C', takenAt: 'bukan tanggal', price: 3, grade: 'A' }
  ];
  const result = pairReturns(records, { horizons: [24] });
  assert.equal(result.observations.length, 0);
  assert.ok(result.unpaired >= 1);
});

test('summarize menghitung median, win rate, dan hit rate per grade', () => {
  const observations = [
    { horizon: 24, grade: 'A', returnPct: 20, mint: 'a' },
    { horizon: 24, grade: 'A', returnPct: -5, mint: 'b' },
    { horizon: 24, grade: 'A', returnPct: 5, mint: 'c' },
    { horizon: 24, grade: 'D', returnPct: -30, mint: 'd' }
  ];
  const summary = summarize(observations, { minReturnPct: 10 });
  const a = summary.find(row => row.grade === 'A');
  assert.equal(a.count, 3);
  assert.equal(a.medianReturnPct, 5);
  assert.equal(a.winRatePct, 66.67);
  assert.equal(a.hitRatePct, 33.33);
  // Tanpa peakReturnPct, peak jatuh ke return titik-horizon: tidak boleh crash.
  assert.equal(a.medianPeakReturnPct, 5);
  const d = summary.find(row => row.grade === 'D');
  assert.equal(d.medianReturnPct, -30);
  assert.equal(d.hitRatePct, 0);
});

test('summarize memisahkan cohort accepted dan near-miss', () => {
  const observations = [
    { horizon: 24, grade: 'B', cohort: 'accepted', returnPct: 10, peakReturnPct: 10 },
    { horizon: 24, grade: 'C', cohort: 'near-miss', returnPct: 300, peakReturnPct: 400 }
  ];
  const summary = summarize(observations, { minReturnPct: 10 });
  const accepted = summary.find(row => row.cohort === 'accepted');
  const nearMiss = summary.find(row => row.cohort === 'near-miss');
  assert.equal(accepted.count, 1);
  assert.equal(nearMiss.count, 1);
  assert.equal(nearMiss.pct2x, 100, 'peak +400% adalah 5x, jadi juga >= 2x');
  assert.equal(nearMiss.pct10x, 0);
  assert.equal(accepted.pct2x, 0);
});

test('pairReturns menghitung puncak di dalam jendela, bukan hanya titik horizon', () => {
  // Harga menyentuh 5x lalu turun kembali ke 1.2x pada horizon 72 jam.
  const records = [
    { mint: 'A', takenAt: day(0), price: 1.0, grade: 'B' },
    { mint: 'A', takenAt: day(1), price: 5.0, grade: 'B' },
    { mint: 'A', takenAt: day(3), price: 1.2, grade: 'B' }
  ];
  const result = pairReturns(records, { horizons: [72] });
  const observation = result.observations[0];
  assert.ok(Math.abs(observation.returnPct - 20) < 1e-9, 'return titik horizon tetap +20%');
  assert.ok(Math.abs(observation.peakReturnPct - 400) < 1e-9, 'puncak 5x harus terlihat');
  assert.equal(observation.peakMultiple, 5);
  assert.ok(Math.abs(observation.hoursToPeak - 24) < 1e-9);
});

test('gateAttribution mengurutkan gate yang paling sering membuang multi-bagger', () => {
  const observations = [
    { horizon: 72, cohort: 'near-miss', gateCodes: ['mcap_low'], returnPct: 300, peakReturnPct: 400 },
    { horizon: 72, cohort: 'near-miss', gateCodes: ['mcap_low', 'holders_low'], returnPct: -10, peakReturnPct: 5 },
    { horizon: 72, cohort: 'near-miss', gateCodes: ['holders_low'], returnPct: 20, peakReturnPct: 25 },
    { horizon: 72, cohort: 'accepted', gateCodes: [], returnPct: 50, peakReturnPct: 60 }
  ];
  const attribution = gateAttribution(observations, { minMultiple: 2 });
  assert.equal(attribution[0].code, 'mcap_low', 'gate dengan satu multi-bag dari dua harus memimpin');
  assert.equal(attribution[0].count, 2);
  assert.equal(attribution[0].pctReachedMultiple, 50);
  const holders = attribution.find(row => row.code === 'holders_low');
  assert.equal(holders.count, 2);
  assert.equal(holders.pctReachedMultiple, 0);
  assert.ok(!attribution.some(row => row.code === undefined), 'hanya gate nyata yang dihitung');
});

test('summarize mengembalikan daftar kosong tanpa observasi', () => {
  assert.deepEqual(summarize([], {}), []);
});

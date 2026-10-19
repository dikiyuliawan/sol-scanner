import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCandles } from '../signals.mjs';

// Fixture OHLCV sintetis untuk unit test saja; bukan data pasar atau input runtime.
const NOW = Date.UTC(2024, 0, 1, 12, 7, 0);
const CURRENT_START = Math.floor((NOW / 1000) / 900) * 900;
const INTERVAL = 900;

function fixture({ count = 21, ageOffset = 0, volume = 100 } = {}) {
  const firstTime = CURRENT_START - INTERVAL * count - ageOffset;
  return Array.from({ length: count }, (_, index) => [
    firstTime + INTERVAL * index,
    99,
    101,
    98,
    100,
    volume
  ]);
}

function run(rows, now = NOW) {
  return analyzeCandles(rows, { now });
}

test('menganalisis 21 candle tertutup dan menghasilkan metrik utama', () => {
  const result = run(fixture());
  assert.equal(result.status, 'available');
  assert.equal(result.candles.length, 21);
  assert.equal(result.metrics.closeUsd, 100);
  assert.equal(result.metrics.sma20Usd, 100);
  assert.equal(result.metrics.previousHighUsd, 101);
  assert.equal(result.metrics.previousLowUsd, 98);
  assert.equal(result.metrics.relativeVolume, 1);
  assert.equal(result.metrics.change5hPct, 0);
  assert.equal(result.watch.state, 'near_resistance');
});

test('lastClosedAt adalah waktu penutupan candle terakhir dalam ISO', () => {
  const result = run(fixture());
  assert.equal(result.lastClosedAt, new Date(CURRENT_START * 1000).toISOString());
  assert.equal(result.candleAgeSeconds, NOW / 1000 - CURRENT_START);
});

test('mengurutkan baris tidak berurutan menurut timestamp', () => {
  const rows = fixture().reverse();
  const result = run(rows);
  assert.equal(result.status, 'available');
  assert.ok(result.candles.every((candle, index, list) => index === 0 || candle.time > list[index - 1].time));
});

test('mengecualikan candle berjalan dengan tetap mempertahankan jumlah 21 candle tertutup', () => {
  const rows = fixture();
  rows.push([CURRENT_START, 100, 105, 99, 104, 500]);
  const result = run(rows);
  assert.equal(result.status, 'available');
  assert.equal(result.candles.length, 21);
  assert.equal(result.candles.at(-1).time, CURRENT_START - INTERVAL);
  assert.equal(result.metrics.closeUsd, 100);
});

test('data stale menghasilkan unknown dan tanpa sinyal actionable', () => {
  const result = run(fixture({ ageOffset: 3 * INTERVAL }));
  assert.equal(result.status, 'unknown');
  assert.match(result.reason, /stale/i);
  assert.ok(result.signals.every(signal => signal.level === 'unknown'));
});

test('celah di dalam 21 candle terakhir menghasilkan unknown', () => {
  const rows = fixture();
  rows.splice(10, 1);
  rows.unshift([rows[0][0] - INTERVAL, 99, 101, 98, 100, 100]);
  const result = run(rows);
  assert.equal(result.status, 'unknown');
  assert.match(result.reason, /celah/i);
});

test('baseline volume nol dinyatakan tidak dapat dinilai', () => {
  const result = run(fixture({ volume: 0 }));
  assert.equal(result.status, 'available');
  assert.equal(result.metrics.relativeVolume, null);
  assert.match(result.metrics.volumeDescription, /nol/i);
});

test('breakout dengan volume setidaknya 1,5x menjadi watch terkonfirmasi', () => {
  const rows = fixture();
  rows[20] = [rows[20][0], 101, 103, 100, 102, 150];
  const result = run(rows);
  assert.equal(result.status, 'available');
  assert.equal(result.watch.state, 'breakout');
  assert.match(result.watch.invalidation, /bukan stop-order/i);
});

test('breakout dengan volume rendah belum terkonfirmasi', () => {
  const rows = fixture();
  rows[20] = [rows[20][0], 101, 103, 100, 102, 149];
  const result = run(rows);
  assert.equal(result.watch.state, 'breakout_unconfirmed');
  assert.match(result.watch.reason, /belum mencapai/i);
});

test('baris malformed ditolak', () => {
  const rows = fixture();
  rows[4] = [rows[4][0], 100, 101];
  assert.equal(run(rows).status, 'unknown');
});

test('tipe string, null, atau non-number pada nilai candle ditolak', () => {
  for (const bad of ['100', null, NaN, Infinity]) {
    const rows = fixture();
    rows[0][1] = bad;
    assert.equal(run(rows).status, 'unknown');
  }
});

test('rows bukan array ditolak', () => {
  assert.equal(analyzeCandles(null, { now: NOW }).status, 'unknown');
});

test('jumlah candle kurang dari 21 menghasilkan unknown', () => {
  assert.equal(run(fixture({ count: 20 })).status, 'unknown');
});

test('timestamp candle yang lebih baru dari awal interval saat ini ditolak', () => {
  const rows = fixture();
  rows.push([CURRENT_START + INTERVAL, 100, 101, 99, 100, 100]);
  assert.equal(run(rows).status, 'unknown');
});

test('timestamp duplikat ditolak', () => {
  const rows = fixture();
  rows[20][0] = rows[19][0];
  assert.equal(run(rows).status, 'unknown');
});

test('timestamp yang tidak selaras 900 detik ditolak', () => {
  const rows = fixture();
  rows[0][0] += 1;
  assert.equal(run(rows).status, 'unknown');
});

test('volume negatif ditolak', () => {
  const rows = fixture();
  rows[0][5] = -1;
  assert.equal(run(rows).status, 'unknown');
});

test('rentang OHLC mustahil ditolak', () => {
  const rows = fixture();
  rows[0][2] = 99;
  assert.equal(run(rows).status, 'unknown');
});

test('kenaikan lebih dari 8% di atas SMA20 menjadi warning extended yang mengesampingkan breakout', () => {
  const rows = fixture();
  rows[20] = [rows[20][0], 108, 111, 107, 109, 300];
  const result = run(rows);
  assert.equal(result.status, 'available');
  assert.ok(result.metrics.extensionPct > 8);
  assert.equal(result.watch.state, 'extended');
  assert.ok(result.signals.some(signal => signal.level === 'warning'));
  assert.match(result.watch.reason, /jangan mengejar/i);
});

test('dekat resistance dalam jarak 2% menghasilkan watch observasional', () => {
  const rows = fixture();
  rows[20] = [rows[20][0], 99, 101, 98, 100, 100];
  const result = run(rows);
  assert.equal(result.watch.state, 'near_resistance');
});

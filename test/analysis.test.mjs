import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStructure, atr, ema, parseCandles, rsi } from '../analysis/candles.mjs';
import { buildEntryPlan } from '../analysis/entryplan.mjs';

const NOW = Date.UTC(2024, 0, 2, 0, 0, 0);

function candles({ count = 60, start = 100, step = 0.5, volume = 1000, interval = 3600 } = {}) {
  const currentStart = Math.floor(NOW / 1000 / interval) * interval;
  return Array.from({ length: count }, (_, index) => {
    const close = start + step * index;
    return [currentStart - (count - index) * interval, close - 0.2, close + 0.4, close - 0.5, close, volume];
  });
}

test('ema menghitung nilai rata-rata awal dan konvergen pada data konstan', () => {
  assert.equal(ema([5, 5, 5, 5], 3), 5);
  assert.equal(ema([1, 2], 3), null);
});

test('atr dan rsi menghasilkan null bila data kurang', () => {
  assert.equal(atr(candles({ count: 5 }), 14), null);
  assert.equal(rsi(candles({ count: 5 }), 14), null);
});

test('rsi mendekati 100 pada kenaikan monoton dan 0 pada penurunan monoton', () => {
  const up = candles({ count: 40, step: 1 }).map((row, index) => [row[0], 100 + index, 101 + index, 99 + index, 100 + index, 1000]);
  const down = candles({ count: 40, step: -1 }).map((row, index) => [row[0], 200 - index, 201 - index, 199 - index, 200 - index, 1000]);
  assert.ok(rsi(up.map(r => ({ close: r[4] })), 14) > 95);
  assert.ok(rsi(down.map(r => ({ close: r[4] })), 14) < 5);
});

test('parseCandles membuang baris rusak tanpa membatalkan seluruh data', () => {
  const rows = candles({ count: 30 });
  rows[3] = [rows[3][0], 'bad', 1, 1, 1, 1];
  rows.push([rows.at(-1)[0], 1, 1, 1, 1, 1]); // duplikat timestamp
  const parsed = parseCandles(rows, { intervalSeconds: 3600, now: NOW });
  assert.equal(parsed.dropped, 2);
  assert.equal(parsed.candles.length, 29);
});

test('parseCandles mengecualikan candle berjalan', () => {
  const currentStart = Math.floor(NOW / 1000 / 3600) * 3600;
  const rows = candles({ count: 30 });
  rows.push([currentStart, 100, 101, 99, 100, 100]);
  const parsed = parseCandles(rows, { intervalSeconds: 3600, now: NOW });
  assert.equal(parsed.candles.length, 30);
  assert.ok(parsed.candles.every(candle => candle.time < currentStart));
});

test('analyzeStructure menandai uptrend, HH/HL, dan jarak ke high', () => {
  const parsed = parseCandles(candles({ count: 60, step: 0.8 }), { intervalSeconds: 3600, now: NOW });
  const structure = analyzeStructure(parsed.candles);
  assert.equal(structure.status, 'available');
  assert.equal(structure.trend, 'uptrend');
  assert.equal(structure.higherHigh, true);
  assert.equal(structure.higherLow, true);
  assert.ok(structure.atrPct > 0);
  assert.ok(structure.distanceToHighPct < 0, 'harga di atas high 20 periode sebelumnya');
});

test('analyzeStructure unknown bila candle kurang dari 30', () => {
  const structure = analyzeStructure([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  assert.equal(structure.status, 'unknown');
});

test('entry plan uptrend menghasilkan zona, invalidasi di bawah entry, dan R:R terukur', () => {
  const parsed = parseCandles(candles({ count: 60, step: 0.8 }), { intervalSeconds: 3600, now: NOW });
  const structure = analyzeStructure(parsed.candles);
  const plan = buildEntryPlan(structure, { slippagePct: 0.5 });
  assert.ok(['plan', 'no_plan'].includes(plan.status));
  assert.ok(plan.entryLow < plan.entryHigh);
  assert.ok(plan.invalidation < plan.entryLow);
  assert.ok(plan.riskReward > 0);
  assert.equal(plan.targets.length, 3);
  assert.ok(plan.positionUsd > 0);
});

test('entry plan menolak slippage di atas batas tanpa memaksakan rencana', () => {
  const parsed = parseCandles(candles({ count: 60 }), { intervalSeconds: 3600, now: NOW });
  const plan = buildEntryPlan(analyzeStructure(parsed.candles), { slippagePct: 5 });
  assert.equal(plan.status, 'no_plan');
  assert.equal(plan.setup, 'illiquid');
  assert.match(plan.reason, /slippage/i);
});

test('entry plan menandai extended dan tidak menyebut entry buy', () => {
  const rows = candles({ count: 60, start: 100, step: 4 });
  const parsed = parseCandles(rows, { intervalSeconds: 3600, now: NOW });
  const plan = buildEntryPlan(analyzeStructure(parsed.candles), { slippagePct: 0.2 });
  assert.equal(plan.setup, 'extended');
  assert.match(plan.rationale, /jangan mengejar|tunggu pullback/i);
  assert.match(plan.note, /bukan perintah/i);
});

test('entry plan tanpa struktur mengembalikan no_plan', () => {
  assert.equal(buildEntryPlan(null).status, 'no_plan');
  assert.equal(buildEntryPlan({ status: 'unknown' }).status, 'no_plan');
});

test('invalidasi = satu ATR di bawah zona entry, bukan low20 yang dalam', () => {
  const parsed = parseCandles(candles({ count: 60, step: 0.6 }), { intervalSeconds: 3600, now: NOW });
  const structure = analyzeStructure(parsed.candles);
  const plan = buildEntryPlan(structure, { slippagePct: 0.3 });
  const expected = plan.entryLow - structure.atr14;
  assert.ok(Math.abs(plan.invalidation - expected) < 1e-9, 'invalidasi memakai 1x ATR');
  assert.ok(plan.invalidation > structure.low20, 'invalidasi tidak memakai low20 yang jauh');
});

test('target memakai level nyata (high20), bukan kelipatan R yang memaksa R:R tetap', () => {
  const parsed = parseCandles(candles({ count: 60, step: 0.6 }), { intervalSeconds: 3600, now: NOW });
  const structure = analyzeStructure(parsed.candles);
  const plan = buildEntryPlan(structure, { slippagePct: 0.3 });
  if (plan.status === 'plan' || plan.setup === 'trend_pullback') {
    assert.equal(plan.targets[0], structure.high20, 'target pertama adalah resistance nyata');
  }
  assert.notEqual(plan.riskReward, 1, 'R:R tidak dipaksa menjadi 1');
  const risk = plan.entryMid - plan.invalidation;
  assert.ok(Math.abs(plan.riskReward - (plan.targets[0] - plan.entryMid) / risk) < 0.01);
});

test('plan sideways tetap memberi R:R terukur dari measured move dengan batas 6 ATR', () => {
  const rows = candles({ count: 60, start: 100, step: 0 });
  const parsed = parseCandles(rows, { intervalSeconds: 3600, now: NOW });
  const structure = analyzeStructure(parsed.candles);
  const plan = buildEntryPlan(structure, { slippagePct: 0.2 });
  // Data datar: range 20 jam sangat sempit, sehingga proyeksi dibatasi floor 1 ATR.
  assert.equal(plan.setup, 'range_breakout');
  assert.ok(Number.isFinite(plan.riskReward));
});


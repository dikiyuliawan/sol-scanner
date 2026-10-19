/**
 * Indikator dan analisis struktur dari OHLCV. Fungsi murni, tanpa I/O.
 * Berbeda dari signals.mjs yang fokus pada 15 menit, modul ini dipakai
 * untuk konteks 1 jam dan rencana entry.
 */

export function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period < 1) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  for (let index = period; index < values.length; index += 1) value = values[index] * k + value * (1 - k);
  return value;
}

export function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const ranges = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index], previous = candles[index - 1];
    ranges.push(Math.max(current.high - current.low, Math.abs(current.high - previous.close), Math.abs(current.low - previous.close)));
  }
  const window = ranges.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

export function rsi(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  let gains = 0, losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    if (change >= 0) gains += change; else losses -= change;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  for (let index = period + 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    avgGain = (avgGain * (period - 1) + Math.max(0, change)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -change)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function parseCandles(rows, { intervalSeconds = 3600, now = Date.now() } = {}) {
  if (!Array.isArray(rows)) return { candles: [], dropped: 0, reason: 'rows bukan array' };
  const currentStart = Math.floor(now / 1000 / intervalSeconds) * intervalSeconds;
  const seen = new Set();
  const candles = [];
  let dropped = 0;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 6) { dropped += 1; continue; }
    const [time, open, high, low, close, volume] = row;
    const numeric = [time, open, high, low, close, volume].every(value => typeof value === 'number' && Number.isFinite(value));
    const valid = numeric && Number.isInteger(time) && time >= 0 && time % intervalSeconds === 0 && time < currentStart
      && volume >= 0 && open > 0 && high > 0 && low > 0 && close > 0
      && low <= high && low <= open && low <= close && high >= open && high >= close;
    if (!valid || seen.has(time)) { dropped += 1; continue; }
    seen.add(time);
    candles.push({ time, open, high, low, close, volume });
  }
  candles.sort((a, b) => a.time - b.time);
  return { candles, dropped, reason: null };
}

export function findPivots(candles, lookback = 3) {
  const highs = [], lows = [];
  for (let index = lookback; index < candles.length - lookback; index += 1) {
    const window = candles.slice(index - lookback, index + lookback + 1);
    if (candles[index].high >= Math.max(...window.map(candle => candle.high))) highs.push(candles[index].high);
    if (candles[index].low <= Math.min(...window.map(candle => candle.low))) lows.push(candles[index].low);
  }
  return { highs, lows };
}

/**
 * Struktur 1 jam: tren dari EMA20/EMA50, posisi terhadap high 20 periode,
 * ATR%, RSI, dan urutan higher-high/higher-low.
 */
export function analyzeStructure(candles, { intervalSeconds = 3600 } = {}) {
  if (!Array.isArray(candles) || candles.length < 50) {
    return { status: 'unknown', reason: `Butuh minimal 50 candle untuk EMA50; tersedia ${candles?.length ?? 0}.`, trend: null };
  }
  const closes = candles.map(candle => candle.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atr14 = atr(candles, 14);
  const rsi14 = rsi(candles, 14);
  const latest = candles.at(-1);
  const prior = candles.slice(-21, -1);
  const high20 = Math.max(...prior.map(candle => candle.high));
  const low20 = Math.min(...prior.map(candle => candle.low));
  const pivots = findPivots(candles.slice(-60), 3);
  const lastHighs = pivots.highs.slice(-2), lastLows = pivots.lows.slice(-2);
  // Data monoton murni bisa menghasilkan kurang dari dua pivot; fallback ke
  // perbandingan dua window high/low terakhir, bukan menebak true/false.
  const recentWindow = candles.slice(-21, -1);
  const priorWindow = candles.slice(-41, -21);
  const fallback = priorWindow.length === 20
    ? {
        higherHigh: Math.max(...recentWindow.map(candle => candle.high)) > Math.max(...priorWindow.map(candle => candle.high)),
        higherLow: Math.min(...recentWindow.map(candle => candle.low)) > Math.min(...priorWindow.map(candle => candle.low))
      }
    : { higherHigh: null, higherLow: null };
  const higherHigh = lastHighs.length === 2 ? lastHighs[1] > lastHighs[0] : fallback.higherHigh;
  const higherLow = lastLows.length === 2 ? lastLows[1] > lastLows[0] : fallback.higherLow;

  let trend = null;
  if (ema20 !== null && ema50 !== null) {
    const spreadPct = ((ema20 - ema50) / ema50) * 100;
    trend = spreadPct > 0.5 && latest.close > ema20 ? 'uptrend'
      : spreadPct < -0.5 && latest.close < ema20 ? 'downtrend'
        : 'sideways';
  }

  return {
    status: 'available',
    reason: null,
    timeframe: intervalSeconds === 3600 ? '1h' : `${intervalSeconds}s`,
    candles: candles.length,
    close: latest.close,
    ema20,
    ema50,
    atr14,
    atrPct: atr14 === null ? null : (atr14 / latest.close) * 100,
    rsi14,
    high20,
    low20,
    distanceToHighPct: (high20 - latest.close) / high20 * 100,
    distanceToLowPct: (latest.close - low20) / latest.close * 100,
    trend,
    higherHigh,
    higherLow,
    change24hPct: candles.length > 24 ? (latest.close / candles.at(-25).close - 1) * 100 : null,
    lastClosedAt: new Date((latest.time + intervalSeconds) * 1000).toISOString()
  };
}

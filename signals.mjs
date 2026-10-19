const INTERVAL_SECONDS = 900;
const REQUIRED_CANDLES = 21;
const MAX_CANDLE_AGE_SECONDS = 1800;

function unknownResult(reason, candles = [], lastClosedAt = null, candleAgeSeconds = null, droppedRows = 0) {
  return {
    status: 'unknown',
    reason,
    candles,
    lastClosedAt,
    candleAgeSeconds,
    droppedRows,
    metrics: null,
    signals: [{ level: 'unknown', title: 'Belum dapat dinilai', reason }],
    setup: { state: 'unknown', title: 'Belum ada setup', reason },
    flags: [],
    watch: {
      state: 'unknown',
      title: 'Data belum memadai',
      reason,
      invalidation: 'Tidak ada kondisi watch yang dapat dinilai dari data ini.'
    }
  };
}

/**
 * Menganalisis OHLCV 15 menit yang sudah diambil pemanggil; tidak melakukan I/O.
 * Ambang bersifat heuristik, belum backtest, dan candle 15 menit bukan prediksi.
 *
 * `tolerant: true` membuang baris rusak dan mencatatnya di `droppedRows`,
 * bukan membatalkan seluruh analisis. Default tetap ketat agar perilaku
 * pemanggil lama tidak berubah.
 */
export function analyzeCandles(rows, { now = Date.now(), tolerant = false } = {}) {
  if (!Array.isArray(rows)) {
    return unknownResult('Format data tidak valid: rows harus berupa array OHLCV.');
  }
  if (!Number.isFinite(now)) {
    return unknownResult('Waktu acuan tidak valid.');
  }

  const nowSeconds = now / 1000;
  const currentCandleStart = Math.floor(nowSeconds / INTERVAL_SECONDS) * INTERVAL_SECONDS;
  const parsed = [];
  let droppedRows = 0;

  for (const row of rows) {
    const malformed = !Array.isArray(row) || row.length !== 6 || row.some(value => typeof value !== 'number' || !Number.isFinite(value));
    if (malformed) {
      if (tolerant) { droppedRows += 1; continue; }
      return unknownResult('Format candle tidak valid: setiap baris harus berisi enam nilai numerik OHLCV.');
    }
    const [time, open, high, low, close, volume] = row;
    if (!Number.isInteger(time) || time < 0 || time % INTERVAL_SECONDS !== 0) {
      if (tolerant) { droppedRows += 1; continue; }
      return unknownResult('Timestamp candle harus berupa detik nonnegatif yang selaras dengan interval 15 menit.');
    }
    if (time > currentCandleStart) {
      if (tolerant) { droppedRows += 1; continue; }
      return unknownResult('Ditemukan timestamp candle yang berada di masa depan.');
    }
    if (volume < 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || low > high || low > open || low > close || high < open || high < close) {
      if (tolerant) { droppedRows += 1; continue; }
      return unknownResult('Nilai OHLCV tidak valid: volume harus nonnegatif dan rentang harga harus memuat open serta close.');
    }
    parsed.push({ time, open, high, low, close, volume });
  }

  parsed.sort((a, b) => a.time - b.time);
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].time === parsed[index - 1].time) {
      if (tolerant) { parsed.splice(index, 1); droppedRows += 1; index -= 1; continue; }
      return unknownResult('Timestamp candle duplikat ditemukan.');
    }
  }

  // Candle dengan waktu mulai saat ini masih terbuka dan sengaja tidak dipakai.
  const candles = parsed
    .filter(candle => candle.time < currentCandleStart)
    .map(({ time, open, high, low, close, volume }) => ({ time, open, high, low, close, volume }));
  const latest = candles.at(-1);
  const lastClosedAt = latest ? new Date((latest.time + INTERVAL_SECONDS) * 1000).toISOString() : null;
  const candleAgeSeconds = latest ? nowSeconds - (latest.time + INTERVAL_SECONDS) : null;

  if (candles.length < REQUIRED_CANDLES) {
    return unknownResult(`Dibutuhkan sedikitnya ${REQUIRED_CANDLES} candle tertutup; tersedia ${candles.length}.`, candles, lastClosedAt, candleAgeSeconds, droppedRows);
  }
  const window = candles.slice(-REQUIRED_CANDLES);
  for (let index = 1; index < window.length; index += 1) {
    if (window[index].time - window[index - 1].time !== INTERVAL_SECONDS) {
      return unknownResult('Ada celah pada 21 candle tertutup terakhir; analisis memerlukan interval yang berurutan.', candles, lastClosedAt, candleAgeSeconds, droppedRows);
    }
  }
  if (candleAgeSeconds < 0) {
    return unknownResult('Waktu penutupan candle terakhir berada di masa depan.', candles, lastClosedAt, candleAgeSeconds, droppedRows);
  }
  if (candleAgeSeconds > MAX_CANDLE_AGE_SECONDS) {
    return unknownResult('Candle terakhir sudah stale: usia penutupan melebihi 1800 detik.', candles, lastClosedAt, candleAgeSeconds, droppedRows);
  }

  const latestCandle = window.at(-1);
  const prior = window.slice(0, -1);
  const sma20Usd = window.slice(-20).reduce((sum, candle) => sum + candle.close, 0) / 20;
  const previousHighUsd = Math.max(...prior.map(candle => candle.high));
  const previousLowUsd = Math.min(...prior.map(candle => candle.low));
  const meanPriorVolume = prior.reduce((sum, candle) => sum + candle.volume, 0) / prior.length;
  const relativeVolume = meanPriorVolume === 0 ? null : latestCandle.volume / meanPriorVolume;
  const metrics = {
    closeUsd: latestCandle.close,
    sma20Usd,
    previousHighUsd,
    previousLowUsd,
    relativeVolume,
    distanceToResistancePct: (previousHighUsd - latestCandle.close) / previousHighUsd * 100,
    extensionPct: (latestCandle.close / sma20Usd - 1) * 100,
    change5hPct: (latestCandle.close / prior[0].close - 1) * 100,
    trend: latestCandle.close > sma20Usd ? 'Harga di atas SMA20' : latestCandle.close < sma20Usd ? 'Harga di bawah SMA20' : 'Harga setara SMA20',
    volumeDescription: meanPriorVolume === 0
      ? 'Baseline volume nol; volume relatif tidak dapat dinilai.'
      : relativeVolume >= 1.5
        ? 'Volume terbaru setidaknya 1,5x baseline 20 candle sebelumnya.'
        : relativeVolume < 1
          ? 'Volume terbaru di bawah baseline 20 candle sebelumnya.'
          : 'Volume terbaru sekitar baseline 20 candle sebelumnya.'
  };

  if (Object.values(metrics).some(value => typeof value === 'number' && !Number.isFinite(value))) {
    return unknownResult('Perhitungan turunan di luar rentang numerik yang valid.', candles, lastClosedAt, candleAgeSeconds, droppedRows);
  }
  const breakout = latestCandle.close > previousHighUsd;
  const breakoutConfirmed = breakout && relativeVolume !== null && relativeVolume >= 1.5;
  const nearResistance = metrics.distanceToResistancePct >= 0 && metrics.distanceToResistancePct <= 2;
  const belowSupport = latestCandle.close < previousLowUsd;
  const extended = metrics.extensionPct > 8;
  const signals = [];
  signals.push({ level: 'info', title: metrics.trend, reason: `Penutupan terbaru ${latestCandle.close} dibanding SMA20 ${sma20Usd.toFixed(6)} USD.` });
  signals.push({ level: relativeVolume === null ? 'unknown' : 'info', title: 'Konteks volume', reason: metrics.volumeDescription });

  let watch;
  if (extended) {
    const reason = `Harga ${metrics.extensionPct.toFixed(2)}% di atas SMA20 (ambang heuristik >8%); jangan mengejar pergerakan.`;
    watch = { state: 'extended', title: 'Terlalu jauh dari SMA20', reason, invalidation: 'Status extended gugur bila penutupan kembali tidak lebih dari 8% di atas SMA20.' };
    signals.push({ level: 'warning', title: 'Pergerakan extended', reason });
  } else if (breakout) {
    if (breakoutConfirmed) {
      const reason = `Penutupan melewati high 20 candle sebelumnya dengan volume relatif ${relativeVolume.toFixed(2)}x (ambang heuristik 1,5x). Watch saja, bukan sinyal transaksi.`;
      watch = { state: 'breakout', title: 'Breakout watch terkonfirmasi volume', reason, invalidation: `Watch breakout gugur jika candle 15 menit berikutnya atau selanjutnya ditutup kembali di bawah ${previousHighUsd} USD (high 20 candle sebelumnya); ini bukan stop-order.` };
      signals.push({ level: 'info', title: 'Breakout watch', reason });
    } else {
      const reason = relativeVolume === null
        ? 'Penutupan melewati high 20 candle sebelumnya, tetapi baseline volume nol sehingga konfirmasi volume tidak dapat dinilai.'
        : `Penutupan melewati high 20 candle sebelumnya, tetapi volume relatif ${relativeVolume.toFixed(2)}x belum mencapai ambang heuristik 1,5x.`;
      watch = { state: 'breakout_unconfirmed', title: 'Breakout belum terkonfirmasi', reason, invalidation: `Watch breakout gugur jika candle 15 menit ditutup kembali di bawah ${previousHighUsd} USD (high 20 candle sebelumnya); ini bukan stop-order.` };
      signals.push({ level: 'info', title: 'Breakout belum terkonfirmasi', reason });
    }
  } else if (nearResistance) {
    const reason = `Penutupan berada ${metrics.distanceToResistancePct.toFixed(2)}% di bawah high 20 candle sebelumnya; ambang dekat resistance adalah 2%.`;
    watch = { state: 'near_resistance', title: 'Watch dekat resistance', reason, invalidation: 'Watch gugur bila harga menjauh dari zona 2% di bawah high sebelumnya atau menembus high tersebut.' };
    signals.push({ level: 'info', title: 'Dekat resistance', reason });
  } else if (belowSupport) {
    const reason = `Penutupan berada di bawah low 20 candle sebelumnya (${previousLowUsd} USD); ini hanya observasi kondisi range/support.`;
    watch = { state: 'below_support', title: 'Di bawah support historis', reason, invalidation: 'Watch gugur bila penutupan kembali ke atau di atas low 20 candle sebelumnya.' };
    signals.push({ level: 'info', title: 'Di bawah support historis', reason });
  } else {
    const reason = 'Penutupan berada dalam rentang high-low 20 candle sebelumnya dan tidak memenuhi ambang breakout atau dekat resistance.';
    watch = { state: 'range', title: 'Watch dalam rentang', reason, invalidation: 'Watch rentang gugur saat penutupan keluar dari rentang high-low 20 candle sebelumnya.' };
    signals.push({ level: 'info', title: 'Masih dalam rentang', reason });
  }

  // `setup` menjawab "pola apa yang terlihat" dan tidak saling meniadakan
  // dengan `flags`. `watch` dipertahankan untuk kompatibilitas tampilan lama.
  const setup = breakout
    ? { state: breakoutConfirmed ? 'breakout' : 'breakout_unconfirmed', title: breakoutConfirmed ? 'Breakout terkonfirmasi volume' : 'Breakout belum terkonfirmasi', reason: watch.reason }
    : nearResistance
      ? { state: 'near_resistance', title: 'Dekat resistance', reason: watch.reason }
      : belowSupport
        ? { state: 'below_support', title: 'Di bawah support', reason: watch.reason }
        : { state: 'range', title: 'Dalam rentang', reason: watch.reason };

  const flags = [];
  if (extended) flags.push({ code: 'extended_sma20', severity: 'warn', reason: `Deviasi ${metrics.extensionPct.toFixed(2)}% di atas SMA20; jangan mengejar.` });
  if (breakoutConfirmed && extended) flags.push({ code: 'breakout_extended', severity: 'warn', reason: 'Breakout terjadi saat harga sudah jauh di atas SMA20; risiko mean reversion lebih tinggi.' });
  if (relativeVolume === null) flags.push({ code: 'volume_baseline_zero', severity: 'unknown', reason: 'Baseline volume nol; konfirmasi volume tidak dapat dinilai.' });
  if (belowSupport) flags.push({ code: 'below_support', severity: 'info', reason: 'Penutupan di bawah low 20 candle sebelumnya.' });
  if (candleAgeSeconds > 900) flags.push({ code: 'candle_aging', severity: 'warn', reason: `Candle terakhir sudah berumur ${Math.floor(candleAgeSeconds / 60)} menit.` });

  return { status: 'available', reason: 'Tersedia 21 candle tertutup berurutan dan tidak stale.', candles, lastClosedAt, candleAgeSeconds, droppedRows, metrics, signals, setup, flags, watch };
}

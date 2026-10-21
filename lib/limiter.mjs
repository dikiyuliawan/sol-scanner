/**
 * Sliding-window limiter per origin, dengan clock yang bisa diinjeksi
 * supaya bisa diuji tanpa menunggu waktu nyata.
 */
export function createLimiter({ clock = Date.now, sleep = defaultSleep } = {}) {
  const state = new Map();

  function bucket(key) {
    let value = state.get(key);
    if (!value) {
      value = { starts: [], cooldownUntil: 0, rejected: 0 };
      state.set(key, value);
    }
    return value;
  }

  function prune(value, now, windowMs) {
    if (value.starts.length) value.starts = value.starts.filter(start => now - start < windowMs);
  }

  return {
    tryTake(key, limit, windowMs = 60_000) {
      const now = clock();
      const value = bucket(key);
      prune(value, now, windowMs);
      if (now < value.cooldownUntil) {
        value.rejected += 1;
        return { ok: false, reason: 'cooldown', retryAfterMs: value.cooldownUntil - now };
      }
      if (value.starts.length >= limit) {
        value.rejected += 1;
        return { ok: false, reason: 'rate', retryAfterMs: Math.max(1, value.starts[0] + windowMs - now) };
      }
      value.starts.push(now);
      return { ok: true };
    },
    /**
     * Tunggu sampai ada slot tersedia instead of menolak. Dipakai oleh
     * pekerjaan latar (deep scan) supaya antrean tidak gagal dan berubah
     * menjadi "unknown" hanya karena kuota habis.
     *
     * `reserve` menyisakan beberapa slot untuk permintaan interaktif: kerja
     * latar berhenti pada `limit - reserve`, sehingga tab Inspect selalu
     * punya kuota sendiri.
     */
    async wait(key, limit, windowMs = 60_000, { reserve = 0, maxWaitMs = 120_000 } = {}) {
      const startedReal = Date.now();
      const usable = Math.max(1, limit - Math.max(0, reserve));
      for (;;) {
        const now = clock();
        const value = bucket(key);
        prune(value, now, windowMs);
        if (now >= value.cooldownUntil && value.starts.length < usable) {
          value.starts.push(now);
          return { ok: true, waitedMs: Date.now() - startedReal };
        }
        if (Date.now() - startedReal >= maxWaitMs) {
          const cooling = now < value.cooldownUntil;
          const retryAfterMs = cooling
            ? value.cooldownUntil - now
            : (value.starts[0] ?? now) + windowMs - now;
          return { ok: false, reason: cooling ? 'cooldown' : 'rate', waitedMs: Date.now() - startedReal, retryAfterMs: Math.max(1, retryAfterMs) };
        }
        await sleep(250);
      }
    },
    /** Kembalikan slot yang sudah diambil ketika request gagal sebelum dipakai. */
    refund(key) {
      const value = state.get(key);
      if (value?.starts.length) value.starts.pop();
    },
    cooldown(key, ms) {
      const value = bucket(key);
      value.cooldownUntil = Math.max(value.cooldownUntil, clock() + ms);
    },
    snapshot(key) {
      const value = state.get(key);
      return value ? { starts: [...value.starts], cooldownUntil: value.cooldownUntil, rejected: value.rejected } : null;
    },
    reset() {
      state.clear();
    }
  };
}

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function rateLimitError(origin, decision) {
  const seconds = Math.max(1, Math.ceil((decision?.retryAfterMs ?? 60_000) / 1000));
  const label = decision?.reason === 'cooldown' ? 'cooldown' : 'rate limit';
  const error = new Error(`Batas lokal ${origin}: ${label}. Coba lagi dalam ${seconds} detik.`);
  error.name = 'RateLimitError';
  error.retryAfterSeconds = seconds;
  return error;
}

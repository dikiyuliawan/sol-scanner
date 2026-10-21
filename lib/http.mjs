export class HttpError extends Error {
  constructor(message, { status = null, url = null, retryAfterMs = null, transient = false } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
    // transient = gangguan jaringan (koneksi diputus), bukan jawaban HTTP.
    // Hanya yang transient yang layak diulang.
    this.transient = transient;
  }
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

async function readTextLimited(response, maxBytes, url) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* oversized body is already rejected */ }
        throw new HttpError('respons terlalu besar', { status: response.status, url });
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(error?.message || 'gagal membaca respons', { status: response.status, url });
  }
  return new TextDecoder().decode(Buffer.concat(chunks, size));
}

export async function getJSON(url, {
  fetcher = fetch,
  timeoutMs = 10_000,
  headers = {},
  maxBytes = 4_000_000,
  accept = 'application/json',
  retries = 1
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await getJSONOnce(url, { fetcher, timeoutMs, headers, maxBytes, accept });
    } catch (error) {
      lastError = error;
      // Hanya gangguan jaringan (koneksi diputus) dan error server yang
      // diulang: jawaban 4xx lain tidak berubah kalau diulang, dan
      // timeout tidak diulang supaya batas waktu UI tetap berlaku.
      const transient = error instanceof HttpError ? (error.transient || (error.status !== null && error.status >= 500)) : true;
      if (!transient || attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function getJSONOnce(url, { fetcher, timeoutMs, headers, maxBytes, accept }) {
  let response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
      headers: { Accept: accept, ...headers }
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new HttpError(`batas waktu ${timeoutMs / 1000} detik`, { url });
    }
    // Kode penyebab (ECONNRESET, ENOTFOUND, ...) ikutReported supaya
    // "fetch failed" bisa ditindaklanjuti: koneksi diputus, DNS, atau
    // proxy yang menahan domain tersebut.
    const cause = error?.cause?.code ? ` (${error.cause.code})` : '';
    throw new HttpError(`${error?.message || 'permintaan jaringan gagal'}${cause}`, { url, transient: true });
  }

  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status}`, {
      status: response.status,
      url,
      retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'))
    });
  }

  const text = await readTextLimited(response, maxBytes, url);
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError('JSON tidak valid', { status: response.status, url });
  }
}

export function errorReason(error, prefix = '') {
  const message = error?.name === 'HttpError' ? error.message : (error?.message || 'gagal');
  return `${prefix}${message}`;
}

/**
 * Pemutus arus untuk penyedia yang sedang tidak dapat dihubungi.
 *
 * Gangguan jaringan beruntun (koneksi diputus, DNS, proxy menahan domain)
 * tidak akan membaik dengan memakai provider lebih sering. Setelah
 * beberapa kegagalan berturut-turut, provider dijeda dan pesannya
 * LANGSUNG menyebut penyebabnya, bukan "fetch failed" yang membingungkan.
 */
export function createBreaker({ threshold = 3, cooldownMs = 300_000, clock = Date.now } = {}) {
  let failures = 0;
  let blockedUntil = 0;
  return {
    check() {
      const now = clock();
      if (now < blockedUntil) return { blocked: true, retryAfterMs: blockedUntil - now };
      return { blocked: false };
    },
    recordFailure() {
      failures += 1;
      if (failures >= threshold) {
        blockedUntil = clock() + cooldownMs;
        failures = 0;
      }
    },
    recordSuccess() {
      failures = 0;
    },
    get blocked() {
      return clock() < blockedUntil;
    }
  };
}

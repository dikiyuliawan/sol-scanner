export class HttpError extends Error {
  constructor(message, { status = null, url = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
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

export async function getJSON(url, {
  fetcher = fetch,
  timeoutMs = 10_000,
  headers = {},
  maxBytes = 4_000_000,
  accept = 'application/json'
} = {}) {
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
    throw new HttpError(error?.message || 'permintaan jaringan gagal', { url });
  }

  if (!response.ok) {
    throw new HttpError(`HTTP ${response.status}`, {
      status: response.status,
      url,
      retryAfterMs: parseRetryAfter(response.headers?.get?.('retry-after'))
    });
  }

  const text = await response.text();
  if (text.length > maxBytes) throw new HttpError('respons terlalu besar', { status: response.status, url });
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

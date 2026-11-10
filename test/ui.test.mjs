import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// DOM kecil khusus kontrak UI; tes browser nyata dilakukan terpisah.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.style = {};
    this.className = ''; this.ownText = ''; this.listeners = {}; this.disabled = false;
    this.classList = {
      contains: value => this.className.split(' ').includes(value),
      add: value => { if (!this.classList.contains(value)) this.className += ` ${value}`; },
      toggle: (value, on) => { this.className = this.className.split(' ').filter(x => x !== value).concat(on ? [value] : []).join(' '); }
    };
  }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  replaceChildren(...children) { this.ownText = ''; this.children = []; this.append(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute() {}
  get nextElementSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1]; }
  after(child) { child.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, child); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function harness(fetcher = async () => ({ ok: true, json: async () => ({}) }), config = { storage: { available: true } }) {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) {
      const el = new Element();
      // Select preset selalu punya nilai di HTML; fake DOM harus menirukan.
      if (id === 'preset') el.value = 'balanced';
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const timers = new Map(); let timerId = 0;
  const clipboardWrites = [];
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), querySelectorAll: () => [] },
    navigator: { clipboard: { async writeText(value) { clipboardWrites.push(value); } } },
    fetch: (url, options) => url === '/api/config' ? Promise.resolve({ ok: true, json: async () => config }) : fetcher(url, options),
    AbortSignal, Intl, Date, console,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}
  });
  vm.runInContext(source, context);
  return { get, timers, context, clipboardWrites, run: script => vm.runInContext(script, context), async tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); } };
}
const row = (mint = 'mint-one', score = 60) => ({ mint, symbol: mint, rank: 1, score, grade: 'B', market: { priceUsd: 1, change: {}, liquidityUsd: 200000, turnover: 1, marketCap: 2000000, ageHours: 72 }, safety: { top10Pct: 10 }, components: [], penalties: [], entryPlan: null });
function allElements(root) { return [root, ...root.children.flatMap(allElements)]; }

test('UI menampilkan gugur saat job masih berjalan dan menaruhnya di bawah kandidat lolos', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ completed: 1, status: 'running', failures: 0, results: [{ ok: true, mint: 'mint-one', result: { ...row('mint-one', 99), disqualified: [{ code: 'mintable', reason: 'authority aktif' }], entryPlan: { status: 'plan' } } }] }) }));
  h.context.fixture = { rows: [row(), row('mint-two', 50)] };
  h.run('discoverData = fixture; pollJob("job-1", 2)');
  await h.tick();
  assert.deepEqual(Array.from(h.run('discoverData.rows.map(row => row.mint)')), ['mint-two', 'mint-one']);
  const rejected = h.get('candidates').children.find(child => child.dataset.mint === 'mint-one');
  assert.ok(rejected.classList.contains('disqualified'));
  assert.match(rejected.textContent, /gugur/);
  h.context.rejected = rejected;
  h.run('toggleDetail(rejected, discoverData.rows[1])');
  assert.match(rejected.nextElementSibling.textContent, /Rencana entry dinonaktifkan/);
  assert.doesNotMatch(rejected.nextElementSibling.textContent, /Zona entry/);
  h.run('renderCandidates(discoverData)');
  assert.equal(h.get('candidates').children.filter(child => child.classList.contains('detail-row')).length, 1);
});

test('UI mengabaikan respons job lama setelah pengguna memulai discovery baru', async () => {
  let resolveJob;
  const h = harness(url => url.startsWith('/api/jobs/') ? new Promise(resolve => { resolveJob = resolve; }) : Promise.reject(new Error('offline')));
  h.context.fixture = { rows: [row()] };
  h.run('discoverData = fixture; pollJob("old", 1)');
  const pending = h.tick();
  await h.get('discover-button').listeners.click();
  resolveJob({ ok: true, json: async () => ({ status: 'done', completed: 1, results: [{ ok: true, mint: 'mint-one', result: row('mint-one', 99) }] }) });
  await pending;
  assert.equal(h.run('discoverData'), null);
  assert.equal(h.timers.size, 0);
  assert.match(h.get('discover-status').textContent, /Discover gagal/);
});

test('UI polling tidak overlap dan mempertahankan pesan hasil sementara saat jaringan gagal', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  h.run('discoverData = { rows: [] }; pollJob("job", 1)');
  await h.tick();
  assert.equal(h.timers.size, 1);
  assert.match(h.get('deep-status').textContent, /Hasil awal belum final/);
});

test('UI Watchlist menangani kegagalan simpan dan mengaktifkan tombol kembali', async () => {
  const h = harness(async () => { throw new Error('offline'); });
  h.context.button = new Element('button');
  await h.run('saveWatch(button, "mint-one", { price: 1 })');
  assert.match(h.context.button.textContent, /Gagal menyimpan: offline/);
  assert.equal(h.context.button.disabled, false);
});

test('UI Watchlist tidak menyembunyikan kegagalan DELETE', async () => {
  const h = harness(async (_url, options) => options?.method === 'DELETE' ? ({ ok: false, status: 503, json: async () => ({ error: 'storage unavailable' }) }) : ({ ok: true, json: async () => ({ items: [{ mint: 'mint-one', addedAt: 'now' }], history: [] }) }));
  await h.run('loadWatchlist()');
  const button = allElements(h.get('watch-items')).find(item => item.tagName === 'button' && item.textContent === 'Hapus');
  await button.listeners.click();
  assert.match(h.get('watch-status').textContent, /Gagal menghapus: storage unavailable/);
  assert.equal(h.get('watch-items').children.length, 1);
  assert.equal(button.disabled, false);
});

test('UI Watchlist menghapus data usang dan mereset status error setelah refresh berhasil', async () => {
  let fail = true;
  const h = harness(async () => { if (fail) throw new Error('offline'); return { ok: true, json: async () => ({ items: [], history: [] }) }; });
  h.get('watch-items').append(new Element());
  await h.run('loadWatchlist()');
  assert.equal(h.get('watch-items').children.length, 0);
  assert.equal(h.get('watch-status').className, 'error');
  fail = false;
  await h.run('loadWatchlist()');
  assert.equal(h.get('watch-status').className, '');
  assert.match(h.get('watch-status').textContent, /Watchlist kosong/);
});

test('UI Inspect menyimpan simbol dan harga snapshot, serta mereset label simpan pada scan baru', async () => {
  let body;
  const h = harness(async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true }) }; });
  h.context.scan = { mint: 'mint-one', checkedAt: '2026-10-19T10:00:00Z', market: { status: 'available', pairs: [], primary: { tokenSymbol: 'TEST', priceUsd: 2 } }, history: { status: 'unknown', metrics: {}, candles: [] }, risk: { status: 'unknown', findings: [] }, entryContext: { cautions: [] } };
  h.run('render(scan)');
  await h.get('add-watch').listeners.click();
  assert.equal(body.snapshot.symbol, 'TEST');
  assert.equal(body.snapshot.price, 2);
  assert.match(h.get('add-watch').textContent, /Tersimpan/);
  h.run('render({ ...scan, mint: "mint-two" })');
  assert.equal(h.get('add-watch').textContent, '+ Tambah ke watchlist');
});

test('UI label Balanced konsisten dengan gate usia pool 48 jam', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /Balanced — likuid, pool ≥ 48 jam/);
  assert.doesNotMatch(html, /Klik satu baris/);
});

test('UI Discover selalu meminta data baru (refresh=1) tanpa toggle', async () => {
  let requested = '';
  const h = harness(async url => {
    requested = url;
    return { ok: true, json: async () => ({
      rows: [], universe: { total: 0, checked: 0, evaluated: 0, accepted: 0, rejected: 0, sources: {} },
      preset: { label: 'Balanced' }, configHash: 'abc123', warnings: [], jobId: null, jobTotal: 0
    }) };
  });
  await h.get('discover-button').listeners.click();
  assert.match(requested, /refresh=1/);
  assert.doesNotMatch(requested, /refresh=0/);
});

test('UI menyalin alamat mint saat teks mint pada baris Discover diklik', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({}) }));
  h.context.fixture = { rows: [row('mint-one')] };
  h.run('discoverData = fixture; renderCandidates(discoverData)');
  const mintEl = allElements(h.get('candidates')).find(item => item.classList.contains('copy-mint'));
  assert.ok(mintEl, 'elemen salin mint harus ada pada baris kandidat');
  await mintEl.listeners.click({ stopPropagation() {} });
  assert.deepEqual(h.clipboardWrites, ['mint-one']);
  assert.match(mintEl.textContent, /Tersalin/);
  await h.tick();
  assert.equal(mintEl.textContent, 'mint-one');
});

test('UI Inspect memakai cache 30 detik (tanpa parameter refresh)', async () => {
  let requested = '';
  const h = harness(async url => {
    requested = url;
    return { ok: true, json: async () => ({
      mint: 'mint-one', checkedAt: '2026-10-19T10:00:00Z', market: { status: 'available', pairs: [], primary: null }, history: { status: 'unknown', metrics: {}, candles: [] }, risk: { status: 'unknown', findings: [] }, entryContext: { cautions: [], reason: '' }
    }) };
  });
  h.get('mint').value = 'mint-one';
  await h.get('scan-form').listeners.submit({ preventDefault() {} });
  assert.doesNotMatch(requested, /refresh=1/);
});

test('UI Inspect menyalin alamat mint saat header token diklik', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({}) }));
  h.context.scan = { mint: 'mint-one', checkedAt: '2026-10-19T10:00:00Z', market: { status: 'available', pairs: [], primary: null }, history: { status: 'unknown', metrics: {}, candles: [] }, risk: { status: 'unknown', findings: [] }, entryContext: { cautions: [] } };
  h.run('render(scan)');
  const mintHeader = h.get('token-mint');
  await mintHeader.listeners.click({ stopPropagation() {} });
  assert.deepEqual(h.clipboardWrites, ['mint-one']);
  assert.match(mintHeader.textContent, /Tersalin/);
  await h.tick();
  assert.equal(mintHeader.textContent, 'mint-one');
});

test('UI Watchlist menyalin alamat mint lengkap dari baris watchlist', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ items: [{ mint: 'mint-panjang-sekali', addedAt: 'now', snapshot: { symbol: 'LONG' } }], history: [] }) }));
  await h.run('loadWatchlist()');
  const label = allElements(h.get('watch-items')).find(item => item.classList.contains('copy-mint'));
  assert.ok(label, 'label watchlist harus bisa disalin');
  await label.listeners.click({ stopPropagation() {} });
  assert.deepEqual(h.clipboardWrites, ['mint-panjang-sekali']);
});

test('UI rincian kandidat menampilkan waktu pengambilan dan asal konsentrasi holder', () => {
  const h = harness();
  const now = new Date().toISOString();
  const candidate = {
    mint: 'mint-one', symbol: 'EX', rank: 1, score: 70, grade: 'C', confidence: 0.75,
    market: { priceUsd: 1, change: {}, liquidityUsd: 200000, turnover: 1, marketCap: 2000000, ageHours: 72, source: 'DEX Screener', fetchedAt: now, targetIsBase: true },
    safety: { top10Pct: 12.5, top10Source: 'Jupiter', top10Secondary: 65, fetchedAt: now },
    structure: { lastClosedAt: now, close: 0.9 },
    components: [], penalties: [], entryPlan: null
  };
  h.context.fixture = { rows: [candidate] };
  h.run('discoverData = fixture; renderCandidates(discoverData)');
  const table = h.get('candidates');
  const detailButton = allElements(table).find(item => item.tagName === 'button' && item.textContent === 'Rincian');
  detailButton.listeners.click({ stopPropagation() {} });
  const detail = allElements(table).find(item => item.className === 'detail-row');
  assert.ok(detail, 'baris rincian harus dibuat');
  const text = detail.textContent;
  assert.match(text, /Data pasar diambil/);
  assert.match(text, /lalu|unknown/);
  assert.match(text, /Jupiter/);
  assert.match(text, /65.0%/);
  assert.match(text, /GoPlus/);
});

test('UI menandai baris yang belum dianalisis sebagai antri dan menampilkan alasan kegagalan', () => {
  const h = harness();
  const base = { mint: 'mint-one', symbol: 'EX', rank: 1, score: 70, grade: 'B', confidence: 0.75, market: { priceUsd: 1, change: {}, liquidityUsd: 200000, turnover: 1, marketCap: 2000000, ageHours: 72 }, safety: { top10Pct: 10 }, components: [], penalties: [], entryPlan: null };
  h.context.fixture = { rows: [{ ...base, deepState: 'antri' }, { ...base, mint: 'mint-two', deepState: 'gagal', deepReason: 'Gecko candle: HTTP 429' }] };
  h.run('discoverData = fixture; renderCandidates(discoverData)');
  const table = h.get('candidates');
  const text = table.textContent;
  assert.match(text, /antri/);
  assert.match(text, /tidak dianalisis/);
  assert.doesNotMatch(text, /pending/);

  const failed = table.children.find(child => child.dataset.mint === 'mint-two');
  const detailButton = allElements(failed).find(item => item.tagName === 'button' && item.textContent === 'Rincian');
  detailButton.listeners.click({ stopPropagation() {} });
  const detail = allElements(table).find(item => item.className === 'detail-row');
  assert.match(detail.textContent, /HTTP 429/);
});

test('UI gauge skor membedakan skor terukur penuh dari skor yang bobotnya belum terukur', () => {
  const h = harness();
  const candidate = {
    mint: 'mint-one', symbol: 'EX', rank: 1, score: 70, grade: 'B', confidence: 0.5,
    market: { priceUsd: 1, change: {}, liquidityUsd: 200000, turnover: 1, marketCap: 2000000, ageHours: 72 },
    safety: { top10Pct: 10 }, components: [], penalties: [], entryPlan: null
  };
  h.context.fixture = { rows: [candidate] };
  h.run('discoverData = fixture; renderCandidates(discoverData)');
  const table = h.get('candidates');
  const parts = allElements(table);
  const solid = parts.find(item => item.className === 'gauge-solid');
  const band = parts.find(item => item.className === 'gauge-band');
  const mark = parts.find(item => item.className === 'gauge-mark');
  // Bobot terukur 50%: bagian yang pasti hanya 70 x 0,5 = 35, sisa 50 poin
  // masih bisa bertambah dari komponen yang belum dianalisis.
  assert.equal(solid.style.width, '35%');
  assert.equal(band.style.left, '35%');
  assert.equal(band.style.width, '50%');
  assert.equal(mark.style.left, '70%');
  // Tick grade hanya di gauge besar: di kolom tabel hanya jadi noise.
  assert.equal(parts.filter(item => item.className === 'gauge-tick').length, 0);
  const gauge = parts.find(item => item.className.startsWith('gauge ') && item.className.includes('grade-b'));
  assert.ok(gauge, 'gauge harus memakai warna grade');
  assert.match(gauge.title, /Bobot terukur 50%/);
  assert.match(gauge.title, /rentang mungkin 35–85/);

  // Gauge besar di rincian: tick grade C >= 45, B >= 60, A >= 75.
  const detailButton = allElements(table).find(item => item.tagName === 'button' && item.textContent === 'Rincian');
  detailButton.listeners.click({ stopPropagation() {} });
  const detail = allElements(table).find(item => item.className === 'detail-row');
  const bigTicks = allElements(detail).filter(item => item.className === 'gauge-tick');
  assert.deepEqual(bigTicks.map(tick => tick.style.left), ['45%', '60%', '75%']);
  // Label skala harus duduk persis di tick-nya.
  const scale = allElements(detail).find(item => item.className === 'gauge-scale');
  const labels = allElements(scale).filter(item => item.tagName === 'span');
  assert.deepEqual(labels.map(label => label.style.left), ['0%', '45%', '60%', '75%', '100%']);
});

test('UI gauge tanpa confidence tidak menganggap bobot terukur penuh', () => {
  const h = harness();
  const candidate = {
    mint: 'mint-one', symbol: 'EX', rank: 1, score: 70, grade: 'B',
    market: { priceUsd: 1, change: {}, liquidityUsd: 200000, turnover: 1, marketCap: 2000000, ageHours: 72 },
    safety: { top10Pct: 10 }, components: [], penalties: [], entryPlan: null
  };
  h.context.fixture = { rows: [candidate] };
  h.run('discoverData = fixture; renderCandidates(discoverData)');
  const parts = allElements(h.get('candidates'));
  assert.equal(parts.find(item => item.className === 'gauge-band'), undefined, 'tanpa confidence tidak boleh ada pita terukur');
  const solid = parts.find(item => item.className === 'gauge-solid');
  assert.equal(solid.style.width, '70%');
});

test('UI telemetry di gutter run diperbarui setelah discovery', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({
    rows: [], rejected: [], nearMissRows: [],
    universe: { total: 412, checked: 96, evaluated: 96, accepted: 12, rejected: 84, sources: {} },
    preset: { label: 'Balanced' }, configHash: 'abc123', warnings: [], jobId: 'job-9', jobTotal: 15, finishedAt: new Date().toISOString()
  }) }), { storage: { available: true }, configHash: 'abc123', presets: { balanced: { label: 'Balanced' } } });
  await h.get('discover-button').listeners.click();
  assert.match(h.get('tel-deep').textContent, /0\/15/);
  assert.ok(h.get('tel-run').textContent.length > 0);
  assert.match(h.get('tel-preset').textContent, /Balanced/);
});

test('UI membandingkan ambang antar preset dari konfigurasi server', async () => {
  const config = {
    storage: { available: true }, configHash: 'abc123',
    entry: { notionalUsd: 500, maxSlippagePct: 2, minRiskReward: 1.5 },
    presets: {
      balanced: { label: 'Balanced', thresholds: { minLiquidityUsd: 150000, minVolume24hUsd: 50000, minPoolAgeHours: 48, minHolderCount: 1500, maxTop10Pct: 30, minMarketCapUsd: 1000000, maxMarketCapUsd: null, maxFdvToMcap: 1.5, maxTurnover: 10, requireVerified: false, allowUnknownSafety: true }, weights: { safety: 22 } },
      gem: { label: 'Gem hunter', thresholds: { minLiquidityUsd: 50000, minVolume24hUsd: 15000, minPoolAgeHours: 1, minHolderCount: 100, maxTop10Pct: 45, minMarketCapUsd: 50000, maxMarketCapUsd: 5000000, maxFdvToMcap: 5, maxTurnover: 80, requireVerified: false, allowUnknownSafety: true }, weights: { safety: 12 } }
    }
  };
  const h = harness(async () => ({ ok: true, json: async () => ({}) }), config);
  await new Promise(resolve => setTimeout(resolve, 0));
  const rows = h.get('preset-rows').children;
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Balanced/);
  assert.match(rows[0].textContent, /\$150,000/);
  assert.match(rows[1].textContent, /Gem hunter/);
  assert.match(rows[1].textContent, /\$50,000/);
});

test('UI tidak melompat-lompat urutan baris selama deep scan, lalu meranking ulang setelah job selesai', async () => {
  const responses = [];
  const h = harness(async () => { const payload = responses.shift(); return { ok: true, json: async () => payload }; });
  h.context.fixture = { rows: [row('mint-a', 60), row('mint-b', 50)] };
  h.run('discoverData = fixture; pollJob("job-2", 2)');
  responses.push({ status: 'running', completed: 1, failures: 0, results: [{ ok: true, mint: 'mint-b', result: { ...row('mint-b', 99) } }] });
  await h.tick();
  // Skor mint-b naik jadi 99, tapi urutan tidak boleh melompat saat run masih jalan.
  assert.deepEqual(Array.from(h.run('discoverData.rows.map(r => r.mint)')), ['mint-a', 'mint-b']);
  responses.push({ status: 'done', completed: 2, failures: 0, results: [] });
  await h.tick();
  // Job selesai: ranking penuh dihitung ulang satu kali.
  assert.deepEqual(Array.from(h.run('discoverData.rows.map(r => r.mint)')), ['mint-b', 'mint-a']);
});

test('UI memakai semantik tablist yang benar dan label kolom konsisten dengan header', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tab" aria-selected="true" aria-controls="tab-discover"/);
  assert.match(html, /role="tabpanel" aria-labelledby="tabbtn-discover"/);
  // Header tabel kandidat dan label data-label harus berjumlah sama.
  const header = html.match(/<table class="candidates" id="candidates-table">[\s\S]*?<thead><tr>([\s\S]*?)<\/tr>/);
  assert.ok(header, 'header tabel kandidat harus ada');
  const columns = (header[1].match(/<th\b/g) || []).length;
  assert.equal(columns, 13);
  const h2 = harness();
  assert.equal(h2.run('CANDIDATE_COLS.length'), columns);
});


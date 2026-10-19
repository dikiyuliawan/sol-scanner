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
function harness(fetcher = async () => ({ ok: true, json: async () => ({}) })) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const timers = new Map(); let timerId = 0;
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Element(tag), querySelectorAll: () => [] },
    fetch: (url, options) => url === '/api/config' ? Promise.resolve({ ok: true, json: async () => ({ storage: { available: true } }) }) : fetcher(url, options),
    AbortSignal, Intl, Date, console,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {}
  });
  vm.runInContext(source, context);
  return { get, timers, context, run: script => vm.runInContext(script, context), async tick() { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); } };
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

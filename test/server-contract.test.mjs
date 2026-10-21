import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createServer } from '../server.mjs';
import { createDb } from '../db.mjs';

async function localServer(t, options = {}) {
  const db = createDb(':memory:');
  const server = createServer({ db, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('seluruh endpoint selain CRUD Watchlist menolak metode non-GET dengan 405', async t => {
  const base = await localServer(t);
  for (const path of ['/api/config', '/api/history?mint=So11111111111111111111111111111111111111112', '/api/jobs/missing', '/api/discover', '/api/scan', '/api/health', '/', '/app.js']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await fetch(base + path, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.match((await response.json()).error, /Hanya GET/);
    }
  }
});

test('server menolak Host asing untuk mencegah pembacaan data lokal lewat DNS rebinding', async t => {
  const base = await localServer(t);
  for (const host of ['attacker.example', '127.0.0.1.attacker.example', 'localhost.attacker.example']) {
    const response = await new Promise((resolve, reject) => {
      get(`${base}/api/watchlist`, { headers: { Host: host } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }).on('error', reject);
    });
    assert.equal(response.status, 403, host);
    assert.match(response.body.error, /loopback/);
  }
  const response = await fetch(`${base}/api/config`);
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).configHash, 'string');
});

test('deep scan membawa seluruh bukti awal dan envelope mint tanpa membocorkan konteks internal ke JSON', async t => {
  const now = Date.now();
  const mint = '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs';
  const token = { mint, symbol: 'TEST', name: 'Fixture', organicScore: 80, organicLabel: 'high', isVerified: true, tags: [], holderCount: 5000, liquidityUsd: 500000,
    audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 15 },
    stats: { '1h': { numNetBuyers: 120, buyVolume: 1000, buyOrganicVolume: 750, numOrganicBuyers: 80, numTraders: 100 } } };
  const pool = { poolAddress: 'Poo1111111111111111111111111111111111111111', dex: 'fixture', priceUsd: 1, liquidityUsd: 500000, marketCap: 5000000, fdv: 5000000, createdAt: now - 72 * 3600000, change: { h1: 2, h6: 5, h24: 10 }, volume: { h1: 50000, h6: 150000, h24: 500000 }, txns: { h24: { buys: 600, sells: 400 } } };
  let input;
  const base = await localServer(t, {
    jupiter: {
      topOrganic: async () => ({ status: 'available', source: 'Jupiter', tokens: [token] }),
      topTrending: async () => ({ status: 'available', source: 'Jupiter', tokens: [token] }),
      recent: async () => ({ status: 'available', source: 'Jupiter', tokens: [token] })
    },
    dexscreener: { batch: async () => ({ status: 'available', pools: new Map([[mint, pool]]) }) },
    gecko: { trending: async () => ({ status: 'available', pools: [] }), newPools: async () => ({ status: 'available', pools: [] }) },
    deepScan: async candidate => { input = candidate; return candidate; }
  });
  const initial = await (await fetch(`${base}/api/discover?preset=balanced`)).json();
  assert.equal(initial.rows.length, 1);
  assert.ok(initial.jobId);
  assert.equal(initial.rows[0].organic.stats, undefined, 'konteks provider lengkap tetap privat');
  const job = await (await fetch(`${base}/api/jobs/${initial.jobId}`)).json();
  assert.equal(job.status, 'done');
  assert.equal(job.results[0].ok, true);
  assert.equal(job.results[0].mint, mint, 'UI memasangkan patch lewat mint envelope');
  assert.deepEqual(input.jupiter.stats, token.stats);
  assert.deepEqual(input.jupiter.audit, token.audit);
  assert.deepEqual(input.market.pool.txns, pool.txns);
  assert.equal(job.results[0].result.score, initial.rows[0].score);
  for (const key of ['organic', 'momentum', 'safety']) {
    assert.deepEqual(job.results[0].result.components.find(item => item.key === key), initial.rows[0].components.find(item => item.key === key));
  }
});

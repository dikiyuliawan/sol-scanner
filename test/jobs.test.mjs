import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createJobs } from '../jobs.mjs';

test('job mempertahankan mint string di envelope hasil sukses dan gagal', async () => {
  const jobs = createJobs({ concurrency: 2 });
  const job = jobs.create(['mint-success', 'mint-failure'], async mint => {
    if (mint === 'mint-failure') throw new Error('fixture failed');
    return { mint, score: 60 };
  });
  await setImmediate();
  const done = jobs.get(job.id);
  assert.equal(done.status, 'done');
  assert.equal(done.completed, 2);
  assert.equal(done.failures, 1);
  assert.equal(done.results.find(result => result.ok).mint, 'mint-success');
  assert.equal(done.results.find(result => !result.ok).mint, 'mint-failure');
});

test('job tetap mendukung item objek yang memiliki properti mint', async () => {
  const jobs = createJobs();
  const job = jobs.create([{ mint: 'object-mint' }], async item => ({ score: 50, mint: item.mint }));
  await setImmediate();
  assert.equal(jobs.get(job.id).results[0].mint, 'object-mint');
});

import { randomUUID } from 'node:crypto';

/**
 * Antrean deep scan in-memory. Job sengaja tidak dipersistensi: hasilnya
 * hanya melengkapi satu run discovery yang sedang dilihat.
 */
export function createJobs({ concurrency = 2, ttlMs = 10 * 60_000, clock = Date.now } = {}) {
  const jobs = new Map();
  const queue = [];
  let running = 0;

  function cleanup() {
    const now = clock();
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - Date.parse(job.finishedAt) > ttlMs) jobs.delete(id);
    }
  }

  function pump() {
    while (running < concurrency && queue.length) {
      const task = queue.shift();
      const job = jobs.get(task.jobId);
      if (!job || job.status === 'cancelled') continue;
      running += 1;
      job.status = 'running';
      job.startedAt = new Date(clock()).toISOString();
      const mint = typeof task.item === 'string' ? task.item : task.item?.mint;
      Promise.resolve()
        .then(() => task.worker(task.item))
        .then(result => {
          job.results.push({ ok: true, mint, result });
          job.completed += 1;
        })
        .catch(error => {
          job.results.push({ ok: false, mint, reason: error?.message ?? 'deep scan gagal' });
          job.completed += 1;
          job.failures += 1;
        })
        .finally(() => {
          running -= 1;
          if (job.completed >= job.total) {
            job.status = 'done';
            job.finishedAt = new Date(clock()).toISOString();
          }
          pump();
        });
    }
  }

  return {
    create(items, worker) {
      cleanup();
      const id = randomUUID();
      const job = {
        id,
        status: 'queued',
        total: items.length,
        completed: 0,
        failures: 0,
        createdAt: new Date(clock()).toISOString(),
        startedAt: null,
        finishedAt: null,
        results: []
      };
      jobs.set(id, job);
      for (const item of items) queue.push({ jobId: id, item, worker });
      pump();
      return job;
    },
    get(id) {
      const job = jobs.get(id);
      return job ? { ...job, results: [...job.results] } : null;
    },
    size: () => jobs.size
  };
}

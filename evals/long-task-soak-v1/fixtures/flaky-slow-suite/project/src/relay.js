import { withRetry } from './retry.js';

// Sends records to sink.send(key, batch) in batches, in order. Each batch takes a
// limiter token (if any) and is retried with withRetry(…, retry).
export async function relay(records, { sink, batchSize = 50, limiter = null, retry = {} } = {}) {
  if (!sink || typeof sink.send !== 'function') throw new TypeError('sink.send is required');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');
  const stats = { batches: 0, delivered: 0, retries: 0 };
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const key = `batch-${offset / batchSize}`;
    if (limiter) await limiter.take();
    await withRetry(async attempt => {
      if (attempt > 1) stats.retries++;
      await sink.send(key, batch);
    }, retry);
    stats.batches++;
    stats.delivered += batch.length;
  }
  return stats;
}

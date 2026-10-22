import { parentPort, workerData } from 'node:worker_threads';
import { searchContextIndexV2 } from './context-engine.js';
// Isolate synchronous SQLite work so the caller can enforce its deadline.
try {
  const result = await searchContextIndexV2(workerData.root, workerData.query,
    { excludePatterns: workerData.excludePatterns, limit: 50 });
  parentPort.postMessage({ paths: result.results.map(row => row.path), available: result.status.exists });
} catch { parentPort.postMessage({ paths: [], available: false }); }

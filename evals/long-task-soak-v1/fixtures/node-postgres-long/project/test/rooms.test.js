import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRepository } from '../src/index.js';
import { setupPool, skip, unique } from './helpers.js';

let pool, repo;
before(async () => { if (skip) return; pool = await setupPool(); repo = createRepository(pool); });
after(async () => { await pool?.end(); });

test('createRoom và getRoom', { skip }, async () => {
  const name = unique('Phòng A');
  const room = await repo.createRoom({ name, capacity: 6 });
  assert.equal(typeof room.id, 'number');
  assert.deepEqual(await repo.getRoom(room.id), room);
  assert.equal(await repo.getRoom(-1), null);
});

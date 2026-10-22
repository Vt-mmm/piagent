import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory } from '../src/index.js';

test('receive adds up the same lot', () => {
  const inv = new Inventory({ clock: () => '2026-01-10' });
  inv.receive('MILK', 5, { lot: 'L1', expiresOn: '2026-02-01' });
  inv.receive('MILK', 3, { lot: 'L1', expiresOn: '2026-02-01' });
  assert.equal(inv.onHand('MILK'), 8);
});

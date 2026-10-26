import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { discoverDeliveryContext, deliveryPrompt } from '../packages/piagent-core/managed/delivery-context.mjs';
import { repositoryChecks, detectedChecks } from '../packages/piagent-core/managed/workflow.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, put(name, value = '') { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), typeof value === 'object' ? JSON.stringify(value) : value); } };
}

test('detects surfaces from dependencies, not member roles or language manifests', t => {
  const { root, put } = fixture(t);
  put('pom.xml', '<project/>');
  assert.deepEqual(discoverDeliveryContext(root).units[0].surfaces, []);
  put('package.json', { dependencies: { react: '1' } });
  put('src/api/client.ts', 'fetch("/api")');
  assert.deepEqual(discoverDeliveryContext(root).units[0].surfaces, ['frontend']);
  put('package.json', { dependencies: { react: '1', '@nestjs/core': '1' } });
  assert.deepEqual(discoverDeliveryContext(root).units[0].surfaces, ['backend', 'frontend']);
  put('package.json', { dependencies: { next: '1' } });
  put('app/api/orders/route.ts', '');
  assert.deepEqual(discoverDeliveryContext(root).units[0].surfaces, ['backend', 'frontend']);
});

test('maps sibling git repositories, worktrees and their packages independently', t => {
  const { root, put } = fixture(t);
  put('shop/.git', 'gitdir: elsewhere');
  put('shop/package.json', { workspaces: ['modules/*'] });
  put('shop/modules/ui/package.json', { dependencies: { vue: '1' }, scripts: { test: 'vitest' } });
  put('shop/modules/orders/pyproject.toml', 'dependencies = ["fastapi"]');
  put('shop/modules/orders/alembic.ini', '');
  put('shop/modules/orders/openapi.yaml', '');
  put('billing/.git/config', '');
  put('billing/pom.xml', '<dependency>spring-boot</dependency>');
  put('billing/mvnw', '');
  put('ignored/node_modules/package.json', { dependencies: { express: '1' } });
  const { units } = discoverDeliveryContext(root);
  assert.deepEqual(units.find(u => u.path === 'shop/modules/ui').surfaces, ['frontend']);
  assert.deepEqual(units.find(u => u.path === 'shop/modules/orders').surfaces, ['backend']);
  assert.deepEqual(units.find(u => u.path === 'shop/modules/orders').capabilities, ['database', 'contract']);
  assert.deepEqual(units.find(u => u.path === 'billing').surfaces, ['backend']);
  assert.ok(!units.some(u => u.path.startsWith('ignored')));
  const checks = repositoryChecks([], root).commands;
  assert.ok(checks.includes("cd 'billing' && ./mvnw verify"));
  assert.ok(checks.includes("cd 'shop/modules/ui' && npm test"));
  assert.ok(checks.includes("cd 'shop/modules/orders' && pytest"));
});

test('workspace exclusions win; root lint does not hide service integration checks', t => {
  const { root, put } = fixture(t);
  put('package.json', { scripts: { lint: 'eslint .' } });
  put('pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "!apps/retired"\n');
  put('apps/orders/package.json', { dependencies: { fastify: '1' }, scripts: { 'test:integration': 'vitest', 'test:api': 'vitest', 'test:contract': 'vitest' } });
  put('apps/retired/package.json', { dependencies: { express: '1' } });
  const context = discoverDeliveryContext(root);
  assert.ok(context.units.some(u => u.path === 'apps/orders'));
  assert.ok(!context.units.some(u => u.path === 'apps/retired'));
  assert.deepEqual(repositoryChecks([], root).commands, ['npm run lint', "cd 'apps/orders' && npm run test:integration", "cd 'apps/orders' && npm run test:api", "cd 'apps/orders' && npm run test:contract"]);
  assert.deepEqual(repositoryChecks([{ content: '## Checks\n- `make check`' }], root), { source: 'agents', commands: ['make check'] });
});

test('discovery skips symlinks, traversal patterns, oversized and invalid manifests', t => {
  const { root, put } = fixture(t);
  const outside = fixture(t);
  outside.put('package.json', { dependencies: { express: '1' } });
  put('package.json', { workspaces: ['../*', '/tmp/*', 'linked', 'apps/*'] });
  fs.symlinkSync(outside.root, path.join(root, 'linked'));
  put('apps/big/package.json', ' '.repeat(128 * 1024 + 1) + '{"dependencies":{"express":"1"}}');
  put('apps/broken/package.json', '{');
  put('apps/linked/keep', '');
  fs.symlinkSync(path.join(outside.root, 'package.json'), path.join(root, 'apps/linked/package.json'));
  const context = discoverDeliveryContext(root);
  assert.ok(!context.units.some(u => u.path === 'linked' || u.path.startsWith('../')));
  assert.ok(context.units.every(u => !u.surfaces.includes('backend')));
  assert.deepEqual(discoverDeliveryContext(path.join(root, 'linked')).units[0].surfaces, []);
});

test('bounded discovery refreshes after new services and supports non-Node backend frameworks', t => {
  const { root, put } = fixture(t);
  assert.deepEqual(discoverDeliveryContext(root).units[0].surfaces, []);
  put('go.mod', 'require github.com/gin-gonic/gin v1.0.0');
  assert.deepEqual(discoverDeliveryContext(root).units[0].surfaces, ['backend']);
  put('build.gradle.kts', 'implementation("io.ktor:ktor-server-core")');
  put('gradlew', '');
  assert.ok(detectedChecks(root).includes('./gradlew test'));
  for (let i = 0; i < 100; i++) put(`services/s${i}/Cargo.toml`, 'axum = "1"');
  const context = discoverDeliveryContext(root);
  assert.equal(context.units.length, 64);
  assert.equal(context.bounded, true);
});

test('delivery guidance separates surfaces, evidence and release approval without role config', () => {
  const prompt = deliveryPrompt({ units: [{ path: '.', surfaces: [] }], bounded: false });
  for (const phrase of ['actual code paths affected', 'frontend changes retain browser/UI checks', 'real integration/API flow', 'disposable data', 'blocked', 'Evidence from before', 'exact commit/artifact', 'rollback or roll-forward', 'merge is not release', 'not a production approval', 'no mandatory task contract']) assert.ok(prompt.includes(phrase), phrase);
});

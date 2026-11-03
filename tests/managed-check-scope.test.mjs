import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksFullChecks, askCheckScope, beforeCheckOrPush, checkScope, isGitPush, suitePart } from '../packages/piagent-core/managed/check-questions.mjs';
import { relevantChecks } from '../packages/piagent-core/managed/check-evidence.mjs';
import { approvalRefusal } from '../packages/piagent-core/managed/approval-refusal.mjs';
import { ledgerWords, settleLedger } from '../packages/piagent-core/managed/ledger.mjs';
import { memberQuestions } from '../packages/piagent-core/managed/member-questions.mjs';
import { RunProcess, completionGate, workflowPrompt } from '../packages/piagent-core/managed/workflow.mjs';

// How much to test is the member's decision: asked at the end of a change, before
// a whole suite and before a push; on the dashboard card or in the Terminal.
const REQUIRE = { plan: 'off', verify: 'require', review: 'off', maxFixLoops: 2, lanes: false };
const START = 's'.repeat(64), CODE = 'c'.repeat(64);
const newRun = (request = 'fix cart', policy = REQUIRE) => { const run = new RunProcess(policy, { request, complex: false, checks: { commands: ['npm test'], source: 'agents' } }); run.startDigest = START; return run; };
const terminal = (...answers) => { const asked = []; return { asked, select: async (title, items) => { asked.push({ title, items }); return answers.shift(); } }; };
function managedOf(run, ui, permission = 'trusted-full-access') {
  const notes = [], code = { digest: CODE }, id = `scope-${Math.random()}`;
  const self = { run, permission, manifest: { harness: { configuration: { bypass_mode: true } } }, cwd: process.cwd(), review: null, ownPaths: new Set(['src/a.js']), notes, code,
    digest: async () => code.digest, changeDigest: async () => code.digest, patchDigest: async () => code.digest, patchSnapshot: async () => ({ patch: '', untracked: [] }), changedFiles: async () => new Map(), refreshReview: async () => {},
    session: { messages: [], sessionManager: { getSessionId: () => id, getBranch: () => [], getEntries: () => [], appendCustomEntry() {} }, extensionRunner: { hasUI: () => !!ui, getUIContext: () => ui },
      sendCustomMessage: async (message, options) => { notes.push({ ...message, triggerTurn: options?.triggerTurn }); } } };
  return self;
}
const check = (run, self, command, ok = true) => run.afterTool('bash', { command }, ok, () => self.digest());

test('checkScope tells a whole suite from a part of it', () => {
  for (const c of ['npm test', 'npm test 2>&1 | tail -5', 'go test ./...', 'pytest', 'npm run test:e2e', 'node --test tests/*.test.mjs', 'cd api && npm test', 'mvn verify', './gradlew test']) assert.equal(checkScope(c), 'suite', c);
  for (const c of ['pytest -k login', 'go test -run TestA ./...', 'go test ./internal/cart', 'npm test -- tests/cart.test.mjs', 'node --test tests/cart.test.mjs', 'npx vitest run src/cart.spec.ts', 'pytest tests/test_cart.py', 'mvn test -Dtest=CartTest', './gradlew test --tests CartTest', 'cargo test -p cart']) assert.equal(checkScope(c), 'partial', c);
  for (const c of ['tsc --noEmit', 'npm run lint', 'go vet ./...', 'tsc --version', 'grep npm test x', 'git status']) assert.equal(checkScope(c), null, c);
  assert.equal(checkScope('./scripts/ci.sh', ['./scripts/ci.sh']), 'suite');
  assert.equal(checkScope('npm run lint', ['npm run lint']), null);
  assert.equal(checkScope('node --test tests/a.test.mjs', ['node --test tests/a.test.mjs']), 'suite');
});

// One table across tools: a member who chose "only the related part" must be able
// to run one file, one filter or one module in each of them, and a whole run still asks.
const SCOPES = {
  // JS: npm/pnpm/yarn/bun scripts
  'JS: npm/pnpm/yarn/bun scripts': { partial: ['npm test -- tests/cart.test.mjs', 'npm test -- -t "adds item"', 'npm run test -- --grep cart', 'pnpm test src/cart.test.ts', 'yarn test cart', 'bun test src/cart.test.ts', 'bun test -t total', 'pnpm --filter web test', 'pnpm -F web test', 'npm test -w packages/web', 'npm test --workspace=web', 'yarn workspace web test'], suite: ['npm test', 'npm run test', 'npm t', 'pnpm test', 'yarn test', 'bun test', 'npm run test:unit', 'npm run test:e2e', 'pnpm -r test', 'npm test -- --coverage', 'npm test -- --runInBand', 'CI=1 npm test'], none: [] },
  // jest / vitest / mocha / node / playwright
  'jest / vitest / mocha / node / playwright': { partial: ['npx jest src/cart.test.ts', 'npx jest cart', 'npx jest -t "adds item"', 'npx jest --testPathPattern cart', 'npx jest --findRelatedTests src/cart.ts', 'npx jest --onlyChanged', 'npx jest --changedSince main', 'npx jest --selectProjects api', 'npx vitest run src/cart.spec.ts', 'npx vitest run cart', 'npx vitest run -t total', 'npx vitest related src/cart.ts --run', 'npx vitest --project api run', 'npx vitest run --changed', 'npx mocha test/cart.spec.js', 'npx mocha --grep cart', 'npx mocha -g cart', 'node --test tests/cart.test.mjs', 'node --test --test-name-pattern=cart', 'npx playwright test e2e/cart.spec.ts', 'npx playwright test cart', 'npx playwright test -g "checkout"', 'npx playwright test --grep @smoke', 'npx playwright test --project chromium', 'npx playwright test e2e/cart.spec.ts:42', 'npx cypress run --spec cypress/e2e/cart.cy.ts'], suite: ['npx jest', 'npx jest --maxWorkers 2', 'npx jest -w 2', 'npx jest --ci --coverage', 'npx vitest', 'npx vitest run', 'vitest run --reporter verbose', 'npx mocha', 'npx mocha --timeout 5000', 'node --test', 'node --test tests/*.test.mjs', 'node --test --test-concurrency=4 tests/', 'npx playwright test', 'npx playwright test --workers 2', 'npx cypress run'], none: [] },
  // Python
  'Python': { partial: ['pytest tests/unit', 'pytest tests/test_cart.py', 'pytest tests/test_cart.py::test_total', 'pytest -k "cart and not slow"', 'pytest -m smoke', 'pytest --lf', 'python3 -m pytest tests/test_cart.py', 'python -m pytest -k cart', 'uv run pytest tests/test_cart.py', 'python -m unittest tests.test_cart', 'python -m unittest tests.test_cart.CartTest.test_total', 'python -m unittest discover -s tests -p "test_cart*.py"', 'python manage.py test shop.tests.test_cart', 'tox -e py311 -- tests/test_cart.py'], suite: ['pytest', 'pytest -q', 'pytest tests', 'pytest tests/', 'pytest -n 4', 'pytest -x --maxfail 1', 'pytest -q --tb=short', 'pytest -n auto', 'python -m pytest', 'poetry run pytest', 'python -m unittest', 'python -m unittest discover', 'python manage.py test', 'tox'], none: [] },
  // Go
  'Go': { partial: ['go test ./internal/cart', 'go test ./internal/cart/...', 'go test -run TestTotal ./...', 'go test -run=TestTotal ./internal/cart', 'go test .', 'go test'], suite: ['go test ./...', 'go test -count=1 ./...', 'go test -p 4 ./...', 'go test -race -timeout 60s ./...'], none: [] },
  // Rust
  'Rust': { partial: ['cargo test total', 'cargo test cart::tests::total', 'cargo test -p cart', 'cargo test --package cart', 'cargo test --test cart_it', 'cargo test --lib', 'cargo test total -- --nocapture', 'cargo nextest run -E "test(total)"'], suite: ['cargo test', 'cargo test --workspace', 'cargo test -- --nocapture', 'cargo test --release', 'cargo test -j 4', 'cargo nextest run'], none: [] },
  // JVM
  'JVM': { partial: ['mvn test -Dtest=CartTest', './mvnw -Dtest=CartTest test', './mvnw -Dtest=CartTest#total test', './mvnw -Dtest="Cart*Test" test', './mvnw -Dit.test=CartIT verify', './mvnw -Dtest=X -Dit.test=Y verify', 'mvn -pl cart test', 'mvn -pl :cart -am verify', 'mvn --projects cart verify', 'mvn -f cart/pom.xml test', 'mvn -Dgroups=fast test', './gradlew test --tests CartTest', './gradlew test --tests "*.CartTest.total"', './gradlew :cart:test', './gradlew -p cart test', './gradlew :app:integrationTest --tests CartIT', './gradlew testDebugUnitTest --tests CartTest'], suite: ['mvn test', 'mvn verify', './mvnw clean verify', './mvnw -q test', './mvnw -T 4 verify', 'mvn -B verify', './gradlew test', 'gradle test', './gradlew check', './gradlew test --max-workers 2', './gradlew integrationTest', './gradlew connectedAndroidTest', './gradlew testDebugUnitTest'], none: ['./mvnw -q -DskipTests test-compile', 'mvn -DskipTests package', 'mvn -DskipTests install', './gradlew build', './gradlew compileTestJava'] },
  // .NET, Swift, Xcode
  '.NET, Swift, Xcode': { partial: ['dotnet test --filter FullyQualifiedName~Cart', 'dotnet test tests/Cart.Tests', 'dotnet test tests/Cart.Tests/Cart.Tests.csproj', 'swift test --filter CartTests', 'swift test --filter CartTests/testTotal', 'xcodebuild test -scheme App -only-testing:AppTests/CartTests', 'xcodebuild test -scheme App -only-testing AppTests/CartTests', 'xcodebuild test-without-building -scheme App -only-testing:AppTests'], suite: ['dotnet test', 'dotnet test -c Release', 'dotnet test --no-build', 'swift test', 'swift test --parallel', 'xcodebuild test -scheme App -destination "platform=iOS Simulator,name=iPhone 16"'], none: ['xcodebuild build -scheme App'] },
  // Ruby, PHP, Elixir, Dart, Deno, make
  'Ruby, PHP, Elixir, Dart, Deno, make': { partial: ['bundle exec rspec spec/cart_spec.rb', 'rspec spec/cart_spec.rb:42', 'rspec --tag focus', 'rspec -e "adds item"', 'bin/rails test test/models/cart_test.rb', 'bin/rails test test/models/cart_test.rb:12', './vendor/bin/phpunit --filter CartTest', 'phpunit tests/CartTest.php', 'php artisan test --filter=CartTest', './vendor/bin/pest --filter cart', 'mix test test/cart_test.exs', 'mix test test/cart_test.exs:12', 'mix test --only focus', 'flutter test test/cart_test.dart', 'flutter test --name total', 'dart test -n total', 'deno test src/cart_test.ts', 'deno test --filter total', 'make test TEST=./internal/cart'], suite: ['bundle exec rspec', 'rspec', 'bin/rails test', 'vendor/bin/phpunit', 'php artisan test', 'mix test', 'flutter test', 'dart test', 'deno test', 'deno test -A', 'make test', 'make test-unit'], none: [] },
  // Monorepo runners
  'Monorepo runners': { partial: ['npx nx test web', 'npx nx affected -t test', 'npx turbo run test --filter=web', 'npx lerna run test --scope web'], suite: ['npx nx run-many -t test', 'npx turbo run test'], none: [] },
  // Not tests
  'Not tests': { partial: [], suite: [], none: ['npm run lint', 'tsc --noEmit', './mvnw -q compile', 'go build ./...', 'go vet ./...', 'cargo build', 'cargo clippy', 'pip install pytest', 'npm install -D vitest', 'git status', 'cat test/cart.test.ts', 'ls tests', 'npm test --version', 'pytest --collect-only', './mvnw dependency:tree', './gradlew dependencies', 'dotnet build', 'echo "npm test"'] },
};
for (const [tools, { partial, suite, none }] of Object.entries(SCOPES)) test(`checkScope reads ${tools} commands`, () => {
  for (const c of partial) assert.equal(checkScope(c), 'partial', c);
  for (const c of suite) assert.equal(checkScope(c), 'suite', c);
  for (const c of none) assert.equal(checkScope(c), null, c);
});

test('commands members ran with a Maven filter before the goal are a part (2026-11-03 refusals)', () => {
  for (const c of ['./mvnw -DskipUnitTests=true -Dit.test=LedgerFoundationMigrationIT,LedgerSeedDriftMigrationIT verify', './mvnw -Dtest=LedgerFoundationMigrationIT surefire:test',
    'cd ~/v-nexus-backend && ./mvnw -DskipUnitTests=true -Dit.test=HubListingReadServiceIT verify', 'set -o pipefail; ./mvnw -Dit.test=A verify 2>&1 | tail -70',
    './mvnw -Dtest=X test > target/x.log 2>&1; code=$?; tail -n 55 target/x.log; exit $code']) assert.equal(checkScope(c), 'partial', c);
  assert.equal(suitePart('cd api && ./mvnw -Dtest=X test 2>&1 | tail -5'), 'mvnw -Dtest=X test');
});

test('checkScope and isGitPush read what runs, not what it quotes, writes to or pipes into', () => {
  for (const c of ['npm test > /tmp/o.txt', 'npm test 2>/tmp/e', 'npm test 2>&1 | sort -k 2', 'jest --config tests/jest.config.js', 'playwright test --config e2e/pw.config.ts', 'go test -coverprofile=/tmp/c ./...']) assert.equal(checkScope(c), 'suite', c);
  assert.equal(checkScope('jest src/cart'), 'partial');
  for (const c of ['cd x && git commit -m "fix npm test now"', "cd x && echo 'go test ./...'"]) assert.equal(checkScope(c), null, c);
  for (const c of ['git commit -m "then git push"', "echo 'git push'"]) assert.equal(isGitPush(c), false, c);
});

test('names of test tools in other commands are not test runs; a declared script can reach the member again', async () => {
  for (const c of ['npm install -D vitest', 'pip install pytest', 'rm jest.config.ts', 'which pytest', 'rm ./ci.sh']) assert.equal(checkScope(c, ['./ci.sh']), null, c);
  for (const c of ['npx jest', 'FOO=1 npm test', 'timeout 600 npm test', './gradlew test', 'node_modules/.bin/vitest run', './ci.sh', 'cd x && ./ci.sh']) assert.equal(checkScope(c, ['./ci.sh']), 'suite', c);
  const ui = terminal('Chỉ chạy phần liên quan', 'Chạy toàn bộ'), run = newRun(); run.checks.commands = ['make check'];
  const self = managedOf(run, ui), ctx = { hasUI: true, ui };
  await assert.rejects(beforeCheckOrPush(self, 'make check', ctx), /only the tests/);
  await assert.rejects(beforeCheckOrPush(self, 'make test', ctx), /only the tests/);
  await beforeCheckOrPush(self, 'make check', ctx); // the second try asks, and the member can let it run
  assert.equal(ui.asked.length, 2);
});

test('stopping during the question ends the turn: no new model turn', async () => {
  const controller = new AbortController(), ui = { select: async () => { controller.abort(); return undefined; } }, run = newRun(), self = managedOf(run, ui);
  await completionGate(self, run, controller.signal);
  assert.equal(self.notes.filter(n => n.triggerTurn).length, 0);
  assert.equal(run.fixLoops, 0); assert.equal(run.outcome, 'interrupted');
});

test('a question nobody answers is taken back: the turn goes on with the part, and no push', async () => {
  // A screen that never answers: only its signal ends the wait (the member is asleep).
  const asleep = () => { const asked = []; return { asked, select: (title, items, { signal }) => { asked.push({ title }); return new Promise(r => signal.addEventListener('abort', () => r(undefined))); } }; };
  const ui = asleep(), run = newRun(), self = managedOf(run, ui); self.unansweredMs = 20;
  await completionGate(self, run, undefined);
  assert.equal(ui.asked.length, 1);
  assert.equal(run.scopeChoice, 'partial');
  assert.notEqual(run.outcome, 'interrupted');
  assert.ok(self.notes.some(n => n.triggerTurn), 'the agent is sent on to run the part');
  const pusher = asleep(), held = managedOf(newRun(), pusher); held.unansweredMs = 20;
  await assert.rejects(beforeCheckOrPush(held, 'git push', { hasUI: true, ui: pusher }), /did not answer/);
  const card = managedOf(newRun(), null), sessionId = card.session.sessionManager.getSessionId();
  const unbind = memberQuestions.bindSurface(sessionId, () => {});
  try {
    card.unansweredMs = 20;
    assert.deepEqual(await askCheckScope(card), { choice: 'partial' });
    assert.equal(memberQuestions.pending(sessionId).length, 0, 'the card is taken back');
  } finally { unbind(); }
});

test('calls sent together get one question', async () => {
  let answer; const asked = [], ui = { select: (title) => { asked.push(title); return new Promise(r => { answer = r; }); } };
  const self = managedOf(newRun(), ui), ctx = { hasUI: true, ui };
  const one = beforeCheckOrPush(self, 'npm test', ctx), two = beforeCheckOrPush(self, 'npm run test:e2e', ctx);
  await new Promise(r => setImmediate(r));
  assert.equal(asked.length, 1);
  answer('Chỉ chạy phần liên quan');
  await assert.rejects(one, /only the tests/); await assert.rejects(two, /only the tests/);
  assert.equal(asked.length, 1);
});

test('"do not run" covers its code only: new code is asked about again', async () => {
  const ui = terminal('Không chạy lúc này', 'Chỉ chạy phần liên quan'), run = newRun(), self = managedOf(run, ui);
  await completionGate(self, run, undefined);
  self.code.digest = 'd'.repeat(64);
  await completionGate(self, run, undefined);
  assert.equal(ui.asked.length, 2); assert.equal(run.scopeChoice, 'partial');
});

test('the member\'s own words ask for the whole suite, and a "no" does not; pushes are seen', () => {
  for (const t of ['chạy full test nhé', 'run all tests', 'chạy toàn bộ test', 'chay tat ca test', 'run the whole suite']) assert.equal(asksFullChecks(t), true, t);
  for (const t of ['sửa dòng này', 'không chạy full test', 'đừng chạy toàn bộ test', "don't run all tests", 'check all links in the docs', 'fix all tests that fail', 'skip the full suite']) assert.equal(asksFullChecks(t), false, t);
  for (const c of ['git push', 'git -C x push origin main', 'git add . && git push', 'git --no-pager push -f']) assert.equal(isGitPush(c), true, c);
  for (const c of ['git status', 'git stash push', 'grep "push" x']) assert.equal(isGitPush(c), false, c);
});

test('with no screen the gate behaves as before: a partial run counts, nothing is asked or held', async () => {
  const run = newRun(), self = managedOf(run, null);
  await check(run, self, 'node --test tests/a.test.mjs');
  await completionGate(self, run, undefined);
  assert.equal(run.verified, true);
  assert.equal(self.notes.filter(n => n.details?.phase === 'verify').length, 0);
  await beforeCheckOrPush(self, 'npm test'); await beforeCheckOrPush(self, 'git push');
  assert.equal(await askCheckScope(self), null);
});

test('a partial pass the member keeps ends the turn and the status says only part ran', async () => {
  const ui = terminal('Giữ kết quả phần đã chạy'), run = newRun(), self = managedOf(run, ui);
  await check(run, self, 'pytest -k cart');
  await completionGate(self, run, undefined);
  assert.equal(ui.asked.length, 1);
  assert.equal(run.outcome, 'clean');
  assert.match(self.notes.at(-1).content, /only part of the test suite passed on the final code/);
  assert.equal(self.notes.at(-1).details.partOnly, true);
});

test('choosing the whole suite after a partial pass sends the agent to run it', async () => {
  const ui = terminal('Chạy toàn bộ'), run = newRun(), self = managedOf(run, ui);
  await check(run, self, 'pytest -k cart');
  self.session.sendCustomMessage = async (message, options) => { self.notes.push({ ...message, triggerTurn: options?.triggerTurn }); if (options?.triggerTurn && message.details?.phase === 'verify') await check(run, self, 'npm test'); };
  await completionGate(self, run, undefined);
  assert.match(self.notes.find(n => n.details?.phase === 'verify').content, /whole suite: a partial run does not count/);
  assert.equal(run.verified, true); assert.equal(ui.asked.length, 1);
  assert.match(self.notes.at(-1).content, /a check passed on the final code/);
});

test('choosing not to run is the waiver: this code, reported unverified, asked again on new code', async () => {
  const ui = terminal('Không chạy lúc này'), run = newRun(), self = managedOf(run, ui);
  await completionGate(self, run, undefined);
  assert.equal(run.waivedDigest, CODE); assert.equal(run.verified, false);
  assert.equal(self.notes.filter(n => n.details?.phase === 'verify').length, 0);
  assert.match(self.notes.at(-1).content, /the member waived the checks/);
  assert.equal(self.notes.at(-1).details.checksWaived, true);
});

test('a failing check is sent back to be fixed, not asked about', async () => {
  const ui = terminal(), run = newRun(), self = managedOf(run, ui);
  await check(run, self, 'pytest -k cart', false);
  await completionGate(self, run, undefined);
  assert.equal(ui.asked.length, 0);
  assert.ok(self.notes.some(n => n.details?.phase === 'verify'));
});

test('a lint after a partial run does not turn it into the whole suite', async () => {
  const run = newRun(), self = managedOf(run, null);
  await check(run, self, 'pytest -k cart'); await check(run, self, 'npm run lint');
  assert.equal(run.lastCheck.scope, 'partial');
});

test('a suite about to start asks; "part" holds for the message, "full" for one run; Bypass does not start it', async () => {
  const ui = terminal('Chỉ chạy phần liên quan'), run = newRun(), self = managedOf(run, ui), ctx = { hasUI: true, ui };
  await assert.rejects(beforeCheckOrPush(self, 'npm test', ctx), /only the tests that cover/);
  await assert.rejects(beforeCheckOrPush(self, 'npm run test:unit', ctx), /only the tests that cover/);
  assert.equal(ui.asked.length, 1);
  await beforeCheckOrPush(self, 'node --test tests/a.test.mjs', ctx);

  const fullUi = terminal('Chạy toàn bộ', 'Chạy toàn bộ'), g = newRun(), other = managedOf(g, fullUi), gctx = { hasUI: true, ui: fullUi };
  await beforeCheckOrPush(other, 'npm test', gctx);
  await check(g, other, 'npm test', false); other.code.digest = 'd'.repeat(64);
  await beforeCheckOrPush(other, 'npm test', gctx);
  assert.equal(fullUi.asked.length, 2);

  const quiet = terminal(), b = managedOf(newRun(), quiet, 'bypass');
  await assert.rejects(beforeCheckOrPush(b, 'npm test', { hasUI: true, ui: quiet }), /managed-check-scope/);
  assert.equal(quiet.asked.length, 0);
  assert.deepEqual(await askCheckScope(b), { choice: 'partial' });
  await beforeCheckOrPush(b, 'npm test', { hasUI: true, ui: quiet }); // the same command again: it runs
});

test('nothing is asked when the member asked for it all or the policy has no verify', async () => {
  const ui = terminal(), ctx = { hasUI: true, ui };
  await beforeCheckOrPush(managedOf(newRun('chạy full test'), ui), 'npm test', ctx);
  const off = managedOf(newRun('x', { ...REQUIRE, verify: 'off' }), ui);
  await beforeCheckOrPush(off, 'npm test', ctx); await beforeCheckOrPush(off, 'git push', ctx);
  assert.equal(ui.asked.length, 0);
});

test('before a push: asked in every mode, once per code state, not after a full pass', async () => {
  for (const mode of ['ask', 'trusted-full-access', 'bypass']) {
    const ui = terminal('Push luôn, không chạy thêm', 'Push luôn, không chạy thêm'), self = managedOf(newRun(), ui, mode), ctx = { hasUI: true, ui };
    await beforeCheckOrPush(self, 'git push origin x', ctx); await beforeCheckOrPush(self, 'git push origin x', ctx);
    assert.equal(ui.asked.length, 1, mode);
    self.code.digest = 'd'.repeat(64);
    await beforeCheckOrPush(self, 'git push origin x', ctx);
    assert.equal(ui.asked.length, 2, mode);
  }
  const ui = terminal('Chạy toàn bộ rồi mới push'), run = newRun(), self = managedOf(run, ui, 'bypass'), ctx = { hasUI: true, ui };
  await assert.rejects(beforeCheckOrPush(self, 'git push', ctx), /whole suite before this push/);
  await beforeCheckOrPush(self, 'npm test', ctx);
  await check(run, self, 'npm test');
  await beforeCheckOrPush(self, 'git push', ctx);
  assert.equal(ui.asked.length, 1);
  const esc = terminal(undefined);
  await assert.rejects(beforeCheckOrPush(managedOf(newRun(), esc), 'git push', { hasUI: true, ui: esc }), /did not answer/);
});

test('the dashboard card answers too, and the member\'s own words go to the agent', async () => {
  const run = newRun(), self = managedOf(run, null), sessionId = self.session.sessionManager.getSessionId(), seen = [];
  const unbind = memberQuestions.bindSurface(sessionId, event => { if (event.type === 'asked') seen.push(event.ref); });
  try {
    const held = beforeCheckOrPush(self, 'npm test', undefined);
    await new Promise(r => setImmediate(r));
    const [card] = memberQuestions.pending(sessionId);
    assert.deepEqual(card.questions[0].options.map(o => o.label), ['Chỉ chạy phần liên quan', 'Chạy toàn bộ']);
    memberQuestions.answer(sessionId, card.questionRef, { answers: [{ selected: [], other: 'chạy thư mục cart thôi' }] });
    await assert.rejects(held, /chạy thư mục cart thôi/);
    assert.equal(run.scopeChoice, 'partial');
    const end = askCheckScope(self);
    await new Promise(r => setImmediate(r));
    memberQuestions.answer(sessionId, memberQuestions.pending(sessionId)[0].questionRef, { answers: [{ selected: [1] }] });
    assert.deepEqual(await end, { choice: 'full' });
  } finally { unbind(); }
});

test('the prompt tells the agent not to pick the whole suite itself', () => {
  assert.match(workflowPrompt(REQUIRE, { commands: ['npm test'] }), /Do not choose the whole test suite yourself/);
});

// What the feedback on a real three-repository task found.
test('the scope of a command: flags and functions are read as what they are', () => {
  assert.equal(checkScope('go test -p 1 ./...'), 'suite'); // -p is parallelism for go, a package for cargo
  assert.equal(checkScope('cargo test -p core'), 'partial');
  assert.equal(checkScope('go test -p 1 ./internal/cart'), 'partial');
  for (const c of ['run() { bash reset.sh; npx playwright test "$@" --reporter=line; }; run e2e/a.spec.ts e2e/b.spec.ts', 'run() { npx playwright test $1; }; run e2e/a.spec.ts', 'for f in e2e/a.spec.ts; do npx playwright test $f; done', 'go test -count=1 $(go list ./... | grep -v x)']) assert.equal(checkScope(c), 'partial', c);
  for (const c of ['(npm run typecheck; npm test 2>&1 | tail -8)', 'npm test && git add a && git commit -m "x"', 'X="$Y" npm test']) assert.equal(checkScope(c), 'suite', c);
  assert.equal(suitePart('cd a && npm run typecheck && npm test 2>&1 | tail -5'), 'npm test');
});

function repositories(ui, permission) {
  const run = newRun(), self = managedOf(run, ui, permission), code = { fe: 'f1', be: 'b1' };
  self.cwd = '/work'; self.repositoryBases = { fe: 'h1', be: 'h2', other: 'h3' }; self.ownPaths = new Set(['fe/a.ts', 'be/b.go']);
  self.scopedDigest = async scope => [...scope].some(file => file.startsWith('fe/')) ? code.fe : code.be;
  return { run, self, code, passed: (command, ok = true) => run.afterTool('bash', { command }, ok, () => self.digest(), self) };
}
const FULL_PUSH = 'Chạy toàn bộ rồi mới push', NOW_PUSH = 'Push luôn, không chạy thêm';

test('a push is judged repository by repository; a later small run does not erase a whole-suite pass', async () => {
  const ui = terminal(FULL_PUSH), { self, passed } = repositories(ui), ctx = { hasUI: true, ui };
  await passed('cd /work/be && go test -p 1 ./...');
  await passed('cd /work/be && go test ./internal/one');
  await passed('cd /work/fe && npx playwright test e2e/a.spec.ts');
  await assert.rejects(beforeCheckOrPush(self, 'git -C /work/fe push origin x && git -C /work/be push origin x', ctx), /still needed in: fe/);
  const asked = ui.asked[0].title;
  assert.match(asked, /Sắp push fe, be/); assert.match(asked, /Đã pass toàn bộ: be/); assert.match(asked, /Mới pass một phần: fe \(1 lệnh\)/); assert.match(asked, /đổi 2 file/);
  await passed('cd /work/fe && npm test');
  await beforeCheckOrPush(self, 'git -C /work/fe push origin x && git -C /work/be push origin x', ctx); // no second question
  assert.equal(ui.asked.length, 1);
});

test('a green suite in one repository does not clear a push of another; changing a repository takes its pass away', async () => {
  const ui = terminal(NOW_PUSH, NOW_PUSH), { self, code, passed } = repositories(ui), ctx = { hasUI: true, ui };
  await passed('cd /work/fe && npm test');
  await beforeCheckOrPush(self, 'git -C /work/fe push', ctx); assert.equal(ui.asked.length, 0);
  await beforeCheckOrPush(self, 'git -C /work/be push', ctx); assert.equal(ui.asked.length, 1);
  code.fe = 'f2';
  self.run.pushAllowedOn = undefined;
  await beforeCheckOrPush(self, 'git -C /work/fe push', ctx); assert.equal(ui.asked.length, 2);
});

test('a push whose target is a variable covers the repositories this conversation changed', async () => {
  const ui = terminal(FULL_PUSH), { self, passed } = repositories(ui), ctx = { hasUI: true, ui };
  await passed('cd /work/fe && npm test');
  await assert.rejects(beforeCheckOrPush(self, 'p() { git -C "$1" push origin "$2"; }; p fe x; p be y', ctx), /still needed in: be/);
});

test('"run it all" stays until every repository the push needs has run; a failure asks again', async () => {
  const ui = terminal(FULL_PUSH), { run, self, passed } = repositories(ui), ctx = { hasUI: true, ui };
  await assert.rejects(beforeCheckOrPush(self, 'git -C /work/fe push && git -C /work/be push', ctx), /fe, be/);
  await passed('cd /work/fe && npm test');
  assert.equal(run.scopeChoice, 'full');
  await passed('cd /work/be && go test ./...');
  assert.equal(run.scopeChoice, null);
  run.scopeChoice = 'full'; run.fullFor = new Set(['be']);
  await passed('cd /work/be && go test ./...', false);
  assert.equal(run.scopeChoice, null);
});

test('Bypass lets through a whole suite it has seen pass quickly; a slow one still takes the detour', async () => {
  const ui = terminal(), run = newRun(), self = managedOf(run, ui, 'bypass'), ctx = { hasUI: true, ui };
  self.manifest.harness.configuration.bypass_mode = true;
  const bounce = command => assert.rejects(beforeCheckOrPush(self, command, ctx), /run the tests that cover/);
  await bounce('npm test');
  await beforeCheckOrPush(self, 'npm test', ctx); // the same command again runs
  await run.afterTool('bash', { command: 'npm test' }, true, () => self.digest(), self);
  await beforeCheckOrPush(self, 'npm test 2>&1 | tail -5', ctx); // quick: no detour, whatever surrounds it
  self.checkTimes.set(`.\u0000npm test`, 9 * 60_000);
  await bounce('npm test | tail -1');
});

test('the checks named are those of the repositories that changed', () => {
  const all = ["cd 'agent-studio' && go test ./...", "cd 'fe' && npm test", "cd 'fe/web' && npm run test:e2e", 'make lint'];
  assert.deepEqual(relevantChecks({ ownPaths: new Set(['fe/a.ts']) }, all), all.slice(1));
  assert.deepEqual(relevantChecks({ ownPaths: new Set() }, all), all);
  assert.deepEqual(relevantChecks({ ownPaths: new Set(['docs/a.md']) }, all.slice(0, 2)), all.slice(0, 2));
});

test('a required review runs before the push, and what it finds holds the push until it is decided', async () => {
  const ui = terminal(NOW_PUSH), run = newRun('fix', { ...REQUIRE, review: 'require' }), self = managedOf(run, ui), ctx = { hasUI: true, ui };
  run.startDigest = START; let reviews = 0, finding = true;
  self.patchDigest = async () => 'p'.repeat(64);
  self.delegate = async (ask, _signal, options) => {
    reviews += 1; assert.equal(ask.role, 'review'); assert.equal(options.harness, true);
    self.review = { patchDigest: 'p'.repeat(64), stale: false, blocking: 0 };
    if (finding) run.ledger.push({ id: 'o1', source: 'review', role: 'review', kind: 'major', status: 'open', detail: 'drafts leak', required: false });
  };
  await assert.rejects(beforeCheckOrPush(self, 'git push', ctx), /managed-review-before-push[\s\S]*o1[\s\S]*drafts leak/);
  assert.equal(ui.asked.length, 0); // nothing asked about tests yet
  assert.equal(reviews, 1);
  run.ledger[0].status = 'accepted'; finding = false;
  await beforeCheckOrPush(self, 'git push', ctx);
  assert.equal(reviews, 1); // the same patch is not reviewed twice
  assert.equal(ui.asked.length, 1);
});

test('a review that cannot run does not hold a push; no change or no required review costs no review', async () => {
  for (const [policy, start, delegate, expected] of [
    [{ ...REQUIRE, review: 'require' }, START, async () => { throw Error('managed-helper-unavailable'); }, 1],
    [{ ...REQUIRE, review: 'suggest' }, START, async () => {}, 0],
    [{ ...REQUIRE, review: 'require' }, CODE, async () => {}, 0]]) {
    const ui = terminal(NOW_PUSH), run = newRun('fix', policy), self = managedOf(run, ui), ctx = { hasUI: true, ui };
    run.startDigest = start; let calls = 0; self.patchDigest = async () => 'p'.repeat(64);
    self.delegate = async (...args) => { calls += 1; return delegate(...args); };
    await beforeCheckOrPush(self, 'git push', ctx);
    assert.equal(calls, expected);
  }
});

test('with verify off a push is still reviewed, and asks nothing about tests', async () => {
  const ui = terminal(), run = newRun('fix', { ...REQUIRE, verify: 'off', review: 'require' }), self = managedOf(run, ui), ctx = { hasUI: true, ui };
  run.startDigest = START; let calls = 0; self.patchDigest = async () => 'p'.repeat(64); self.delegate = async () => { calls += 1; };
  await beforeCheckOrPush(self, 'git push', ctx);
  assert.equal(calls, 1); assert.equal(ui.asked.length, 0);
});

test('an approval that ran out of time says so; a refusal is a refusal', () => {
  assert.match(approvalRefusal({ receipt: { state: 'expired', decision: null } }).message, /^managed-operation-expired: .*Nobody refused/);
  assert.match(approvalRefusal({ receipt: { state: 'cancelled', decision: null } }).message, /^managed-operation-cancelled/);
  assert.match(approvalRefusal({ receipt: { state: 'resolved', decision: 'deny' } }).message, /^managed-operation-denied: the member refused/);
  assert.match(approvalRefusal({ receipt: null }).message, /^managed-operation-denied: the command was not approved/);
});

test('findings of a later review are put to the agent too, by their ids', async () => {
  const run = newRun('fix'); const sent = [], io = { note: async () => {}, send: async (text, details) => { sent.push({ text, details }); }, signal: undefined }, managed = { run };
  run.ledger.push({ id: 'o1', source: 'review', role: 'review', kind: 'major', status: 'open', detail: 'first', required: false });
  assert.equal(await settleLedger(managed, run, io), true);
  assert.equal(await settleLedger(managed, run, io), false); // asked once
  run.ledger[0].status = 'accepted';
  run.ledger.push({ id: 'o3', source: 'review', role: 'review', kind: 'major', status: 'open', detail: 'later', required: false });
  assert.equal(await settleLedger(managed, run, io), true);
  assert.deepEqual(sent.map(s => s.details.ids), [['o1'], ['o3']]);
  assert.match(ledgerWords({ ledger: [run.ledger[1]] }), /1 left without a decision \(o3\)/);
});

test('one push question reads the code once: each read starts a sandboxed worker', async () => {
  const ui = terminal(NOW_PUSH), run = newRun(), self = managedOf(run, ui), ctx = { hasUI: true, ui }, digest = self.digest; let reads = 0;
  self.digest = async () => { reads += 1; return digest.call(self); };
  await beforeCheckOrPush(self, 'git push', ctx);
  assert.equal(ui.asked.length, 1); assert.equal(reads, 1);
});

// How much of the suite a test command covers: 'partial' (a filter, one file, one
// package or module), 'suite' (the whole test command) or null when it runs no tests.
// A member who chose "only the related part" is stuck when a part reads as the
// whole suite, so each tool says how its own commands narrow: the flags that pick
// tests, the flags that take a value, and the words that still run everything
// (a Maven goal, `vitest run`). Any other word on the line names a part.

// What a command runs, without the text it merely quotes (a commit message, an
// echo): a quoted word stays one word with nothing in it that splits a command.
export const unquoted = text => text.replace(/"[^"]*"|'[^']*'/g, quoted => quoted.startsWith('"$') ? '$' : quoted.length > 2 ? quoted.slice(1, -1).replace(/[\s;&|<>()]/g, '_') : '""');
export const partsOf = bare => bare.split(/\s*(?:\|\|?|&&|;)\s*/).map(part => part.replace(/\s\d*[<>].*$/, '').replace(/[\s)}]+$/, '').trim());

const VERSION_ONLY = /(?:^|\s)(?:--version|-V|--help)(?:\s|$)/;
// Listing the tests runs none of them.
const LIST_ONLY = /(?:^|\s)(?:--collect-only|--co|--listTests|--list-tests|--list|-list|--dry-run|--dryRun|-showTestPlans)(?=[\s=]|$)/;
const NOT_A_RUN = /^(echo|printf|grep|rg|cat|sed|awk|head|tail|less|git|ls|find)\b/;
const NOT_TESTS = /\b(lint|typecheck|type-check|tsc|eslint|biome|ruff|mypy|pyright|vet|clippy|format|build)\b/;
// What starts a command before the tool itself: a function body, a group, a loop body, env, a runner of binaries.
const LAUNCHER = /^(?:[\w-]+\s*\(\)\s*\{?\s*|\{\s+|\(\s*|(?:do|then|else)\s+|\w+=\S*\s+|env\s+|time\s+|nohup\s+|timeout\s+\S+\s+|npx\s+(?:-\S+\s+)*|bunx\s+|bun\s+x\s+|pnpm\s+(?:exec|dlx)\s+|(?:yarn|pnpm|bun)\s+(?=(?:jest|vitest|mocha|ava|playwright|cypress|nx|turbo|lerna)\b)|uv\s+run\s+|poetry\s+run\s+|pipenv\s+run\s+|hatch\s+run\s+|bundle\s+exec\s+|php\s+(?=\S*(?:phpunit|pest)\b)|node_modules\/\.bin\/|(?:vendor\/)?bin\/|\.\/)+/;

const NONE = /$^/;
// A word that names everything there is: the test folder, every package, a glob, a count.
const ALL_OF_IT = /^(?:\.\/)?(?:tests?|specs?|__tests__|e2e|src)\/?$|^(?:\.\/)?\.\.\.$|\*|^\d+[smh]?$|^auto$/;
// Does this command pick part of the tests? `narrow` flags pick tests (by name before
// `=`), `value` flags take the next word, `whole` words still run everything; any
// other word names a part, unless the tool takes none (`words: false`).
function narrows(args, { narrow = NONE, value = NONE, whole = NONE, words = true }) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // A variable: a function's arguments, a loop's file. The caller chose them, so this is not the whole command.
    if (a.startsWith('$')) return true;
    if (a === '--') continue;
    if (a.startsWith('-')) {
      const name = a.split('=')[0];
      if (narrow.test(name)) return true;
      if (!a.includes('=') && value.test(name)) i++;
      continue;
    }
    if (words && !whole.test(a) && !ALL_OF_IT.test(a)) return true;
  }
  return false;
}

const JS = {
  narrow: /^(?:-t|--testNamePattern|--test-name-pattern|-g|--grep|--fgrep|--testPathPattern|--testPathPatterns|--filter|--spec|--project|--selectProjects|--findRelatedTests|--onlyChanged|-o|--changed|--changedSince|--lastCommit|--only|--test-only|--match|-m)$/,
  value: /^(?:-w|--maxWorkers|--workers|-j|--jobs|--timeout|--reporter|-r|--require|--import|--loader|--config|-c|--rootDir|--root|--outputFile|--coverageDirectory|--test-concurrency|--test-reporter|--test-reporter-destination|--retries|--repeat-each|--env|--browser|--shard|--seed|--slow|--file|--mode|--environment|--pool|--dir)$/,
  whole: /^(?:run|watch|dev|test)$/,
};
const PYTEST = { narrow: /^(?:-k|-m|--lf|--last-failed|--sw|--stepwise|--deselect|--pyargs)$/, value: /^(?:-n|--numprocesses|-c|-p|--maxfail|--rootdir|--durations|-o|--junitxml|--cov|--timeout|--dist|-W|--basetemp|--log-level|--confcutdir|--ignore|--ignore-glob|--tb|-r|--reruns)$/ };
const tool = (start, spec, test = () => true) => ({ start, scope: args => test(args) ? (narrows(args, spec) ? 'partial' : 'suite') : null });

// npm/pnpm/yarn/bun: the workspace or filter before the script, the script, then its own arguments (Jest, Vitest, …).
function packageScript(args) {
  let picked = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^(?:-w|--workspace|--filter|-F)$/.test(a)) { picked = true; i++; continue; }
    if (/^(?:--workspace|--filter)=/.test(a)) { picked = true; continue; }
    if (a.startsWith('-')) continue;
    if (a === 'workspace') { picked = true; i++; continue; }
    // `npm t` is `npm test`; `npm run t` is a script of that name.
    const run = /^(?:run|run-script)$/.test(a), script = run ? args[++i] : a;
    if (!(run ? /^test(?::\S+)?$/ : /^(?:test|t|tst)(?::\S+)?$/).test(script ?? '')) return null;
    // Before `--`, `-w web` is still npm's workspace; a number is Jest's worker count.
    const rest = args.slice(i + 1), end = rest.includes('--') ? rest.indexOf('--') : rest.length;
    picked ||= rest.slice(0, end).some((a, j) => /^--workspace=/.test(a) || (/^(?:-w|--workspace)$/.test(a) && !/^\d+$/.test(rest[j + 1] ?? '0')));
    return picked || narrows(rest, JS) ? 'partial' : 'suite';
  }
  return null;
}
// Maven: every word is a goal; it tests when a goal reaches `test`. The flags pick classes, groups or modules.
function maven(args) {
  if (!args.some(a => /^(?:[\w.-]+:)*(?:test|verify|integration-test)$/.test(a))) return null;
  if (args.some(a => /^-D(?:skipTests|maven\.test\.skip)(?:=true)?$/.test(a))) return null;
  const file = args.findIndex(a => a === '-f' || a === '--file');
  if (file >= 0 && args[file + 1]?.includes('/')) return 'partial';
  return narrows(args, { narrow: /^(?:-Dtest|-Dit\.test|-Dgroups|-Dcucumber\.filter\.tags|-Dcucumber\.options|-pl|--projects|-rf|--resume-from)$/, value: /^(?:-T|--threads|-s|--settings|-gs|--global-settings|-P|--activate-profiles|-l|--log-file|-t|--toolchains|-b|--builder|-f|--file)$/, words: false }) ? 'partial' : 'suite';
}
// Gradle: the words are tasks; `:cart:test` is one module's.
function gradle(args) {
  const value = /^(?:-x|--exclude-task|--max-workers|-I|--init-script|-c|--settings-file|--console|-g|--gradle-user-home)$/;
  const tasks = args.filter((a, i) => !a.startsWith('-') && !value.test(args[i - 1] ?? ''));
  const testTasks = tasks.filter(t => /^(?:test|check|[a-zA-Z]*Test)$/.test(t.split(':').pop()));
  if (!testTasks.length) return null;
  if (testTasks.some(t => /^:?[\w-]+(?::[\w-]+)*:\w+$/.test(t) && t.replace(/^:/, '').includes(':'))) return 'partial';
  return narrows(args, { narrow: /^(?:--tests|-p|--project-dir|-b|--build-file)$/, value, words: false }) ? 'partial' : 'suite';
}
// Go: the words are packages; none is the current one, `./...` is all of them.
function goTest(args) {
  const end = args.indexOf('-args');
  const own = end >= 0 ? args.slice(0, end) : args;
  const spec = { narrow: /^-{1,2}run$/, value: /^-{1,2}(?:p|count|timeout|parallel|cpu|tags|exec|covermode|coverpkg|coverprofile|o|bench|benchtime|shuffle|vet|C|fuzz|fuzztime|skip|json)$/ };
  const packages = own.filter((a, i) => !a.startsWith('-') && !(spec.value.test(own[i - 1] ?? '') && !own[i - 1].includes('=')));
  return !packages.length || narrows(own, spec) ? 'partial' : 'suite';
}
// make: a test target; a variable naming tests narrows it (`make test TEST=./cart`).
function make(args) {
  if (!args.some(a => /^(?:test|check)(?:[-_:]\w+)*$/.test(a))) return null;
  return args.some(a => /^\w*(?:TEST|RUN|FILTER|PKG|SPEC|ONLY|PATTERN|FILE)\w*=/i.test(a) || a.startsWith('$')) ? 'partial' : 'suite';
}
// Nx, Turborepo, Lerna run a target across projects; naming projects or `affected` narrows.
function monorepo(name, args) {
  const words = args.filter(a => !a.startsWith('-'));
  const target = args.find((a, i) => /^(?:-t|--targets?)$/.test(args[i - 1] ?? '')) ?? args.find(a => /^--targets?=/.test(a))?.split('=')[1];
  if (name === 'nx') {
    const [command, project] = words;
    if (command === 'run-many') return /test|e2e/.test(target ?? '') ? (args.some(a => /^(?:-p|--projects)(?:=|$)/.test(a)) ? 'partial' : 'suite') : null;
    if (command === 'affected') return /test|e2e/.test(target ?? words[1] ?? '') ? 'partial' : null;
    if (command === 'run') return /:(?:\w*test|e2e)\w*$/.test(project ?? '') ? 'partial' : null;
    return /test|e2e/.test(command ?? '') ? (project ? 'partial' : 'suite') : null;
  }
  const tasks = words[0] === 'run' ? words.slice(1) : words;
  if (!tasks.some(t => /test|e2e/.test(t))) return null;
  return args.some(a => /^(?:--filter|-F|--scope|--since|--affected)(?:=|$)/.test(a)) ? 'partial' : 'suite';
}

const TOOLS = [
  { start: /^(?:npm|pnpm|yarn|bun)(?=\s|$)/, scope: packageScript },
  tool(/^(?:jest|vitest|mocha|ava|tap|uvu)(?=\s|$)/, JS),
  tool(/^node(?=\s)/, JS, args => args.includes('--test')),
  tool(/^playwright\s+test(?=\s|$)/, JS),
  tool(/^cypress\s+run(?=\s|$)/, JS),
  tool(/^(?:pytest|py\.test|python[\d.]*\s+-m\s+pytest)(?=\s|$)/, PYTEST),
  tool(/^python[\d.]*\s+-m\s+unittest(?=\s|$)/, { narrow: /^(?:-k|-p|--pattern)$/, value: /^(?:-s|--start-directory|-t|--top-level-directory)$/, whole: /^discover$/ }),
  tool(/^python[\d.]*\s+manage\.py\s+test(?=\s|$)/, { narrow: /^(?:-k|--tag)$/, value: /^(?:--parallel|--settings|-v|--verbosity|--exclude-tag|--testrunner)$/ }),
  tool(/^tox(?=\s|$)/, { value: /^(?:-e|-c|--conf|-p|--parallel|-x|--override)$/ }),
  { start: /^go\s+test(?=\s|$)/, scope: goTest },
  tool(/^cargo\s+test(?=\s|$)/, { narrow: /^(?:-p|--package|--test|--lib|--bin|--bins|--example|--examples|--doc|--bench|--manifest-path|--ignored|--exact)$/, value: /^(?:-j|--jobs|--features|-F|--target|--profile|--test-threads|--color|-Z|--target-dir|--message-format|--config|--exclude)$/ }),
  tool(/^cargo\s+nextest\s+run(?=\s|$)/, { narrow: /^(?:-E|--filterset|--filter-expr|-p|--package|--test|--lib|--bin)$/, value: /^(?:-j|--jobs|--profile|--test-threads|--retries|--partition|--features|-F)$/ }),
  { start: /^mvnw?(?=\s|$)/, scope: maven },
  { start: /^gradlew?(?=\s|$)/, scope: gradle },
  tool(/^dotnet\s+test(?=\s|$)/, { narrow: /^--filter$/, value: /^(?:-c|--configuration|-f|--framework|-r|--runtime|-l|--logger|-s|--settings|-v|--verbosity|--results-directory|-a|--test-adapter-path|--collect|-d|--diag|-o|--output|--arch|--os|--blame-hang-timeout|--blame-crash-dump-type|-e|--environment)$/, whole: /\.slnx?$/ }),
  tool(/^swift\s+test(?=\s|$)/, { narrow: /^(?:--filter|--package-path)$/, value: /^(?:-c|--configuration|-j|--jobs|--num-workers|--scratch-path|--skip)$/ }),
  tool(/^xcodebuild(?=\s)/, { narrow: /^-only-testing(?::|$)/, value: /^-(?:scheme|destination|project|workspace|sdk|configuration|derivedDataPath|resultBundlePath|testPlan|skip-testing|parallel-testing-worker-count|xctestrun|target|arch|toolchain|destination-timeout|maximum-parallel-testing-workers|test-iterations|testLanguage|testRegion|only-test-configuration|skip-test-configuration)$/, words: false }, args => args.some(a => /^test(?:-without-building)?$/.test(a))),
  tool(/^rspec(?=\s|$)/, { narrow: /^(?:-t|--tag|-e|--example|-E|--example-matches|--only-failures|--next-failure|-P|--pattern)$/, value: /^(?:-f|--format|-o|--out|--seed|--order|-r|--require|-I|--default-path|-O|--options)$/ }),
  tool(/^(?:rails|rake)\s+test(?::\w+)?(?=\s|$)/, { narrow: /^(?:-n|--name)$/, value: /^(?:--seed|-s|-e|--environment|-j)$/ }),
  tool(/^(?:phpunit|pest|php\s+artisan\s+test)(?=\s|$)/, { narrow: /^(?:--filter|--group|--testsuite)$/, value: /^(?:-c|--configuration|--bootstrap|--log-junit|--exclude-group|--coverage-html|--coverage-clover|--order-by|--cache-directory|--processes|-d)$/ }),
  tool(/^mix\s+test(?=\s|$)/, { narrow: /^(?:--only|--failed|--stale)$/, value: /^(?:--seed|--max-failures|--exclude|--include|--formatter|--partitions|--max-cases)$/ }),
  tool(/^(?:flutter|dart)\s+test(?=\s|$)/, { narrow: /^(?:--name|-n|--plain-name|-N|--tags|-t)$/, value: /^(?:-j|--concurrency|-r|--reporter|-p|--platform|-x|--exclude-tags|--file-reporter|--coverage-path|--flavor|--total-shards|--shard-index)$/ }),
  tool(/^deno\s+test(?=\s|$)/, { narrow: /^--filter$/, value: /^(?:-c|--config|--import-map|--reporter|--seed)$/ }),
  { start: /^make(?=\s)/, scope: make },
  { start: /^(?:nx|turbo|lerna)(?=\s)/, scope: (args, name) => monorepo(name, args) },
];
function testRun(part) {
  const own = part.replace(LAUNCHER, '');
  for (const { start, scope } of TOOLS) {
    const hit = own.match(start);
    if (!hit) continue;
    const result = scope(own.slice(hit[0].length).split(' ').filter(Boolean), hit[0]);
    return result ? { own, result } : null;
  }
  return null;
}

export function checkScope(command, declared = []) {
  const text = String(command ?? '').replace(/\s+/g, ' ').trim();
  if (!text || NOT_A_RUN.test(text) || VERSION_ONLY.test(text) || LIST_ONLY.test(text)) return null;
  const bare = unquoted(text), runs = partsOf(bare).map(testRun).filter(Boolean);
  // A command the repository declares is its whole check, however it is written;
  // a line that also runs a whole suite is a whole run.
  if (runs.length) return declared.includes(text) || runs.some(run => run.result === 'suite') ? 'suite' : 'partial';
  // A script the repository declares: it cannot be narrowed from here.
  const named = declared.find(d => partsOf(bare).some(part => part.startsWith(unquoted(d))));
  return named && !NOT_TESTS.test(named) ? 'suite' : null;
}
// The test step of a command, without what surrounds it: the same step costs the same.
export function suitePart(command) {
  const runs = partsOf(unquoted(String(command ?? '').replace(/\s+/g, ' ').trim())).map(testRun).filter(Boolean);
  return (runs.find(run => run.result === 'suite') ?? runs[0])?.own ?? String(command ?? '').trim();
}

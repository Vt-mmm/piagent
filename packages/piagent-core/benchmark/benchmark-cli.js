import path from "node:path";

import { PIAGENT_BENCHMARK_TREATMENTS } from "./benchmark-runtime.js";

export const benchmarkSurfaces = new Set(["raw-pi", "piagent", "codex-cli"]);
const codexModes = new Set(["controlled", "native"]);
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const benchmarkUsage = `Usage:
  piagent-benchmark [options]
  piagent-benchmark <project-path> --record ...   Legacy recorder
  piagent-benchmark <project-path> --init         Legacy scenario notes

Runs a clean, paired baseline vs Piagent benchmark and grades it automatically.
With no options it uses the built-in core-v1 suite, the current Pi default
model/thinking setting, and the suite's repeat count.

Options:
  --suite <id|path>            core-v1, capability-v1, e2-framework-v1, production-v1, or suite.json path.
  --capability                 Alias for --suite capability-v1.
  --production                 Alias for --suite production-v1.
  --surfaces <a,b>             raw-pi,piagent (default) or piagent,codex-cli.
  --model <provider/model>     Pin one model identity for both surfaces.
  --thinking <level>           off|minimal|low|medium|high|xhigh|max.
  --codex-mode <mode>          controlled isolated home (default) or native user configuration.
  --piagent-treatment <id>     release-defaults, local-safe, mechanical-core, intelligence-engine, causal-phase-enforce, candidate, or feature-off.
  --allow-pi-auth-writeback    Allow same-account OAuth refresh CAS writeback under Pi's auth lock.
  --repeats <1-10>             Override the suite repeat count.
  --infrastructure-retries <n> Retry 0-3 startup failures with zero recorded usage.
  --retry-delay <seconds>      Backoff before infrastructure retry, 0-120 seconds.
  --scenarios <id,id>          Run selected scenario families for diagnosis.
  --seed <value>               Reproduce generated hidden variants.
  --timeout <seconds>          Per-agent timeout, 30-3600 seconds.
  --output <directory>         Report directory; must be empty or absent.
  --keep-workspaces            Retain isolated workspaces and session logs.
  --replay-failures <report>   Re-run failed scenario/repeat pairs from a prior report.
  --resume <run-directory>     Continue an interrupted/paused run with the same seed.
  --max-sessions <n>           Stop cleanly after n new sessions and resume later.
  --max-runtime-minutes <n>    Stop cleanly after the current session once the budget is used.
  --stop-after-failed-pair      Terminal-stop after a Piagent outcome falls below the suite floor.
  --yes                        Skip the cost/run-count confirmation.
  --dry-run                    Validate and print the execution plan only.
  --preflight-only             Freeze assets and verify auth/tools without starting a model.
  --json                       Print final report JSON instead of the table.
  -h, --help                   Show this help.

Outputs report.json, report.html, summary.txt, and runs.jsonl with mode 0600.
No token/result value is entered manually; usage comes from Pi session JSONL
or Codex exec JSONL. Codex CLI comparisons require --model and --thinking.
`;

function fail(message, code = 2) {
  const error = new Error(message);
  error.exitCode = code;
  throw error;
}

function requireValue(argv, index, name) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`Missing value for ${name}`);
  return value;
}

function positiveInteger(raw, name, minimum, maximum) {
  if (!/^\d+$/.test(String(raw ?? ""))) fail(`${name} must be an integer`);
  const value = Number(raw);
  if (value < minimum || value > maximum) fail(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

export function parseBenchmarkArgs(argv) {
  const options = {
    suite: "core-v1",
    surfaces: ["raw-pi", "piagent"],
    model: undefined,
    thinking: undefined,
    codexMode: "controlled",
    piagentTreatment: "release-defaults",
    allowPiAuthWriteback: false,
    seed: undefined,
    repeats: undefined,
    infrastructureRetries: undefined,
    retryDelaySeconds: undefined,
    scenarioIds: undefined,
    timeoutSeconds: undefined,
    output: undefined,
    keepWorkspaces: false,
    replayFailures: undefined,
    replayRuns: undefined,
    replaySource: undefined,
    resume: undefined,
    maxSessions: undefined,
    maxRuntimeMinutes: undefined,
    stopAfterFailedPair: false,
    yes: false,
    dryRun: false,
    preflightOnly: false,
    json: false,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "run":
        break;
      case "--suite":
        options.suite = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--production":
        options.suite = "production-v1";
        break;
      case "--capability":
        options.suite = "capability-v1";
        break;
      case "--surfaces": {
        const values = requireValue(argv, index, arg).split(",").map((value) => value.trim()).filter(Boolean);
        if (values.length !== 2 || new Set(values).size !== 2 || values.some((value) => !benchmarkSurfaces.has(value))) {
          fail("--surfaces must contain two different values from raw-pi, piagent, codex-cli");
        }
        if (!values.includes("piagent") || (!values.includes("raw-pi") && !values.includes("codex-cli"))) {
          fail("--surfaces must compare piagent with raw-pi or codex-cli");
        }
        options.surfaces = values;
        index += 1;
        break;
      }
      case "--model":
        options.model = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--thinking":
        options.thinking = requireValue(argv, index, arg);
        if (!thinkingLevels.has(options.thinking)) fail(`--thinking must be one of ${[...thinkingLevels].join(", ")}`);
        index += 1;
        break;
      case "--codex-mode":
        options.codexMode = requireValue(argv, index, arg);
        if (!codexModes.has(options.codexMode)) fail("--codex-mode must be controlled or native");
        index += 1;
        break;
      case "--piagent-treatment":
        options.piagentTreatment = requireValue(argv, index, arg);
        if (!Object.hasOwn(PIAGENT_BENCHMARK_TREATMENTS, options.piagentTreatment)) {
          fail(`--piagent-treatment must be one of ${Object.keys(PIAGENT_BENCHMARK_TREATMENTS).join(", ")}`);
        }
        index += 1;
        break;
      case "--allow-pi-auth-writeback":
        options.allowPiAuthWriteback = true;
        break;
      case "--repeats":
        options.repeats = positiveInteger(requireValue(argv, index, arg), arg, 1, 10);
        index += 1;
        break;
      case "--infrastructure-retries":
        options.infrastructureRetries = positiveInteger(requireValue(argv, index, arg), arg, 0, 3);
        index += 1;
        break;
      case "--retry-delay":
        options.retryDelaySeconds = positiveInteger(requireValue(argv, index, arg), arg, 0, 120);
        index += 1;
        break;
      case "--scenarios": {
        const values = requireValue(argv, index, arg).split(",").map((value) => value.trim()).filter(Boolean);
        if (values.length === 0 || new Set(values).size !== values.length) fail("--scenarios must contain unique scenario ids");
        options.scenarioIds = values;
        index += 1;
        break;
      }
      case "--seed":
        options.seed = requireValue(argv, index, arg);
        if (options.seed.length > 200) fail("--seed must contain at most 200 characters");
        index += 1;
        break;
      case "--timeout":
        options.timeoutSeconds = positiveInteger(requireValue(argv, index, arg), arg, 30, 3600);
        index += 1;
        break;
      case "--output":
        options.output = path.resolve(requireValue(argv, index, arg));
        index += 1;
        break;
      case "--keep-workspaces":
        options.keepWorkspaces = true;
        break;
      case "--replay-failures":
        options.replayFailures = path.resolve(requireValue(argv, index, arg));
        index += 1;
        break;
      case "--resume":
        options.resume = path.resolve(requireValue(argv, index, arg));
        index += 1;
        break;
      case "--max-sessions":
        options.maxSessions = positiveInteger(requireValue(argv, index, arg), arg, 1, 10_000);
        index += 1;
        break;
      case "--max-runtime-minutes":
        options.maxRuntimeMinutes = positiveInteger(requireValue(argv, index, arg), arg, 1, 24 * 60);
        index += 1;
        break;
      case "--stop-after-failed-pair":
        options.stopAfterFailedPair = true;
        break;
      case "--yes":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--preflight-only":
        options.preflightOnly = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        options.help = true;
        break;
      default:
        fail(`Unknown benchmark option: ${arg}`);
    }
  }
  if (options.dryRun && options.preflightOnly) fail("--dry-run and --preflight-only are mutually exclusive");
  if (options.preflightOnly && (options.resume || options.replayFailures)) fail("--preflight-only cannot resume or replay a prior run");
  return options;
}

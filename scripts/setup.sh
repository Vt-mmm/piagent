#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/setup.sh [project-path] [options]

Default behavior:
  - install the platform package globally into Pi;
  - initialize the target project with .pi settings/profile;
  - run the team doctor.

If project-path is omitted:
  - from a normal project directory: initialize the current directory;
  - from the platform repo itself: global install only.

Options:
  --profile <name-or-json>       auto | generic | web-frontend | backend-api | be-readonly-fe | fullstack | node-typescript | python | data | devops | mobile | docs | path/to/profile.json
  --package-source <source>      Portable Pi package source committed into project .pi/settings.json
  --global-only                  Only install global Pi package
  --project-only, --no-global    Only initialize project, skip global install
  --no-project                   Skip project initialization
  --with-mcp / --no-mcp          Install/skip Pi MCP adapter during global install (default: install)
  --mcp-preset <minimal|core|popular|all|docs|browser|github|design|design-local|web>
                                  Configure shared global MCP baseline when --with-mcp is enabled (default: core)
  --with-subagents / --no-subagents
                                  Install/skip pi-subagents during global install (default: install)
  --subagents-preset <minimal|safe|async|parallel>
                                  Configure pi-subagents runtime baseline (default: safe)
  --subagents-model-scope <none|piagent|codex|claude>   model family for subagents
                                  Optional subagent model allowlist (default: none)
  --with-web-access               Install pi-web-access for builtin `researcher` subagent (default: skip)
  --with-herdr / --no-herdr      Install/skip Herdr Pi integration if herdr exists (default: install)
  --model-scope <full|codex|claude>   model families to enable
                                  Configure Pi enabledModels for selector/cycling (default: full)
  --default-model <provider/model[:thinking]>
                                  Configure default provider/model/thinking (default: openai-codex/gpt-5.5:xhigh)
  --no-model-scope               Skip global model-scope configuration
  --install-pi / --no-install-pi Install/skip Pi CLI with npm if `pi` is missing (default: install)
  --force-profile                Replace existing project .pi/piagent-profile.json
  --force-settings               Replace existing project .pi/settings.json
  --force                        Replace both profile and settings
  --skip-agents                  Do not create AGENTS.md
  --skip-review-guidelines       Do not create REVIEW_GUIDELINES.md
  --dry-run                      Print commands without executing
  -h, --help

Package source examples:
  # Moving latest for a personal machine or sandbox only:
  pi install git:github.com/Vt-mmm/piagent

  # Exact sources for .pi/settings.json and capability lock:
  git:github.com/Vt-mmm/piagent@vX.Y.Z
  https://github.com/Vt-mmm/piagent/archive/refs/tags/vX.Y.Z.tar.gz
  npm:@your-scope/platform@x.y.z
  /absolute/path/to/piagent

One-command team setup example:
  bash /path/to/piagent/scripts/setup.sh . --profile auto --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z
USAGE
}

PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH=""
PROFILE_INPUT="auto"
PACKAGE_SOURCE="${PIAGENT_PACKAGE_SOURCE:-}"
DO_GLOBAL=true
DO_PROJECT=true
WITH_MCP=true
MCP_PRESET="core"
MCP_PRESET_EXPLICIT=false
WITH_SUBAGENTS=true
SUBAGENTS_PRESET="safe"
SUBAGENTS_MODEL_SCOPE="none"
WITH_WEB_ACCESS=false
WITH_HERDR=true
CONFIGURE_MODEL_SCOPE=true
MODEL_SCOPE_PRESET="full"
DEFAULT_MODEL="openai-codex/gpt-5.5:xhigh"
AUTO_INSTALL_PI=true
FORCE_PROFILE=false
FORCE_SETTINGS=false
SKIP_AGENTS=false
SKIP_REVIEW=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --profile" >&2
        exit 2
      fi
      PROFILE_INPUT="$2"
      shift 2
      ;;
    --package-source)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --package-source" >&2
        exit 2
      fi
      PACKAGE_SOURCE="$2"
      shift 2
      ;;
    --global-only)
      DO_PROJECT=false
      shift
      ;;
    --project-only|--no-global)
      DO_GLOBAL=false
      shift
      ;;
    --no-project)
      DO_PROJECT=false
      shift
      ;;
    --with-mcp)
      WITH_MCP=true
      shift
      ;;
    --no-mcp)
      WITH_MCP=false
      shift
      ;;
    --mcp-preset)
      MCP_PRESET="${2:-}"
      MCP_PRESET_EXPLICIT=true
      shift 2
      ;;
    --with-subagents)
      WITH_SUBAGENTS=true
      shift
      ;;
    --no-subagents)
      WITH_SUBAGENTS=false
      shift
      ;;
    --subagents-preset)
      SUBAGENTS_PRESET="${2:-}"
      shift 2
      ;;
    --subagents-model-scope)
      SUBAGENTS_MODEL_SCOPE="${2:-}"
      shift 2
      ;;
    --with-web-access)
      WITH_WEB_ACCESS=true
      shift
      ;;
    --with-herdr)
      WITH_HERDR=true
      shift
      ;;
    --no-herdr)
      WITH_HERDR=false
      shift
      ;;
    --model-scope)
      MODEL_SCOPE_PRESET="${2:-}"
      shift 2
      ;;
    --default-model)
      DEFAULT_MODEL="${2:-}"
      shift 2
      ;;
    --no-model-scope)
      CONFIGURE_MODEL_SCOPE=false
      shift
      ;;
    --install-pi)
      AUTO_INSTALL_PI=true
      shift
      ;;
    --no-install-pi)
      AUTO_INSTALL_PI=false
      shift
      ;;
    --force-profile)
      FORCE_PROFILE=true
      shift
      ;;
    --force-settings)
      FORCE_SETTINGS=true
      shift
      ;;
    --force)
      FORCE_PROFILE=true
      FORCE_SETTINGS=true
      shift
      ;;
    --skip-agents)
      SKIP_AGENTS=true
      shift
      ;;
    --skip-review-guidelines)
      SKIP_REVIEW=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$PROJECT_PATH" ]]; then
        PROJECT_PATH="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

# setup never forwards --mcp-preset alongside --no-mcp, so the installer's own
# check for that pair never sees it and the preset was accepted and dropped in
# silence. The contradiction is rejected here, whatever the install mode.
if [[ "$WITH_MCP" == false && "$MCP_PRESET_EXPLICIT" == true ]]; then
  echo "FAIL: --mcp-preset has no effect with --no-mcp. Drop one of them." >&2
  exit 2
fi

resolve_package_source() {
  if [[ -n "$PACKAGE_SOURCE" ]]; then
    printf '%s\n' "$PACKAGE_SOURCE"
    return
  fi

  if [[ "$DO_PROJECT" == true && -n "$PROJECT_PATH" && -f "$PROJECT_PATH/.pi/settings.json" ]]; then
    local existing_source
    existing_source="$(node --input-type=module - "$PROJECT_PATH/.pi/settings.json" <<'NODE'
import fs from "node:fs";
const settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const source = Array.isArray(settings.packages)
  ? settings.packages.find((item) => typeof item === "string" && item.length > 0)
  : undefined;
if (source) process.stdout.write(source);
NODE
)"
    if [[ -n "$existing_source" ]]; then
      printf '%s\n' "$existing_source"
      return
    fi
  fi

  # Running from an installed package rather than a checkout. The name and
  # version on disk are exactly what a teammate resolves from the registry, so
  # they are a portable source; the install path is not, and project settings
  # are meant to be committed.
  if [[ "$PLATFORM_ROOT" == */node_modules/* ]]; then
    local installed_name installed_version
    installed_name="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).name ?? "");' "$PLATFORM_ROOT/package.json")"
    installed_version="$(node -e 'const fs=require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version ?? "");' "$PLATFORM_ROOT/package.json")"
    if [[ -n "$installed_name" && "$installed_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
      printf 'npm:%s@%s\n' "$installed_name" "$installed_version"
      return
    fi
  fi

  echo "WARN: No exact package source provided." >&2
  echo "WARN: using local platform path; do not commit project .pi/settings.json with this value for team rollout." >&2
  printf '%s\n' "$PLATFORM_ROOT"
}

print_cmd() {
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

run_cmd() {
  print_cmd "$@"
  if [[ "$DRY_RUN" == false ]]; then
    "$@"
  fi
}

require_node_version() {
  if ! command -v node >/dev/null 2>&1; then
    echo "FAIL: Node.js >=22.19.0 is required." >&2
    exit 1
  fi
  local node_version
  node_version="$(node -p 'process.versions.node' 2>/dev/null || true)"
  if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && (minor > 19 || (minor === 19 && patch >= 0))) ? 0 : 1);'; then
    echo "FAIL: Node.js >=22.19.0 is required; found ${node_version:-unknown}." >&2
    exit 1
  fi
}

ensure_pi_cli() {
  local expected_pi_version current_output current_version=""
  expected_pi_version="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.peerDependencies?.["@earendil-works/pi-coding-agent"] ?? "");' "$PLATFORM_ROOT/package.json")"
  if [[ ! "$expected_pi_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
    echo "FAIL: package.json must pin an exact Pi Coding Agent version." >&2
    exit 1
  fi

  if command -v pi >/dev/null 2>&1; then
    current_output="$(pi --version 2>/dev/null || true)"
    if [[ "$current_output" =~ ([0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?) ]]; then
      current_version="${BASH_REMATCH[1]}"
    fi
    if [[ "$current_version" == "$expected_pi_version" ]]; then
      return
    fi
    if [[ "$AUTO_INSTALL_PI" == false ]]; then
      echo "FAIL: Pi Coding Agent $expected_pi_version is required; found ${current_version:-${current_output:-unknown}}. Remove --no-install-pi or upgrade it manually." >&2
      exit 1
    fi
    echo "Pi CLI ${current_version:-unknown} is not supported; installing exact host $expected_pi_version:"
  elif [[ "$AUTO_INSTALL_PI" == false ]]; then
    echo "FAIL: pi is not on PATH. Rerun without --no-install-pi or install Pi manually." >&2
    exit 1
  else
    echo "Pi CLI not found; installing exact host $expected_pi_version:"
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "FAIL: npm is required to install Pi Coding Agent $expected_pi_version." >&2
    echo "Install Node.js >=22.19.0 with npm, then rerun setup." >&2
    exit 1
  fi

  run_cmd npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$expected_pi_version"
  if [[ "$DRY_RUN" == false ]]; then
    hash -r
    current_output="$(pi --version 2>/dev/null || true)"
    current_version=""
    if [[ "$current_output" =~ ([0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?) ]]; then
      current_version="${BASH_REMATCH[1]}"
    fi
    if [[ "$current_version" != "$expected_pi_version" ]]; then
      echo "FAIL: Pi Coding Agent upgrade did not activate version $expected_pi_version; found ${current_version:-${current_output:-unknown}}." >&2
      exit 1
    fi
  fi
}

require_node_version

if [[ -z "$PROJECT_PATH" && "$DO_PROJECT" == true ]]; then
  if [[ "$(pwd)" == "$PLATFORM_ROOT" ]]; then
    DO_PROJECT=false
  else
    PROJECT_PATH="$(pwd)"
  fi
fi

if [[ "$DO_PROJECT" == true ]]; then
  if [[ -z "$PROJECT_PATH" ]]; then
    echo "FAIL: project path is required when project initialization is enabled." >&2
    exit 2
  fi
  if [[ ! -d "$PROJECT_PATH" ]]; then
    echo "FAIL: project path does not exist: $PROJECT_PATH" >&2
    exit 1
  fi
  PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
fi

PACKAGE_SOURCE="$(resolve_package_source)"

echo "Pi Agent Platform setup"
echo "  platform: $PLATFORM_ROOT"
echo "  packageSource: $PACKAGE_SOURCE"
echo "  globalInstall: $DO_GLOBAL"
echo "  projectInit: $DO_PROJECT"
if [[ "$DO_PROJECT" == true ]]; then
  echo "  project: $PROJECT_PATH"
  echo "  profile: $PROFILE_INPUT"
fi
echo

if [[ "$DO_GLOBAL" == true ]]; then
  ensure_pi_cli
  install_args=("$PLATFORM_ROOT/scripts/install-global.sh" "--package-source" "$PACKAGE_SOURCE")
  # The opt-out has to be passed explicitly. The installer defaults MCP on, so
  # saying nothing here would install it against the operator's choice; the
  # flags below can stay one-sided only because the installer defaults them off.
  #
  if [[ "$WITH_MCP" == true ]]; then
    install_args+=("--with-mcp" "--mcp-preset" "$MCP_PRESET")
  else
    install_args+=("--no-mcp")
  fi
  if [[ "$WITH_SUBAGENTS" == true ]]; then
    install_args+=("--with-subagents" "--subagents-preset" "$SUBAGENTS_PRESET" "--subagents-model-scope" "$SUBAGENTS_MODEL_SCOPE")
  fi
  if [[ "$WITH_WEB_ACCESS" == true ]]; then
    install_args+=("--with-web-access")
  fi
  if [[ "$WITH_HERDR" == true ]]; then
    install_args+=("--with-herdr")
  fi
  if [[ "$CONFIGURE_MODEL_SCOPE" == true ]]; then
    install_args+=("--model-scope" "$MODEL_SCOPE_PRESET" "--default-model" "$DEFAULT_MODEL")
  else
    install_args+=("--no-model-scope")
  fi
  run_cmd bash "${install_args[@]}"
fi

if [[ "$DO_PROJECT" == true ]]; then
  init_args=("$PLATFORM_ROOT/scripts/init-project.sh" "$PROJECT_PATH" "--profile" "$PROFILE_INPUT" "--package-source" "$PACKAGE_SOURCE")
  if [[ "$FORCE_PROFILE" == true ]]; then
    init_args+=("--force-profile")
  fi
  if [[ "$FORCE_SETTINGS" == true ]]; then
    init_args+=("--force-settings")
  fi
  if [[ "$SKIP_AGENTS" == true ]]; then
    init_args+=("--skip-agents")
  fi
  if [[ "$SKIP_REVIEW" == true ]]; then
    init_args+=("--skip-review-guidelines")
  fi
  run_cmd bash "${init_args[@]}"
  run_cmd bash "$PLATFORM_ROOT/scripts/team-doctor.sh" "$PROJECT_PATH" --strict-share
fi

echo
echo "Next:"
if [[ "$DO_PROJECT" == true ]]; then
  echo "  cd \"$PROJECT_PATH\""
fi
echo "  pi"
echo "  /login             # first time only"
if [[ "$DO_PROJECT" == true ]]; then
  echo "  /model             # or Ctrl+L: select provider/model from Pi selector"
  echo "  /scoped-models     # optional: edit Ctrl+P model cycle scope"
  echo "  /mcp               # inspect MCP servers; run /mcp setup for guided changes"
  echo "  /subagents-doctor  # inspect subagent setup"
  echo "  /onboard-project   # first project-read snapshot before implementation"
  echo "  /memory-policy     # inspect project memory policy when needed"
fi
echo
echo "Daily flow after setup:"
echo "  herdr    # optional"
echo "  cd <project>"
echo "  pi"
echo "  /task Implement <task>  # parent may auto-delegate scout/planner/reviewer"

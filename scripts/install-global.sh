#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-global.sh [--stable|--dev|--local|--channel <stable|dev|local>] [--version <tag>] [--resolve-tag] [--package-source <source>] [--dry-run] [--with-mcp|--no-mcp] [--mcp-preset <preset>] [--with-subagents] [--subagents-preset <preset>] [--with-web-access] [--with-herdr] [--model-scope <preset>]

Purpose:
  Install the piagent Pi package into the current user's global Pi settings.

Package source examples:
  # Recommended stable install: exact current release tag
  scripts/install-global.sh --stable
  # Installs the stable tag after resolving it to a commit SHA.

  # Pin a specific release:
  scripts/install-global.sh --version v1.1.7 --resolve-tag

  # Preview the planned install/update without changing user config:
  scripts/install-global.sh --stable --dry-run

  # Exact sources for reviewed/team rollout:
  git:github.com/Vt-mmm/piagent@vX.Y.Z
  https://github.com/Vt-mmm/piagent/archive/refs/tags/vX.Y.Z.tar.gz
  npm:@your-scope/platform@x.y.z
  /absolute/path/to/piagent

  # Personal/sandbox moving source:
  scripts/install-global.sh --dev

Notes:
  - `currentRelease` in output is the version of the terminal helper executing this command.
  - Use exactly one package selector. The first CLI selector overrides environment defaults; a second selector fails closed.
  - OAuth is intentionally not automated. Run `pi` then `/login`.
  - Model scope is configured with Pi's native `enabledModels` so users choose via `/model`, Ctrl+L, `/scoped-models`, and Ctrl+P.
  - Herdr integration is optional and modifies user-level Herdr/Pi config.
  - MCP is installed by default with the core preset: Context7 docs, Chrome DevTools, GitHub.
    Skip it with --no-mcp. Writing the config does not start or authenticate anything:
    the GitHub server additionally needs Docker running and GITHUB_PERSONAL_ACCESS_TOKEN
    exported, and Chrome DevTools needs a local Chrome.
  - Subagents preset defaults to safe: compact tool description, bounded concurrency/depth.
  - Web access is optional. Install it only when you want the builtin `researcher` subagent to browse/fetch web sources inside Pi.
USAGE
}

PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CURRENT_RELEASE_TAG=""
EXPECTED_PI_VERSION=""
EXPECTED_RELEASE_COMMIT="${PIAGENT_EXPECTED_RELEASE_COMMIT:-}"
DEFAULT_REPO_SOURCE="git:github.com/Vt-mmm/piagent"
DEFAULT_REPO_REMOTE_URL="https://github.com/Vt-mmm/piagent.git"
PACKAGE_SOURCE="${PIAGENT_PACKAGE_SOURCE:-}"
PACKAGE_VERSION="${PIAGENT_PACKAGE_VERSION:-}"
RELEASE_CHANNEL="${PIAGENT_RELEASE_CHANNEL:-}"
WITH_MCP=true
MCP_PRESET="core"
MCP_PRESET_EXPLICIT=false
WITH_SUBAGENTS=false
SUBAGENTS_PRESET="safe"
SUBAGENTS_MODEL_SCOPE="none"
WITH_WEB_ACCESS=false
WITH_HERDR=false
CONFIGURE_MODEL_SCOPE=true
MODEL_SCOPE_PRESET="full"
DEFAULT_MODEL="openai-codex/gpt-5.5:xhigh"
DRY_RUN=false
FLOATING_PACKAGE_SOURCE=false
RESOLVED_CHANNEL_LABEL="custom"
RESOLVE_TAG=false
RESOLVED_PACKAGE_TAG=""
RESOLVED_PACKAGE_COMMIT=""
CLI_PACKAGE_SELECTOR=""
PI_MCP_ADAPTER_SOURCE="npm:pi-mcp-adapter@2.11.0"
PI_SUBAGENTS_SOURCE="npm:pi-subagents@0.35.1"
PI_WEB_ACCESS_SOURCE="npm:pi-web-access@0.13.0"
PI_MCP_ADAPTER_INTEGRITY="sha512-4Y/eLbhbxnRih519dJUxMyQ5QASvPcdWyBlS8+dDXteAzaMuLnd4nMTWgoZw3JRIW+0r93KAQcz1Rbli4xCwEQ=="
PI_SUBAGENTS_INTEGRITY="sha512-nIH6liO541FZ1RoeEu58Ligd59tiNw0/ODPgHh7uvx9Dk4UpWH08F84/l1+hXCzUgC85OCmyVtngWkZjcK94Cg=="
PI_WEB_ACCESS_INTEGRITY="sha512-ny0bHisMWdobmu1hcMp/jqjaRh6pYrH7dctBK2CVyRF4ia7bP47RnOPYdG1yiks9ohtcanWir5Hl9EFap8h0zQ=="

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "Missing value for $option" >&2
    exit 2
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

detect_runtime_surface() {
  local os_name arch_name
  os_name="$(uname -s 2>/dev/null || echo unknown)"
  arch_name="$(uname -m 2>/dev/null || echo unknown)"

  if [[ "$os_name" == "Linux" && -r /proc/version ]] && grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then
    printf 'wsl2/%s (experimental; not release-gated)' "$arch_name"
    return
  fi

  case "${os_name}:${arch_name}" in
    Darwin:arm64)
      printf 'macos-apple-silicon/darwin-arm64 (verified)'
      ;;
    Darwin:x86_64)
      printf 'macos-intel/darwin-x64 (supported target; run smoke before team rollout)'
      ;;
    Linux:x86_64|Linux:amd64)
      printf 'linux-x64 (verified in CI)'
      ;;
    Linux:aarch64|Linux:arm64)
      printf 'linux-arm64 (supported target; run smoke before team rollout)'
      ;;
    MINGW*|MSYS*|CYGWIN*)
      printf 'native-windows/%s (not release-gated; terminal helpers require Bash semantics)' "$arch_name"
      ;;
    *)
      printf '%s/%s (outside v1.1.7 release matrix)' "$os_name" "$arch_name"
      ;;
  esac
}

warn_runtime_surface_if_needed() {
  local surface="$1"
  case "$surface" in
    *"supported target"*|*"experimental"*|*"not release-gated"*|*"outside v1.1.7 release matrix"*)
      echo "WARN: runtime surface is $surface." >&2
      echo "WARN: For team rollout, run piagent-doctor plus the project smoke/verify suite on this machine before relying on it." >&2
      ;;
  esac
}

claim_cli_package_selector() {
  local option="$1"
  if [[ -n "$CLI_PACKAGE_SELECTOR" ]]; then
    echo "FAIL: only one CLI package selector is allowed; received $CLI_PACKAGE_SELECTOR before $option." >&2
    exit 2
  fi

  CLI_PACKAGE_SELECTOR="$option"
  # Environment values are defaults. The first explicit CLI selector replaces
  # all of them; any later CLI selector is rejected above.
  PACKAGE_SOURCE=""
  PACKAGE_VERSION=""
  RELEASE_CHANNEL=""
}

case "${PIAGENT_DRY_RUN:-}" in
  1|true|TRUE|yes|YES)
    DRY_RUN=true
    ;;
esac

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

verify_npm_integrity() {
  local source="$1"
  local expected="$2"
  local package_spec="${source#npm:}"
  if ! command -v npm >/dev/null 2>&1; then
    echo "FAIL: npm is required to verify package integrity for $package_spec." >&2
    exit 1
  fi
  local actual
  actual="$(npm view "$package_spec" dist.integrity 2>/dev/null | tr -d '\r\n')"
  if [[ -z "$actual" || "$actual" != "$expected" ]]; then
    echo "FAIL: registry integrity does not match the approved digest for $package_spec." >&2
    exit 1
  fi
}

resolve_git_tag_commit() {
  local tag="$1"
  if [[ -z "$tag" ]]; then
    echo "FAIL: tag is required for release resolution." >&2
    exit 2
  fi
  if [[ "$tag" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "FAIL: --resolve-tag expects a tag, not a commit SHA: $tag" >&2
    exit 2
  fi
  if [[ "$tag" == *".."* || "$tag" == *"~"* || "$tag" == *"^"* || "$tag" == *":"* || "$tag" == *" "* ]]; then
    echo "FAIL: unsupported tag syntax for release resolution: $tag" >&2
    exit 2
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "FAIL: git is required to resolve release tag $tag to a commit SHA." >&2
    exit 1
  fi

  local refs commit=""
  refs="$(git ls-remote --tags "$DEFAULT_REPO_REMOTE_URL" "refs/tags/${tag}" "refs/tags/${tag}^{}" 2>/dev/null || true)"
  if [[ -z "$refs" ]]; then
    echo "FAIL: could not resolve release tag $tag from $DEFAULT_REPO_REMOTE_URL." >&2
    exit 1
  fi

  commit="$(printf '%s\n' "$refs" | awk -v exact="refs/tags/${tag}^{}" '$2 == exact { print $1; exit }')"
  if [[ -z "$commit" ]]; then
    commit="$(printf '%s\n' "$refs" | awk -v exact="refs/tags/${tag}" '$2 == exact { print $1; exit }')"
  fi
  if [[ ! "$commit" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "FAIL: release tag $tag did not resolve to a valid commit SHA." >&2
    exit 1
  fi

  printf '%s\n' "$commit"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --package-source)
      require_value "$1" "${2:-}"
      claim_cli_package_selector "$1"
      PACKAGE_SOURCE="$2"
      shift 2
      ;;
    --channel)
      require_value "$1" "${2:-}"
      claim_cli_package_selector "$1"
      RELEASE_CHANNEL="$2"
      shift 2
      ;;
    --stable)
      claim_cli_package_selector "$1"
      RELEASE_CHANNEL="stable"
      shift
      ;;
    --dev)
      claim_cli_package_selector "$1"
      RELEASE_CHANNEL="dev"
      shift
      ;;
    --local)
      claim_cli_package_selector "$1"
      RELEASE_CHANNEL="local"
      shift
      ;;
    --version|--tag)
      require_value "$1" "${2:-}"
      claim_cli_package_selector "$1"
      PACKAGE_VERSION="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --resolve-tag)
      RESOLVE_TAG=true
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
      require_value "$1" "${2:-}"
      MCP_PRESET="$2"
      MCP_PRESET_EXPLICIT=true
      shift 2
      ;;
    --with-subagents)
      WITH_SUBAGENTS=true
      shift
      ;;
    --subagents-preset)
      require_value "$1" "${2:-}"
      SUBAGENTS_PRESET="$2"
      shift 2
      ;;
    --subagents-model-scope)
      require_value "$1" "${2:-}"
      SUBAGENTS_MODEL_SCOPE="$2"
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
    --model-scope)
      require_value "$1" "${2:-}"
      MODEL_SCOPE_PRESET="$2"
      shift 2
      ;;
    --default-model)
      require_value "$1" "${2:-}"
      DEFAULT_MODEL="$2"
      shift 2
      ;;
    --no-model-scope)
      CONFIGURE_MODEL_SCOPE=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# A preset chosen alongside --no-mcp used to be accepted and then quietly
# dropped, which reads as "the preset was applied".
if [[ "$WITH_MCP" == false && "$MCP_PRESET_EXPLICIT" == true ]]; then
  echo "FAIL: --mcp-preset has no effect with --no-mcp. Drop one of them." >&2
  exit 2
fi

require_node_version

# The preset is only read at the very last step, after the platform package and
# the MCP adapter are already installed. A name with a typo therefore failed
# after two installs had landed, leaving a half-configured machine, and the
# dry-run still exited 0 because it never reached the check. Validating here
# costs one process and makes a bad preset cost nothing. It has to come after the
# Node check, not before: the validator is a Node script, so on a machine without
# Node it reported a missing interpreter as a bad preset.
if [[ "$WITH_MCP" == true ]]; then
  if ! bash "$PLATFORM_ROOT/scripts/configure-mcp.sh" --scope global --preset "$MCP_PRESET" --validate-preset >/dev/null; then
    echo "Nothing was installed." >&2
    exit 2
  fi
fi

CURRENT_RUNTIME_SURFACE="$(detect_runtime_surface)"
warn_runtime_surface_if_needed "$CURRENT_RUNTIME_SURFACE"
CURRENT_RELEASE_TAG="$(node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(`v${p.version}`);' "$PLATFORM_ROOT/package.json")"
EXPECTED_PI_VERSION="$(node -e 'const fs = require("node:fs"); const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.peerDependencies?.["@earendil-works/pi-coding-agent"] ?? "");' "$PLATFORM_ROOT/package.json")"
if [[ ! "$EXPECTED_PI_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
  echo "FAIL: package.json must pin an exact Pi Coding Agent version." >&2
  exit 1
fi

resolve_package_source() {
  if [[ -n "$PACKAGE_SOURCE" ]]; then
    if [[ -n "$RELEASE_CHANNEL" || -n "$PACKAGE_VERSION" ]]; then
      echo "FAIL: use either --package-source or --channel/--version, not both." >&2
      exit 2
    fi
    if [[ "$RESOLVE_TAG" == true ]]; then
      echo "FAIL: --resolve-tag only works with --stable or --version <tag>." >&2
      exit 2
    fi
    RESOLVED_CHANNEL_LABEL="custom"
    return
  fi

  if [[ -n "$RELEASE_CHANNEL" && -n "$PACKAGE_VERSION" ]]; then
    echo "FAIL: use either --channel or --version, not both." >&2
    exit 2
  fi

  if [[ -n "$PACKAGE_VERSION" ]]; then
    if [[ "$RESOLVE_TAG" == true ]]; then
      RESOLVED_PACKAGE_TAG="$PACKAGE_VERSION"
      RESOLVED_PACKAGE_COMMIT="$(resolve_git_tag_commit "$PACKAGE_VERSION")"
      PACKAGE_SOURCE="${DEFAULT_REPO_SOURCE}@${RESOLVED_PACKAGE_COMMIT}"
    else
      PACKAGE_SOURCE="${DEFAULT_REPO_SOURCE}@${PACKAGE_VERSION}"
    fi
    RESOLVED_CHANNEL_LABEL="exact"
    return
  fi

  case "$RELEASE_CHANNEL" in
    stable)
      RESOLVED_PACKAGE_TAG="$CURRENT_RELEASE_TAG"
      RESOLVED_PACKAGE_COMMIT="$(resolve_git_tag_commit "$CURRENT_RELEASE_TAG")"
      PACKAGE_SOURCE="${DEFAULT_REPO_SOURCE}@${RESOLVED_PACKAGE_COMMIT}"
      RESOLVED_CHANNEL_LABEL="stable"
      ;;
    dev|latest)
      if [[ "$RESOLVE_TAG" == true ]]; then
        echo "FAIL: --resolve-tag cannot be used with the floating dev/latest channel." >&2
        exit 2
      fi
      PACKAGE_SOURCE="$DEFAULT_REPO_SOURCE"
      FLOATING_PACKAGE_SOURCE=true
      RESOLVED_CHANNEL_LABEL="dev"
      ;;
    local)
      if [[ "$RESOLVE_TAG" == true ]]; then
        echo "FAIL: --resolve-tag cannot be used with the local channel." >&2
        exit 2
      fi
      PACKAGE_SOURCE="$PLATFORM_ROOT"
      RESOLVED_CHANNEL_LABEL="local"
      ;;
    "")
      if [[ "$RESOLVE_TAG" == true ]]; then
        echo "FAIL: --resolve-tag requires --stable or --version <tag>." >&2
        exit 2
      fi
      PACKAGE_SOURCE="$PLATFORM_ROOT"
      RESOLVED_CHANNEL_LABEL="local"
      echo "WARN: No exact package source provided. Installing from local path." >&2
      echo "WARN: For team rollout, pass --stable, --version vX.Y.Z, or --package-source git:github.com/Vt-mmm/piagent@TAG." >&2
      ;;
    *)
      echo "FAIL: unsupported release channel: $RELEASE_CHANNEL" >&2
      echo "Expected: stable, dev, or local." >&2
      exit 2
      ;;
  esac
}

resolve_package_source

if [[ -n "$EXPECTED_RELEASE_COMMIT" ]]; then
  if [[ ! "$EXPECTED_RELEASE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "FAIL: PIAGENT_EXPECTED_RELEASE_COMMIT must be a 40-character commit SHA." >&2
    exit 2
  fi
  normalized_resolved_commit="$(printf '%s' "$RESOLVED_PACKAGE_COMMIT" | tr '[:upper:]' '[:lower:]')"
  normalized_expected_commit="$(printf '%s' "$EXPECTED_RELEASE_COMMIT" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$RESOLVED_PACKAGE_COMMIT" || "$normalized_resolved_commit" != "$normalized_expected_commit" ]]; then
    echo "FAIL: resolved commit does not match the required release commit." >&2
    exit 1
  fi
fi

if [[ "$FLOATING_PACKAGE_SOURCE" == true ]]; then
  echo "WARN: Installing a floating dev/latest source. Use only for personal machines or sandbox testing." >&2
else
  node "$PLATFORM_ROOT/scripts/capability-catalog.mjs" validate-source --package-source "$PACKAGE_SOURCE" >/dev/null
fi

if ! command -v pi >/dev/null 2>&1; then
  if [[ "$DRY_RUN" == true ]]; then
    echo "DRY RUN: pi is not on PATH; install would require Pi CLI first." >&2
  else
  echo "FAIL: pi is not on PATH." >&2
  echo "Install Pi first, then rerun this script." >&2
    echo "Expected command on npm-based installs: npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.82.0" >&2
  exit 1
  fi
else
  pi_version_output="$(pi --version 2>/dev/null || true)"
  current_pi_version=""
  if [[ "$pi_version_output" =~ ([0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?) ]]; then
    current_pi_version="${BASH_REMATCH[1]}"
  fi
  if [[ "$current_pi_version" != "$EXPECTED_PI_VERSION" ]]; then
    echo "FAIL: Pi Coding Agent $EXPECTED_PI_VERSION is required; found ${current_pi_version:-${pi_version_output:-unknown}}." >&2
    echo "Install the supported host with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent@$EXPECTED_PI_VERSION" >&2
    exit 1
  fi
fi

echo "Installing Pi Agent Platform package:"
echo "  channel: $RESOLVED_CHANNEL_LABEL"
echo "  currentRelease: $CURRENT_RELEASE_TAG (helper package version)"
echo "  runtime: $CURRENT_RUNTIME_SURFACE"
if [[ -n "$RESOLVED_PACKAGE_TAG" ]]; then
  echo "  tag: $RESOLVED_PACKAGE_TAG"
fi
if [[ -n "$RESOLVED_PACKAGE_COMMIT" ]]; then
  echo "  resolvedCommit: $RESOLVED_PACKAGE_COMMIT"
fi
echo "  source: $PACKAGE_SOURCE"
run_cmd pi install "$PACKAGE_SOURCE"

if [[ "$WITH_MCP" == true ]]; then
  echo "Installing Pi MCP adapter:"
  if [[ "$DRY_RUN" == false ]]; then
    verify_npm_integrity "$PI_MCP_ADAPTER_SOURCE" "$PI_MCP_ADAPTER_INTEGRITY"
  fi
  run_cmd pi install "$PI_MCP_ADAPTER_SOURCE"
  if [[ "$DRY_RUN" == false ]] && command -v pi-mcp-adapter >/dev/null 2>&1; then
    pi-mcp-adapter init || true
  fi
  echo "Configuring shared global MCP baseline:"
  run_cmd bash "$PLATFORM_ROOT/scripts/configure-mcp.sh" --scope global --preset "$MCP_PRESET" --replace
fi

if [[ "$WITH_SUBAGENTS" == true ]]; then
  echo "Installing Pi subagents:"
  if [[ "$DRY_RUN" == false ]]; then
    verify_npm_integrity "$PI_SUBAGENTS_SOURCE" "$PI_SUBAGENTS_INTEGRITY"
  fi
  run_cmd pi install "$PI_SUBAGENTS_SOURCE"
  echo "Configuring Pi subagents baseline:"
  run_cmd bash "$PLATFORM_ROOT/scripts/configure-subagents.sh" --preset "$SUBAGENTS_PRESET" --model-scope "$SUBAGENTS_MODEL_SCOPE"
fi

if [[ "$WITH_WEB_ACCESS" == true ]]; then
  echo "Installing Pi web access for researcher subagent:"
  if [[ "$DRY_RUN" == false ]]; then
    verify_npm_integrity "$PI_WEB_ACCESS_SOURCE" "$PI_WEB_ACCESS_INTEGRITY"
  fi
  run_cmd pi install "$PI_WEB_ACCESS_SOURCE"
fi

if [[ "$CONFIGURE_MODEL_SCOPE" == true ]]; then
  echo "Configuring Pi model selector scope:"
  run_cmd bash "$PLATFORM_ROOT/scripts/configure-model-scope.sh" --preset "$MODEL_SCOPE_PRESET" --default-model "$DEFAULT_MODEL"
fi

if [[ "$WITH_HERDR" == true ]]; then
  if ! command -v herdr >/dev/null 2>&1; then
    echo "WARN: herdr is not on PATH. Skipping Herdr integration." >&2
  else
    PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}"
    run_cmd mkdir -p "$PI_AGENT_DIR/extensions"
    run_cmd herdr integration install pi
  fi
fi

echo
echo "Installed packages:"
if [[ "$DRY_RUN" == true ]]; then
  print_cmd pi list
else
  pi list
fi

echo
echo "Next:"
echo "  pi"
echo "  /login"
echo "  /model          # or Ctrl+L: select provider/model from Pi selector"
echo "  /scoped-models  # optional: edit Ctrl+P model cycle scope"
if [[ "$WITH_MCP" == true ]]; then
  echo "  /mcp            # inspect MCP servers; authenticate Figma/GitHub only when needed"
fi
echo "  /subagents-doctor"
echo "  /task Implement <task>  # parent may auto-delegate scout/planner/reviewer"

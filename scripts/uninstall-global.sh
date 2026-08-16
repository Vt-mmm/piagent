#!/usr/bin/env bash
set -euo pipefail

# Removes what this platform installed, and nothing else.
#
# Uninstall is reported before it is performed, for the same reason install is:
# the two touch shared Pi state that other tools also write to. Anything this
# script cannot prove it installed is listed for the operator instead of being
# deleted.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}"
GLOBAL_SETTINGS="$PI_AGENT_DIR/settings.json"

APPLY=false
WITH_ADDONS=false
WITH_HOST=false
PROJECT_PATH=""

PLATFORM_PACKAGE="@piagent/platform"
ADDON_PACKAGES=("pi-mcp-adapter" "pi-subagents" "pi-web-access")
PI_HOST_PACKAGE="@earendil-works/pi-coding-agent"

usage() {
  cat <<'USAGE'
Usage:
  piagent-uninstall [--apply] [--with-addons] [--with-host] [--project <path>]

Removes the Pi package this platform installed from Pi's global settings.

  (default)        Dry run. Reports what would be removed and exits 0.
  --apply          Perform the removal.
  --with-addons    Also remove pi-mcp-adapter, pi-subagents, and pi-web-access.
  --with-host      Also uninstall the global Pi Coding Agent host.
  --project <path> Also remove this platform's state from a project.

Never removed, at any flag combination: credentials, trust decisions, sessions,
todos, and project memory. Those are operator data, not platform state.
USAGE
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "Missing value for $option" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --with-addons) WITH_ADDONS=true; shift ;;
    --with-host) WITH_HOST=true; shift ;;
    --project)
      require_value "$1" "${2:-}"
      PROJECT_PATH="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

print_cmd() {
  printf '+'
  for arg in "$@"; do printf ' %q' "$arg"; done
  printf '\n'
}

run_cmd() {
  print_cmd "$@"
  if [[ "$APPLY" == true ]]; then
    "$@"
  fi
}

# The helper can live under a non-default npm prefix: install falls back to a
# user-writable root when the configured one is not writable, and --npm-prefix
# picks one deliberately. A bare `npm uninstall -g` resolves against the
# configured prefix instead, so it removes nothing and still reports success.
# Derive the prefix from where this script actually runs, the same way
# update-global.mjs does, and only add --prefix when it differs.
installed_helper_prefix() {
  local root="$ROOT"
  [[ "$(basename "$root")" == "platform" ]] || return 0
  local scope_root node_modules_root parent
  scope_root="$(dirname "$root")"
  [[ "$(basename "$scope_root")" == "@piagent" ]] || return 0
  node_modules_root="$(dirname "$scope_root")"
  [[ "$(basename "$node_modules_root")" == "node_modules" ]] || return 0
  parent="$(dirname "$node_modules_root")"
  # An npx run lives in a prunable cache that owns no bin on anyone's PATH;
  # uninstalling from there would claim to remove an install nobody has.
  case "$parent" in
    */_npx/*|*/_npx) return 0 ;;
  esac
  if [[ "$(basename "$parent")" == "lib" ]]; then
    dirname "$parent"
  else
    printf '%s' "$parent"
  fi
}

# The prefix npm has to be pointed at, or empty when the helper already lives
# under the configured one and the plain command is correct. Returns a single
# value rather than an argument list: macOS still ships bash 3.2, where
# expanding an empty array under `set -u` aborts the script.
npm_prefix_override() {
  local helper_prefix configured
  helper_prefix="$(installed_helper_prefix)"
  [[ -n "$helper_prefix" ]] || return 0
  configured="$(npm prefix -g 2>/dev/null || true)"
  [[ "$helper_prefix" != "$configured" ]] || return 0
  printf '%s' "$helper_prefix"
}

# Reads the package sources Pi has registered, so removal targets what is
# actually installed rather than what this version happens to install today. An
# older release registered a different source shape, and it still has to come
# out.
platform_sources() {
  [[ -f "$GLOBAL_SETTINGS" ]] || return 0
  node --input-type=module - "$GLOBAL_SETTINGS" <<'NODE'
import fs from "node:fs";

let settings;
try {
  settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch {
  process.exit(0);
}
const packages = Array.isArray(settings.packages) ? settings.packages : [];
// Every shape this platform has ever been installed as: the scoped npm
// package, the Git source, and a local checkout path.
const owned = /(@piagent\/platform|[/:]piagent(@|$|#)|Vt-mmm\/piagent|pi-company-platform)/;
for (const entry of packages) {
  if (typeof entry === "string" && owned.test(entry)) process.stdout.write(`${entry}\n`);
}
NODE
}

addon_sources() {
  [[ -f "$GLOBAL_SETTINGS" ]] || return 0
  node --input-type=module - "$GLOBAL_SETTINGS" "${ADDON_PACKAGES[@]}" <<'NODE'
import fs from "node:fs";

let settings;
try {
  settings = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
} catch {
  process.exit(0);
}
const names = process.argv.slice(3);
const packages = Array.isArray(settings.packages) ? settings.packages : [];
for (const entry of packages) {
  if (typeof entry !== "string") continue;
  if (names.some((name) => entry.includes(name))) process.stdout.write(`${entry}\n`);
}
NODE
}

echo "Pi Agent Platform uninstall"
echo "  mode: $([[ "$APPLY" == true ]] && echo apply || echo "dry run")"
echo "  settings: $GLOBAL_SETTINGS"
echo "  addons: $WITH_ADDONS"
echo "  host: $WITH_HOST"
[[ -n "$PROJECT_PATH" ]] && echo "  project: $PROJECT_PATH"
echo

if ! command -v pi >/dev/null 2>&1; then
  echo "WARN: pi is not on PATH; skipping Pi package removal." >&2
  echo "WARN: reinstall the host or remove entries from $GLOBAL_SETTINGS by hand." >&2
else
  found=false
  while IFS= read -r source; do
    [[ -z "$source" ]] && continue
    found=true
    echo "Removing platform package:"
    run_cmd pi remove "$source"
  done < <(platform_sources)
  if [[ "$found" == false ]]; then
    echo "No platform package found in Pi settings; nothing to remove."
  fi

  if [[ "$WITH_ADDONS" == true ]]; then
    addon_found=false
    while IFS= read -r source; do
      [[ -z "$source" ]] && continue
      addon_found=true
      echo "Removing add-on:"
      run_cmd pi remove "$source"
    done < <(addon_sources)
    if [[ "$addon_found" == false ]]; then
      echo "No pinned add-on found in Pi settings."
    fi
    # The MCP baseline and subagent config are shared files that the operator
    # may have edited after install, so they are reported rather than reset.
    # Install writes the shared global scope; the Pi-global file is the override
    # scope and is listed too, because an operator who used it will look there.
    echo "Left in place, review by hand if no longer wanted:"
    echo "  ${XDG_CONFIG_HOME:-"${HOME}/.config"}/mcp/mcp.json   # written by install"
    echo "  $PI_AGENT_DIR/mcp.json                               # Pi-global override scope, only if you created it"
    echo "  $PI_AGENT_DIR/extensions/subagent/config.json"
  fi
fi

if [[ "$WITH_HOST" == true ]]; then
  echo
  if command -v npm >/dev/null 2>&1; then
    echo "Uninstalling Pi host:"
    HOST_PREFIX="$(npm_prefix_override)"
    if [[ -n "$HOST_PREFIX" ]]; then
      echo "  (prefix $HOST_PREFIX, where this helper is installed)"
      run_cmd npm uninstall -g --prefix "$HOST_PREFIX" "$PI_HOST_PACKAGE"
    else
      run_cmd npm uninstall -g "$PI_HOST_PACKAGE"
    fi
  else
    echo "WARN: npm is not on PATH; cannot uninstall $PI_HOST_PACKAGE." >&2
  fi
fi

if [[ -n "$PROJECT_PATH" ]]; then
  echo
  if [[ ! -d "$PROJECT_PATH" ]]; then
    echo "FAIL: project path does not exist: $PROJECT_PATH" >&2
    exit 1
  fi
  PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
  echo "Project state in $PROJECT_PATH:"

  # Files this platform alone writes and owns.
  for relative in ".pi/piagent-profile.json" ".pi/piagent-profile.lock.json"; do
    [[ -e "$PROJECT_PATH/$relative" ]] && run_cmd rm -f "$PROJECT_PATH/$relative"
  done
  if [[ -d "$PROJECT_PATH/.pi/piagent-state" ]]; then
    run_cmd rm -rf "$PROJECT_PATH/.pi/piagent-state"
  fi

  # settings.json belongs to Pi, not to this platform. Only the package entry
  # pointing here comes out; everything else the operator configured stays.
  if [[ -f "$PROJECT_PATH/.pi/settings.json" ]]; then
    echo "+ drop platform package entry from $PROJECT_PATH/.pi/settings.json"
    if [[ "$APPLY" == true ]]; then
      node --input-type=module - "$PROJECT_PATH/.pi/settings.json" <<'NODE'
import fs from "node:fs";

const target = process.argv[2];
const settings = JSON.parse(fs.readFileSync(target, "utf8"));
if (Array.isArray(settings.packages)) {
  const owned = /(@piagent\/platform|[/:]piagent(@|$|#)|Vt-mmm\/piagent|pi-company-platform)/;
  const kept = settings.packages.filter((entry) => !(typeof entry === "string" && owned.test(entry)));
  if (kept.length > 0) settings.packages = kept;
  else delete settings.packages;
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
}
NODE
    fi
  fi

  # Written from templates at init, then edited by whoever used the project.
  # Deleting them would take the operator's work with them.
  echo "Left in place because they carry project content:"
  for relative in "AGENTS.md" "REVIEW_GUIDELINES.md" ".mcp.json" ".pi/settings.json" ".pi/mcp.json" \
    ".pi/project-context.md" ".pi/context-index.json" ".pi/tech-stack.json" ".pi/tech-context" ".pi/memory"; do
    [[ -e "$PROJECT_PATH/$relative" ]] && echo "  $relative"
  done
fi

echo
if [[ "$APPLY" == true ]]; then
  echo "Uninstall complete."
  echo "The npm-global helper is separate and stays until you remove it:"
  HELPER_PREFIX="$(npm_prefix_override)"
  if [[ -n "$HELPER_PREFIX" ]]; then
    echo "  npm uninstall -g --prefix $HELPER_PREFIX $PLATFORM_PACKAGE"
  else
    echo "  npm uninstall -g $PLATFORM_PACKAGE"
  fi
else
  echo "Dry run only. Nothing was removed. Re-run with --apply to perform it."
fi

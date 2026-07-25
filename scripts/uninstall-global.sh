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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --with-addons) WITH_ADDONS=true; shift ;;
    --with-host) WITH_HOST=true; shift ;;
    --project)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "Missing value for --project" >&2
        exit 2
      fi
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
    echo "Left in place, review by hand if no longer wanted:"
    echo "  $PI_AGENT_DIR/mcp.json"
    echo "  $PI_AGENT_DIR/extensions/subagent/config.json"
  fi
fi

if [[ "$WITH_HOST" == true ]]; then
  echo
  if command -v npm >/dev/null 2>&1; then
    echo "Uninstalling Pi host:"
    run_cmd npm uninstall -g "$PI_HOST_PACKAGE"
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
  echo "  npm uninstall -g $PLATFORM_PACKAGE"
else
  echo "Dry run only. Nothing was removed. Re-run with --apply to perform it."
fi

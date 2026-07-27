#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/init-project.sh <project-path> [options]

Options:
  --profile <name-or-json>       auto | generic | web-frontend | backend-api | be-readonly-fe | fullstack | node-typescript | python | data | devops | mobile | docs | path/to/profile.json
  --package-source <source>      Pi package source committed into .pi/settings.json
  --force-profile                Replace existing .pi/piagent-profile.json
  --force-settings               Replace existing .pi/settings.json
  --skip-agents                  Do not create AGENTS.md
  --skip-review-guidelines       Do not create REVIEW_GUIDELINES.md
  -h, --help

Package source examples:
  # Exact sources are required here because init writes .pi/settings.json and a capability lock:
  git:github.com/Vt-mmm/piagent@vX.Y.Z
  https://github.com/Vt-mmm/piagent/archive/refs/tags/vX.Y.Z.tar.gz
  npm:@your-scope/platform@x.y.z

Default package source:
  1. --package-source
  2. PIAGENT_PACKAGE_SOURCE
  3. local platform path (warn; do not commit for team)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 2
fi

PROJECT_PATH="$1"
shift

PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_INPUT="auto"
PACKAGE_SOURCE="${PIAGENT_PACKAGE_SOURCE:-}"
FORCE_PROFILE=false
FORCE_SETTINGS=false
SKIP_AGENTS=false
SKIP_REVIEW=false

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
    --force-profile)
      FORCE_PROFILE=true
      shift
      ;;
    --force-settings)
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

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "FAIL: project path does not exist: $PROJECT_PATH" >&2
  exit 1
fi

PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"

# Profile detection lives in packages/piagent-core/extensions/project-shape.js so
# that this script and the runtime `piagent_profile_options` tool recommend the
# same profile. They used to hold separate copies of the rules and drifted apart.
detect_profile() {
  local project="$1"
  node --input-type=module - "$PLATFORM_ROOT" "$project" <<'NODE'
import path from "node:path";
import { pathToFileURL } from "node:url";

const [platformRoot, project] = process.argv.slice(2);
const modulePath = path.join(platformRoot, "packages/piagent-core/extensions/project-shape.js");
const { detectProfileName } = await import(pathToFileURL(modulePath).href);
process.stdout.write(`${detectProfileName(project).name}\n`);
NODE
}

resolve_profile_path() {
  local input="$1"
  if [[ -f "$input" ]]; then
    printf '%s\n' "$input"
    return
  fi

  local candidate="$PLATFORM_ROOT/adapters/$input/profile.json"
  if [[ -f "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  echo "FAIL: profile not found: $input" >&2
  echo "Known default profiles:" >&2
  find "$PLATFORM_ROOT/adapters" -mindepth 2 -maxdepth 2 -name profile.json -print | sed "s#^$PLATFORM_ROOT/adapters/##; s#/profile.json##" | sort >&2
  exit 1
}

resolve_package_source() {
  if [[ -n "$PACKAGE_SOURCE" ]]; then
    printf '%s\n' "$PACKAGE_SOURCE"
    return
  fi

  local existing_settings="$PROJECT_PATH/.pi/settings.json"
  if [[ -f "$existing_settings" ]]; then
    local existing_source
    existing_source="$(node --input-type=module - "$existing_settings" <<'NODE'
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
  echo "WARN: .pi/settings.json will use local platform path; do not commit it for team use." >&2
  printf '%s\n' "$PLATFORM_ROOT"
}

REQUESTED_PROFILE="$PROFILE_INPUT"
if [[ "$PROFILE_INPUT" == "auto" ]]; then
  PROFILE_INPUT="$(detect_profile "$PROJECT_PATH")"
fi

PROFILE_PATH="$(resolve_profile_path "$PROFILE_INPUT")"
PACKAGE_SOURCE="$(resolve_package_source)"
node "$PLATFORM_ROOT/scripts/capability-catalog.mjs" validate-source --package-source "$PACKAGE_SOURCE" >/dev/null

mkdir -p "$PROJECT_PATH/.pi"

if [[ ! -f "$PROJECT_PATH/.mcp.json" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.mcp.json" "$PROJECT_PATH/.mcp.json"
fi

SETTINGS_PATH="$PROJECT_PATH/.pi/settings.json"
if [[ "$FORCE_SETTINGS" == true || ! -f "$SETTINGS_PATH" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/settings.json" "$SETTINGS_PATH"
  node --input-type=module - "$SETTINGS_PATH" "$PACKAGE_SOURCE" <<'NODE'
import fs from "node:fs";
const [settingsPath, packageSource] = process.argv.slice(2);
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
settings.packages = [packageSource];
fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
NODE
else
  echo "SKIP: .pi/settings.json exists. Use --force-settings to replace."
fi

PROFILE_TARGET="$PROJECT_PATH/.pi/piagent-profile.json"
CAPABILITY_LOCK_TARGET="$PROJECT_PATH/.pi/piagent-profile.lock.json"
if [[ "$FORCE_PROFILE" == true || ! -f "$PROFILE_TARGET" ]]; then
  apply_profile_args=(
    "$PLATFORM_ROOT/scripts/capability-catalog.mjs"
    apply-profile
    --profile "$PROFILE_PATH"
    --target "$PROFILE_TARGET"
    --package-source "$PACKAGE_SOURCE"
  )
  if [[ "$FORCE_PROFILE" == true ]]; then
    apply_profile_args+=(--force)
  fi
  node "${apply_profile_args[@]}" >/dev/null
else
  echo "SKIP: .pi/piagent-profile.json exists. Use --force-profile to replace."
  node "$PLATFORM_ROOT/scripts/capability-catalog.mjs" resolve \
    --profile "$PROFILE_TARGET" \
    --output "$CAPABILITY_LOCK_TARGET" \
    --package-source "$PACKAGE_SOURCE" >/dev/null
fi

if [[ ! -f "$PROJECT_PATH/.pi/mcp.json" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/mcp.json" "$PROJECT_PATH/.pi/mcp.json"
fi

if [[ ! -f "$PROJECT_PATH/.pi/.gitignore" ]]; then
  if [[ -f "$PLATFORM_ROOT/templates/project/.pi/gitignore.template" ]]; then
    cp "$PLATFORM_ROOT/templates/project/.pi/gitignore.template" "$PROJECT_PATH/.pi/.gitignore"
  else
    cp "$PLATFORM_ROOT/templates/project/.pi/.gitignore" "$PROJECT_PATH/.pi/.gitignore"
  fi
fi

PROJECT_GITIGNORE="$PROJECT_PATH/.gitignore"
if [[ ! -f "$PROJECT_GITIGNORE" ]]; then
  : > "$PROJECT_GITIGNORE"
fi
if ! grep -F "# Pi Agent Platform runtime" "$PROJECT_GITIGNORE" >/dev/null 2>&1; then
  {
    echo
    echo "# Pi Agent Platform runtime"
    echo ".pi-subagents/"
    echo "progress.md"
  } >> "$PROJECT_GITIGNORE"
fi

if [[ ! -f "$PROJECT_PATH/.pi/project-context.md" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/project-context.md" "$PROJECT_PATH/.pi/project-context.md"
fi

if [[ ! -f "$PROJECT_PATH/.pi/context-index.json" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/context-index.json" "$PROJECT_PATH/.pi/context-index.json"
fi

if [[ ! -f "$PROJECT_PATH/.pi/tech-stack.json" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/tech-stack.json" "$PROJECT_PATH/.pi/tech-stack.json"
fi
mkdir -p "$PROJECT_PATH/.pi/tech-context"
if [[ ! -f "$PROJECT_PATH/.pi/tech-context/README.md" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/tech-context/README.md" "$PROJECT_PATH/.pi/tech-context/README.md"
fi

mkdir -p "$PROJECT_PATH/.pi/memory"
if [[ ! -f "$PROJECT_PATH/.pi/memory/memory_summary.md" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/memory/memory_summary.md" "$PROJECT_PATH/.pi/memory/memory_summary.md"
fi
if [[ ! -f "$PROJECT_PATH/.pi/memory/MEMORY.md" ]]; then
  cp "$PLATFORM_ROOT/templates/project/.pi/memory/MEMORY.md" "$PROJECT_PATH/.pi/memory/MEMORY.md"
fi

if [[ "$SKIP_AGENTS" == false && ! -f "$PROJECT_PATH/AGENTS.md" ]]; then
  cp "$PLATFORM_ROOT/templates/project/AGENTS.md" "$PROJECT_PATH/AGENTS.md"
fi

if [[ "$SKIP_REVIEW" == false && ! -f "$PROJECT_PATH/REVIEW_GUIDELINES.md" ]]; then
  cp "$PLATFORM_ROOT/templates/project/REVIEW_GUIDELINES.md" "$PROJECT_PATH/REVIEW_GUIDELINES.md"
fi

echo "Project initialized:"
echo "  project: $PROJECT_PATH"
echo "  requestedProfile: $REQUESTED_PROFILE"
echo "  resolvedProfile: $PROFILE_INPUT"
echo "  profile: $PROFILE_TARGET"
echo "  capabilityLock: $CAPABILITY_LOCK_TARGET"
echo "  profileSource: $PROFILE_PATH"
echo "  packageSource: $PACKAGE_SOURCE"
echo
echo "Next:"
echo "  cd \"$PROJECT_PATH\""
echo "  pi"
echo "  /login              # first time only"
echo "  /onboard-project    # first project-read after model selection"
echo "  /mcp                # MCP servers come from the global install, not from this project"
echo "  /context-index      # inspect compact project context index"
echo "  /memory-policy      # inspect project memory policy when needed"
echo
echo "Note: .mcp.json and .pi/mcp.json are written empty on purpose. They exist so this"
echo "project can add its own servers later; the shared baseline lives in the global"
echo "config written by piagent-setup. An empty file here does not mean MCP is missing."

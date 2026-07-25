#!/usr/bin/env bash
set -euo pipefail

PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}"
MCP_CONFIG_DIR="${XDG_CONFIG_HOME:-"${HOME}/.config"}/mcp"

mkdir -p "$PI_AGENT_DIR/extensions" "$PI_AGENT_DIR/prompts" "$PI_AGENT_DIR/skills"
mkdir -p "$MCP_CONFIG_DIR"

echo "Pi Agent Platform"
echo "platform: $PLATFORM_ROOT"
echo "pi agent dir: $PI_AGENT_DIR"
echo
echo "Run these commands when ready:"
echo
echo "  bash \"$PLATFORM_ROOT/scripts/install-global.sh\" --package-source \"$PLATFORM_ROOT\" --with-mcp --mcp-preset core --with-herdr"
echo "  pi"
echo "  /login"
echo
echo "Then link a project:"
echo
echo "  bash \"$PLATFORM_ROOT/scripts/init-project.sh\" /path/to/project --profile generic --package-source git:github.com/Vt-mmm/piagent@vX.Y.Z"
echo "  cd /path/to/project"
echo "  pi"

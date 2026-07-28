#!/bin/bash
# Verðandi Capsule Wrapper — Herhangi bir agent'ı capsule enjeksiyonu ile çalıştırır
#
# Usage: ./run_with_capsule.sh <agent> <projectRoot> <task>
# Example: ./run_with_capsule.sh natureco /path/to/project "Fix imports"

set -euo pipefail

AGENT="${1:-natureco}"
PROJECT_ROOT="${2:-$(pwd)}"
TASK="${3:-Analyze this codebase}"

CAPSULE_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$CAPSULE_DIR/dist/src/mcp_server.js" ]; then
  echo "ERROR: dist/src/mcp_server.js missing. Run: npm run build" >&2
  exit 1
fi

# Step 1: Generate auto-inject prompt
INJECTED_PROMPT=$(node "$CAPSULE_DIR/src/auto_inject.mjs" "$PROJECT_ROOT" "$TASK" 1)

if [ -z "$INJECTED_PROMPT" ]; then
  echo "ERROR: auto_inject failed" >&2
  exit 1
fi

echo "📦 Capsule enjekte ediliyor... ($(( ${#INJECTED_PROMPT} / 4 )) token approx)"
echo ""

# Step 2: Run the agent with the injected prompt
case "$AGENT" in
  natureco)
    natureco code --dir "$PROJECT_ROOT" -p "$INJECTED_PROMPT"
    ;;
  hermes)
    (cd "$PROJECT_ROOT" && hermes chat -q "$INJECTED_PROMPT" --yolo --cli)
    ;;
  codex)
    codex exec --ephemeral --model "${VERDANDI_CODEX_MODEL:-${URDR_CODEX_MODEL:-gpt-5.6}}" --cd "$PROJECT_ROOT" "$INJECTED_PROMPT"
    ;;
  claude)
    (cd "$PROJECT_ROOT" && claude -p "$INJECTED_PROMPT" --permission-mode auto)
    ;;
  opencode)
    (cd "$PROJECT_ROOT" && opencode run "$INJECTED_PROMPT")
    ;;
  openclaw)
    # OpenClaw agent message with pre-built capsule context
    (cd "$PROJECT_ROOT" && openclaw agent --message "$INJECTED_PROMPT")
    ;;
  kimi)
    (cd "$PROJECT_ROOT" && kimi -p "$INJECTED_PROMPT")
    ;;
  glm)
    (cd "$PROJECT_ROOT" && glm -p "$INJECTED_PROMPT")
    ;;
  *)
    echo "Unknown agent: $AGENT" >&2
    echo "Supported: natureco, hermes, codex, claude, opencode, openclaw, kimi, glm" >&2
    exit 1
    ;;
esac

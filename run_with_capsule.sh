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

# İzin kapılarını atlayan bayraklar VARSAYILAN DEĞİL.
#
# Bu betiğin işi, indekslenen kod tabanının HAM KAYNAĞINI bir ajanın
# prompt'una koymaktır. O kaynak güvenilmeyen bir depodan geliyorsa (çekilmiş
# bir bağımlılık, bir PR, bir yorum satırı), içindeki metin ajana talimat
# olarak ulaşabilir. Bunu `--yolo` / `--permission-mode auto` /
# `--dangerously-skip-permissions` ile birleştirmek, o talimatın onay
# sorulmadan çalışması demektir.
#
# Kendi deponuzda bu bir sorun değil; bu yüzden yasaklamıyoruz, VARSAYILAN
# olmaktan çıkarıyoruz. Tam yetki artık bilinçli bir tercih:
#
#   VERDANDI_YOLO=1 ./run_with_capsule.sh claude /path/to/project "..."
#
# Bayraklar olmadan ajanlar kendi normal izin davranışlarını uygular; bir araç
# çağrısı onay isteyip etkileşimsiz kipte reddedilebilir. Yarıda kalan bir
# görev, sormadan çalıştırılmış bir görevden iyidir.
if [ "${VERDANDI_YOLO:-0}" = "1" ]; then
  HERMES_IZIN=(--yolo)
  CLAUDE_IZIN=(--permission-mode auto)
  AGY_IZIN=(--dangerously-skip-permissions)
else
  HERMES_IZIN=()
  CLAUDE_IZIN=()
  AGY_IZIN=()
fi

if [ "${VERDANDI_YOLO:-0}" = "1" ]; then
  echo "⚠  VERDANDI_YOLO=1 — ajan izin kapıları KAPALI çalıştırılacak." >&2
  echo "   Yalnızca güvendiğiniz kod tabanlarında kullanın: indekslenen kaynak" >&2
  echo "   ajanın prompt'una giriyor ve oradaki metin talimat gibi okunabilir." >&2
fi

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
    (cd "$PROJECT_ROOT" && hermes chat -q "$INJECTED_PROMPT" ${HERMES_IZIN[@]+"${HERMES_IZIN[@]}"} --cli)
    ;;
  codex)
    codex exec --ephemeral --model "${VERDANDI_CODEX_MODEL:-${URDR_CODEX_MODEL:-gpt-5.6}}" --cd "$PROJECT_ROOT" "$INJECTED_PROMPT"
    ;;
  claude)
    (cd "$PROJECT_ROOT" && claude -p "$INJECTED_PROMPT" ${CLAUDE_IZIN[@]+"${CLAUDE_IZIN[@]}"})
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
  antigravity)
    # The binary is `agy`; `antigravity` is accepted as a fallback for installs
    # that alias it. The agent key stays `antigravity` to match the MCP registry.
    AGY_BIN=""
    for candidate in agy antigravity; do
      if command -v "$candidate" >/dev/null 2>&1; then
        AGY_BIN="$candidate"
        break
      fi
    done
    if [ -z "$AGY_BIN" ]; then
      echo "ERROR: neither 'agy' nor 'antigravity' found on PATH." >&2
      exit 1
    fi

    # Before 1.0.15, print mode silently discarded stdout on Windows when run
    # from a pipe or subprocess — which is exactly how this script calls it.
    # It exits 0 with no output, so without this guard the failure looks like
    # the model returned nothing. See google-antigravity/antigravity-cli#76.
    AGY_VERSION="$("$AGY_BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
    if [ -n "$AGY_VERSION" ]; then
      AGY_MAJOR="${AGY_VERSION%%.*}"
      AGY_REST="${AGY_VERSION#*.}"
      AGY_MINOR="${AGY_REST%%.*}"
      AGY_PATCH="${AGY_REST#*.}"
      if [ "$AGY_MAJOR" -eq 1 ] && [ "$AGY_MINOR" -eq 0 ] && [ "$AGY_PATCH" -lt 15 ]; then
        echo "WARNING: agy $AGY_VERSION drops piped stdout on Windows (fixed in 1.0.15)." >&2
        echo "         If you see no output below, upgrade rather than debugging the capsule." >&2
      fi
    fi

    (cd "$PROJECT_ROOT" && "$AGY_BIN" -p "$INJECTED_PROMPT" ${AGY_IZIN[@]+"${AGY_IZIN[@]}"})
    ;;
  *)
    echo "Unknown agent: $AGENT" >&2
    echo "Supported: natureco, hermes, codex, claude, opencode, openclaw, kimi, glm, antigravity" >&2
    exit 1
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

export DISPLAY="${DISPLAY:-:99}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/xdg-runtime-$UID}"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[start] node is not installed."
  exit 1
fi

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "[start] Xvfb is not installed."
  echo "[start] install: sudo apt-get update && sudo apt-get install -y xvfb"
  exit 1
fi

if ! pgrep -f "Xvfb $DISPLAY" >/dev/null 2>&1; then
  echo "[start] starting Xvfb on $DISPLAY"
  Xvfb "$DISPLAY" -screen 0 1400x900x24 -ac -nolisten tcp >/tmp/voice-bot-xvfb.log 2>&1 &
  sleep 1
fi

echo "[start] preparing pulseaudio virtual devices..."
bash "$ROOT_DIR/scripts/ubuntu/setup-audio.sh"

if [[ -z "${CHROME_PATH:-}" ]]; then
  for bin in google-chrome-stable google-chrome chromium-browser chromium; do
    if command -v "$bin" >/dev/null 2>&1; then
      export CHROME_PATH="$(command -v "$bin")"
      break
    fi
  done
fi

if [[ -z "${CHROME_PATH:-}" ]]; then
  echo "[start] chrome/chromium not found."
  echo "[start] install: sudo apt-get update && sudo apt-get install -y chromium-browser"
  exit 1
fi

export HEADLESS="${HEADLESS:-false}"
export OPENAI_STT_SOURCE="${OPENAI_STT_SOURCE:-bridge-input}"
export OPENAI_STT_PREFER_LOOPBACK="${OPENAI_STT_PREFER_LOOPBACK:-true}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-.chrome-profile}"

if [[ -z "${OPENAI_STT_DEVICE_LABEL:-}" ]] || [[ "${OPENAI_STT_DEVICE_LABEL,,}" == *"blackhole"* ]]; then
  export OPENAI_STT_DEVICE_LABEL="Monitor of Meet-RX"
fi

if [[ -z "${BRIDGE_TTS_OUTPUT_DEVICE_LABEL:-}" ]] || [[ "${BRIDGE_TTS_OUTPUT_DEVICE_LABEL,,}" == *"blackhole"* ]]; then
  export BRIDGE_TTS_OUTPUT_DEVICE_LABEL="Meet-TX"
fi

mkdir -p "$CHROME_USER_DATA_DIR"

echo "[start] DISPLAY=$DISPLAY"
echo "[start] CHROME_PATH=$CHROME_PATH"
echo "[start] OPENAI_STT_DEVICE_LABEL=$OPENAI_STT_DEVICE_LABEL"
echo "[start] BRIDGE_TTS_OUTPUT_DEVICE_LABEL=$BRIDGE_TTS_OUTPUT_DEVICE_LABEL"
echo "[start] starting API..."
exec node src/api.js

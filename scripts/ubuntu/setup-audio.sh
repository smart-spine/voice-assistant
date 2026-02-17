#!/usr/bin/env bash
set -euo pipefail

SINK_RX_NAME="${SINK_RX_NAME:-meet_rx}"
SINK_TX_NAME="${SINK_TX_NAME:-meet_tx}"
SOURCE_TX_NAME="${SOURCE_TX_NAME:-meet_tx_mic}"
SOURCE_RX_NAME="${SOURCE_RX_NAME:-meet_rx_in}"
SINK_RX_DESC="${SINK_RX_DESC:-Meet-RX}"
SINK_TX_DESC="${SINK_TX_DESC:-Meet-TX}"
SOURCE_TX_DESC="${SOURCE_TX_DESC:-Meet-TX-Mic}"
SOURCE_RX_DESC="${SOURCE_RX_DESC:-Meet-RX-In}"

if ! command -v pulseaudio >/dev/null 2>&1; then
  echo "[audio] pulseaudio is not installed."
  echo "[audio] install: sudo apt-get update && sudo apt-get install -y pulseaudio pulseaudio-utils"
  exit 1
fi

if ! command -v pactl >/dev/null 2>&1; then
  echo "[audio] pactl is not installed."
  echo "[audio] install: sudo apt-get update && sudo apt-get install -y pulseaudio-utils"
  exit 1
fi

if ! pulseaudio --check >/dev/null 2>&1; then
  pulseaudio --start --daemonize=yes --exit-idle-time=-1 >/dev/null 2>&1 || true
fi

if ! pulseaudio --check >/dev/null 2>&1; then
  echo "[audio] failed to start pulseaudio."
  exit 1
fi

ensure_sink() {
  local sink_name="$1"
  local sink_desc="$2"
  if pactl list short sinks | awk '{print $2}' | grep -Fxq "$sink_name"; then
    echo "[audio] sink exists: $sink_name"
    return 0
  fi

  pactl load-module module-null-sink \
    sink_name="$sink_name" \
    sink_properties="device.description=$sink_desc" >/dev/null
  echo "[audio] created sink: $sink_name ($sink_desc)"
}

ensure_source() {
  local source_name="$1"
  local source_desc="$2"
  local master="$3"
  if pactl list short sources | awk '{print $2}' | grep -Fxq "$source_name"; then
    echo "[audio] source exists: $source_name"
    return 0
  fi

  pactl load-module module-remap-source \
    source_name="$source_name" \
    source_properties="device.description=$source_desc" \
    master="$master" >/dev/null
  echo "[audio] created source: $source_name ($source_desc)"
}

ensure_sink "$SINK_RX_NAME" "$SINK_RX_DESC"
ensure_sink "$SINK_TX_NAME" "$SINK_TX_DESC"
ensure_source "$SOURCE_TX_NAME" "$SOURCE_TX_DESC" "$SINK_TX_NAME.monitor"
ensure_source "$SOURCE_RX_NAME" "$SOURCE_RX_DESC" "$SINK_RX_NAME.monitor"

pactl set-default-sink "$SINK_RX_NAME" || true
pactl set-default-source "$SOURCE_TX_NAME" || true

echo
echo "[audio] ready."
echo "[audio] sinks:"
pactl list short sinks
echo
echo "[audio] sources:"
pactl list short sources
echo
echo "[audio] recommended env:"
echo "OPENAI_STT_DEVICE_LABEL=$SOURCE_RX_DESC"
echo "BRIDGE_TTS_OUTPUT_DEVICE_LABEL=$SINK_TX_DESC"

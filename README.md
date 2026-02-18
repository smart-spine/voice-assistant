# Google Meet Voice Bot

OpenAI-native Google Meet bot for short intake calls.

The runtime is intentionally strict and minimal:
1. Join Google Meet with Puppeteer.
2. Capture audio in the bridge page via `MediaRecorder`.
3. Transcribe turns with OpenAI STT.
4. Generate streaming assistant output (OpenAI or LangChain runtime).
5. Synthesize speech with OpenAI TTS and play it back through the bridge page.

Legacy caption scraping, browser `SpeechSynthesis` fallback, and mixed transcription modes were removed.

## Project structure

- `src/index.js` - CLI entrypoint (`npm start`).
- `src/api.js` - control API entrypoint (`npm run start:api`).
- `src/runtime/bot-session.js` - core session lifecycle and turn pipeline.
- `src/runtime/session-manager.js` - single active session orchestrator.
- `src/meet-controller.js` - browser automation + Meet interactions.
- `src/openai-stt-service.js` - OpenAI STT turn stream.
- `src/openai-service.js` - OpenAI chat + TTS runtime.
- `src/langchain-agent-service.js` - LangChain chat runtime with OpenAI TTS.
- `src/transports/transport-factory.js` - transport adapter factory (Meet now, extensible for phone/mobile channels).
- `src/transports/meet-transport-adapter.js` - Meet transport adapter implementation.
- `src/prompts/prompt-builder.js` - system prompt composition.
- `src/workflows/call-summary-graph.js` - post-call summary workflow.
- `src/api/control-server.js` - REST API layer.
- `public/bridge.html` - audio bridge for STT capture + playback.
- `prompts/system-prompt.txt` - default system prompt.

## Requirements

- Node.js 18+
- Google Chrome installed (or `CHROME_PATH` configured)
- Valid OpenAI API key
- Bot Google account already signed in inside `CHROME_USER_DATA_DIR`

## Quick start (CLI)

```bash
npm install
cp .env.example .env
npm start
```

Required env vars for CLI mode:
- `OPENAI_API_KEY`
- `MEET_URL`

Recommended local values:
- `HEADLESS=false`
- `CHROME_USER_DATA_DIR=.chrome-profile`
- `OPENAI_STT_MODEL=gpt-4o-mini-transcribe`

## API mode

```bash
npm run start:api
```

Default: `http://127.0.0.1:3200`

If `CONTROL_API_TOKEN` is set, send `Authorization: Bearer <token>`.

## Ubuntu/Hetzner runbook

For headless Ubuntu servers, run Chrome with `Xvfb` and PulseAudio virtual devices:

1. Install runtime deps:
```bash
sudo apt-get update
sudo apt-get install -y \
  xvfb pulseaudio pulseaudio-utils \
  chromium-browser fonts-liberation fonts-noto-color-emoji
```

2. Install project deps and configure env:
```bash
npm install
cp .env.example .env
```

3. Start API with Linux audio bootstrap:
```bash
npm run start:api:ubuntu
```

What this script does:
- starts `Xvfb` on `:99` (if needed),
- starts PulseAudio (if needed),
- creates virtual devices:
  - sink `meet_rx` (`Meet-RX`) for incoming call audio,
  - sink `meet_tx` (`Meet-TX`) for bot TTS out,
  - source `meet_tx_mic` (`Meet-TX-Mic`) for Meet microphone,
  - source `meet_rx_in` (`Meet-RX-In`) for STT capture from remote participants,
- exports defaults:
  - `OPENAI_STT_DEVICE_LABEL=Meet-RX-In`
  - `BRIDGE_TTS_OUTPUT_DEVICE_LABEL=Meet-TX`

Recommended first-run check:
- Open Meet settings in the bot browser profile once and ensure:
  - `Microphone = Meet-TX-Mic` (or monitor of `Meet-TX`),
  - `Speakers = Meet-RX`.
- Keep `HEADLESS=false` on server unless you fully verify media capture in your environment.

### Endpoints

Health:
```bash
curl http://127.0.0.1:3200/health
```

Status:
```bash
curl http://127.0.0.1:3200/api/v1/bot/status
```

Start:
```bash
curl -X POST http://127.0.0.1:3200/api/v1/bot/start \
  -H "Content-Type: application/json" \
  -d '{
    "meetUrl": "https://meet.google.com/xxx-xxxx-xxx",
    "forceRestart": false,
    "projectContext": {
      "requestedProduct": "AI sales call assistant"
    }
  }'
```

Stop:
```bash
curl -X POST http://127.0.0.1:3200/api/v1/bot/stop \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual stop"}'
```

## Active environment variables

Core:
- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_TEMPERATURE`
- `AGENT_RUNTIME` (`langchain` or `openai`)

TTS:
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`
- `OPENAI_TTS_FORMAT`
- `OPENAI_TTS_TIMEOUT_MS`

STT:
- `OPENAI_STT_MODEL`
- `OPENAI_STT_SOURCE` (`bridge-input` only)
- `OPENAI_STT_LANGUAGE`
- `OPENAI_STT_CHUNK_MS`
- `OPENAI_STT_TIMEOUT_MS`
- `OPENAI_STT_LOG_FINALS`
- `OPENAI_STT_LOG_PARTIALS`
- `OPENAI_STT_MAX_RETRIES`
- `OPENAI_STT_MIN_CHUNK_BYTES`
- `OPENAI_STT_MIME_TYPE`
- `OPENAI_STT_DEVICE_ID`
- `OPENAI_STT_DEVICE_LABEL` (optional substring match for input device label, useful on macOS when device id changes)
- `OPENAI_STT_PREFER_LOOPBACK` (default `true`: if no device is explicitly set, bridge prefers loopback-style inputs such as BlackHole/Loopback/Soundflower)
- `OPENAI_STT_AUDIO_BITS_PER_SECOND`
- `OPENAI_STT_MIN_SIGNAL_PEAK` (default `0.004`; drop near-silent chunks before sending to STT)
- `OPENAI_STT_VAD_THRESHOLD` (default `0.015`; voice activity threshold for segment start/continue)
- `OPENAI_STT_HANGOVER_MS` (default `700`; silence window before segment flush)
- `OPENAI_STT_SEGMENT_MIN_MS` (default `900`; drop too-short segments)
- `OPENAI_STT_SEGMENT_MAX_MS` (default `7000`; force flush long utterances)
- `BRIDGE_TTS_OUTPUT_DEVICE_ID` (optional explicit audio output device id for bridge playback)
- `BRIDGE_TTS_OUTPUT_DEVICE_LABEL` (optional label match for bridge playback sink; useful for forcing TTS to `BlackHole 2ch`)
- `TURN_SILENCE_MS`
- `POST_TURN_RESPONSE_DELAY_MS`
- `FIRST_TURN_RESPONSE_DELAY_CAP_MS` (caps extra delay for the very first user turn to keep initial reply snappy)
- `TURN_STITCH_ENABLED` (merge adjacent final STT turns when first segment looks incomplete)
- `TURN_STITCH_WINDOW_MS` (max gap for final-turn stitching, default `1100`)

Conversation/runtime:
- `WAKE_WORD`
- `REPLY_CHUNK_MIN_CHARS`
- `REPLY_CHUNK_TARGET_CHARS`
- `REPLY_CHUNK_MAX_CHARS`
- `REPLY_CHUNK_MAX_LATENCY_MS`
- `BARGE_IN_ENABLED`
- `BARGE_IN_ON_PARTIALS` (default `false`; keep disabled to avoid canceling replies on unstable interim STT text)
- `BARGE_IN_MIN_MS`
- `BARGE_IN_MIN_WORDS_OPENAI_STT` (default `2`; avoids barge-in on one-word STT noise)
- `SILENCE_AFTER_SPEAK_MS`
- `INBOUND_DEDUP_MS`
- `AUTO_GREETING_ENABLED`
- `AUTO_GREETING_DELAY_MS`
- `AUTO_GREETING_TEXT`
- `AUTO_GREETING_PROMPT`

Prompt/context:
- `SYSTEM_PROMPT_FILE`
- `SYSTEM_PROMPT`
- `PROJECT_CONTEXT`

Call completion/summary:
- `INTAKE_COMPLETE_TOKEN`
- `AUTO_LEAVE_ON_INTAKE_COMPLETE`
- `INTAKE_COMPLETE_LEAVE_DELAY_MS`
- `CALL_SUMMARY_ENABLED`
- `CALL_SUMMARY_MODEL`
- `CALL_SUMMARY_TEMPERATURE`
- `CALL_SUMMARY_MAX_TURNS`
- `CALL_SUMMARY_MAX_TRANSCRIPT_CHARS`
- `CALL_SUMMARY_MAX_OUTPUT_CHARS`
- `CALL_SUMMARY_TIMEOUT_MS`

Browser:
- `MEET_URL`
- `HEADLESS`
- `CHROME_PATH`
- `CHROME_USER_DATA_DIR`
- `MEET_JOIN_STATE_TIMEOUT_MS` (initial join-state wait during startup; lower means faster startup when Meet is slow to report joined)
- `MEET_JOIN_POLL_MS` (background join-state polling interval used after startup)
- `MEET_JOIN_CLICK_ATTEMPTS` (max join-button retries on prejoin screen)
- `MEET_JOIN_CLICK_RETRY_MS` (delay between join-button retries)
- `BRIDGE_HOST`
- `BRIDGE_PORT`

Control API:
- `CONTROL_API_HOST`
- `CONTROL_API_PORT`
- `CONTROL_API_TOKEN`
- `ALLOW_ANY_MEET_URL`

## Audio routing note

Recommended macOS setup for stable single-machine tests:
1. Keep separate TX/RX buses: `BlackHole 2ch` for Meet microphone (bot voice out) and `BlackHole 16ch` for Meet speakers (remote voice in).
2. In Meet, set `Microphone = BlackHole 2ch` and `Speakers = BlackHole 16ch`.
3. Set `OPENAI_STT_SOURCE=bridge-input` and `OPENAI_STT_DEVICE_LABEL=BlackHole 16ch`.
4. Set `BRIDGE_TTS_OUTPUT_DEVICE_LABEL=BlackHole 2ch` so bridge playback is routed directly to Meet mic path (independent from macOS default output).

The bridge uses VAD-driven segment capture plus a software gate while TTS is playing:
- STT only flushes full speech segments (not fixed 650ms slices).
- STT ignores bot playback and resumes after a silence window (`SILENCE_AFTER_SPEAK_MS`).
- Segment boundaries are controlled by `OPENAI_STT_VAD_THRESHOLD`, `OPENAI_STT_HANGOVER_MS`, `OPENAI_STT_SEGMENT_MIN_MS`, and `OPENAI_STT_SEGMENT_MAX_MS`.

## Security

- Keep API bound to localhost unless behind a trusted proxy.
- Set `CONTROL_API_TOKEN` outside local-only development.
- Do not commit real `.env` secrets.

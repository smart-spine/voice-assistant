# Google Meet Voice Bot

Ultra-low-latency voice bot for Google Meet with OpenAI Realtime pipeline and hybrid fallback.

## Runtime architecture

The bot now has two execution paths:

1. `realtime` (recommended)
- Browser bridge establishes direct WebRTC to OpenAI Realtime.
- User speech transcription and assistant audio come back over the Realtime data/audio channels.
- Assistant audio is rendered directly from remote WebRTC track.
- Barge-in cancels active response immediately (`response.cancel` + output/input buffer clear).

2. `hybrid` (fallback)
- Bridge VAD segments -> OpenAI STT (`gpt-4o-*-transcribe`) -> OpenAI chat stream -> OpenAI TTS.

`VOICE_PIPELINE_MODE` controls the primary path.
`VOICE_PIPELINE_FALLBACK_TO_HYBRID=true` allows automatic fallback if realtime init fails.

## Project structure

- `/Users/uladzislaupraskou/voice-assistant/src/index.js` - CLI entrypoint (`npm start`).
- `/Users/uladzislaupraskou/voice-assistant/src/api.js` - Control API entrypoint (`npm run start:api`).
- `/Users/uladzislaupraskou/voice-assistant/src/runtime/bot-session.js` - session lifecycle, turn logic, barge-in.
- `/Users/uladzislaupraskou/voice-assistant/src/runtime/session-manager.js` - single active session manager.
- `/Users/uladzislaupraskou/voice-assistant/src/transports/bridge-realtime-adapter.js` - bridge-facing realtime controller.
- `/Users/uladzislaupraskou/voice-assistant/src/openai-stt-service.js` - hybrid STT turn stream.
- `/Users/uladzislaupraskou/voice-assistant/src/openai-service.js` - OpenAI chat + TTS responder.
- `/Users/uladzislaupraskou/voice-assistant/src/meet-controller.js` - Puppeteer + bridge wiring.
- `/Users/uladzislaupraskou/voice-assistant/src/transports/meet-transport-adapter.js` - Meet transport implementation.
- `/Users/uladzislaupraskou/voice-assistant/src/workflows/call-summary-graph.js` - post-call summary workflow.
- `/Users/uladzislaupraskou/voice-assistant/public/bridge.html` - browser audio bridge (capture/playback/VAD events).
- `/Users/uladzislaupraskou/voice-assistant/prompts/system-prompt.txt` - base system prompt.

## Requirements

- Node.js 18+
- Google Chrome (or `CHROME_PATH`)
- OpenAI API key
- Signed-in Google account in `CHROME_USER_DATA_DIR`

## Quick start

```bash
npm install
cp .env.example .env
npm start
```

Required env:
- `OPENAI_API_KEY`
- `MEET_URL`

## Control API

```bash
npm run start:api
```

Default address: `http://127.0.0.1:3200`

If `CONTROL_API_TOKEN` is set, send:
`Authorization: Bearer <token>`

## Control UI

`/Users/uladzislaupraskou/voice-assistant/control-ui`

```bash
cd control-ui
cp .env.example .env
npm install
npm run dev
```

UI: `http://127.0.0.1:3300`

## Ubuntu / Hetzner runbook

```bash
sudo apt-get update
sudo apt-get install -y \
  xvfb pulseaudio pulseaudio-utils \
  chromium-browser fonts-liberation fonts-noto-color-emoji

npm install
cp .env.example .env
npm run start:api:ubuntu
```

The ubuntu startup script prepares virtual PulseAudio devices and exports device labels for bridge STT/TTS routing.

## Environment variables

### Core
- `OPENAI_API_KEY`
- `MEET_URL`
- `OPENAI_MODEL`
- `OPENAI_TEMPERATURE`
- `SYSTEM_PROMPT_FILE`
- `SYSTEM_PROMPT`

### Voice pipeline
- `VOICE_PIPELINE_MODE` (`realtime` or `hybrid`)
- `VOICE_PIPELINE_FALLBACK_TO_HYBRID`

### Realtime mode
- `OPENAI_REALTIME_MODEL`
- `OPENAI_REALTIME_CONNECT_TIMEOUT_MS`
- `OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL`
- `OPENAI_REALTIME_TURN_DETECTION` (`manual`, `server_vad`, `semantic_vad`)
- `OPENAI_REALTIME_TURN_EAGERNESS`
- `OPENAI_REALTIME_VAD_THRESHOLD`
- `OPENAI_REALTIME_VAD_SILENCE_MS`
- `OPENAI_REALTIME_VAD_PREFIX_PADDING_MS`
- `OPENAI_REALTIME_INTERRUPT_RESPONSE_ON_TURN`

### Hybrid STT/TTS fallback
- `OPENAI_STT_MODEL`
- `OPENAI_STT_LANGUAGE`
- `OPENAI_STT_CHUNK_MS`
- `OPENAI_STT_TIMEOUT_MS`
- `OPENAI_STT_LOG_FINALS`
- `OPENAI_STT_LOG_PARTIALS`
- `OPENAI_STT_PARTIALS_ENABLED`
- `OPENAI_STT_PARTIAL_EMIT_MS`
- `OPENAI_STT_MAX_RETRIES`
- `OPENAI_STT_MIN_CHUNK_BYTES`
- `OPENAI_STT_MAX_QUEUE_CHUNKS`
- `OPENAI_STT_MIME_TYPE`
- `OPENAI_STT_DEVICE_ID`
- `OPENAI_STT_DEVICE_LABEL`
- `OPENAI_STT_PREFER_LOOPBACK`
- `OPENAI_STT_AUDIO_BITS_PER_SECOND`
- `OPENAI_STT_MIN_SIGNAL_PEAK`
- `OPENAI_STT_VAD_THRESHOLD`
- `OPENAI_STT_HANGOVER_MS`
- `OPENAI_STT_SEGMENT_MIN_MS`
- `OPENAI_STT_SEGMENT_MAX_MS`
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`
- `OPENAI_TTS_FORMAT`
- `OPENAI_TTS_TIMEOUT_MS`
- `BRIDGE_TTS_OUTPUT_DEVICE_ID`
- `BRIDGE_TTS_OUTPUT_DEVICE_LABEL`

### Turn-taking / interruption
- `TURN_SILENCE_MS`
- `TURN_CONTINUATION_SILENCE_MS`
- `POST_TURN_RESPONSE_DELAY_MS`
- `TURN_STITCH_ENABLED`
- `TURN_STITCH_WINDOW_MS`
- `SEMANTIC_EOT_ENABLED`
- `SEMANTIC_EOT_USE_LLM`
- `SEMANTIC_EOT_MODEL`
- `SEMANTIC_EOT_TIMEOUT_MS`
- `SEMANTIC_EOT_MIN_DELAY_MS`
- `SEMANTIC_EOT_MAX_DELAY_MS`
- `BARGE_IN_ENABLED`
- `BARGE_IN_ON_PARTIALS`
- `BARGE_IN_ON_VAD_CONFIRMED`
- `BARGE_IN_VAD_MIN_PEAK`
- `BARGE_IN_MIN_MS`
- `BARGE_IN_MIN_WORDS_OPENAI_STT`
- `BARGE_IN_CONTINUATION_WINDOW_MS`
- `SOFT_INTERRUPT_ENABLED`
- `SOFT_INTERRUPT_CONFIRM_MS`
- `SOFT_INTERRUPT_DUCK_LEVEL`
- `SILENCE_AFTER_SPEAK_MS`
- `INBOUND_DEDUP_MS`

### Browser / Meet
- `HEADLESS`
- `CHROME_PATH`
- `CHROME_USER_DATA_DIR`
- `MEET_ASSUME_LOGGED_IN`
- `MEET_JOIN_STATE_TIMEOUT_MS`
- `MEET_JOIN_POLL_MS`
- `MEET_JOIN_CLICK_ATTEMPTS`
- `MEET_JOIN_CLICK_RETRY_MS`
- `BRIDGE_HOST`
- `BRIDGE_PORT`

### API
- `CONTROL_API_HOST`
- `CONTROL_API_PORT`
- `CONTROL_API_TOKEN`
- `ALLOW_ANY_MEET_URL`

### Call summary
- `CALL_SUMMARY_ENABLED`
- `CALL_SUMMARY_MODEL`
- `CALL_SUMMARY_TEMPERATURE`
- `CALL_SUMMARY_MAX_TURNS`
- `CALL_SUMMARY_MAX_TRANSCRIPT_CHARS`
- `CALL_SUMMARY_MAX_OUTPUT_CHARS`
- `CALL_SUMMARY_TIMEOUT_MS`

## Health / control endpoints

```bash
curl http://127.0.0.1:3200/health
curl http://127.0.0.1:3200/api/v1/bot/status
```

Start session:

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

Stop session:

```bash
curl -X POST http://127.0.0.1:3200/api/v1/bot/stop \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual stop"}'
```

## Security

- Keep API on localhost unless protected by trusted proxy.
- Set `CONTROL_API_TOKEN` outside local dev.
- Do not commit real `.env` secrets.

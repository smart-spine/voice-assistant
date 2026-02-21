# Google Meet Voice Bot

Server-core voice assistant for Google Meet and Control-UI.
All turn-taking, VAD/EoT, interrupts, commit logic, STT/LLM/TTS orchestration run in the backend `VoiceEngine`.
Clients (Control-UI Voice tab and Meet bridge) are thin transports over `voice.core.v1`.

## Architecture

### Server Core (single source of truth)

- `src/voice-core/engine/voice-engine.js` - core host
- `src/voice-core/engine/session-manager.js` - lifecycle of core sessions
- `src/voice-core/engine/voice-session.js` - state machine + routing
- `src/voice-core/engine/turn-manager.js` - VAD/EoT/barge-in decisions
- `src/voice-core/engine/audio-pipeline.js` - input/output buffers + commit windows
- `src/voice-core/engine/ai-provider.js` - OpenAI Realtime adapter

### Transport Layer (thin)

- `public/bridge.html` - Meet transport page (audio in/out + protocol relay only)
- `control-ui/app/page.js` - Voice tab transport client (audio in/out + UI)
- `src/api/voice-ws-server.js` - `voice.core.v1` websocket host

### Control API + Settings

- `src/api/control-server.js` - REST + WS auth/tickets
- `src/config-service.js` - config preview/apply workflow
- `src/config-overrides-store.js` - encrypted overrides (AES-GCM)
- `src/config-audit-log.js` - config audit events

## Signal Flow

### Meet Bot Runtime

1. Meet audio enters bridge (`public/bridge.html`).
2. Bridge sends binary `audio.append` frames via `voice.core.v1` websocket.
3. `VoiceEngine` runs turn detection, commits input, requests AI response.
4. `VoiceEngine` streams binary output audio chunks back to bridge.
5. Bridge plays ready audio into Meet TX output.

### Control-UI Voice Tab

1. Browser captures mic.
2. UI sends binary input audio frames to `/ws/voice` (`voice.core.v1`).
3. Core emits events (`stt.partial`, `stt.final`, `assistant.state`, `metrics.tick`, `audio.clear`).
4. UI renders transcripts/latency and plays output audio chunks.

## Protocol

WebSocket subprotocol: `voice.core.v1`

Control messages (JSON envelopes):
- Client -> Core: `session.start`, `session.update`, `text.input`, `audio.commit`, `assistant.interrupt`, `session.stop`, `ping`
- Core -> Client: `session.started`, `session.state`, `turn.eot`, `stt.partial`, `stt.final`, `assistant.state`, `assistant.text.delta`, `assistant.text.final`, `audio.committed`, `audio.clear`, `text.committed`, `metrics.tick`, `warning`, `error`, `pong`

Audio messages:
- Binary frames (preferred) for both directions.

## Quick Start

```bash
npm install
cp .env.example .env
npm run start:api
```

Minimum required:
- `OPENAI_API_KEY`
- `CONTROL_API_TOKEN`

For Meet session start:
- `MEET_URL`

## Control API Endpoints

### Bot control

- `GET /health`
- `GET /api/v1/bot/status`
- `POST /api/v1/bot/start`
- `POST /api/v1/bot/stop`

### Voice websocket

- `POST /api/v1/voice/ws-ticket`
- `WS /ws/voice` (requires Bearer token or ticket)

### Config management

- `GET /api/v1/config/schema`
- `GET /api/v1/config?search=...`
- `PUT /api/v1/config` (validate + preview)
- `POST /api/v1/config/apply`
- `GET /api/v1/config/audit`

### Restart flag

- `GET /api/v1/restart-request`
- `POST /api/v1/restart-request`

## Secure Config Model

Precedence:
1. Base `.env`
2. Encrypted overrides file (`CONFIG_OVERRIDES_FILE`)
3. Runtime merged config

Sensitive keys are masked in API responses and audit output.
Writes are atomic (temp + fsync + rename) with backup versions.

## TTS Mapping (OpenAI Speech Create)

Supported vars:
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`
- `OPENAI_TTS_VOICE_ID`
- `OPENAI_TTS_FORMAT`
- `OPENAI_TTS_INSTRUCTIONS`
- `OPENAI_TTS_SPEED`
- `OPENAI_TTS_STREAM_FORMAT`

## Notes

- `VOICE_CORE_MODE=server` is the default and intended production mode.
- Legacy direct-realtime and hybrid transport paths are removed from runtime transport entrypoints.

## Tests

```bash
npm test
cd control-ui && npm run build
```

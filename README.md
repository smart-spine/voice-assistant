# Google Meet Voice Bot

Ultra-low-latency voice bot for Google Meet with OpenAI Realtime pipeline, secure Control API, and Control-UI voice/settings workflows.

## Runtime architecture

### 1) Meet bot runtime

- `realtime` mode (recommended): bridge page opens direct WebRTC session to OpenAI Realtime.
- `hybrid` fallback: bridge VAD segments -> OpenAI STT -> LLM stream -> OpenAI TTS.

Switch with `VOICE_PIPELINE_MODE=realtime|hybrid`.
Fallback is controlled by `VOICE_PIPELINE_FALLBACK_TO_HYBRID=true|false`.

### 2) Control API

- REST control endpoints for bot lifecycle.
- Secure config endpoints with validation + preview/apply.
- Voice websocket endpoint (`/ws/voice`) for browser-to-bot realtime voice sessions.

### 3) Control-UI

- Dashboard (API process + bot + logs).
- `Voice Bot` tab (mic, transcript, assistant audio, latency indicators).
- `Settings` tab (schema-driven config dictionary with secure apply flow).

## Key paths

- `/Users/uladzislaupraskou/voice-assistant/src/api.js` - Control API entrypoint
- `/Users/uladzislaupraskou/voice-assistant/src/runtime/bot-session.js` - Meet bot session lifecycle
- `/Users/uladzislaupraskou/voice-assistant/src/api/control-server.js` - REST + WS endpoints
- `/Users/uladzislaupraskou/voice-assistant/src/api/voice-ws-server.js` - voice WS runtime bridge
- `/Users/uladzislaupraskou/voice-assistant/src/config-service.js` - secure config preview/apply
- `/Users/uladzislaupraskou/voice-assistant/src/config-overrides-store.js` - encrypted overrides store
- `/Users/uladzislaupraskou/voice-assistant/src/config-audit-log.js` - config audit log
- `/Users/uladzislaupraskou/voice-assistant/control-ui/app/page.js` - tabs UI (Dashboard / Voice Bot / Settings)

## Quick start

```bash
npm install
cp .env.example .env
npm run start:api
```

Required minimum:

- `OPENAI_API_KEY`
- `CONTROL_API_TOKEN` (strongly recommended for all non-local environments)

For direct Meet auto-join session startup (`npm start`), also set:

- `MEET_URL`

## Control API endpoints

### Existing bot control

- `GET /health`
- `GET /api/v1/bot/status`
- `POST /api/v1/bot/start`
- `POST /api/v1/bot/stop`

### New secure config endpoints

- `GET /api/v1/config/schema`
- `GET /api/v1/config?search=...`
- `PUT /api/v1/config` (validate + preview)
- `POST /api/v1/config/apply`
- `GET /api/v1/config/audit`

### Voice session endpoints

- `POST /api/v1/voice/ws-ticket` (short-lived WS auth ticket)
- `WS /ws/voice` (requires bearer token or valid ticket)

### Restart-request flag endpoint

- `GET /api/v1/restart-request`
- `POST /api/v1/restart-request`

No remote shell or generic file-edit endpoints are exposed.

## Voice Bot tab (Control-UI)

In `Control-UI -> Voice Bot`:

1. Click `Connect` (WS session to Control API).
2. Pick microphone/speaker (if browser exposes devices).
3. Start mic (toggle mode) or hold `Hold To Talk` (PTT mode).
4. Watch:
   - user partial/final transcript,
   - assistant text,
   - assistant audio playback,
   - latency counters (STT partial/final, first audio).

## Safe configuration system

### Source precedence

1. Base `.env`
2. Encrypted UI overrides (`config.overrides.enc`)
3. Runtime merged config

### Storage

Overrides are encrypted at rest (AES-256-GCM) and written atomically:

- default overrides: `.config/config.overrides.enc`
- default backups: `.config/config-backups/`
- default audit log: `.config/config.audit.log`

Set a 32-byte key:

```env
CONFIG_ENCRYPTION_KEY=...
```

Accepted formats:

- 64-char hex
- base64 of 32 bytes
- raw 32-byte UTF-8 string

### Apply flow

1. UI submits changeset (`set` / `unset`).
2. Server validates key names + value types + allowlist.
3. Server returns preview diff.
4. UI applies by `previewId`.
5. Server atomically persists encrypted overrides, logs audit entry, updates runtime env.

Sensitive keys are always masked in API responses and audit diff.

## TTS config mapping (OpenAI Speech Create)

Supported vars:

- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`
- `OPENAI_TTS_VOICE_ID` (if set, used as custom voice object)
- `OPENAI_TTS_FORMAT`
- `OPENAI_TTS_INSTRUCTIONS`
- `OPENAI_TTS_SPEED`
- `OPENAI_TTS_STREAM_FORMAT`

Runtime uses modern speech params and falls back to legacy payload if provider rejects unknown fields.

## Security model summary

Protected against:

- unauthenticated config/voice API access (bearer token + WS ticket)
- unauthorized cross-origin browser calls (strict CORS allowlist)
- plaintext secret exposure (masking + log redaction)
- unsafe env/file mutation (schema allowlist + dangerous key blocklist)
- non-atomic config writes (temp + fsync + rename)

Not provided by design:

- remote command execution
- generic file browser/editor endpoints

## Migration plan (.env -> UI config)

1. Keep current `.env` as base configuration.
2. Set `CONFIG_ENCRYPTION_KEY` on server.
3. Restart API once so secure config service is active.
4. In Control-UI `Settings` tab:
   - apply non-secret tweaks first,
   - rotate secrets using new values (never revealed afterward).
5. Use preview/apply workflow for all further updates.
6. For changes marked `restart`, restart API process from Control-UI dashboard.

If needed, rollback by restoring latest backup from `.config/config-backups/`.

## Tests

Run root tests:

```bash
npm test
```

Run Control-UI build validation:

```bash
cd control-ui
npm run build
```

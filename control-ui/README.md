# Voice Bot Control UI

Control dashboard for Meet Voice Bot operations.

## Tabs

- `Dashboard`:
  - managed API process start/stop
  - bot start/stop
  - health/status
  - live logs

- `Voice Bot`:
  - realtime connect/disconnect
  - mic toggle + push-to-talk mode
  - input/output device selectors
  - transcript stream (partial/final)
  - assistant audio playback
  - latency indicators (STT partial/final, first audio)

- `Settings`:
  - schema-aware config dictionary
  - add/update/delete keys
  - preview diff before apply
  - apply preview by ID
  - audit log list

## Quick start

```bash
cd control-ui
cp .env.example .env
npm install
npm run dev
```

UI: `http://127.0.0.1:3300`

## Environment

- `CONTROL_API_BASE_URL` - Control API base URL
- `CONTROL_API_TOKEN` - bearer token used by server-side proxy routes
- `MANAGED_API_ENABLED` - allow UI to control local API process
- `MANAGED_API_COMMAND` - command to launch API
- `MANAGED_API_CWD` - working directory for managed command
- `CONTROL_API_TIMEOUT_MS` - default proxy timeout
- `CONTROL_API_START_TIMEOUT_MS` - longer timeout for `/bot/start`

## Internal routes (UI server)

- `GET /api/system/state`
- `POST /api/system/api`
- `POST /api/system/bot`
- `GET /api/system/logs`
- `GET /api/system/logs/stream`

Config routes:

- `GET /api/system/config/schema`
- `GET /api/system/config`
- `PUT /api/system/config`
- `POST /api/system/config/apply`
- `GET /api/system/config/audit`

Voice route:

- `POST /api/system/voice/ticket`

The browser never receives `CONTROL_API_TOKEN` directly; proxy routes add it server-side.

## Production

```bash
cd control-ui
npm run build
npm run start
```

Default bind: `0.0.0.0:3300`.

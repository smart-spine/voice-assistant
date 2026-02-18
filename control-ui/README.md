# Voice Bot Control UI

Dark-green Next.js dashboard for operating the existing voice-bot stack.

## What it does

- Starts/stops the local bot Control API process (`npm run start:api` or custom command).
- Starts/stops bot sessions via existing REST API (`/api/v1/bot/start`, `/api/v1/bot/stop`, `/api/v1/bot/status`).
- Streams unified logs in one place:
  - managed API stdout/stderr,
  - control actions from UI,
  - network/control errors.

Because bot session logs are emitted by the API process, API + bot logs appear in one stream.

## Quick start

```bash
cd control-ui
cp .env.example .env
npm install
npm run dev
```

Open: `http://localhost:3300`

## Environment

See `.env.example`.

Key values:

- `CONTROL_API_BASE_URL` - where existing bot control API is reachable.
- `CONTROL_API_TOKEN` - optional Bearer token for protected API.
- `CONTROL_API_START_TIMEOUT_MS` - timeout for `/api/v1/bot/start` (default `120000` ms).
- `MANAGED_API_ENABLED` - if `true`, UI can start/stop local API process.
- `MANAGED_API_COMMAND` - command to launch API process.
- `MANAGED_API_CWD` - working dir for command (default `..`, repo root from `control-ui`).

### Ubuntu/Hetzner recommended command

If API should bootstrap Xvfb/PulseAudio automatically:

```env
MANAGED_API_COMMAND=npm run start:api:ubuntu
```

## Internal API routes (inside control-ui)

- `GET /api/system/state` - snapshot of managed process + remote bot status.
- `POST /api/system/api` - `{ action: "start" | "stop" }` for managed API process.
- `POST /api/system/bot` - `{ action: "start" | "stop", ... }` for bot session.
- `GET /api/system/logs` - buffered logs snapshot.
- `GET /api/system/logs/stream` - SSE stream for live logs.

## Production run

```bash
cd control-ui
npm run build
npm run start
```

By default `start` binds `0.0.0.0:3300`.

const test = require("node:test");
const assert = require("node:assert/strict");
const { startControlServer, isAllowedMeetUrl } = require("../src/api/control-server");
const { WebSocket } = require("ws");

test("isAllowedMeetUrl enforces Google Meet host by default", () => {
  assert.equal(
    isAllowedMeetUrl("https://meet.google.com/abc-defg-hij", {
      allowAnyMeetUrl: false
    }),
    true
  );
  assert.equal(
    isAllowedMeetUrl("https://example.com/meeting", { allowAnyMeetUrl: false }),
    false
  );
});

test("control API validates auth token and meetUrl", async () => {
  const manager = {
    getStatus: () => ({ sessionId: null, status: "idle" }),
    startSession: async ({ meetUrl, projectContext }) => ({
      sessionId: "session_test",
      status: "running",
      meetUrl,
      hasProjectContext: Boolean(projectContext)
    }),
    stopSession: async () => ({
      sessionId: "session_test",
      status: "stopped"
    })
  };

  const api = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    authToken: "secret-token",
    allowAnyMeetUrl: false,
    manager
  });

  const base = `http://127.0.0.1:${api.port}`;

  const unauthorized = await fetch(`${base}/api/v1/bot/status`);
  assert.equal(unauthorized.status, 401);

  const invalidStart = await fetch(`${base}/api/v1/bot/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token"
    },
    body: JSON.stringify({ meetUrl: "https://example.com/x" })
  });
  assert.equal(invalidStart.status, 400);

  const invalidContextType = await fetch(`${base}/api/v1/bot/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer secret-token"
    },
    body: JSON.stringify({
      meetUrl: "https://meet.google.com/abc-defg-hij",
      projectContext: 42
    })
  });
  assert.equal(invalidContextType.status, 400);

  const validStart = await fetch(`${base}/api/v1/bot/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "bearer secret-token"
    },
    body: JSON.stringify({
      meetUrl: "https://meet.google.com/abc-defg-hij",
      projectContext: { requestedProduct: "AI caller bot" }
    })
  });
  assert.equal(validStart.status, 201);
  const payload = await validStart.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "running");
  assert.equal(payload.data.hasProjectContext, true);

  await api.stop();
});

test("control API allows non-Meet URL when explicitly enabled", async () => {
  const manager = {
    getStatus: () => ({ sessionId: null, status: "idle" }),
    startSession: async ({ meetUrl, forceRestart }) => ({
      sessionId: "session_test",
      status: "running",
      meetUrl,
      forceRestart
    }),
    stopSession: async () => ({
      sessionId: "session_test",
      status: "stopped"
    })
  };

  const api = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    authToken: "",
    allowAnyMeetUrl: true,
    manager
  });

  const base = `http://127.0.0.1:${api.port}`;
  const started = await fetch(`${base}/api/v1/bot/start`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      meetUrl: "http://example.com/custom-room",
      forceRestart: "true"
    })
  });

  assert.equal(started.status, 201);
  const payload = await started.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.meetUrl, "http://example.com/custom-room");
  assert.equal(payload.data.forceRestart, true);

  await api.stop();
});

test("control API config endpoints require auth and return masked values", async () => {
  const manager = {
    getStatus: () => ({ sessionId: null, status: "idle" }),
    startSession: async () => ({ sessionId: "x", status: "running" }),
    stopSession: async () => ({ sessionId: "x", status: "stopped" })
  };

  const configService = {
    getSchema: () => [
      {
        key: "OPENAI_API_KEY",
        type: "string",
        sensitive: true
      }
    ],
    getConfigSnapshot: () => ({
      entries: [
        {
          key: "OPENAI_API_KEY",
          value: "********",
          sensitive: true,
          source: "override"
        }
      ]
    }),
    preview: () => ({
      ok: true,
      previewId: "preview_1",
      diff: [],
      restartRequired: false
    }),
    applyPreview: async () => ({
      ok: true,
      diff: [],
      restartRequired: false
    }),
    getAudit: () => []
  };

  const api = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    authToken: "secret-token",
    allowAnyMeetUrl: false,
    manager,
    configService
  });

  const base = `http://127.0.0.1:${api.port}`;

  const unauthorized = await fetch(`${base}/api/v1/config`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${base}/api/v1/config`, {
    headers: {
      Authorization: "Bearer secret-token"
    }
  });
  assert.equal(authorized.status, 200);
  const payload = await authorized.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.entries[0].value, "********");

  await api.stop();
});

test("voice websocket rejects unauthenticated clients and accepts signed tickets", async () => {
  const manager = {
    getStatus: () => ({ sessionId: null, status: "idle" }),
    startSession: async () => ({ sessionId: "x", status: "running" }),
    stopSession: async () => ({ sessionId: "x", status: "stopped" }),
    getConfig: () => ({
      openaiApiKey: "sk-test",
      openaiRealtimeModel: "gpt-4o-mini-realtime-preview-2024-12-17"
    })
  };

  const api = await startControlServer({
    port: 0,
    host: "127.0.0.1",
    authToken: "secret-token",
    allowAnyMeetUrl: false,
    manager
  });

  const baseHttp = `http://127.0.0.1:${api.port}`;
  const baseWs = `ws://127.0.0.1:${api.port}`;

  const unauthorizedAttempt = await new Promise((resolve) => {
    const ws = new WebSocket(`${baseWs}/ws/voice`);
    ws.once("unexpected-response", (_, response) => {
      resolve(response.statusCode);
    });
    ws.once("error", () => {
      resolve(401);
    });
  });
  assert.equal(Number(unauthorizedAttempt), 401);

  const ticketResponse = await fetch(`${baseHttp}/api/v1/voice/ws-ticket`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ttlMs: 60000 })
  });
  assert.equal(ticketResponse.status, 200);
  const ticketPayload = await ticketResponse.json();
  assert.equal(ticketPayload.ok, true);
  assert.ok(ticketPayload.data.ticket);

  const welcome = await new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${baseWs}/ws/voice?ticket=${encodeURIComponent(ticketPayload.data.ticket)}`
    );
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for welcome event."));
    }, 5000);

    ws.on("message", (message) => {
      const parsed = JSON.parse(String(message || "{}"));
      if (parsed.type === "welcome") {
        clearTimeout(timeout);
        ws.close();
        resolve(parsed);
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  assert.equal(welcome.type, "welcome");
  assert.ok(welcome.session_id);

  await api.stop();
});

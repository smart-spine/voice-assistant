const test = require("node:test");
const assert = require("node:assert/strict");
const { startControlServer, isAllowedMeetUrl } = require("../src/api/control-server");

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

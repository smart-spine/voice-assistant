const express = require("express");
const crypto = require("crypto");
const { log, warn, error } = require("../logger");
const { isAllowedMeetUrl } = require("../config");
const { normalizeProjectContext } = require("../prompts/prompt-builder");

function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ""));
  const bBuf = Buffer.from(String(b || ""));
  if (aBuf.length !== bBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function parseBearerToken(authorizationHeader) {
  const value = String(authorizationHeader || "").trim();
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) {
    return "";
  }
  return String(match[1] || "").trim();
}

function parseBooleanFlag(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function parseProjectContext(value) {
  if (value === undefined || value === null) {
    return { ok: true, value: "" };
  }

  if (typeof value !== "string" && typeof value !== "object") {
    return {
      ok: false,
      error: "`projectContext` must be a string or JSON object."
    };
  }

  return {
    ok: true,
    value: normalizeProjectContext(value, 6000)
  };
}

async function startControlServer({
  port,
  host = "127.0.0.1",
  manager,
  authToken = "",
  allowAnyMeetUrl = false
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.use((req, res, next) => {
    if (!authToken) {
      return next();
    }

    const tokenFromHeader = parseBearerToken(req.get("authorization"));
    if (!safeEqual(tokenFromHeader, authToken)) {
      return res.status(401).json({
        ok: false,
        error: "Unauthorized. Provide a valid bearer token."
      });
    }

    return next();
  });

  app.get("/health", (_, res) => {
    res.json({ ok: true, service: "voice-bot-control-api" });
  });

  app.get("/api/v1/bot/status", (_, res) => {
    res.json({ ok: true, data: manager.getStatus() });
  });

  app.post("/api/v1/bot/start", async (req, res) => {
    try {
      const { meetUrl, forceRestart = false, projectContext } = req.body || {};
      if (!meetUrl || !isAllowedMeetUrl(meetUrl, { allowAnyMeetUrl })) {
        return res.status(400).json({
          ok: false,
          error:
            "Request body must include a valid `meetUrl` (default: https://meet.google.com/...)."
        });
      }

      const parsedContext = parseProjectContext(projectContext);
      if (!parsedContext.ok) {
        return res.status(400).json({
          ok: false,
          error: parsedContext.error
        });
      }

      const status = await manager.startSession({
        meetUrl,
        forceRestart: parseBooleanFlag(forceRestart, false),
        projectContext: parsedContext.value
      });
      return res.status(201).json({ ok: true, data: status });
    } catch (err) {
      if (err?.code === "SESSION_ALREADY_RUNNING") {
        return res.status(409).json({
          ok: false,
          error: err.message,
          data: manager.getStatus()
        });
      }

      error("API", err?.stack || err?.message || String(err));
      return res.status(500).json({ ok: false, error: "Internal server error." });
    }
  });

  app.post("/api/v1/bot/stop", async (req, res) => {
    try {
      const { reason } = req.body || {};
      const status = await manager.stopSession({ reason });
      return res.json({ ok: true, data: status });
    } catch (err) {
      error("API", err?.stack || err?.message || String(err));
      return res.status(500).json({ ok: false, error: "Internal server error." });
    }
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.on("error", reject);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 16000;
  server.keepAliveTimeout = 5000;

  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : Number(port);

  log(
    "API",
    `Control API is running on http://${host}:${actualPort} (auth=${
      authToken ? "enabled" : "disabled"
    }, allowAnyMeetUrl=${allowAnyMeetUrl ? "true" : "false"}).`
  );

  return {
    app,
    server,
    port: actualPort,
    host,
    stop: async () =>
      new Promise((resolve) => {
        server.close(() => {
          warn("API", "Control API stopped.");
          resolve();
        });
      })
  };
}

module.exports = {
  startControlServer,
  isAllowedMeetUrl
};

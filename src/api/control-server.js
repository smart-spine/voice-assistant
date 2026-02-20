const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { log, warn, error } = require("../logger");
const { isAllowedMeetUrl } = require("../config");
const { normalizeProjectContext } = require("../prompts/prompt-builder");
const { attachVoiceWsServer } = require("./voice-ws-server");

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

function normalizeOrigin(origin) {
  try {
    const url = new URL(String(origin || ""));
    return url.origin;
  } catch (_) {
    return "";
  }
}

function buildCorsAllowlist(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map((item) => normalizeOrigin(item)).filter(Boolean))];
}

function createCorsMiddleware({ allowlist = [] } = {}) {
  const normalizedAllowlist = buildCorsAllowlist(allowlist);
  const allowAny = normalizedAllowlist.length === 0;

  return (req, res, next) => {
    const origin = normalizeOrigin(req.get("origin"));

    if (origin) {
      const allowed = allowAny ? false : normalizedAllowlist.includes(origin);
      if (!allowed) {
        return res.status(403).json({
          ok: false,
          error: "Origin is not allowed."
        });
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "3600");
    }

    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    return next();
  };
}

function createRateLimiter({
  windowMs = 60_000,
  limit = 30,
  keyFn = (req) => req.ip || "unknown"
} = {}) {
  const buckets = new Map();

  return (req, res, next) => {
    const now = Date.now();
    const key = String(keyFn(req) || "unknown");
    const current = buckets.get(key) || [];
    const active = current.filter((ts) => now - ts <= windowMs);

    if (active.length >= limit) {
      return res.status(429).json({
        ok: false,
        error: "Too many requests. Retry later."
      });
    }

    active.push(now);
    buckets.set(key, active);
    return next();
  };
}

function base64UrlEncode(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signTicketBody(body, secret) {
  return crypto
    .createHmac("sha256", String(secret || ""))
    .update(body)
    .digest("base64url");
}

function createWsTicket({ actor = "api", ttlMs = 60_000, secret = "" } = {}) {
  const payload = {
    actor: String(actor || "api"),
    iat: Date.now(),
    exp: Date.now() + Math.max(10_000, Math.min(5 * 60_000, Number(ttlMs) || 60_000)),
    nonce: crypto.randomBytes(12).toString("hex")
  };

  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = signTicketBody(body, secret);
  return `${body}.${signature}`;
}

function verifyWsTicket(ticket, { secret = "" } = {}) {
  const value = String(ticket || "").trim();
  if (!value || !value.includes(".")) {
    return { ok: false, reason: "ticket_missing" };
  }

  const [body, signature] = value.split(".");
  const expected = signTicketBody(body, secret);
  if (!safeEqual(signature, expected)) {
    return { ok: false, reason: "ticket_invalid_signature" };
  }

  let payload = null;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch (_) {
    return { ok: false, reason: "ticket_malformed" };
  }

  if (!payload || Number(payload.exp || 0) < Date.now()) {
    return { ok: false, reason: "ticket_expired" };
  }

  return {
    ok: true,
    actor: String(payload.actor || "api")
  };
}

function resolveRestartFlagPath() {
  return path.resolve(process.cwd(), ".config/restart.requested.json");
}

function writeRestartRequestedFlag({ reason = "config_change", actor = "api" } = {}) {
  const filePath = resolveRestartFlagPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = {
    requestedAt: new Date().toISOString(),
    reason: String(reason || "config_change"),
    actor: String(actor || "api")
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return filePath;
}

function readRestartRequestedFlag() {
  const filePath = resolveRestartFlagPath();
  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      filePath,
      payload: null
    };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const payload = JSON.parse(raw);
    return {
      exists: true,
      filePath,
      payload
    };
  } catch (_) {
    return {
      exists: true,
      filePath,
      payload: null
    };
  }
}

function actorFromRequest(req) {
  const explicit = String(req.get("x-actor") || "").trim();
  if (explicit) {
    return explicit;
  }
  return `token:${req.ip || "unknown"}`;
}

function requestMeta(req) {
  return {
    ip: req.ip || req.socket?.remoteAddress || "unknown",
    userAgent: String(req.get("user-agent") || "")
  };
}

function getWsAuthTokenFromRequest({ request, url }) {
  const headerToken = parseBearerToken(request.headers?.authorization || "");
  if (headerToken) {
    return headerToken;
  }
  const queryToken = String(url.searchParams.get("token") || "").trim();
  if (queryToken) {
    return queryToken;
  }
  return "";
}

async function startControlServer({
  port,
  host = "127.0.0.1",
  manager,
  authToken = "",
  allowAnyMeetUrl = false,
  corsAllowlist = [],
  configService = null,
  getRuntimeConfig = () => manager?.getConfig?.() || manager?.config || {}
}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  const normalizedCorsAllowlist = buildCorsAllowlist(corsAllowlist);
  app.use(
    createCorsMiddleware({
      allowlist: normalizedCorsAllowlist
    })
  );

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

  const configRateLimiter = createRateLimiter({
    windowMs: 60_000,
    limit: 30,
    keyFn: (req) => `cfg:${req.ip || "unknown"}`
  });

  if (configService) {
    app.get("/api/v1/config/schema", configRateLimiter, (req, res) => {
      res.json({
        ok: true,
        data: {
          schema: configService.getSchema()
        }
      });
    });

    app.get("/api/v1/config", configRateLimiter, (req, res) => {
      const search = String(req.query.search || "").trim();
      res.json({
        ok: true,
        data: configService.getConfigSnapshot({ search })
      });
    });

    app.put("/api/v1/config", configRateLimiter, (req, res) => {
      const preview = configService.preview({
        changeSet: req.body || {},
        actor: actorFromRequest(req),
        requestMeta: requestMeta(req)
      });

      if (!preview.ok) {
        return res.status(400).json({
          ok: false,
          error: "Config validation failed.",
          data: preview
        });
      }

      return res.json({ ok: true, data: preview });
    });

    app.post("/api/v1/config/apply", configRateLimiter, async (req, res) => {
      try {
        const previewId = String(req.body?.previewId || "").trim();
        if (!previewId) {
          return res.status(400).json({
            ok: false,
            error: "`previewId` is required."
          });
        }

        const applied = await configService.applyPreview({
          previewId,
          actor: actorFromRequest(req),
          requestMeta: requestMeta(req)
        });

        if (applied.restartRequired) {
          writeRestartRequestedFlag({
            reason: "config_apply_restart_required",
            actor: actorFromRequest(req)
          });
        }

        return res.json({ ok: true, data: applied });
      } catch (err) {
        return res.status(400).json({
          ok: false,
          error: String(err?.message || "Failed to apply configuration preview.")
        });
      }
    });

    app.get("/api/v1/config/audit", configRateLimiter, (req, res) => {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isFinite(rawLimit) ? rawLimit : 200;
      const entries = configService.getAudit({ limit });
      res.json({
        ok: true,
        data: {
          entries
        }
      });
    });
  }

  app.get("/api/v1/restart-request", (req, res) => {
    const state = readRestartRequestedFlag();
    res.json({
      ok: true,
      data: state
    });
  });

  app.post("/api/v1/restart-request", (req, res) => {
    const reason = String(req.body?.reason || "manual_restart_request").trim();
    const filePath = writeRestartRequestedFlag({
      reason,
      actor: actorFromRequest(req)
    });
    res.json({
      ok: true,
      data: {
        requested: true,
        reason,
        filePath
      }
    });
  });

  const wsTicketRateLimiter = createRateLimiter({
    windowMs: 60_000,
    limit: 20,
    keyFn: (req) => `ws-ticket:${req.ip || "unknown"}`
  });

  const wsTicketSecret = authToken || crypto.randomBytes(32).toString("hex");

  app.post("/api/v1/voice/ws-ticket", wsTicketRateLimiter, (req, res) => {
    const actor = actorFromRequest(req);
    const ttlMs = Number(req.body?.ttlMs || 60_000);
    const ticket = createWsTicket({ actor, ttlMs, secret: wsTicketSecret });

    res.json({
      ok: true,
      data: {
        ticket,
        expiresInMs: Math.max(10_000, Math.min(5 * 60_000, ttlMs || 60_000)),
        wsPath: "/ws/voice"
      }
    });
  });

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(port, host, () => resolve(instance));
    instance.on("error", reject);
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 16000;
  server.keepAliveTimeout = 5000;

  const voiceWs = attachVoiceWsServer({
    server,
    path: "/ws/voice",
    authenticate: ({ request, url }) => {
      const origin = normalizeOrigin(request.headers.origin || "");
      if (origin && normalizedCorsAllowlist.length > 0) {
        if (!normalizedCorsAllowlist.includes(origin)) {
          return { ok: false, reason: "origin_not_allowed" };
        }
      }

      if (!authToken) {
        return { ok: true, actor: `anon:${request.socket.remoteAddress || "unknown"}` };
      }

      const ticket = String(url.searchParams.get("ticket") || "").trim();
      if (ticket) {
        const verified = verifyWsTicket(ticket, { secret: wsTicketSecret });
        if (verified.ok) {
          return { ok: true, actor: verified.actor || "ws-ticket" };
        }
      }

      const token = getWsAuthTokenFromRequest({ request, url });
      if (safeEqual(token, authToken)) {
        return { ok: true, actor: "ws-token" };
      }

      return { ok: false, reason: "unauthorized" };
    },
    getRuntimeConfig,
    getRateLimiterKey: ({ request, auth }) =>
      `${auth?.actor || "unknown"}:${request.socket.remoteAddress || "unknown"}`
  });

  const address = server.address();
  const actualPort =
    address && typeof address === "object" ? address.port : Number(port);

  log(
    "API",
    `Control API is running on http://${host}:${actualPort} (auth=${
      authToken ? "enabled" : "disabled"
    }, allowAnyMeetUrl=${allowAnyMeetUrl ? "true" : "false"}, corsAllowlist=${
      normalizedCorsAllowlist.length > 0
        ? normalizedCorsAllowlist.join("|")
        : "disabled"
    }).`
  );

  return {
    app,
    server,
    port: actualPort,
    host,
    stop: async () =>
      new Promise((resolve) => {
        voiceWs
          .stop()
          .catch(() => {})
          .finally(() => {
            server.close(() => {
              warn("API", "Control API stopped.");
              resolve();
            });
          });
      })
  };
}

module.exports = {
  startControlServer,
  isAllowedMeetUrl
};

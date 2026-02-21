const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { log, warn } = require("../logger");
const {
  VoiceEngine,
  PROTOCOL_VERSION,
  buildEnvelope,
  parseEnvelope,
  createId,
  normalizeType,
  normalizeAudioFrame,
  encodeBinaryAudioFrame
} = require("../voice-core");

function nowMs() {
  return Date.now();
}

function randomId(prefix = "voice") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function redactOpenAiError(message) {
  const text = String(message || "");
  if (!text) {
    return "Unknown upstream error.";
  }
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***");
}

function closeWithHttpError(socket, statusCode, statusText) {
  try {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
  } catch (_) {
    // Ignore socket write errors.
  }
  try {
    socket.destroy();
  } catch (_) {
    // Ignore destroy errors.
  }
}

class VoiceCoreWsSession {
  constructor({
    ws,
    actor = "unknown",
    getRuntimeConfig,
    voiceEngine,
    onClose = () => {}
  }) {
    this.ws = ws;
    this.actor = String(actor || "unknown");
    this.getRuntimeConfig = getRuntimeConfig;
    this.voiceEngine = voiceEngine;
    this.onClose = onClose;

    this.connectionId = randomId("voice_core_ws");
    this.engineSessionId = "";
    this.closed = false;
    this.lastSessionState = "stopped";

    this.transport = {
      sendControl: async (envelope) => {
        await this.sendCoreControlToClient(envelope);
      },
      sendAudio: async (frame) => {
        await this.sendCoreAudioToClient(frame);
      },
      close: async () => {
        // Connection lifecycle is managed by ws close handlers.
      }
    };
  }

  getRuntimeSnapshot() {
    const runtime = this.getRuntimeConfig?.();
    return runtime && typeof runtime === "object" ? runtime : {};
  }

  sendRawJson(payload = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  sendRawBinary(binaryPayload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(binaryPayload, { binary: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  sendError(code, message, { fatal = false, replyTo = undefined } = {}) {
    const envelope = buildEnvelope({
      v: PROTOCOL_VERSION,
      type: "error",
      sessionId: this.engineSessionId || this.connectionId,
      msgId: createId("core"),
      replyTo: replyTo || undefined,
      tsMs: nowMs(),
      payload: {
        code: String(code || "voice_error").trim() || "voice_error",
        message: redactOpenAiError(message || "Voice session error."),
        fatal: Boolean(fatal),
        t_ms: nowMs()
      }
    });
    this.sendRawJson(envelope);
  }

  sendWelcome() {
    this.sendRawJson(
      buildEnvelope({
        v: PROTOCOL_VERSION,
        type: "welcome",
        sessionId: this.connectionId,
        msgId: createId("core"),
        tsMs: nowMs(),
        payload: {
          session_id: this.connectionId,
          actor: this.actor,
          protocol: "voice.core.v1",
          t_ms: nowMs()
        }
      })
    );
  }

  maybeLogStateTransition(envelope) {
    if (!envelope || envelope.type !== "session.state") {
      return;
    }
    const nextState = String(envelope?.payload?.state || "")
      .trim()
      .toLowerCase();
    if (!nextState) {
      return;
    }
    const fromState = this.lastSessionState || "unknown";
    if (fromState !== nextState) {
      log(
        "VOICE-WS",
        `[${this.engineSessionId || this.connectionId}] transition: ${fromState} -> ${nextState}`
      );
      this.lastSessionState = nextState;
    }
  }

  async sendCoreControlToClient(envelope = {}) {
    this.maybeLogStateTransition(envelope);
    this.sendRawJson(envelope);
  }

  async sendCoreAudioToClient(frame = {}) {
    const normalized = normalizeAudioFrame(
      {
        ...frame,
        kind: "output_audio"
      },
      {
        defaultKind: "output_audio"
      }
    );
    const binary = encodeBinaryAudioFrame(normalized);
    this.sendRawBinary(binary);
  }

  refreshEngineRuntimeConfig() {
    const runtimeConfig = this.getRuntimeSnapshot();
    this.voiceEngine.runtimeConfig = runtimeConfig;
    if (this.voiceEngine.sessionManager) {
      this.voiceEngine.sessionManager.runtimeConfig = runtimeConfig;
    }
  }

  async startEngineSession(startEnvelope) {
    if (this.engineSessionId) {
      throw new Error("Voice session is already started.");
    }

    this.refreshEngineRuntimeConfig();
    const requestedSessionId = String(startEnvelope?.session_id || "").trim();
    const status = await this.voiceEngine.createSession(this.transport, {
      sessionId: requestedSessionId,
      startEnvelope
    });

    this.engineSessionId = String(
      status?.session_id || requestedSessionId || this.connectionId
    ).trim();
  }

  async routeCoreControl(payload = {}) {
    const parsed = parseEnvelope(payload, {
      requireSessionId: false,
      strictType: false,
      allowUnknownType: true
    });

    if (!parsed.ok) {
      throw new Error(parsed.message);
    }

    const envelope = parsed.value;
    if (envelope.type === "session.start") {
      await this.startEngineSession(envelope);
      return;
    }

    if (envelope.type === "ping" && !this.engineSessionId) {
      this.sendRawJson(
        buildEnvelope({
          v: PROTOCOL_VERSION,
          type: "pong",
          sessionId: this.connectionId,
          msgId: createId("core"),
          replyTo: envelope.msg_id,
          tsMs: nowMs(),
          payload: {
            nonce: envelope?.payload?.nonce,
            t_ms: nowMs()
          }
        })
      );
      return;
    }

    if (envelope.type === "session.stop") {
      await this.stop(String(envelope?.payload?.reason || "client_stop"));
      return;
    }

    if (!this.engineSessionId) {
      throw new Error("Voice session is not started.");
    }

    const normalizedSessionId = String(envelope.session_id || "").trim();
    const routedEnvelope =
      normalizedSessionId && normalizedSessionId === this.engineSessionId
        ? envelope
        : {
            ...envelope,
            session_id: this.engineSessionId
          };

    await this.voiceEngine.routeControl(this.engineSessionId, routedEnvelope);
  }

  async handleClientMessage(rawMessage, isBinary = false) {
    if (isBinary) {
      if (!this.engineSessionId) {
        throw new Error("Voice session is not started.");
      }
      await this.voiceEngine.routeBinaryAudio(this.engineSessionId, rawMessage);
      return;
    }

    let payload = null;
    try {
      payload = JSON.parse(String(rawMessage || ""));
    } catch (_) {
      throw new Error("Control frame is not valid JSON.");
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Envelope must be a JSON object.");
    }

    await this.routeCoreControl(payload);
  }

  async stop(reason = "socket_closed") {
    const normalizedReason = String(reason || "socket_closed").trim() || "socket_closed";
    if (!this.engineSessionId) {
      return;
    }

    const sessionId = this.engineSessionId;
    this.engineSessionId = "";
    this.lastSessionState = "stopped";

    try {
      await this.voiceEngine.stopSession(sessionId, normalizedReason);
    } catch (stopError) {
      warn(
        "VOICE-WS",
        `failed to stop voice-core session ${sessionId}: ${redactOpenAiError(
          stopError?.message || stopError
        )}`
      );
    }
  }

  async close(reason = "socket_closed") {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.stop(reason);
    this.onClose();
  }
}

function attachVoiceWsServer({
  server,
  path = "/ws/voice",
  authenticate = () => ({ ok: true, actor: "anonymous" }),
  getRuntimeConfig = () => ({}),
  getRateLimiterKey = () => "voice:global",
  maxConnectionsPerKey = 4
} = {}) {
  const baseRuntimeConfig = getRuntimeConfig() || {};
  const voiceEngine = new VoiceEngine({
    runtimeConfig: baseRuntimeConfig
  });

  void voiceEngine
    .init()
    .then(() => {
      log("VOICE-WS", "VoiceEngine initialized.");
    })
    .catch((initError) => {
      warn(
        "VOICE-WS",
        `VoiceEngine initialization failed: ${redactOpenAiError(
          initError?.message || initError
        )}`
      );
    });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: (protocols) => {
      if (protocols && typeof protocols.has === "function" && protocols.has("voice.core.v1")) {
        return "voice.core.v1";
      }
      return undefined;
    }
  });

  const liveConnectionsByKey = new Map();

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== path) {
      return;
    }

    const auth = authenticate({ request, url });
    if (!auth?.ok) {
      closeWithHttpError(socket, 401, "Unauthorized");
      return;
    }

    const limiterKey = String(getRateLimiterKey({ request, auth }) || "voice:global");
    const active = Number(liveConnectionsByKey.get(limiterKey) || 0);
    if (active >= maxConnectionsPerKey) {
      closeWithHttpError(socket, 429, "Too Many Requests");
      return;
    }

    const requestedProtocols = String(request.headers["sec-websocket-protocol"] || "");
    const requestedProtocolList = requestedProtocols
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const hasRequestedCoreProtocol = requestedProtocolList.includes("voice.core.v1");
    if (!hasRequestedCoreProtocol) {
      closeWithHttpError(socket, 426, "Upgrade Required");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, auth, limiterKey);
    });
  });

  wss.on("connection", (ws, request, auth, limiterKey) => {
    const remote = `${request.socket.remoteAddress || "unknown"}:${
      request.socket.remotePort || "?"
    }`;
    liveConnectionsByKey.set(limiterKey, (liveConnectionsByKey.get(limiterKey) || 0) + 1);

    log("VOICE-WS", `connected actor=${auth?.actor || "unknown"} remote=${remote}`);

    const session = new VoiceCoreWsSession({
      ws,
      actor: auth?.actor || "unknown",
      getRuntimeConfig,
      voiceEngine
    });

    log(
      "VOICE-WS",
      `voice core mode=server (subprotocol=${String(ws.protocol || "none") || "none"})`
    );

    ws.on("message", async (data, isBinary) => {
      try {
        await session.handleClientMessage(data, isBinary);
      } catch (err) {
        warn(
          "VOICE-WS",
          `bad_request actor=${auth?.actor || "unknown"}: ${redactOpenAiError(
            err?.message || err
          )}`
        );
        session.sendError("bad_request", err?.message || "Invalid voice message.");
      }
    });

    ws.on("close", () => {
      session.close("client_disconnect").catch(() => {});
      const current = Math.max(0, Number(liveConnectionsByKey.get(limiterKey) || 1) - 1);
      if (current <= 0) {
        liveConnectionsByKey.delete(limiterKey);
      } else {
        liveConnectionsByKey.set(limiterKey, current);
      }
      log("VOICE-WS", `disconnected actor=${auth?.actor || "unknown"} remote=${remote}`);
    });

    ws.on("error", (err) => {
      warn("VOICE-WS", `socket error: ${redactOpenAiError(err?.message || err)}`);
    });

    session.sendWelcome();
  });

  return {
    wss,
    voiceEngine,
    stop: async () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          try {
            client.close();
          } catch (_) {
            // Ignore close errors.
          }
        }
        wss.close(() => {
          voiceEngine
            .shutdown("voice_ws_server_stop")
            .catch((shutdownError) => {
              warn(
                "VOICE-WS",
                `voice engine shutdown failed: ${redactOpenAiError(
                  shutdownError?.message || shutdownError
                )}`
              );
            })
            .finally(() => resolve());
        });
      })
  };
}

module.exports = {
  attachVoiceWsServer
};

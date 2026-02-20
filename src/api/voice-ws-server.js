const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { log, warn } = require("../logger");

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function nowMs() {
  return Date.now();
}

function randomId(prefix = "voice") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function clampNumber(value, { fallback, min = -Infinity, max = Infinity, integer = false }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = integer ? Math.trunc(parsed) : parsed;
  return Math.min(max, Math.max(min, normalized));
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLanguageTag(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) {
    return "";
  }
  const [primary] = value.split("-");
  if (!primary || primary.length < 2 || primary.length > 3) {
    return "";
  }
  return primary;
}

function normalizeForEchoComparison(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeEchoTranscript(userText, assistantText) {
  const normalizedUser = normalizeForEchoComparison(userText);
  const normalizedAssistant = normalizeForEchoComparison(assistantText);
  if (!normalizedUser || !normalizedAssistant) {
    return false;
  }

  if (normalizedUser.length < 12 || normalizedAssistant.length < 12) {
    return false;
  }

  if (normalizedUser === normalizedAssistant) {
    return true;
  }

  if (
    normalizedUser.length >= 18 &&
    (normalizedAssistant.includes(normalizedUser) || normalizedUser.includes(normalizedAssistant))
  ) {
    return true;
  }

  const userTokens = new Set(
    normalizedUser
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 2)
  );
  const assistantTokens = new Set(
    normalizedAssistant
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 2)
  );

  if (!userTokens.size || !assistantTokens.size) {
    return false;
  }

  let overlap = 0;
  for (const token of userTokens) {
    if (assistantTokens.has(token)) {
      overlap += 1;
    }
  }

  const recall = overlap / userTokens.size;
  return userTokens.size >= 4 && recall >= 0.82;
}

function buildRealtimeTurnDetection(options = {}) {
  const type = String(options.turnDetection || "server_vad")
    .trim()
    .toLowerCase();
  if (type === "server_vad") {
    return {
      type: "server_vad",
      threshold: clampNumber(options.vadThreshold, {
        fallback: 0.45,
        min: 0,
        max: 1
      }),
      silence_duration_ms: clampNumber(options.vadSilenceMs, {
        fallback: 280,
        min: 120,
        max: 2000,
        integer: true
      }),
      prefix_padding_ms: clampNumber(options.vadPrefixPaddingMs, {
        fallback: 180,
        min: 0,
        max: 1000,
        integer: true
      }),
      create_response: true,
      interrupt_response: options.interruptResponseOnTurn !== false
    };
  }
  if (type === "semantic_vad") {
    const eagerness = String(options.turnDetectionEagerness || "auto")
      .trim()
      .toLowerCase();
    return {
      type: "semantic_vad",
      eagerness: ["low", "medium", "high", "auto"].includes(eagerness)
        ? eagerness
        : "auto",
      create_response: true,
      interrupt_response: options.interruptResponseOnTurn !== false
    };
  }
  return null;
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

class VoiceRealtimeBridgeSession {
  constructor({ ws, getRuntimeConfig, onClose = () => {} }) {
    this.ws = ws;
    this.getRuntimeConfig = getRuntimeConfig;
    this.onClose = onClose;

    this.sessionId = randomId("voice_ws");
    this.upstream = null;
    this.started = false;
    this.closed = false;
    this.clientTurnDetection = "server_vad";
    this.assistantInProgress = false;
    this.ttsSeq = 0;
    this.partialBufferByItem = new Map();
    this.assistantTextByResponse = new Map();
    this.lastUserSpeechStartedAt = 0;
    this.lastAssistantAudioAt = 0;
    this.lastAssistantTranscript = "";
    this.lastResponseCreatedAt = 0;
    this.pendingCommitResponseTimer = null;
    this.pendingResponseAfterCommit = false;
    this.lastCommitAt = 0;
  }

  clearPendingCommitResponseTimer() {
    if (!this.pendingCommitResponseTimer) {
      return;
    }
    clearTimeout(this.pendingCommitResponseTimer);
    this.pendingCommitResponseTimer = null;
  }

  send(event = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.ws.send(JSON.stringify(event));
      return true;
    } catch (_) {
      return false;
    }
  }

  sendError(code, message) {
    const normalizedMessage = String(message || "").toLowerCase();
    if (
      normalizedMessage.includes("committing input audio buffer") ||
      normalizedMessage.includes("buffer too small")
    ) {
      this.pendingResponseAfterCommit = false;
      this.lastCommitAt = 0;
      this.clearPendingCommitResponseTimer();
    }

    this.send({
      type: "error",
      code: String(code || "voice_error"),
      message: redactOpenAiError(message)
    });
  }

  sendUpstream(event = {}) {
    if (!this.upstream || this.upstream.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      this.upstream.send(JSON.stringify(event));
      return true;
    } catch (_) {
      return false;
    }
  }

  async startSession(payload = {}) {
    await this.stopSession({ reason: "restart" });

    const runtimeConfig = this.getRuntimeConfig();
    const apiKey = String(runtimeConfig?.openaiApiKey || "").trim();
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    const model = normalizeText(payload.model || runtimeConfig?.openaiRealtimeModel);
    if (!model) {
      throw new Error("Realtime model is required.");
    }

    const instructions = normalizeText(
      payload.instructions || runtimeConfig?.systemPrompt || ""
    );
    const voice = normalizeText(payload.voice || runtimeConfig?.openaiTtsVoice || "alloy");
    const language = normalizeLanguageTag(payload.language || runtimeConfig?.language);
    const temperature = clampNumber(payload.temperature, {
      fallback: clampNumber(runtimeConfig?.openaiTemperature, {
        fallback: 0.8,
        min: 0.6,
        max: 1.2
      }),
      min: 0.6,
      max: 1.2
    });

    this.clientTurnDetection = String(
      payload.turnDetection || runtimeConfig?.openaiRealtimeTurnDetection || "server_vad"
    )
      .trim()
      .toLowerCase();

    const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    const upstream = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    const connectTimeoutMs = clampNumber(payload.connectTimeoutMs, {
      fallback: clampNumber(runtimeConfig?.openaiRealtimeConnectTimeoutMs, {
        fallback: 8000,
        min: 1000,
        max: 30000,
        integer: true
      }),
      min: 1000,
      max: 30000,
      integer: true
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        upstream.removeListener("open", onOpen);
        upstream.removeListener("error", onError);
        callback();
      };

      const onOpen = () => finish(resolve);
      const onError = (error) => finish(() => reject(error));

      const timer = setTimeout(() => {
        finish(() => reject(new Error("Realtime upstream connection timed out.")));
      }, connectTimeoutMs);

      upstream.once("open", onOpen);
      upstream.once("error", onError);
    });

    this.upstream = upstream;
    this.started = true;
    this.assistantInProgress = false;
    this.ttsSeq = 0;
    this.partialBufferByItem.clear();
    this.assistantTextByResponse.clear();
    this.lastResponseCreatedAt = 0;
    this.clearPendingCommitResponseTimer();
    this.pendingResponseAfterCommit = false;
    this.lastCommitAt = 0;
    this.lastAssistantAudioAt = 0;
    this.lastAssistantTranscript = "";

    upstream.on("message", (raw) => {
      const event = safeJsonParse(String(raw || ""), {});
      this.handleUpstreamEvent(event);
    });

    upstream.on("close", () => {
      this.upstream = null;
      this.started = false;
      if (!this.closed) {
        this.send({
          type: "session_state",
          state: "disconnected"
        });
      }
    });

    upstream.on("error", (error) => {
      this.sendError("upstream_error", error?.message || "Realtime upstream error.");
    });

    this.sendUpstream({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions,
        voice,
        temperature,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: normalizeText(
            payload.inputTranscriptionModel ||
              runtimeConfig?.openaiRealtimeInputTranscriptionModel ||
              "gpt-4o-mini-transcribe"
          ),
          language: language || undefined
        },
        turn_detection: buildRealtimeTurnDetection({
          turnDetection: this.clientTurnDetection,
          turnDetectionEagerness:
            payload.turnDetectionEagerness || runtimeConfig?.openaiRealtimeTurnEagerness,
          vadThreshold:
            payload.vadThreshold ?? runtimeConfig?.openaiRealtimeVadThreshold,
          vadSilenceMs:
            payload.vadSilenceMs ?? runtimeConfig?.openaiRealtimeVadSilenceMs,
          vadPrefixPaddingMs:
            payload.vadPrefixPaddingMs ?? runtimeConfig?.openaiRealtimeVadPrefixPaddingMs,
          interruptResponseOnTurn:
            payload.interruptResponseOnTurn ??
            runtimeConfig?.openaiRealtimeInterruptResponseOnTurn
        })
      }
    });

    this.send({
      type: "session_started",
      session_id: this.sessionId,
      model,
      turn_detection: this.clientTurnDetection,
      t_ms: nowMs()
    });
  }

  handleUpstreamEvent(event = {}) {
    const type = String(event?.type || "").trim().toLowerCase();
    if (!type) {
      return;
    }

    if (type === "session.created" || type === "session.updated") {
      this.send({
        type: "session_state",
        state: "ready",
        model: String(event?.session?.model || "").trim() || undefined,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.lastUserSpeechStartedAt = nowMs();
      this.send({ type: "vad", state: "start", t_ms: nowMs() });
      if (this.assistantInProgress) {
        this.interruptAssistant({ reason: "barge_in" });
      }
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      const speechMs = this.lastUserSpeechStartedAt
        ? Math.max(0, nowMs() - this.lastUserSpeechStartedAt)
        : 0;
      this.lastUserSpeechStartedAt = 0;
      this.send({
        type: "vad",
        state: "stop",
        speech_ms: speechMs,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "input_audio_buffer.committed") {
      const committedAt = nowMs();
      this.send({
        type: "input_committed",
        t_ms: committedAt
      });
      if (this.pendingResponseAfterCommit && !this.assistantInProgress) {
        this.requestResponseFromCommit({
          reason: "upstream_committed",
          commitAt: this.lastCommitAt || committedAt
        });
      }
      return;
    }

    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = String(event?.item_id || "").trim();
      const delta = String(event?.delta || "").trim();
      if (!itemId || !delta) {
        return;
      }
      const prev = this.partialBufferByItem.get(itemId) || "";
      const text = normalizeText(`${prev} ${delta}`);
      if (!text) {
        return;
      }
      this.partialBufferByItem.set(itemId, text);
      this.send({
        type: "stt_partial",
        text,
        turn_id: itemId,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = String(event?.item_id || "").trim();
      const transcript = normalizeText(event?.transcript || "");
      if (itemId) {
        this.partialBufferByItem.delete(itemId);
      }
      if (!transcript) {
        return;
      }

      const now = nowMs();
      const echoWindowMs = 2800;
      const likelyEcho =
        this.lastAssistantAudioAt > 0 &&
        now - this.lastAssistantAudioAt <= echoWindowMs &&
        looksLikeEchoTranscript(transcript, this.lastAssistantTranscript);

      if (likelyEcho) {
        this.send({
          type: "input_rejected",
          reason: "echo",
          text: transcript,
          t_ms: now
        });
        this.sendUpstream({ type: "response.cancel" });
        this.sendUpstream({ type: "output_audio_buffer.clear" });
        this.assistantInProgress = false;
        warn(
          "VOICE-WS",
          `dropped probable echo transcript (session=${this.sessionId}): ${normalizeText(
            transcript
          )}`
        );
        return;
      }

      this.send({
        type: "stt_final",
        text: transcript,
        turn_id: itemId || undefined,
        t_ms: now
      });

      if (this.pendingResponseAfterCommit && !this.assistantInProgress) {
        this.requestResponseFromCommit({
          reason: "stt_final",
          commitAt: this.lastCommitAt || now
        });
      }
      return;
    }

    if (type === "response.created") {
      this.assistantInProgress = true;
      this.lastResponseCreatedAt = nowMs();
      this.clearPendingCommitResponseTimer();
      this.pendingResponseAfterCommit = false;
      this.send({
        type: "assistant_state",
        state: "speaking",
        response_id: String(event?.response?.id || "").trim() || undefined,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "response.audio_transcript.delta") {
      const responseId = String(event?.response_id || "").trim();
      const delta = String(event?.delta || "").trim();
      if (!responseId || !delta) {
        return;
      }
      const prev = this.assistantTextByResponse.get(responseId) || "";
      const text = normalizeText(`${prev} ${delta}`);
      this.assistantTextByResponse.set(responseId, text);
      this.lastAssistantTranscript = text;
      this.send({
        type: "assistant_text",
        response_id: responseId,
        text,
        is_final: false,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "response.audio_transcript.done") {
      const responseId = String(event?.response_id || "").trim();
      const text = normalizeText(event?.transcript || "");
      if (!responseId || !text) {
        return;
      }
      this.lastAssistantTranscript = text;
      this.assistantTextByResponse.set(responseId, text);
      this.send({
        type: "assistant_text",
        response_id: responseId,
        text,
        is_final: true,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "response.text.delta") {
      const responseId = String(event?.response_id || "").trim();
      const delta = String(event?.delta || "").trim();
      if (!responseId || !delta) {
        return;
      }
      const prev = this.assistantTextByResponse.get(responseId) || "";
      const text = normalizeText(`${prev} ${delta}`);
      this.assistantTextByResponse.set(responseId, text);
      this.lastAssistantTranscript = text;
      this.send({
        type: "assistant_text",
        response_id: responseId,
        text,
        is_final: false,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "response.text.done") {
      const responseId = String(event?.response_id || "").trim();
      const text = normalizeText(event?.text || "");
      if (!responseId || !text) {
        return;
      }
      this.lastAssistantTranscript = text;
      this.assistantTextByResponse.set(responseId, text);
      this.send({
        type: "assistant_text",
        response_id: responseId,
        text,
        is_final: true,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "response.audio.delta") {
      const responseId = String(event?.response_id || "").trim();
      const audioBase64 = String(event?.delta || "").trim();
      if (!audioBase64) {
        return;
      }
      this.lastAssistantAudioAt = nowMs();
      this.ttsSeq += 1;
      this.send({
        type: "tts_audio_chunk",
        response_id: responseId || undefined,
        seq: this.ttsSeq,
        format: String(event?.format || "pcm16"),
        audio_base64: audioBase64,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "response.done") {
      this.assistantInProgress = false;
      const responseId = String(event?.response?.id || "").trim();
      const status = String(event?.response?.status || event?.status || "unknown").trim();
      this.send({
        type: "assistant_state",
        state: "done",
        response_id: responseId || undefined,
        status,
        t_ms: nowMs()
      });
      return;
    }

    if (type === "error") {
      this.sendError(
        String(event?.error?.code || "upstream_error"),
        event?.error?.message || event?.message || "Realtime upstream error."
      );
    }
  }

  handleAudioChunk({ audioBase64 = "", commit = false, createResponse = false } = {}) {
    if (!this.started || !this.upstream) {
      throw new Error("Voice session is not started.");
    }
    const normalizedAudio = String(audioBase64 || "").trim();
    if (!normalizedAudio) {
      return;
    }

    this.sendUpstream({
      type: "input_audio_buffer.append",
      audio: normalizedAudio
    });

    if (commit) {
      this.commitInput({
        createResponse,
        reason: "audio_chunk_commit"
      });
    }
  }

  requestResponseFromCommit({ reason = "client_commit", commitAt = nowMs() } = {}) {
    this.clearPendingCommitResponseTimer();
    this.pendingCommitResponseTimer = setTimeout(() => {
      this.pendingCommitResponseTimer = null;
      if (!this.started || !this.upstream) {
        return;
      }

      if (this.assistantInProgress) {
        return;
      }

      if (this.lastResponseCreatedAt >= commitAt) {
        return;
      }

      this.sendUpstream({
        type: "response.create",
        response: {
          modalities: ["audio", "text"]
        }
      });
      this.pendingResponseAfterCommit = false;

      this.send({
        type: "assistant_state",
        state: "requested",
        reason: normalizeText(reason) || "client_commit",
        t_ms: nowMs()
      });
    }, 140);
  }

  commitInput({ createResponse = false, reason = "client_commit" } = {}) {
    if (!this.started) {
      return;
    }
    const commitAt = nowMs();
    this.lastCommitAt = commitAt;
    this.pendingResponseAfterCommit = true;
    this.clearPendingCommitResponseTimer();
    this.sendUpstream({ type: "input_audio_buffer.commit" });

    // We intentionally do not force response.create here.
    // It is only requested after commit is accepted (input_audio_buffer.committed)
    // or after transcription final arrives for this turn.
    void reason;
    void createResponse;
    void commitAt;
  }

  interruptAssistant({ reason = "interrupt" } = {}) {
    if (!this.started) {
      return;
    }
    this.clearPendingCommitResponseTimer();
    this.sendUpstream({ type: "response.cancel" });
    this.sendUpstream({ type: "output_audio_buffer.clear" });
    this.assistantInProgress = false;
    this.send({
      type: "assistant_state",
      state: "interrupted",
      reason: normalizeText(reason) || "interrupt",
      t_ms: nowMs()
    });
  }

  async stopSession({ reason = "stop" } = {}) {
    this.clearPendingCommitResponseTimer();
    if (this.upstream) {
      try {
        this.upstream.close();
      } catch (_) {
        // Ignore close races.
      }
      this.upstream = null;
    }
    this.started = false;
    this.assistantInProgress = false;
    this.partialBufferByItem.clear();
    this.assistantTextByResponse.clear();
    this.lastAssistantAudioAt = 0;
    this.lastAssistantTranscript = "";
    this.lastResponseCreatedAt = 0;
    this.pendingResponseAfterCommit = false;
    this.lastCommitAt = 0;
    this.send({
      type: "session_state",
      state: "stopped",
      reason,
      t_ms: nowMs()
    });
  }

  async handleClientMessage(rawMessage, isBinary = false) {
    if (isBinary) {
      const buffer = Buffer.isBuffer(rawMessage)
        ? rawMessage
        : Buffer.from(rawMessage || []);
      if (!buffer.length) {
        return;
      }
      this.handleAudioChunk({
        audioBase64: buffer.toString("base64"),
        commit: false
      });
      return;
    }

    const payload = safeJsonParse(String(rawMessage || ""), null);
    if (!payload || typeof payload !== "object") {
      throw new Error("Invalid JSON message.");
    }

    const type = String(payload.type || "").trim().toLowerCase();
    if (!type) {
      throw new Error("Message `type` is required.");
    }

    if (type === "start_session") {
      await this.startSession(payload);
      return;
    }

    if (type === "audio_chunk") {
      this.handleAudioChunk({
        audioBase64: payload.audio_base64 || payload.audioBase64 || "",
        commit: payload.commit === true,
        createResponse:
          payload.create_response !== false && payload.createResponse !== false
      });
      return;
    }

    if (type === "commit") {
      this.commitInput({
        createResponse:
          payload.create_response !== false && payload.createResponse !== false,
        reason: "client_commit"
      });
      return;
    }

    if (type === "interrupt") {
      this.interruptAssistant({ reason: payload.reason || "client_interrupt" });
      return;
    }

    if (type === "stop_session") {
      await this.stopSession({ reason: "client_stop" });
      return;
    }

    if (type === "ping") {
      this.send({ type: "pong", t_ms: nowMs() });
      return;
    }

    throw new Error(`Unsupported message type: ${type}`);
  }

  async close(reason = "socket_closed") {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.stopSession({ reason });
    this.onClose();
  }
}

function closeWithHttpError(socket, statusCode, statusText) {
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`
    );
  } catch (_) {
    // Ignore socket write errors.
  }
  try {
    socket.destroy();
  } catch (_) {
    // Ignore destroy errors.
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

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

    const session = new VoiceRealtimeBridgeSession({
      ws,
      getRuntimeConfig
    });

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

    session.send({
      type: "welcome",
      session_id: session.sessionId,
      actor: auth?.actor || "unknown",
      t_ms: nowMs()
    });
  });

  return {
    wss,
    stop: async () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          try {
            client.close();
          } catch (_) {
            // Ignore close errors.
          }
        }
        wss.close(() => resolve());
      })
  };
}

module.exports = {
  attachVoiceWsServer
};

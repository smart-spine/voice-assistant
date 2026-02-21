const { EventEmitter } = require("events");
const { WebSocket } = require("ws");
const {
  AUDIO_CODEC_PCM16,
  AUDIO_KIND_OUTPUT
} = require("../protocol/constants");
const {
  base64ToBytes,
  bytesToBase64,
  normalizeAudioFrame,
  estimatePcm16DurationMs
} = require("../protocol/audio-frame");
const { nowMs } = require("../protocol/envelope");
const { warn } = require("../../logger");

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
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

function redactOpenAiError(message) {
  const text = String(message || "");
  if (!text) {
    return "Unknown upstream error.";
  }
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***");
}

function buildRealtimeTurnDetection({
  enabled = false,
  turnDetection = "server_vad",
  turnDetectionEagerness = "auto",
  vadThreshold = 0.45,
  vadSilenceMs = 280,
  vadPrefixPaddingMs = 180,
  interruptResponseOnTurn = false
} = {}) {
  if (!enabled) {
    return null;
  }

  const normalizedType = String(turnDetection || "server_vad")
    .trim()
    .toLowerCase();

  if (normalizedType === "semantic_vad") {
    const normalizedEagerness = String(turnDetectionEagerness || "auto")
      .trim()
      .toLowerCase();
    return {
      type: "semantic_vad",
      eagerness: ["low", "medium", "high", "auto"].includes(normalizedEagerness)
        ? normalizedEagerness
        : "auto",
      create_response: true,
      interrupt_response: interruptResponseOnTurn !== false
    };
  }

  if (normalizedType === "server_vad") {
    return {
      type: "server_vad",
      threshold: clampNumber(vadThreshold, {
        fallback: 0.45,
        min: 0,
        max: 1
      }),
      silence_duration_ms: clampNumber(vadSilenceMs, {
        fallback: 280,
        min: 100,
        max: 4000,
        integer: true
      }),
      prefix_padding_ms: clampNumber(vadPrefixPaddingMs, {
        fallback: 180,
        min: 0,
        max: 2000,
        integer: true
      }),
      create_response: true,
      interrupt_response: interruptResponseOnTurn !== false
    };
  }

  return null;
}

class BaseAIProvider extends EventEmitter {
  async startSession() {
    throw new Error("startSession() is not implemented.");
  }

  async createTextTurn() {
    throw new Error("createTextTurn() is not implemented.");
  }

  async appendInputAudio() {
    throw new Error("appendInputAudio() is not implemented.");
  }

  async commitInput() {
    throw new Error("commitInput() is not implemented.");
  }

  async interrupt() {
    throw new Error("interrupt() is not implemented.");
  }

  async stopSession() {
    throw new Error("stopSession() is not implemented.");
  }
}

class OpenAIRealtimeAIProvider extends BaseAIProvider {
  constructor({ runtimeConfig = {}, now = () => Date.now() } = {}) {
    super();

    this.runtimeConfig = runtimeConfig || {};
    this.now = typeof now === "function" ? now : () => Date.now();

    this.sessionId = "";
    this.upstream = null;
    this.started = false;
    this.outputSeq = 0;

    this.partialBufferByItem = new Map();
    this.assistantTextByResponse = new Map();
    this.pendingCommitQueue = [];

    this.assistantInProgress = false;
  }

  resolveConfig(sessionConfig = {}) {
    return {
      apiKey: String(
        sessionConfig.openaiApiKey || this.runtimeConfig.openaiApiKey || ""
      ).trim(),
      model: normalizeText(
        sessionConfig.openaiRealtimeModel ||
          this.runtimeConfig.openaiRealtimeModel ||
          "gpt-4o-mini-realtime-preview-2024-12-17"
      ),
      inputTranscriptionModel: normalizeText(
        sessionConfig.openaiRealtimeInputTranscriptionModel ||
          this.runtimeConfig.openaiRealtimeInputTranscriptionModel ||
          "gpt-4o-mini-transcribe"
      ),
      instructions: normalizeText(
        sessionConfig.systemPrompt || this.runtimeConfig.systemPrompt || ""
      ),
      voice: normalizeText(
        sessionConfig.openaiTtsVoice || this.runtimeConfig.openaiTtsVoice || "alloy"
      ),
      language: normalizeLanguageTag(
        sessionConfig.language || this.runtimeConfig.language || ""
      ),
      temperature: clampNumber(
        sessionConfig.openaiTemperature ?? this.runtimeConfig.openaiTemperature,
        {
          fallback: 0.8,
          min: 0.6,
          max: 1.2
        }
      ),
      connectTimeoutMs: clampNumber(
        sessionConfig.openaiRealtimeConnectTimeoutMs ??
          this.runtimeConfig.openaiRealtimeConnectTimeoutMs,
        {
          fallback: 8000,
          min: 1000,
          max: 30000,
          integer: true
        }
      ),
      enableUpstreamTurnDetection: Boolean(
        sessionConfig.openaiRealtimeUpstreamTurnDetectionEnabled ||
          this.runtimeConfig.openaiRealtimeUpstreamTurnDetectionEnabled
      ),
      turnDetection: String(
        sessionConfig.openaiRealtimeTurnDetection ||
          this.runtimeConfig.openaiRealtimeTurnDetection ||
          "server_vad"
      )
        .trim()
        .toLowerCase(),
      turnDetectionEagerness: String(
        sessionConfig.openaiRealtimeTurnEagerness ||
          this.runtimeConfig.openaiRealtimeTurnEagerness ||
          "auto"
      )
        .trim()
        .toLowerCase(),
      vadThreshold:
        sessionConfig.openaiRealtimeVadThreshold ??
        this.runtimeConfig.openaiRealtimeVadThreshold,
      vadSilenceMs:
        sessionConfig.openaiRealtimeVadSilenceMs ??
        this.runtimeConfig.openaiRealtimeVadSilenceMs,
      vadPrefixPaddingMs:
        sessionConfig.openaiRealtimeVadPrefixPaddingMs ??
        this.runtimeConfig.openaiRealtimeVadPrefixPaddingMs,
      interruptResponseOnTurn:
        sessionConfig.openaiRealtimeInterruptResponseOnTurn ??
        this.runtimeConfig.openaiRealtimeInterruptResponseOnTurn
    };
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

  async startSession({ sessionId = "", sessionConfig = {} } = {}) {
    if (this.started) {
      await this.stopSession({ reason: "restart" });
    }

    this.sessionId = String(sessionId || "").trim();
    const cfg = this.resolveConfig(sessionConfig);

    if (!cfg.apiKey) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }

    if (!cfg.model) {
      throw new Error("openaiRealtimeModel is required.");
    }

    const wsUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(cfg.model)}`;
    const upstream = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "OpenAI-Beta": "realtime=v1"
      }
    });

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        upstream.removeListener("open", onOpen);
        upstream.removeListener("error", onError);
        callback();
      };

      const onOpen = () => finish(resolve);
      const onError = (error) => finish(() => reject(error));

      const timeout = setTimeout(() => {
        finish(() => reject(new Error("Realtime upstream connection timed out.")));
      }, cfg.connectTimeoutMs);

      upstream.once("open", onOpen);
      upstream.once("error", onError);
    });

    this.upstream = upstream;
    this.started = true;
    this.outputSeq = 0;
    this.assistantInProgress = false;
    this.pendingCommitQueue = [];
    this.partialBufferByItem.clear();
    this.assistantTextByResponse.clear();

    upstream.on("message", (rawValue) => {
      const event = safeJsonParse(String(rawValue || ""), null);
      if (!event || typeof event !== "object") {
        return;
      }
      this.handleUpstreamEvent(event);
    });

    upstream.on("close", () => {
      this.upstream = null;
      this.started = false;
      this.assistantInProgress = false;
      this.emit("session.state", {
        state: "stopped",
        reason: "upstream_closed",
        t_ms: this.now()
      });
    });

    upstream.on("error", (error) => {
      this.emit("error", {
        code: "upstream_error",
        message: redactOpenAiError(error?.message || "Realtime upstream error."),
        fatal: false,
        t_ms: this.now()
      });
    });

    this.sendUpstream({
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: cfg.instructions,
        voice: cfg.voice,
        temperature: cfg.temperature,
        input_audio_format: AUDIO_CODEC_PCM16,
        output_audio_format: AUDIO_CODEC_PCM16,
        input_audio_transcription: {
          model: cfg.inputTranscriptionModel,
          language: cfg.language || undefined
        },
        turn_detection: buildRealtimeTurnDetection({
          enabled: cfg.enableUpstreamTurnDetection,
          turnDetection: cfg.turnDetection,
          turnDetectionEagerness: cfg.turnDetectionEagerness,
          vadThreshold: cfg.vadThreshold,
          vadSilenceMs: cfg.vadSilenceMs,
          vadPrefixPaddingMs: cfg.vadPrefixPaddingMs,
          interruptResponseOnTurn: cfg.interruptResponseOnTurn
        })
      }
    });

    this.emit("session.ready", {
      model: cfg.model,
      t_ms: this.now()
    });
  }

  handleUpstreamEvent(event = {}) {
    const type = String(event.type || "")
      .trim()
      .toLowerCase();
    if (!type) {
      return;
    }

    if (type === "session.created" || type === "session.updated") {
      this.emit("session.state", {
        state: "ready",
        model: String(event?.session?.model || "").trim() || undefined,
        t_ms: this.now()
      });
      return;
    }

    if (type === "input_audio_buffer.speech_started") {
      this.emit("vad.start", {
        source: "upstream",
        t_ms: this.now()
      });
      return;
    }

    if (type === "input_audio_buffer.speech_stopped") {
      this.emit("vad.stop", {
        source: "upstream",
        t_ms: this.now()
      });
      return;
    }

    if (type === "input_audio_buffer.committed") {
      const pending = this.pendingCommitQueue.length ? this.pendingCommitQueue.shift() : null;
      const commitId = pending?.commit_id || undefined;
      const forceResponse = Boolean(pending?.force_response);

      this.emit("input.committed", {
        commit_id: commitId,
        source: "upstream",
        buffered_ms: Number(pending?.buffered_ms || 0) || 0,
        t_ms: this.now()
      });

      if (forceResponse) {
        this.sendUpstream({
          type: "response.create",
          response: {
            modalities: ["audio", "text"]
          }
        });
        this.emit("assistant.state", {
          state: "requested",
          reason: "commit_force_response",
          t_ms: this.now()
        });
      }
      return;
    }

    if (type === "conversation.item.input_audio_transcription.delta") {
      const itemId = String(event.item_id || "").trim();
      const delta = String(event.delta || "").trim();
      if (!itemId || !delta) {
        return;
      }

      const prev = this.partialBufferByItem.get(itemId) || "";
      const text = normalizeText(`${prev} ${delta}`);
      this.partialBufferByItem.set(itemId, text);

      this.emit("stt.partial", {
        turn_id: itemId,
        text,
        t_ms: this.now()
      });
      return;
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      const itemId = String(event.item_id || "").trim();
      if (itemId) {
        this.partialBufferByItem.delete(itemId);
      }
      const transcript = normalizeText(event.transcript || "");
      if (!transcript) {
        return;
      }

      this.emit("stt.final", {
        turn_id: itemId || undefined,
        text: transcript,
        t_ms: this.now()
      });
      return;
    }

    if (type === "response.created") {
      this.assistantInProgress = true;
      this.emit("assistant.state", {
        state: "speaking",
        response_id: String(event?.response?.id || "").trim() || undefined,
        t_ms: this.now()
      });
      return;
    }

    if (type === "response.text.delta" || type === "response.audio_transcript.delta") {
      const responseId = String(event.response_id || "").trim();
      const delta = String(event.delta || "").trim();
      if (!responseId || !delta) {
        return;
      }

      const prev = this.assistantTextByResponse.get(responseId) || "";
      const text = normalizeText(`${prev} ${delta}`);
      this.assistantTextByResponse.set(responseId, text);
      this.emit("assistant.text.delta", {
        response_id: responseId,
        text,
        t_ms: this.now()
      });
      return;
    }

    if (type === "response.text.done" || type === "response.audio_transcript.done") {
      const responseId = String(event.response_id || "").trim();
      const text = normalizeText(event.text || event.transcript || "");
      if (!responseId || !text) {
        return;
      }

      this.assistantTextByResponse.set(responseId, text);
      this.emit("assistant.text.final", {
        response_id: responseId,
        text,
        t_ms: this.now()
      });
      return;
    }

    if (type === "response.audio.delta") {
      const audioBase64 = String(event.delta || "").trim();
      if (!audioBase64) {
        return;
      }

      const bytes = base64ToBytes(audioBase64);
      if (!bytes.byteLength) {
        return;
      }

      this.outputSeq += 1;
      const frame = normalizeAudioFrame({
        kind: AUDIO_KIND_OUTPUT,
        codec: AUDIO_CODEC_PCM16,
        seq: this.outputSeq,
        sample_rate_hz: 24000,
        channels: 1,
        duration_ms: estimatePcm16DurationMs({
          byteLength: bytes.byteLength,
          sampleRateHz: 24000,
          channels: 1
        }),
        bytes
      });

      this.emit("assistant.audio.chunk", {
        response_id: String(event.response_id || "").trim() || undefined,
        frame,
        t_ms: this.now()
      });
      return;
    }

    if (type === "response.done") {
      this.assistantInProgress = false;
      const status = String(event?.response?.status || event?.status || "unknown").trim();
      this.emit("assistant.state", {
        state: "done",
        status,
        response_id: String(event?.response?.id || "").trim() || undefined,
        t_ms: this.now()
      });
      return;
    }

    if (type === "error") {
      this.emit("error", {
        code: String(event?.error?.code || "upstream_error"),
        message: redactOpenAiError(
          event?.error?.message || event?.message || "Realtime upstream error."
        ),
        fatal: false,
        t_ms: this.now()
      });
      return;
    }

    this.emit("warning", {
      code: "unknown_upstream_event",
      message: `Unhandled upstream event type: ${type}`,
      t_ms: this.now()
    });
  }

  async appendInputAudio(frame) {
    if (!this.started) {
      throw new Error("Provider session is not started.");
    }
    const normalized = normalizeAudioFrame(frame);
    this.sendUpstream({
      type: "input_audio_buffer.append",
      audio: bytesToBase64(normalized.bytes)
    });
  }

  async commitInput({ commitId = "", reason = "unknown", bufferedMs = 0, forceResponse = true } = {}) {
    if (!this.started) {
      throw new Error("Provider session is not started.");
    }

    const normalizedCommitId = String(commitId || "").trim();
    if (!normalizedCommitId) {
      throw new Error("commitId is required for commitInput().");
    }

    this.pendingCommitQueue.push({
      commit_id: normalizedCommitId,
      reason: String(reason || "unknown"),
      buffered_ms: Math.max(0, Number(bufferedMs) || 0),
      force_response: forceResponse !== false,
      t_ms: this.now()
    });

    this.sendUpstream({
      type: "input_audio_buffer.commit"
    });
  }

  async interrupt({ reason = "interrupt" } = {}) {
    if (!this.started) {
      return;
    }

    this.sendUpstream({ type: "response.cancel" });
    this.sendUpstream({ type: "output_audio_buffer.clear" });

    this.assistantInProgress = false;
    this.emit("assistant.state", {
      state: "interrupted",
      reason: String(reason || "interrupt"),
      t_ms: this.now()
    });
  }

  async appendSystemContext(note = "") {
    const text = normalizeText(note);
    if (!text || !this.started) {
      return;
    }

    this.sendUpstream({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text
          }
        ]
      }
    });
  }

  async createTextTurn({
    role = "user",
    text = "",
    createResponse = true
  } = {}) {
    if (!this.started) {
      throw new Error("Provider session is not started.");
    }

    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      return {
        ok: false,
        code: "empty_text"
      };
    }

    const normalizedRole = String(role || "user")
      .trim()
      .toLowerCase();
    const resolvedRole = normalizedRole === "system" ? "system" : "user";

    const created = this.sendUpstream({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: resolvedRole,
        content: [
          {
            type: "input_text",
            text: normalizedText
          }
        ]
      }
    });

    if (!created) {
      return {
        ok: false,
        code: "upstream_unavailable"
      };
    }

    if (createResponse) {
      this.sendUpstream({
        type: "response.create",
        response: {
          modalities: ["audio", "text"]
        }
      });
      this.emit("assistant.state", {
        state: "requested",
        reason: "text_input",
        t_ms: this.now()
      });
    }

    return {
      ok: true,
      code: "ok",
      role: resolvedRole,
      create_response: Boolean(createResponse)
    };
  }

  async stopSession({ reason = "stop" } = {}) {
    const normalizedReason = String(reason || "stop").trim() || "stop";

    this.pendingCommitQueue = [];
    this.partialBufferByItem.clear();
    this.assistantTextByResponse.clear();
    this.assistantInProgress = false;

    if (this.upstream) {
      try {
        this.upstream.close();
      } catch (closeError) {
        warn("VOICE-AI", `upstream close failed: ${closeError?.message || closeError}`);
      }
      this.upstream = null;
    }

    this.started = false;

    this.emit("session.state", {
      state: "stopped",
      reason: normalizedReason,
      t_ms: nowMs()
    });
  }
}

function createAIProvider({ runtimeConfig = {}, provider = "openai-realtime" } = {}) {
  const normalized = String(provider || "openai-realtime")
    .trim()
    .toLowerCase();

  if (normalized !== "openai-realtime") {
    throw new Error(`Unsupported AI provider: ${normalized}.`);
  }

  return new OpenAIRealtimeAIProvider({ runtimeConfig });
}

module.exports = {
  BaseAIProvider,
  OpenAIRealtimeAIProvider,
  createAIProvider,
  buildRealtimeTurnDetection,
  normalizeLanguageTag
};

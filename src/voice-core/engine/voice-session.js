const { EventEmitter } = require("events");
const { log, warn, error } = require("../../logger");
const { AudioPipeline } = require("./audio-pipeline");
const { TurnManager } = require("./turn-manager");
const { createAIProvider } = require("./ai-provider");
const {
  SESSION_STATES,
  canTransition,
  normalizeState
} = require("./state-machine");
const {
  AUDIO_MIN_COMMIT_MS,
  AUDIO_MIN_COMMIT_BYTES,
  PROTOCOL_VERSION,
  AUDIO_KIND_OUTPUT
} = require("../protocol/constants");
const {
  createId,
  buildEnvelope,
  validateEnvelope
} = require("../protocol/envelope");
const {
  normalizeAudioFrame,
  decodeBinaryAudioFrame,
  base64ToBytes
} = require("../protocol/audio-frame");

class VoiceSession extends EventEmitter {
  constructor({
    sessionId,
    runtimeConfig = {},
    transport,
    audioPipeline,
    turnManager,
    aiProvider,
    now = () => Date.now()
  } = {}) {
    super();

    const normalizedSessionId = String(sessionId || createId("vs")).trim();
    if (!normalizedSessionId) {
      throw new Error("VoiceSession requires a valid sessionId.");
    }

    if (!transport || typeof transport.sendControl !== "function" || typeof transport.sendAudio !== "function") {
      throw new Error("VoiceSession requires transport with sendControl() and sendAudio().");
    }

    this.sessionId = normalizedSessionId;
    this.runtimeConfig = runtimeConfig || {};
    this.transport = transport;
    this.now = typeof now === "function" ? now : () => Date.now();

    this.audioPipeline =
      audioPipeline ||
      new AudioPipeline({
        minCommitMs: this.runtimeConfig.voiceCoreMinCommitMs || AUDIO_MIN_COMMIT_MS,
        minCommitBytes: this.runtimeConfig.voiceCoreMinCommitBytes || AUDIO_MIN_COMMIT_BYTES
      });

    this.turnManager =
      turnManager ||
      new TurnManager({
        vadThreshold:
          this.runtimeConfig.voiceCoreVadThreshold ?? this.runtimeConfig.openaiSttVadThreshold,
        vadSilenceMs:
          this.runtimeConfig.voiceCoreVadSilenceMs ??
          this.runtimeConfig.openaiRealtimeVadSilenceMs,
        vadHangoverMs:
          this.runtimeConfig.voiceCoreVadHangoverMs ?? this.runtimeConfig.openaiSttHangoverMs,
        minSpeechMsForTurn:
          this.runtimeConfig.voiceCoreMinSpeechMsForTurn ??
          this.runtimeConfig.bargeInMinMs ??
          180,
        bargeInMinMs: this.runtimeConfig.bargeInMinMs ?? 220,
        semanticEotEnabled: this.runtimeConfig.semanticEotEnabled,
        semanticEotUseLlm: this.runtimeConfig.semanticEotUseLlm,
        semanticEotApiKey: this.runtimeConfig.openaiApiKey,
        semanticEotModel: this.runtimeConfig.semanticEotModel,
        semanticEotTimeoutMs: this.runtimeConfig.semanticEotTimeoutMs,
        semanticEotMinDelayMs: this.runtimeConfig.semanticEotMinDelayMs,
        semanticEotMaxDelayMs: this.runtimeConfig.semanticEotMaxDelayMs,
        now: this.now
      });

    this.aiProvider =
      aiProvider ||
      createAIProvider({
        runtimeConfig: this.runtimeConfig,
        provider: this.runtimeConfig.voiceCoreProvider || "openai-realtime"
      });

    this.state = SESSION_STATES.READY;
    this.started = false;
    this.closed = false;
    this.clientInfo = null;
    this.sessionConfig = {};
    this.lastInputAt = 0;
    this.metrics = this.createEmptyMetrics();

    this.debugScope = `VOICE-CORE:${this.sessionId}`;
    this.voiceCoreVerboseLogs = Boolean(this.runtimeConfig.voiceCoreVerboseLogs);

    this.bindTurnManagerEvents();
    this.bindProviderEvents();
  }

  createEmptyMetrics() {
    return {
      turn_id: "",
      input_started_at_ms: 0,
      commit_at_ms: 0,
      stt_partial_ms: null,
      stt_final_ms: null,
      first_audio_ms: null
    };
  }

  async emitMetricsTick(reason = "tick") {
    try {
      await this.sendControlEvent("metrics.tick", {
        ...this.metrics,
        reason: String(reason || "tick").trim() || "tick",
        t_ms: this.now()
      });
    } catch (_) {
      // Metrics are best-effort and must never block the session.
    }
  }

  markInputStarted(tsMs = this.now()) {
    const ts = Number(tsMs) || this.now();
    if (!this.metrics.input_started_at_ms || this.metrics.commit_at_ms) {
      this.metrics = {
        ...this.createEmptyMetrics(),
        input_started_at_ms: ts
      };
      void this.emitMetricsTick("input_started");
    }
  }

  markCommitted(snapshot = {}) {
    const committedAt = this.now();
    this.metrics = {
      ...this.metrics,
      turn_id: String(snapshot?.commit_id || "").trim(),
      input_started_at_ms:
        Number(this.metrics.input_started_at_ms) > 0
          ? Number(this.metrics.input_started_at_ms)
          : committedAt,
      commit_at_ms: committedAt,
      stt_partial_ms: null,
      stt_final_ms: null,
      first_audio_ms: null
    };
    void this.emitMetricsTick("committed");
  }

  markSttPartial(tsMs = this.now()) {
    if (
      this.metrics.input_started_at_ms > 0 &&
      this.metrics.stt_partial_ms == null
    ) {
      this.metrics.stt_partial_ms = Math.max(
        0,
        Number(tsMs || this.now()) - Number(this.metrics.input_started_at_ms)
      );
      void this.emitMetricsTick("stt_partial");
    }
  }

  markSttFinal(tsMs = this.now()) {
    if (this.metrics.input_started_at_ms > 0) {
      this.metrics.stt_final_ms = Math.max(
        0,
        Number(tsMs || this.now()) - Number(this.metrics.input_started_at_ms)
      );
      void this.emitMetricsTick("stt_final");
    }
  }

  markFirstAudio(tsMs = this.now()) {
    if (this.metrics.first_audio_ms != null) {
      return;
    }
    const baseTs =
      Number(this.metrics.commit_at_ms) > 0
        ? Number(this.metrics.commit_at_ms)
        : Number(this.metrics.input_started_at_ms);
    if (!baseTs) {
      return;
    }
    this.metrics.first_audio_ms = Math.max(0, Number(tsMs || this.now()) - baseTs);
    if (!this.voiceCoreVerboseLogs) {
      log(
        this.debugScope,
        `latency turn=${this.metrics.turn_id || "-"} stt_partial_ms=${
          this.metrics.stt_partial_ms == null ? "-" : this.metrics.stt_partial_ms
        } stt_final_ms=${
          this.metrics.stt_final_ms == null ? "-" : this.metrics.stt_final_ms
        } first_audio_ms=${this.metrics.first_audio_ms}`
      );
    }
    void this.emitMetricsTick("first_audio");
  }

  getStatus() {
    return {
      session_id: this.sessionId,
      state: this.state,
      started: this.started,
      closed: this.closed,
      last_input_at: this.lastInputAt || 0,
      stats: this.audioPipeline.getStats()
    };
  }

  bindTurnManagerEvents() {
    this.turnManager.on("vad.start", (event) => {
      this.protocolLog("event", "turn.vad.start", event);
    });

    this.turnManager.on("vad.stop", (event) => {
      this.protocolLog("event", "turn.vad.stop", event);
    });

    this.turnManager.on("turn.eot", async (event) => {
      this.protocolLog("event", "turn.eot", event);
      await this.sendControlEvent("turn.eot", {
        reason: String(event?.reason || "vad_silence"),
        confidence: Number(event?.confidence || 0.5),
        delay_ms: Number(event?.delay_ms || 0),
        t_ms: Number(event?.t_ms || this.now())
      }).catch((err) => {
        warn(this.debugScope, `failed to send turn.eot event: ${err?.message || err}`);
      });

      await this.commitCurrentInput({
        source: "auto_eot",
        reason: String(event?.reason || "vad_silence"),
        forceResponse: true
      });
    });

    this.turnManager.on("barge_in.start", (event) => {
      this.protocolLog("event", "turn.barge_in.start", event);
    });

    this.turnManager.on("barge_in.cancelled", (event) => {
      this.protocolLog("event", "turn.barge_in.cancelled", event);
    });

    this.turnManager.on("barge_in.confirmed", async (event) => {
      this.protocolLog("event", "turn.barge_in.confirmed", event);
      await this.handleBargeIn(event);
    });
  }

  bindProviderEvents() {
    this.aiProvider.on("session.ready", async (event) => {
      this.protocolLog("upstream", "session.ready", event);
      await this.setState(SESSION_STATES.READY, "provider_ready");
      await this.sendSessionState("ready", "provider_ready");
    });

    this.aiProvider.on("session.state", async (event) => {
      this.protocolLog("upstream", "session.state", event);
      const state = normalizeState(event?.state);
      if (state === "stopped") {
        await this.setState(SESSION_STATES.STOPPED, event?.reason || "provider_stopped");
        await this.sendSessionState("stopped", event?.reason || "provider_stopped");
      }
    });

    this.aiProvider.on("input.committed", async (event) => {
      this.protocolLog("upstream", "input.committed", event);
      const pending = this.audioPipeline.ackPendingCommit();
      const commitId = String(event?.commit_id || pending?.commit_id || "").trim();
      const source = String(event?.source || "upstream").trim() || "upstream";
      await this.sendControlEvent("audio.committed", {
        commit_id: commitId || undefined,
        source,
        buffered_ms: Number(event?.buffered_ms || pending?.buffered_ms || 0),
        t_ms: Number(event?.t_ms || this.now())
      });
    });

    this.aiProvider.on("stt.partial", async (event) => {
      this.protocolLog("upstream", "stt.partial", event);
      const text = String(event?.text || "").trim();
      if (!text) {
        return;
      }
      this.markSttPartial(event?.t_ms || this.now());
      this.turnManager.onSttPartial(text);
      await this.sendControlEvent("stt.partial", {
        turn_id: String(event?.turn_id || "").trim() || undefined,
        text,
        t_ms: Number(event?.t_ms || this.now())
      });
    });

    this.aiProvider.on("stt.final", async (event) => {
      this.protocolLog("upstream", "stt.final", event);
      const text = String(event?.text || "").trim();
      if (!text) {
        return;
      }
      this.markSttFinal(event?.t_ms || this.now());
      log(
        this.debugScope,
        `stt.final "${this.truncateForLog(text, 220)}"`
      );

      await this.turnManager.onSttFinal(text, {
        isFirstUserTurn: false
      });

      await this.sendControlEvent("stt.final", {
        turn_id: String(event?.turn_id || "").trim() || undefined,
        text,
        t_ms: Number(event?.t_ms || this.now())
      });
    });

    this.aiProvider.on("assistant.state", async (event) => {
      this.protocolLog("upstream", "assistant.state", event);
      const state = String(event?.state || "").trim().toLowerCase();
      let reportedSessionState = this.state;

      if (state === "requested" || state === "thinking") {
        await this.setState(SESSION_STATES.THINKING, state);
        reportedSessionState = SESSION_STATES.THINKING;
      } else if (state === "speaking") {
        await this.setState(SESSION_STATES.SPEAKING, state);
        this.turnManager.setAssistantSpeaking(true);
        reportedSessionState = SESSION_STATES.SPEAKING;
      } else if (state === "done") {
        this.turnManager.setAssistantSpeaking(false);
        this.audioPipeline.clearOutputFrames();
        await this.setState(SESSION_STATES.READY, state);
        reportedSessionState = SESSION_STATES.READY;
      } else if (state === "interrupted") {
        this.turnManager.setAssistantSpeaking(false);
        this.audioPipeline.clearOutputFrames();
        await this.setState(SESSION_STATES.INTERRUPTED, state);
        reportedSessionState = SESSION_STATES.INTERRUPTED;
        await this.sendControlEvent("audio.clear", {
          reason: String(event?.reason || "interrupt"),
          t_ms: Number(event?.t_ms || this.now())
        });
      }

      await this.sendControlEvent("assistant.state", {
        state,
        reason: String(event?.reason || "").trim() || undefined,
        response_id: String(event?.response_id || "").trim() || undefined,
        status: String(event?.status || "").trim() || undefined,
        t_ms: Number(event?.t_ms || this.now())
      });

      await this.sendSessionState(
        normalizeState(reportedSessionState) || this.state,
        `assistant_${state || "state"}`
      );
    });

    this.aiProvider.on("assistant.text.delta", async (event) => {
      this.protocolLog("upstream", "assistant.text.delta", event);
      const text = String(event?.text || "").trim();
      if (!text) {
        return;
      }
      await this.sendControlEvent("assistant.text.delta", {
        response_id: String(event?.response_id || "").trim() || undefined,
        text,
        t_ms: Number(event?.t_ms || this.now())
      });
    });

    this.aiProvider.on("assistant.text.final", async (event) => {
      this.protocolLog("upstream", "assistant.text.final", event);
      const text = String(event?.text || "").trim();
      if (!text) {
        return;
      }
      await this.sendControlEvent("assistant.text.final", {
        response_id: String(event?.response_id || "").trim() || undefined,
        text,
        t_ms: Number(event?.t_ms || this.now())
      });
    });

    this.aiProvider.on("assistant.audio.chunk", async (event) => {
      const frame = event?.frame;
      if (!frame) {
        return;
      }
      this.markFirstAudio(event?.t_ms || this.now());
      this.protocolLog("upstream", "assistant.audio.chunk", {
        seq: frame.seq,
        duration_ms: frame.duration_ms,
        bytes: frame.bytes?.byteLength || 0
      });

      const normalizedOutput = normalizeAudioFrame(
        {
          ...frame,
          kind: AUDIO_KIND_OUTPUT
        },
        {
          defaultKind: AUDIO_KIND_OUTPUT
        }
      );

      this.audioPipeline.appendOutputFrame(normalizedOutput);
      await this.transport.sendAudio(normalizedOutput);
    });

    this.aiProvider.on("warning", async (event) => {
      this.protocolLog("warn", "warning", event);
      await this.sendControlEvent("warning", {
        code: String(event?.code || "warning").trim() || "warning",
        message: String(event?.message || "Voice provider warning.").trim(),
        t_ms: Number(event?.t_ms || this.now())
      });
    });

    this.aiProvider.on("error", async (event) => {
      this.protocolLog("error", "error", event);
      await this.setState(SESSION_STATES.ERROR, String(event?.code || "provider_error"));
      this.metrics = this.createEmptyMetrics();
      await this.sendControlEvent("error", {
        code: String(event?.code || "provider_error").trim() || "provider_error",
        message: String(event?.message || "Voice provider error.").trim(),
        fatal: Boolean(event?.fatal),
        t_ms: Number(event?.t_ms || this.now())
      });
    });
  }

  protocolLog(direction, type, payload = {}) {
    if (!this.shouldProtocolLog(direction, type)) {
      return;
    }
    const meta = payload && typeof payload === "object" ? payload : {};
    const safe = {
      ...meta
    };
    if (safe.audio_b64) {
      safe.audio_b64 = `[base64:${String(safe.audio_b64).length}]`;
    }
    if (safe.bytes instanceof Uint8Array) {
      safe.bytes = `[bytes:${safe.bytes.byteLength}]`;
    }
    log(this.debugScope, `${direction} ${type} ${JSON.stringify(safe)}`);
  }

  shouldProtocolLog(direction, type) {
    if (this.voiceCoreVerboseLogs) {
      return true;
    }
    const normalizedType = String(type || "")
      .trim()
      .toLowerCase();
    if (direction === "state") {
      return true;
    }
    return [
      "session.started",
      "session.state",
      "session.stop",
      "turn.eot",
      "stt.final",
      "assistant.state",
      "audio.clear",
      "warning",
      "error"
    ].includes(normalizedType);
  }

  truncateForLog(value, maxChars = 180) {
    const normalized = String(value || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!normalized) {
      return "";
    }
    const limit = Math.max(32, Number(maxChars) || 180);
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, limit - 1)}…`;
  }

  async setState(nextState, reason = "") {
    const normalizedNext = normalizeState(nextState);
    if (!normalizedNext) {
      return;
    }

    const normalizedCurrent = normalizeState(this.state);
    if (!canTransition(normalizedCurrent, normalizedNext)) {
      warn(
        this.debugScope,
        `invalid state transition ${normalizedCurrent} -> ${normalizedNext} (reason=${reason})`
      );
      return;
    }

    if (normalizedCurrent !== normalizedNext) {
      this.state = normalizedNext;
      this.protocolLog("state", "session.state", {
        from: normalizedCurrent,
        to: normalizedNext,
        reason
      });
    }
  }

  async sendControlEvent(type, payload = {}, { replyTo = null } = {}) {
    const envelope = buildEnvelope({
      v: PROTOCOL_VERSION,
      type,
      payload,
      sessionId: this.sessionId,
      replyTo,
      tsMs: this.now(),
      msgId: createId("core")
    });

    this.protocolLog("tx", type, payload);
    await this.transport.sendControl(envelope);
    return envelope;
  }

  async sendSessionState(state, reason = "") {
    await this.sendControlEvent("session.state", {
      state: normalizeState(state) || this.state,
      reason: String(reason || "").trim() || undefined,
      t_ms: this.now()
    });
  }

  async start(startEnvelope) {
    if (this.started) {
      return this.getStatus();
    }

    const validation = validateEnvelope(startEnvelope, {
      requireSessionId: false,
      strictType: false,
      allowUnknownType: true
    });

    if (!validation.ok) {
      throw new Error(validation.message);
    }

    if (validation.value.type !== "session.start") {
      throw new Error(`VoiceSession.start expected type=session.start, got ${validation.value.type}.`);
    }

    this.clientInfo = validation.value.payload?.client || null;
    this.metrics = this.createEmptyMetrics();

    this.sessionConfig = {
      ...this.runtimeConfig,
      ...validation.value.payload
    };

    await this.aiProvider.startSession({
      sessionId: this.sessionId,
      sessionConfig: this.sessionConfig
    });

    this.started = true;
    await this.setState(SESSION_STATES.READY, "session_start");

    await this.sendControlEvent("session.started", {
      session_id: this.sessionId,
      state: this.state,
      engine: "voice-core",
      model_profile: "realtime-openai",
      t_ms: this.now()
    });

    await this.sendSessionState("ready", "session_start");

    return this.getStatus();
  }

  async onControl(envelope) {
    if (!this.started) {
      throw new Error("Voice session is not started.");
    }

    const validation = validateEnvelope(envelope, {
      requireSessionId: false,
      strictType: false,
      allowUnknownType: true
    });

    if (!validation.ok) {
      await this.sendControlEvent("error", {
        code: validation.code,
        message: validation.message,
        fatal: false,
        t_ms: this.now()
      });
      return;
    }

    const event = validation.value;
    this.protocolLog("rx", event.type, event.payload);

    switch (event.type) {
      case "ping": {
        await this.sendControlEvent("pong", {
          nonce: event.payload?.nonce || undefined,
          t_ms: this.now()
        }, {
          replyTo: event.msg_id
        });
        return;
      }

      case "session.update": {
        this.sessionConfig = {
          ...this.sessionConfig,
          ...(event.payload || {})
        };
        await this.sendControlEvent("session.state", {
          state: this.state,
          reason: "session_updated",
          t_ms: this.now()
        }, {
          replyTo: event.msg_id
        });
        return;
      }

      case "assistant.interrupt": {
        await this.handleInterrupt({
          reason: String(event.payload?.reason || "client_interrupt").trim() || "client_interrupt"
        });
        return;
      }

      case "audio.commit": {
        await this.commitCurrentInput({
          source: "manual",
          reason: String(event.payload?.reason || "manual_commit").trim() || "manual_commit",
          forceResponse: event.payload?.force_response !== false
        });
        return;
      }

      case "text.input": {
        const text = String(event.payload?.text || "").trim();
        const role = String(event.payload?.role || "user")
          .trim()
          .toLowerCase();
        const createResponse = event.payload?.create_response !== false;
        if (!text) {
          await this.sendControlEvent("warning", {
            code: "empty_text",
            message: "text.input requires non-empty `payload.text`.",
            t_ms: this.now()
          }, {
            replyTo: event.msg_id
          });
          return;
        }

        if (createResponse) {
          await this.setState(SESSION_STATES.THINKING, "text_input");
          await this.sendSessionState("thinking", "text_input");
        }

        const createResult = await this.aiProvider.createTextTurn({
          role: role === "system" ? "system" : "user",
          text,
          createResponse
        });

        await this.sendControlEvent("text.committed", {
          role: role === "system" ? "system" : "user",
          text,
          create_response: Boolean(createResponse),
          upstream_code: String(createResult?.code || "ok"),
          t_ms: this.now()
        }, {
          replyTo: event.msg_id
        });
        return;
      }

      case "audio.append": {
        const frame = normalizeAudioFrame(
          {
            kind: "input_audio",
            codec: event.payload?.codec || "pcm16",
            seq: event.payload?.seq,
            sample_rate_hz: event.payload?.sample_rate_hz,
            channels: event.payload?.channels,
            duration_ms: event.payload?.duration_ms,
            bytes: base64ToBytes(event.payload?.audio_b64 || "")
          },
          {
            defaultKind: "input_audio"
          }
        );
        await this.onAudio(frame);
        return;
      }

      case "session.stop": {
        await this.stop({
          reason: String(event.payload?.reason || "client_stop").trim() || "client_stop"
        });
        return;
      }

      default: {
        await this.sendControlEvent("error", {
          code: "unsupported_type",
          message: `Unsupported message type: ${event.type}`,
          fatal: false,
          t_ms: this.now()
        }, {
          replyTo: event.msg_id
        });
      }
    }
  }

  async onBinaryAudio(binaryFrame) {
    const frame = decodeBinaryAudioFrame(binaryFrame, {
      defaultKind: "input_audio"
    });
    await this.onAudio(frame);
  }

  async onAudio(frame) {
    if (!this.started) {
      throw new Error("Voice session is not started.");
    }

    const normalizedFrame = normalizeAudioFrame(frame, {
      defaultKind: "input_audio"
    });

    this.lastInputAt = this.now();

    this.audioPipeline.appendInputFrame(normalizedFrame);
    this.markInputStarted(this.now());
    this.turnManager.onInputFrame(normalizedFrame);

    await this.aiProvider.appendInputAudio(normalizedFrame);

    if (this.state === SESSION_STATES.READY || this.state === SESSION_STATES.INTERRUPTED) {
      await this.setState(SESSION_STATES.LISTENING, "audio_in");
      await this.sendSessionState("listening", "audio_in");
    }
  }

  async commitCurrentInput({
    source = "manual",
    reason = "manual_commit",
    forceResponse = true
  } = {}) {
    if (!this.started) {
      return {
        ok: false,
        code: "session_not_started"
      };
    }

    const commitResult = this.audioPipeline.consumeCommitSnapshot({
      reason,
      minMs: this.runtimeConfig.voiceCoreMinCommitMs || AUDIO_MIN_COMMIT_MS,
      minBytes: this.runtimeConfig.voiceCoreMinCommitBytes || AUDIO_MIN_COMMIT_BYTES
    });

    if (!commitResult.ok) {
      await this.sendControlEvent("warning", {
        code: commitResult.code,
        message: commitResult.reason,
        source,
        buffered_ms: Number(commitResult.buffered_ms || 0),
        buffered_bytes: Number(commitResult.buffered_bytes || 0),
        t_ms: this.now()
      });
      return commitResult;
    }

    const snapshot = commitResult.snapshot;
    this.markCommitted(snapshot);
    this.turnManager.onTurnCommitted();

    await this.setState(SESSION_STATES.THINKING, `commit:${source}`);
    await this.sendSessionState("thinking", `commit:${source}`);

    await this.aiProvider.commitInput({
      commitId: snapshot.commit_id,
      reason,
      bufferedMs: snapshot.buffered_ms,
      forceResponse
    });

    return {
      ok: true,
      code: "ok",
      commit_id: snapshot.commit_id,
      buffered_ms: snapshot.buffered_ms,
      buffered_bytes: snapshot.buffered_bytes
    };
  }

  async handleInterrupt({ reason = "interrupt" } = {}) {
    if (!this.started) {
      return;
    }

    const outputStats = this.audioPipeline.getStats()?.output || {};
    const truncateAudioMs = Math.max(
      0,
      Math.trunc(Number(outputStats.buffered_ms || 0))
    );
    this.audioPipeline.clearOutputFrames();
    this.turnManager.setAssistantSpeaking(false);

    await this.sendControlEvent("audio.clear", {
      reason,
      t_ms: this.now()
    });

    await this.setState(SESSION_STATES.INTERRUPTED, reason);
    await this.sendSessionState("interrupted", reason);

    try {
      await this.aiProvider.interrupt({
        reason,
        truncateAudioMs
      });
    } catch (interruptError) {
      warn(
        this.debugScope,
        `provider interrupt failed: ${interruptError?.message || interruptError}`
      );
    }
  }

  async handleBargeIn(event = {}) {
    if (!this.started) {
      return;
    }

    const normalizedState = normalizeState(this.state);
    if (
      normalizedState !== SESSION_STATES.SPEAKING &&
      normalizedState !== SESSION_STATES.THINKING
    ) {
      return;
    }

    await this.handleInterrupt({
      reason: String(event?.reason || "barge_in").trim() || "barge_in"
    });
  }

  async stop({ reason = "session_stop" } = {}) {
    if (this.closed) {
      return this.getStatus();
    }

    const normalizedReason = String(reason || "session_stop").trim() || "session_stop";

    try {
      this.turnManager.reset();
      this.audioPipeline.resetAll();
      await this.aiProvider.stopSession({ reason: normalizedReason });
    } catch (stopError) {
      error(this.debugScope, `stop failed: ${stopError?.message || stopError}`);
    }

    await this.setState(SESSION_STATES.STOPPED, normalizedReason);
    await this.sendSessionState("stopped", normalizedReason).catch(() => {});

    this.closed = true;
    this.started = false;
    this.metrics = this.createEmptyMetrics();

    this.emit("stopped", {
      session_id: this.sessionId,
      reason: normalizedReason,
      t_ms: this.now()
    });

    return this.getStatus();
  }
}

module.exports = {
  VoiceSession
};

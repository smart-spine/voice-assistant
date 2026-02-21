const { EventEmitter } = require("events");
const { SemanticTurnDetector } = require("../../semantic-turn-detector");

function toInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = Math.trunc(parsed);
  return Math.min(max, Math.max(min, normalized));
}

function toFloat(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function computePcm16Rms(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2) {
    return 0;
  }

  const sampleCount = Math.floor(bytes.byteLength / 2);
  if (!sampleCount) {
    return 0;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  let sum = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 0x8000;
    sum += sample * sample;
  }

  return Math.sqrt(sum / sampleCount);
}

class TurnManager extends EventEmitter {
  constructor({
    vadThreshold = 0.015,
    vadSilenceMs = 280,
    vadHangoverMs = 180,
    minSpeechMsForTurn = 180,
    bargeInMinMs = 220,
    semanticEotEnabled = false,
    semanticEotUseLlm = false,
    semanticEotApiKey = "",
    semanticEotModel = "gpt-4o-mini",
    semanticEotTimeoutMs = 180,
    semanticEotMinDelayMs = 250,
    semanticEotMaxDelayMs = 900,
    now = () => Date.now()
  } = {}) {
    super();

    this.now = typeof now === "function" ? now : () => Date.now();

    this.vadThreshold = toFloat(vadThreshold, 0.015, 0.001, 0.2);
    this.vadSilenceMs = toInt(vadSilenceMs, 280, 60, 4000);
    this.vadHangoverMs = toInt(vadHangoverMs, 180, 0, 2000);
    this.minSpeechMsForTurn = toInt(minSpeechMsForTurn, 180, 40, 20000);
    this.bargeInMinMs = toInt(bargeInMinMs, 220, 40, 5000);

    this.semanticDetector = new SemanticTurnDetector({
      enabled: Boolean(semanticEotEnabled),
      useLlm: Boolean(semanticEotUseLlm),
      apiKey: String(semanticEotApiKey || "").trim(),
      model: String(semanticEotModel || "gpt-4o-mini").trim() || "gpt-4o-mini",
      timeoutMs: semanticEotTimeoutMs,
      minDelayMs: semanticEotMinDelayMs,
      maxDelayMs: semanticEotMaxDelayMs
    });

    this.assistantSpeaking = false;
    this.speechActive = false;
    this.speechStartedAt = 0;
    this.lastSpeechAt = 0;

    this.pendingBargeIn = false;
    this.bargeInStartedAt = 0;
    this.bargeInConfirmed = false;

    this.lastPartialText = "";
    this.lastFinalText = "";
    this.lastFinalAt = 0;

    this.pendingEotTimer = null;
    this.pendingEotReason = "";
  }

  reset() {
    if (this.pendingEotTimer) {
      clearTimeout(this.pendingEotTimer);
      this.pendingEotTimer = null;
    }

    this.speechActive = false;
    this.speechStartedAt = 0;
    this.lastSpeechAt = 0;

    this.pendingBargeIn = false;
    this.bargeInStartedAt = 0;
    this.bargeInConfirmed = false;

    this.lastPartialText = "";
    this.lastFinalText = "";
    this.lastFinalAt = 0;
    this.pendingEotReason = "";
  }

  setAssistantSpeaking(active) {
    const normalized = Boolean(active);
    if (this.assistantSpeaking === normalized) {
      return;
    }
    this.assistantSpeaking = normalized;
    if (!normalized) {
      this.pendingBargeIn = false;
      this.bargeInStartedAt = 0;
      this.bargeInConfirmed = false;
    }
  }

  onSttPartial(text) {
    this.lastPartialText = String(text || "").trim();
  }

  async onSttFinal(text, { isFirstUserTurn = false } = {}) {
    const normalized = String(text || "").trim();
    if (!normalized) {
      return null;
    }

    this.lastFinalText = normalized;
    this.lastFinalAt = this.now();

    const semantic = await this.semanticDetector.evaluate(normalized, {
      isFirstUserTurn
    });

    if (!semantic || !this.semanticDetector.enabled) {
      return semantic || null;
    }

    // Do not auto-close turns while assistant is speaking.
    // During full-duplex this is usually echo/overlap and must be handled
    // through barge-in interrupt flow, not regular EoT commit.
    if (this.assistantSpeaking) {
      return semantic;
    }

    if (semantic.status === "complete") {
      this.scheduleEot({
        reason: "semantic_complete",
        confidence: Number(semantic.confidence || 0.5),
        delayMs: Number(semantic.recommendedDelayMs || this.vadSilenceMs)
      });
    } else if (semantic.status === "uncertain") {
      this.scheduleEot({
        reason: "semantic_uncertain",
        confidence: Number(semantic.confidence || 0.5),
        delayMs: Number(semantic.recommendedDelayMs || this.vadSilenceMs)
      });
    }

    return semantic;
  }

  onTurnCommitted() {
    if (this.pendingEotTimer) {
      clearTimeout(this.pendingEotTimer);
      this.pendingEotTimer = null;
    }
    this.pendingEotReason = "";
    this.lastPartialText = "";
    this.lastFinalText = "";
    this.lastFinalAt = 0;
  }

  scheduleEot({ reason = "vad_silence", confidence = 0.6, delayMs = this.vadSilenceMs } = {}) {
    const normalizedDelay = toInt(delayMs, this.vadSilenceMs, 0, 6000);
    this.pendingEotReason = String(reason || "vad_silence");

    if (this.pendingEotTimer) {
      clearTimeout(this.pendingEotTimer);
      this.pendingEotTimer = null;
    }

    this.pendingEotTimer = setTimeout(() => {
      this.pendingEotTimer = null;
      this.emit("turn.eot", {
        reason: this.pendingEotReason || "vad_silence",
        confidence: toFloat(confidence, 0.6, 0, 1),
        delay_ms: normalizedDelay,
        t_ms: this.now()
      });
    }, normalizedDelay);
  }

  onInputFrame(frame) {
    const now = this.now();
    const frameDurationMs = Math.max(1, Number(frame?.duration_ms || 0) || 20);
    const rms = computePcm16Rms(frame?.bytes);
    const effectiveVadThreshold = this.assistantSpeaking
      ? Math.max(0.003, this.vadThreshold * 0.55)
      : this.vadThreshold;
    const speechDetected = rms >= effectiveVadThreshold;

    if (speechDetected) {
      if (!this.speechActive) {
        this.speechActive = true;
        this.speechStartedAt = now;
        this.emit("vad.start", {
          state: "start",
          rms,
          t_ms: now
        });
      }
      this.lastSpeechAt = now;

      if (this.assistantSpeaking) {
        if (!this.pendingBargeIn) {
          this.pendingBargeIn = true;
          this.bargeInStartedAt = now;
          this.bargeInConfirmed = false;
          this.emit("barge_in.start", {
            reason: "assistant_speaking",
            rms,
            threshold: effectiveVadThreshold,
            t_ms: now
          });
        }

        const bargeInMs = Math.max(0, now - this.bargeInStartedAt + frameDurationMs);
        if (!this.bargeInConfirmed && bargeInMs >= this.bargeInMinMs) {
          this.bargeInConfirmed = true;
          this.emit("barge_in.confirmed", {
            reason: "speech_while_assistant",
            rms,
            threshold: effectiveVadThreshold,
            speech_ms: bargeInMs,
            t_ms: now
          });
        }
      }
      return;
    }

    if (!this.speechActive) {
      if (this.pendingBargeIn && !this.bargeInConfirmed && now - this.bargeInStartedAt > this.vadHangoverMs) {
        this.pendingBargeIn = false;
        this.bargeInStartedAt = 0;
        this.emit("barge_in.cancelled", {
          reason: "short_fragment",
          t_ms: now
        });
      }
      return;
    }

    const silenceMs = Math.max(0, now - this.lastSpeechAt);
    if (silenceMs < this.vadSilenceMs + this.vadHangoverMs) {
      return;
    }

    const speechMs = this.speechStartedAt ? Math.max(0, now - this.speechStartedAt) : 0;

    this.speechActive = false;
    this.speechStartedAt = 0;
    this.lastSpeechAt = 0;

    if (this.pendingBargeIn && !this.bargeInConfirmed) {
      this.emit("barge_in.cancelled", {
        reason: "below_threshold",
        speech_ms: speechMs,
        t_ms: now
      });
    }

    this.pendingBargeIn = false;
    this.bargeInStartedAt = 0;
    this.bargeInConfirmed = false;

    this.emit("vad.stop", {
      state: "stop",
      speech_ms: speechMs,
      t_ms: now
    });

    // While assistant is speaking, VAD stop should not create a regular EoT.
    // If user truly interrupts, barge_in.confirmed path handles it.
    if (this.assistantSpeaking) {
      return;
    }

    if (speechMs < this.minSpeechMsForTurn) {
      return;
    }

    this.emit("speech.confirmed", {
      reason: "vad_speech_confirmed",
      speech_ms: speechMs,
      t_ms: now
    });

    this.scheduleEot({
      reason: "vad_silence",
      confidence: 0.66,
      delayMs: this.vadHangoverMs
    });
  }
}

module.exports = {
  TurnManager,
  computePcm16Rms
};

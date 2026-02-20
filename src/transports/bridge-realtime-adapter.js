const { normalizeText } = require("../utils/text-utils");

function parseLanguageTag(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const [primary] = normalized.split("-");
  if (!primary || primary.length < 2 || primary.length > 3) {
    return "";
  }
  return primary;
}

class BridgeRealtimeAdapter {
  constructor({
    transportAdapter,
    model,
    language = "en-US",
    instructions = "",
    voice = "alloy",
    temperature = 0.8,
    connectTimeoutMs = 8000,
    inputTranscriptionModel = "gpt-4o-mini-transcribe",
    turnDetection = "manual",
    turnDetectionEagerness = "auto",
    vadThreshold = 0.45,
    vadSilenceMs = 280,
    vadPrefixPaddingMs = 180,
    interruptResponseOnTurn = true,
    bargeInMinMs = 220,
    inputDeviceId = "",
    inputDeviceLabel = "",
    inputPreferLoopback = true,
    onLog = () => {}
  } = {}) {
    this.transportAdapter = transportAdapter;
    this.model = String(model || "gpt-4o-mini-realtime-preview-2024-12-17").trim();
    this.language = parseLanguageTag(language);
    this.instructions = String(instructions || "").trim();
    this.voice = String(voice || "alloy").trim() || "alloy";
    this.temperature = Number.isFinite(Number(temperature))
      ? Math.min(1.2, Math.max(0.6, Number(temperature)))
      : 0.8;
    this.connectTimeoutMs = Number.isFinite(Number(connectTimeoutMs))
      ? Math.min(30000, Math.max(1000, Math.trunc(Number(connectTimeoutMs))))
      : 8000;
    this.inputTranscriptionModel = String(
      inputTranscriptionModel || "gpt-4o-mini-transcribe"
    ).trim();
    this.turnDetection = String(turnDetection || "semantic_vad")
      .trim()
      .toLowerCase();
    if (!["manual", "server_vad", "semantic_vad"].includes(this.turnDetection)) {
      this.turnDetection = "semantic_vad";
    }
    this.turnDetectionEagerness = String(turnDetectionEagerness || "auto")
      .trim()
      .toLowerCase();
    this.vadThreshold = Number.isFinite(Number(vadThreshold))
      ? Math.min(1, Math.max(0, Number(vadThreshold)))
      : 0.45;
    this.vadSilenceMs = Number.isFinite(Number(vadSilenceMs))
      ? Math.min(2000, Math.max(120, Math.trunc(Number(vadSilenceMs))))
      : 280;
    this.vadPrefixPaddingMs = Number.isFinite(Number(vadPrefixPaddingMs))
      ? Math.min(1000, Math.max(0, Math.trunc(Number(vadPrefixPaddingMs))))
      : 180;
    this.interruptResponseOnTurn = Boolean(interruptResponseOnTurn);
    this.bargeInMinMs = Number.isFinite(Number(bargeInMinMs))
      ? Math.min(5000, Math.max(80, Math.trunc(Number(bargeInMinMs))))
      : 220;
    this.inputDeviceId = String(inputDeviceId || "").trim();
    this.inputDeviceLabel = String(inputDeviceLabel || "").trim();
    this.inputPreferLoopback = Boolean(inputPreferLoopback);

    this.onLog = typeof onLog === "function" ? onLog : () => {};
    this.started = false;
  }

  log(message) {
    const line = normalizeText(message);
    if (!line) {
      return;
    }
    this.onLog(line);
  }

  async start() {
    if (this.started) {
      return true;
    }
    if (
      !this.transportAdapter ||
      typeof this.transportAdapter.startRealtime !== "function"
    ) {
      throw new Error("Transport adapter does not support bridge realtime mode.");
    }

    const effectiveTurnDetection =
      this.turnDetection === "manual" ? "semantic_vad" : this.turnDetection;
    if (effectiveTurnDetection !== this.turnDetection) {
      this.log(
        "turn_detection=manual is not supported for continuous voice input; using semantic_vad."
      );
    }

    const started = await this.transportAdapter.startRealtime({
      model: this.model,
      language: this.language || undefined,
      instructions: this.instructions,
      voice: this.voice,
      temperature: this.temperature,
      connectTimeoutMs: this.connectTimeoutMs,
      inputTranscriptionModel: this.inputTranscriptionModel,
      turnDetection: effectiveTurnDetection,
      turnDetectionEagerness: this.turnDetectionEagerness,
      vadThreshold: this.vadThreshold,
      vadSilenceMs: this.vadSilenceMs,
      vadPrefixPaddingMs: this.vadPrefixPaddingMs,
      interruptResponseOnTurn: this.interruptResponseOnTurn,
      bargeInMinMs: this.bargeInMinMs,
      inputDeviceId: this.inputDeviceId || undefined,
      inputDeviceLabel: this.inputDeviceLabel || undefined,
      inputPreferLoopback: this.inputPreferLoopback
    });

    if (!started) {
      throw new Error("Bridge realtime start did not return success.");
    }
    this.started = true;
    this.log(
      `bridge realtime started (model=${this.model}, turn_detection=${effectiveTurnDetection}).`
    );
    return true;
  }

  async stop() {
    if (!this.started) {
      return true;
    }
    this.started = false;
    try {
      if (
        this.transportAdapter &&
        typeof this.transportAdapter.stopRealtime === "function"
      ) {
        await this.transportAdapter.stopRealtime();
      }
    } catch (_) {
      // Ignore stop errors during shutdown.
    }
    this.log("bridge realtime stopped.");
    return true;
  }

  async createTextTurn({ text, role = "user", createResponse = true } = {}) {
    if (!this.started) {
      return false;
    }
    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      return false;
    }
    return Boolean(
      await this.transportAdapter.realtimeCreateTextTurn({
        text: normalizedText,
        role: String(role || "user").trim().toLowerCase(),
        createResponse: Boolean(createResponse)
      })
    );
  }

  async appendSystemContext(note = "") {
    if (!this.started) {
      return false;
    }
    const normalized = normalizeText(note);
    if (!normalized) {
      return false;
    }
    if (typeof this.transportAdapter.realtimeAppendSystemContext === "function") {
      return Boolean(await this.transportAdapter.realtimeAppendSystemContext(normalized));
    }
    return this.createTextTurn({
      role: "system",
      text: normalized,
      createResponse: false
    });
  }

  async interrupt({ reason = "barge-in", clearInputBuffer = false } = {}) {
    if (!this.started) {
      return false;
    }
    if (
      !this.transportAdapter ||
      typeof this.transportAdapter.realtimeInterrupt !== "function"
    ) {
      return false;
    }
    const interrupted = await this.transportAdapter.realtimeInterrupt({
      reason: normalizeText(reason || "barge-in") || "barge-in",
      clearInputBuffer: Boolean(clearInputBuffer)
    });
    if (interrupted) {
      this.log(
        `bridge realtime interrupted (${normalizeText(reason) || "unknown"}).`
      );
    }
    return Boolean(interrupted);
  }
}

module.exports = {
  BridgeRealtimeAdapter
};

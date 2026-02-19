const OpenAI = require("openai");
const { OpenAIRealtimeWS } = require("openai/beta/realtime/ws");
const { normalizeText } = require("../utils/text-utils");

function clamp(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

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

function createEventId(prefix = "evt") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncateForLog(value, maxChars = 160) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }
  const limit = Math.max(24, Number(maxChars) || 160);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function extractWavPcm16(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  if (buffer.length < 44) {
    throw new Error("WAV payload is too small.");
  }
  if (buffer.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("WAV RIFF header is missing.");
  }
  if (buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV format header is missing.");
  }

  let offset = 12;
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    const chunkDataEnd = Math.min(buffer.length, chunkDataOffset + chunkSize);

    if (chunkId === "fmt " && chunkDataOffset + 16 <= chunkDataEnd) {
      audioFormat = buffer.readUInt16LE(chunkDataOffset);
      channels = buffer.readUInt16LE(chunkDataOffset + 2);
      sampleRate = buffer.readUInt32LE(chunkDataOffset + 4);
      bitsPerSample = buffer.readUInt16LE(chunkDataOffset + 14);
    } else if (chunkId === "data") {
      dataOffset = chunkDataOffset;
      dataLength = Math.max(0, chunkDataEnd - chunkDataOffset);
      break;
    }

    const alignedChunkSize = chunkSize + (chunkSize % 2);
    offset = chunkDataOffset + alignedChunkSize;
  }

  if (audioFormat !== 1) {
    throw new Error(`Unsupported WAV format: ${audioFormat}. Expected PCM.`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}. Expected 16-bit PCM.`);
  }
  if (channels < 1) {
    throw new Error("Invalid WAV channel count.");
  }
  if (!Number.isFinite(sampleRate) || sampleRate < 8000) {
    throw new Error("Invalid WAV sample rate.");
  }
  if (dataOffset < 0 || dataLength <= 0) {
    throw new Error("WAV data chunk is missing.");
  }

  const bytesPerFrame = channels * 2;
  const frameCount = Math.floor(dataLength / bytesPerFrame);
  const samples = new Int16Array(frameCount);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const sampleOffset = dataOffset + frameIndex * bytesPerFrame;
    samples[frameIndex] = buffer.readInt16LE(sampleOffset);
  }

  return {
    sampleRate,
    channels,
    samples
  };
}

function resamplePcm16(samples, sourceRate, targetRate) {
  const input =
    samples instanceof Int16Array
      ? samples
      : new Int16Array(Buffer.from(samples || []).buffer);
  if (!input.length) {
    return new Int16Array(0);
  }

  const fromRate = Math.max(1, Math.trunc(Number(sourceRate) || 24000));
  const toRate = Math.max(1, Math.trunc(Number(targetRate) || fromRate));
  if (fromRate === toRate) {
    return input;
  }

  if (fromRate < toRate) {
    const upsampleRatio = toRate / fromRate;
    const outputLength = Math.max(1, Math.round(input.length * upsampleRatio));
    const output = new Int16Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const sourceIndex = Math.min(
        input.length - 1,
        Math.round(index / upsampleRatio)
      );
      output[index] = input[sourceIndex];
    }
    return output;
  }

  const ratio = fromRate / toRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));

    if (end <= start) {
      output[index] = input[Math.min(input.length - 1, start)];
      continue;
    }

    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      sum += input[sourceIndex];
    }

    output[index] = Math.max(
      -32768,
      Math.min(32767, Math.round(sum / Math.max(1, end - start)))
    );
  }

  return output;
}

function int16ArrayToBuffer(samples) {
  if (Buffer.isBuffer(samples)) {
    return samples;
  }
  const source = samples instanceof Int16Array ? samples : new Int16Array(0);
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
}

function encodeWavFromPcm16(pcmBuffer, sampleRate = 24000, channels = 1) {
  const payload = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || []);
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;

  const wav = Buffer.alloc(44 + payload.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + payload.length, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(payload.length, 40);
  payload.copy(wav, 44);

  return wav;
}

class RealtimeTransportAdapter {
  constructor({
    apiKey,
    model,
    language = "en-US",
    instructions = "",
    voice = "alloy",
    temperature = 0.8,
    inputSampleRateHz = 24000,
    outputSampleRateHz = 24000,
    outputChunkMs = 120,
    connectTimeoutMs = 8000,
    inputTranscriptionModel = "gpt-4o-mini-transcribe",
    turnDetection = "manual",
    turnDetectionEagerness = "auto",
    vadThreshold = 0.45,
    vadSilenceMs = 280,
    vadPrefixPaddingMs = 180,
    interruptResponseOnTurn = true,
    maxResponseOutputTokens = "inf",
    bargeInMinMs = 220,
    onEvent = () => {},
    onLog = () => {}
  } = {}) {
    this.apiKey = String(apiKey || "").trim();
    this.model = String(model || "gpt-4o-mini-realtime-preview-2024-12-17").trim();
    this.language = parseLanguageTag(language);
    this.instructions = String(instructions || "").trim();
    this.voice = String(voice || "alloy").trim() || "alloy";
    this.temperature = clamp(temperature, 0.6, 1.2, 0.8);

    this.inputSampleRateHz = Math.max(
      8000,
      Math.min(48000, Math.trunc(Number(inputSampleRateHz) || 24000))
    );
    this.outputSampleRateHz = Math.max(
      8000,
      Math.min(48000, Math.trunc(Number(outputSampleRateHz) || 24000))
    );
    this.outputChunkMs = Math.max(
      40,
      Math.min(500, Math.trunc(Number(outputChunkMs) || 120))
    );
    this.outputChunkTargetBytes = Math.max(
      320,
      Math.round((this.outputSampleRateHz * 2 * this.outputChunkMs) / 1000)
    );

    this.connectTimeoutMs = Math.max(
      1000,
      Math.min(30000, Math.trunc(Number(connectTimeoutMs) || 8000))
    );
    this.inputTranscriptionModel = String(
      inputTranscriptionModel || "gpt-4o-mini-transcribe"
    ).trim();

    const normalizedTurnDetection = String(turnDetection || "manual")
      .trim()
      .toLowerCase();
    if (["manual", "server_vad", "semantic_vad"].includes(normalizedTurnDetection)) {
      this.turnDetection = normalizedTurnDetection;
    } else {
      this.turnDetection = "manual";
    }

    this.turnDetectionEagerness = ["low", "medium", "high", "auto"].includes(
      String(turnDetectionEagerness || "auto").trim().toLowerCase()
    )
      ? String(turnDetectionEagerness || "auto").trim().toLowerCase()
      : "auto";

    this.vadThreshold = clamp(vadThreshold, 0, 1, 0.45);
    this.vadSilenceMs = Math.max(
      120,
      Math.min(2000, Math.trunc(Number(vadSilenceMs) || 280))
    );
    this.vadPrefixPaddingMs = Math.max(
      0,
      Math.min(1000, Math.trunc(Number(vadPrefixPaddingMs) || 180))
    );

    this.interruptResponseOnTurn = Boolean(interruptResponseOnTurn);
    this.maxResponseOutputTokens =
      maxResponseOutputTokens === "inf"
        ? "inf"
        : Math.max(
            16,
            Math.min(4096, Math.trunc(Number(maxResponseOutputTokens) || 512))
          );

    this.bargeInMinMs = Math.max(
      80,
      Math.min(5000, Math.trunc(Number(bargeInMinMs) || 220))
    );

    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.onLog = typeof onLog === "function" ? onLog : () => {};

    this.client = null;
    this.socket = null;
    this.started = false;
    this.sessionReady = false;

    this.commitChain = Promise.resolve();
    this.segmentSentSamples = 0;

    this.outputPcmBuffer = Buffer.alloc(0);
    this.outputResponseId = "";

    this.userPartialByItem = new Map();
    this.assistantTextByResponse = new Map();

    this.speechActive = false;
    this.speechStartedAtMs = 0;
    this.speechConfirmTimer = null;
    this.speechConfirmed = false;
  }

  emit(event = {}) {
    try {
      this.onEvent({
        source: "openai-realtime",
        ts: Date.now(),
        ...event
      });
    } catch (_) {
      // Ignore consumer-side errors; realtime stream should continue.
    }
  }

  log(message) {
    const line = normalizeText(message);
    if (!line) {
      return;
    }
    this.onLog(line);
  }

  removeListener(eventName, handler) {
    if (!this.socket || typeof this.socket.off !== "function") {
      return;
    }
    try {
      this.socket.off(eventName, handler);
    } catch (_) {
      // Ignore listener cleanup failures.
    }
  }

  send(event) {
    if (!this.socket) {
      throw new Error("Realtime socket is not initialized.");
    }
    this.socket.send(event);
  }

  buildTurnDetectionConfig() {
    if (this.turnDetection === "server_vad") {
      return {
        type: "server_vad",
        threshold: this.vadThreshold,
        silence_duration_ms: this.vadSilenceMs,
        prefix_padding_ms: this.vadPrefixPaddingMs,
        create_response: true,
        interrupt_response: this.interruptResponseOnTurn
      };
    }

    if (this.turnDetection === "semantic_vad") {
      return {
        type: "semantic_vad",
        eagerness: this.turnDetectionEagerness,
        create_response: true,
        interrupt_response: this.interruptResponseOnTurn
      };
    }

    return null;
  }

  buildSessionUpdatePayload() {
    return {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: this.instructions,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: this.inputTranscriptionModel,
          language: this.language || undefined
        },
        voice: this.voice,
        temperature: this.temperature,
        turn_detection: this.buildTurnDetectionConfig()
      }
    };
  }

  async waitForOpen() {
    if (!this.socket || !this.socket.socket) {
      throw new Error("Realtime socket is unavailable.");
    }

    const wsSocket = this.socket.socket;
    if (wsSocket.readyState === 1) {
      return;
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Realtime websocket open timed out after ${this.connectTimeoutMs}ms.`
          )
        );
      }, this.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        wsSocket.off("open", onOpen);
        wsSocket.off("error", onError);
        wsSocket.off("close", onClose);
      };

      const onOpen = () => {
        cleanup();
        resolve();
      };

      const onError = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Realtime websocket closed before opening."));
      };

      wsSocket.on("open", onOpen);
      wsSocket.on("error", onError);
      wsSocket.on("close", onClose);
    });
  }

  async waitForSessionUpdateAck() {
    if (!this.socket) {
      throw new Error("Realtime socket is unavailable.");
    }

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Realtime session.update timed out after ${this.connectTimeoutMs}ms.`
          )
        );
      }, this.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener("session.updated", onUpdated);
        this.removeListener("error", onError);
      };

      const onUpdated = () => {
        cleanup();
        resolve();
      };

      const onError = (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      this.socket.on("session.updated", onUpdated);
      this.socket.on("error", onError);
      this.send(this.buildSessionUpdatePayload());
    });
  }

  armSpeechConfirmedTimer() {
    if (!this.speechActive || this.speechConfirmed) {
      return;
    }

    if (this.speechConfirmTimer) {
      clearTimeout(this.speechConfirmTimer);
      this.speechConfirmTimer = null;
    }

    this.speechConfirmTimer = setTimeout(() => {
      if (!this.speechActive || this.speechConfirmed) {
        return;
      }
      this.speechConfirmed = true;
      const speechMs = Math.max(0, Date.now() - Number(this.speechStartedAtMs || 0));
      this.emit({
        type: "vad.confirmed",
        reason: "realtime-speech-confirmed",
        speechMs
      });
    }, this.bargeInMinMs);
  }

  flushOutputAudio({ force = false, responseId = "" } = {}) {
    const currentResponseId = String(responseId || this.outputResponseId || "").trim();
    const chunks = [];

    while (this.outputPcmBuffer.length > 0) {
      if (!force && this.outputPcmBuffer.length < this.outputChunkTargetBytes) {
        break;
      }

      const chunkSize = force
        ? this.outputPcmBuffer.length
        : Math.min(this.outputChunkTargetBytes, this.outputPcmBuffer.length);
      const chunk = this.outputPcmBuffer.subarray(0, chunkSize);
      this.outputPcmBuffer = this.outputPcmBuffer.subarray(chunkSize);
      chunks.push(chunk);

      if (force) {
        break;
      }
    }

    for (const chunk of chunks) {
      if (!chunk.length) {
        continue;
      }

      const wavBytes = encodeWavFromPcm16(chunk, this.outputSampleRateHz, 1);
      const durationMs = Math.max(
        1,
        Math.round((chunk.length / 2 / this.outputSampleRateHz) * 1000)
      );
      this.emit({
        type: "assistant.audio.chunk",
        audioBase64: wavBytes.toString("base64"),
        mimeType: "audio/wav",
        durationMs,
        responseId: currentResponseId || undefined
      });
    }
  }

  bindSocketEvents() {
    if (!this.socket) {
      return;
    }

    this.socket.on("session.created", (event) => {
      const model = normalizeText(event?.session?.model || this.model);
      this.log(`realtime connected (model=${model || this.model}).`);
    });

    this.socket.on("session.updated", (event) => {
      this.sessionReady = true;
      this.log(
        `realtime session updated (turn_detection=${
          normalizeText(event?.session?.turn_detection?.type) || "manual"
        }).`
      );
    });

    this.socket.on("input_audio_buffer.speech_started", () => {
      this.speechActive = true;
      this.speechConfirmed = false;
      this.speechStartedAtMs = Date.now();
      this.emit({
        type: "vad.start",
        reason: "realtime-speech-started"
      });
      this.armSpeechConfirmedTimer();
    });

    this.socket.on("input_audio_buffer.speech_stopped", () => {
      const speechMs = Math.max(0, Date.now() - Number(this.speechStartedAtMs || 0));
      if (!this.speechConfirmed && speechMs >= this.bargeInMinMs) {
        this.speechConfirmed = true;
        this.emit({
          type: "vad.confirmed",
          reason: "realtime-speech-stopped",
          speechMs
        });
      }
      this.speechActive = false;
      this.speechStartedAtMs = 0;
      if (this.speechConfirmTimer) {
        clearTimeout(this.speechConfirmTimer);
        this.speechConfirmTimer = null;
      }
      this.speechConfirmed = false;
      this.emit({
        type: "vad.stop",
        reason: "realtime-speech-stopped"
      });
    });

    this.socket.on("conversation.item.input_audio_transcription.delta", (event) => {
      const itemId = normalizeText(event?.item_id || "");
      const delta = normalizeText(event?.delta || "");
      if (!itemId || !delta) {
        return;
      }

      const previous = this.userPartialByItem.get(itemId) || "";
      const next = normalizeText(`${previous} ${delta}`);
      if (!next) {
        return;
      }

      this.userPartialByItem.set(itemId, next);
      this.emit({
        type: "transcript.partial",
        text: next,
        turnId: itemId
      });
    });

    this.socket.on("conversation.item.input_audio_transcription.completed", (event) => {
      const itemId = normalizeText(event?.item_id || "");
      const transcript = normalizeText(event?.transcript || "");
      if (itemId) {
        this.userPartialByItem.delete(itemId);
      }
      if (!transcript) {
        return;
      }

      this.emit({
        type: "transcript.final",
        text: transcript,
        isFinal: true,
        turnId: itemId || undefined
      });
      this.emit({
        type: "turn.final",
        text: transcript,
        isFinal: true,
        turnId: itemId || undefined
      });
    });

    this.socket.on("response.created", (event) => {
      const responseId = normalizeText(event?.response?.id || "");
      if (responseId) {
        this.outputResponseId = responseId;
      }
      this.emit({
        type: "assistant.response.started",
        responseId: responseId || undefined
      });
    });

    this.socket.on("response.audio.delta", (event) => {
      const responseId = normalizeText(event?.response_id || "");
      if (responseId && this.outputResponseId && this.outputResponseId !== responseId) {
        this.flushOutputAudio({ force: true, responseId: this.outputResponseId });
        this.outputPcmBuffer = Buffer.alloc(0);
      }
      if (responseId) {
        this.outputResponseId = responseId;
      }

      const delta = String(event?.delta || "").trim();
      if (!delta) {
        return;
      }

      const pcm = Buffer.from(delta, "base64");
      if (!pcm.length) {
        return;
      }

      this.outputPcmBuffer = Buffer.concat([this.outputPcmBuffer, pcm]);
      this.flushOutputAudio({ force: false, responseId: this.outputResponseId });
    });

    this.socket.on("response.audio.done", (event) => {
      const responseId = normalizeText(event?.response_id || this.outputResponseId);
      this.flushOutputAudio({ force: true, responseId });
      this.outputResponseId = "";
    });

    this.socket.on("response.audio_transcript.delta", (event) => {
      const responseId = normalizeText(event?.response_id || "");
      const delta = normalizeText(event?.delta || "");
      if (!responseId || !delta) {
        return;
      }

      const previous = this.assistantTextByResponse.get(responseId) || "";
      const next = normalizeText(`${previous} ${delta}`);
      if (!next) {
        return;
      }

      this.assistantTextByResponse.set(responseId, next);
      this.emit({
        type: "assistant.text.partial",
        responseId,
        text: next
      });
    });

    this.socket.on("response.audio_transcript.done", (event) => {
      const responseId = normalizeText(event?.response_id || "");
      const transcript = normalizeText(event?.transcript || "");
      if (!responseId || !transcript) {
        return;
      }
      this.assistantTextByResponse.set(responseId, transcript);
      this.emit({
        type: "assistant.text.final",
        responseId,
        text: transcript,
        isFinal: true
      });
    });

    this.socket.on("response.text.done", (event) => {
      const responseId = normalizeText(event?.response_id || "");
      const text = normalizeText(event?.text || "");
      if (!responseId || !text) {
        return;
      }
      if (this.assistantTextByResponse.has(responseId)) {
        return;
      }
      this.assistantTextByResponse.set(responseId, text);
      this.emit({
        type: "assistant.text.final",
        responseId,
        text,
        isFinal: true
      });
    });

    this.socket.on("response.done", (event) => {
      const responseId = normalizeText(event?.response?.id || this.outputResponseId);
      this.flushOutputAudio({ force: true, responseId });
      this.outputResponseId = "";

      const status = normalizeText(event?.response?.status || "") || "unknown";
      const statusReason = normalizeText(event?.response?.status_details?.reason || "");
      this.emit({
        type: "assistant.response.done",
        responseId: responseId || undefined,
        status,
        reason: statusReason || undefined
      });
    });

    this.socket.on("error", (err) => {
      const message = normalizeText(err?.message || err) || "Realtime transport error.";
      this.log(`realtime error: ${message}`);
      this.emit({
        type: "realtime.error",
        reason: message
      });
    });
  }

  async start() {
    if (this.started) {
      return true;
    }
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY is required for realtime transport.");
    }

    this.client = new OpenAI({ apiKey: this.apiKey });
    this.socket = new OpenAIRealtimeWS(
      {
        model: this.model
      },
      this.client
    );

    this.bindSocketEvents();
    await this.waitForOpen();
    await this.waitForSessionUpdateAck();

    this.started = true;
    this.log(
      `realtime transport started (model=${this.model}, turn_detection=${this.turnDetection}).`
    );

    return true;
  }

  async stop() {
    if (this.speechConfirmTimer) {
      clearTimeout(this.speechConfirmTimer);
      this.speechConfirmTimer = null;
    }

    this.started = false;
    this.sessionReady = false;
    this.segmentSentSamples = 0;
    this.outputPcmBuffer = Buffer.alloc(0);
    this.outputResponseId = "";

    this.userPartialByItem.clear();
    this.assistantTextByResponse.clear();

    if (this.socket) {
      try {
        this.socket.close({
          code: 1000,
          reason: "session-stop"
        });
      } catch (_) {
        // Ignore realtime close errors.
      }
    }

    this.socket = null;
    this.client = null;
    this.log("realtime transport stopped.");
    return true;
  }

  async interrupt({ reason = "barge-in", clearInputBuffer = false } = {}) {
    if (!this.socket) {
      return false;
    }

    this.outputPcmBuffer = Buffer.alloc(0);
    this.outputResponseId = "";

    try {
      this.send({
        type: "response.cancel",
        event_id: createEventId("resp_cancel")
      });
    } catch (_) {
      // Ignore response cancel transport errors.
    }

    try {
      this.send({
        type: "output_audio_buffer.clear",
        event_id: createEventId("out_clear")
      });
    } catch (_) {
      // Some providers may not support this event outside WebRTC.
    }

    if (clearInputBuffer) {
      try {
        this.send({
          type: "input_audio_buffer.clear",
          event_id: createEventId("in_clear")
        });
      } catch (_) {
        // Ignore clear failures.
      }
    }

    this.log(`realtime response interrupted (${normalizeText(reason) || "unknown"}).`);
    return true;
  }

  async appendAudioChunk(payload = {}) {
    if (!this.socket || !this.started) {
      return false;
    }

    const audioBase64 = String(payload.audioBase64 || "").trim();
    if (!audioBase64) {
      return false;
    }

    let decoded;
    try {
      decoded = extractWavPcm16(Buffer.from(audioBase64, "base64"));
    } catch (err) {
      this.log(`realtime input chunk decode failed: ${err?.message || err}`);
      return false;
    }

    if (!decoded.samples.length) {
      return false;
    }

    const resampled = resamplePcm16(
      decoded.samples,
      decoded.sampleRate,
      this.inputSampleRateHz
    );
    if (!resampled.length) {
      return false;
    }

    if (resampled.length < this.segmentSentSamples) {
      this.segmentSentSamples = 0;
    }

    const isSegmentFinal = Boolean(payload.isSegmentFinal);
    const newSamples = isSegmentFinal
      ? resampled.subarray(this.segmentSentSamples)
      : resampled.subarray(Math.min(this.segmentSentSamples, resampled.length));

    if (newSamples.length > 0) {
      const pcmChunk = int16ArrayToBuffer(newSamples);
      this.send({
        type: "input_audio_buffer.append",
        audio: pcmChunk.toString("base64")
      });
      this.segmentSentSamples = isSegmentFinal ? 0 : resampled.length;
    } else if (isSegmentFinal) {
      this.segmentSentSamples = 0;
    }

    if (isSegmentFinal && this.turnDetection === "manual") {
      this.commitChain = this.commitChain
        .then(async () => {
          this.send({
            type: "input_audio_buffer.commit",
            event_id: createEventId("in_commit")
          });
          this.send({
            type: "response.create",
            event_id: createEventId("resp_create"),
            response: {
              modalities: ["audio", "text"],
              output_audio_format: "pcm16"
            }
          });
        })
        .catch((err) => {
          this.log(`realtime commit/create failed: ${err?.message || err}`);
        });
      await this.commitChain;
    }

    return true;
  }

  async createTextTurn({ text, role = "user", createResponse = true } = {}) {
    if (!this.socket || !this.started) {
      return false;
    }

    const normalizedText = normalizeText(text);
    if (!normalizedText) {
      return false;
    }

    const normalizedRole = ["user", "system"].includes(
      String(role || "user").trim().toLowerCase()
    )
      ? String(role || "user").trim().toLowerCase()
      : "user";

    this.send({
      type: "conversation.item.create",
      event_id: createEventId("item_create"),
      item: {
        type: "message",
        role: normalizedRole,
        content: [
          {
            type: "input_text",
            text: normalizedText
          }
        ]
      }
    });

    if (createResponse) {
      this.send({
        type: "response.create",
        event_id: createEventId("resp_create"),
        response: {
          modalities: ["audio", "text"],
          output_audio_format: "pcm16"
        }
      });
    }

    this.log(
      `realtime text turn created (role=${normalizedRole}, chars=${normalizedText.length}, preview="${truncateForLog(
        normalizedText,
        120
      )}").`
    );
    return true;
  }

  async appendSystemContext(note) {
    return this.createTextTurn({
      role: "system",
      text: note,
      createResponse: false
    });
  }
}

module.exports = {
  RealtimeTransportAdapter,
  extractWavPcm16,
  resamplePcm16,
  encodeWavFromPcm16
};

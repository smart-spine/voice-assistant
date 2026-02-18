const OpenAI = require("openai");
const { toFile } = require("openai/uploads");
const {
  normalizeText,
  normalizeComparableText,
  countWords
} = require("./utils/text-utils");

function createTurnId() {
  return `oa-stt-turn-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function extensionFromMimeType(mimeType) {
  const value = String(mimeType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();
  if (value.includes("wav")) {
    return "wav";
  }
  if (value.includes("mpeg") || value.includes("mp3")) {
    return "mp3";
  }
  if (value.includes("flac")) {
    return "flac";
  }
  if (value.includes("ogg")) {
    return "ogg";
  }
  if (value.includes("mp4") || value.includes("aac")) {
    return "m4a";
  }
  return "webm";
}

function sanitizeMimeType(mimeType) {
  const normalized = String(mimeType || "")
    .toLowerCase()
    .trim();
  if (!normalized) {
    return "audio/webm;codecs=opus";
  }
  const [baseType] = normalized.split(";");
  if (!baseType || !baseType.startsWith("audio/")) {
    return "audio/webm;codecs=opus";
  }
  return normalized;
}

function isWebmMimeType(mimeType) {
  return String(mimeType || "").toLowerCase().includes("webm");
}

function hasWebmHeader(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  );
}

function findWebmClusterOffset(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return -1;
  }
  return buffer.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
}

function extractTranscribedText(response) {
  if (!response) {
    return "";
  }
  if (typeof response === "string") {
    return normalizeText(response);
  }
  if (typeof response.text === "string") {
    return normalizeText(response.text);
  }
  return "";
}

class OpenAiSttTurnStream {
  constructor({
    apiKey,
    model = "gpt-4o-mini-transcribe",
    language = "en-US",
    turnSilenceMs = 700,
    timeoutMs = 10000,
    minChunkBytes = 3000,
    maxQueueChunks = 6,
    maxRetries = 2,
    onEvent = () => {},
    onLog = () => {}
  } = {}) {
    this.client = new OpenAI({ apiKey });
    this.model = String(model || "gpt-4o-mini-transcribe").trim();
    this.language = parseLanguageTag(language);
    this.turnSilenceMs = Math.max(150, Number(turnSilenceMs) || 700);
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 10000);
    this.minChunkBytes = Math.max(0, Number(minChunkBytes) || 0);
    this.maxQueueChunks = Math.max(
      1,
      Math.min(64, Math.trunc(Number(maxQueueChunks) || 6))
    );
    this.maxRetries = Math.max(0, Math.min(5, Math.trunc(Number(maxRetries) || 0)));

    this.onEvent = onEvent;
    this.onLog = onLog;

    this.queue = [];
    this.processing = false;
    this.stopped = false;
    this.finalizeTimer = null;
    this.activeTurnId = "";
    this.activeText = "";
    this.activeComparable = "";
    this.activeUpdatedAtMs = 0;
    this.webmInitSegment = null;
    this.lastQueueTrimLogAtMs = 0;
    this.lastFinalComparable = "";
    this.lastFinalAtMs = 0;
  }

  emit(payload = {}) {
    try {
      this.onEvent?.({
        source: "openai-stt",
        ts: Date.now(),
        ...payload
      });
    } catch (_) {
      // Ignore consumer-side errors; stream should keep running.
    }
  }

  log(message) {
    const line = normalizeText(message);
    if (!line) {
      return;
    }
    this.onLog?.(line);
  }

  enqueueChunk(chunk = {}) {
    if (this.stopped) {
      return;
    }

    const audioBase64 = String(chunk.audioBase64 || "").trim();
    if (!audioBase64) {
      return;
    }

    this.queue.push({
      audioBase64,
      mimeType: String(chunk.mimeType || "audio/webm;codecs=opus").trim(),
      ts: Number.isFinite(Number(chunk.ts)) ? Number(chunk.ts) : Date.now(),
      durationMs: Number.isFinite(Number(chunk.durationMs))
        ? Number(chunk.durationMs)
        : undefined,
      isSegmentFinal: Boolean(chunk.isSegmentFinal)
    });
    if (this.queue.length > this.maxQueueChunks) {
      const dropCount = this.queue.length - this.maxQueueChunks;
      this.queue.splice(0, dropCount);
      const now = Date.now();
      if (now - this.lastQueueTrimLogAtMs > 3000) {
        this.log(
          `openai-stt queue trimmed by ${dropCount} chunk(s) to reduce latency.`
        );
        this.lastQueueTrimLogAtMs = now;
      }
    }

    void this.processQueue();
  }

  async processQueue() {
    if (this.processing || this.stopped) {
      return;
    }
    this.processing = true;

    try {
      while (this.queue.length > 0 && !this.stopped) {
        const chunk = this.queue.shift();
        await this.processChunk(chunk);
      }
    } finally {
      this.processing = false;
    }
  }

  async processChunk({ audioBase64, mimeType, ts, durationMs, isSegmentFinal }) {
    const inputBuffer = Buffer.from(audioBase64, "base64");
    const normalizedMimeType = sanitizeMimeType(mimeType);
    const buffer = this.prepareAudioBuffer(inputBuffer, normalizedMimeType);
    if (buffer.length === 0) {
      return;
    }

    if (this.minChunkBytes > 0 && buffer.length < this.minChunkBytes) {
      return;
    }

    const transcribed = await this.transcribeBuffer(buffer, normalizedMimeType);
    if (!transcribed) {
      return;
    }

    const normalizedTranscribed = normalizeText(transcribed);
    if (
      this.shouldDropTranscription(normalizedTranscribed, {
        isSegmentFinal,
        durationMs
      })
    ) {
      return;
    }

    if (isSegmentFinal) {
      this.pushSegmentFinalTranscript(normalizedTranscribed, ts, {
        durationMs
      });
      return;
    }

    this.pushTranscript(normalizedTranscribed, ts);
  }

  shouldDropTranscription(text, { isSegmentFinal = false, durationMs } = {}) {
    const normalized = normalizeText(text);
    const comparable = normalizeComparableText(normalized);
    if (!normalized || !comparable) {
      return true;
    }

    const words = countWords(normalized);
    if (words <= 0) {
      return true;
    }

    if (words === 1 && comparable.length <= 1) {
      return true;
    }

    // Very short segment + single token tends to be noise from routing artifacts.
    if (
      isSegmentFinal &&
      words === 1 &&
      Number.isFinite(Number(durationMs)) &&
      Number(durationMs) < 700
    ) {
      return true;
    }

    return false;
  }

  async transcribeBuffer(buffer, mimeType) {
    const extension = extensionFromMimeType(mimeType);
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const file = await toFile(buffer, `chunk-${Date.now()}.${extension}`, {
        type: mimeType
      });
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        abortController.abort();
      }, this.timeoutMs);

      try {
        const payload = {
          model: this.model,
          file,
          response_format: "text"
        };
        if (this.language) {
          payload.language = this.language;
        }

        const response = await this.client.audio.transcriptions.create(payload, {
          signal: abortController.signal
        });
        clearTimeout(timeout);
        return extractTranscribedText(response);
      } catch (err) {
        clearTimeout(timeout);
        const status = Number(err?.status || 0);
        const message = String(err?.message || err || "");
        const timedOut = abortController.signal.aborted;
        const isRetryableStatus = status === 403 || status === 429 || status >= 500;
        const shouldRetry =
          attempt < this.maxRetries && (timedOut || isRetryableStatus);

        if (timedOut) {
          this.log(
            `openai-stt chunk timed out (attempt ${attempt + 1}/${this.maxRetries + 1})`
          );
        } else {
          if (status === 400 && attempt === 0) {
            this.log(
              `openai-stt chunk rejected by format validator (bytes=${buffer.length}, mime=${mimeType}, magic=${buffer
                .subarray(0, 8)
                .toString("hex")})`
            );
          }
          this.log(
            `openai-stt chunk failed (status=${status || "n/a"}, attempt ${
              attempt + 1
            }/${this.maxRetries + 1}): ${message}`
          );
        }

        if (!shouldRetry) {
          return "";
        }

        await sleep(250 * (attempt + 1));
      }
    }

    return "";
  }

  prepareAudioBuffer(buffer, mimeType) {
    if (!isWebmMimeType(mimeType) || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      return buffer;
    }

    if (hasWebmHeader(buffer)) {
      const clusterOffset = findWebmClusterOffset(buffer);
      if (clusterOffset > 0) {
        const initSegment = buffer.subarray(0, clusterOffset);
        if (initSegment.length >= 16 && initSegment.length <= 128 * 1024) {
          this.webmInitSegment = Buffer.from(initSegment);
        }
      } else if (buffer.length <= 128 * 1024) {
        this.webmInitSegment = Buffer.from(buffer);
      }
      return buffer;
    }

    if (this.webmInitSegment?.length) {
      return Buffer.concat([this.webmInitSegment, buffer]);
    }

    return buffer;
  }

  pushSegmentFinalTranscript(text, ts, { durationMs } = {}) {
    const normalizedText = normalizeText(text);
    const comparable = normalizeComparableText(normalizedText);
    if (!normalizedText || !comparable) {
      return;
    }

    const now = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
    if (
      comparable === this.lastFinalComparable &&
      now - this.lastFinalAtMs <= 2500
    ) {
      return;
    }
    this.lastFinalComparable = comparable;
    this.lastFinalAtMs = now;

    if (this.activeTurnId) {
      this.flushTurn({ reason: "segment-preempt", ts: now });
    }

    const turnId = createTurnId();
    const segmentDurationMs = Number.isFinite(Number(durationMs))
      ? Math.max(0, Math.trunc(Number(durationMs)))
      : undefined;
    this.emit({
      type: "speech.start",
      turnId,
      ts: now
    });
    this.emit({
      type: "transcript.partial",
      text: normalizedText,
      turnId,
      isFinal: false,
      ts: now
    });
    this.emit({
      type: "transcript.final",
      text: normalizedText,
      turnId,
      isFinal: true,
      ts: now
    });
    this.emit({
      type: "turn.final",
      text: normalizedText,
      turnId,
      isFinal: true,
      segmentDurationMs,
      ts: now
    });
    this.emit({
      type: "speech.end",
      text: "segment-final",
      turnId,
      ts: now
    });
  }

  pushTranscript(text, ts) {
    const normalizedText = normalizeText(text);
    const comparable = normalizeComparableText(normalizedText);
    if (!normalizedText || !comparable) {
      return;
    }

    const now = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();
    const hasActiveTurn = Boolean(this.activeTurnId && this.activeComparable);

    if (!hasActiveTurn) {
      this.startTurn({ text: normalizedText, comparable, ts: now });
      return;
    }

    if (comparable === this.activeComparable) {
      this.activeUpdatedAtMs = now;
      this.scheduleFinalize();
      return;
    }

    const isExpansion =
      comparable.startsWith(this.activeComparable) &&
      comparable.length > this.activeComparable.length;

    if (isExpansion) {
      const shouldReplace = comparable.length >= this.activeComparable.length;
      if (shouldReplace && normalizedText !== this.activeText) {
        this.activeText = normalizedText;
        this.activeComparable = comparable;
        this.activeUpdatedAtMs = now;
        this.emit({
          type: "transcript.partial",
          text: normalizedText,
          turnId: this.activeTurnId,
          isFinal: false,
          ts: now
        });
      }
      this.scheduleFinalize();
      return;
    }

    // For noisy chunk mode, avoid switching turns on a tiny one-word fragment.
    if (
      countWords(normalizedText) <= 1 &&
      countWords(this.activeText) >= 3
    ) {
      this.activeUpdatedAtMs = now;
      this.scheduleFinalize();
      return;
    }

    this.flushTurn({ reason: "switch", ts: now });
    this.startTurn({ text: normalizedText, comparable, ts: now });
  }

  startTurn({ text, comparable, ts }) {
    this.activeTurnId = createTurnId();
    this.activeText = text;
    this.activeComparable = comparable;
    this.activeUpdatedAtMs = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();

    this.emit({
      type: "speech.start",
      turnId: this.activeTurnId,
      ts: this.activeUpdatedAtMs
    });
    this.emit({
      type: "transcript.partial",
      text: this.activeText,
      turnId: this.activeTurnId,
      isFinal: false,
      ts: this.activeUpdatedAtMs
    });
    this.scheduleFinalize();
  }

  scheduleFinalize() {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }

    this.finalizeTimer = setTimeout(() => {
      this.flushTurn({ reason: "silence", ts: Date.now() });
    }, this.turnSilenceMs);
  }

  flushTurn({ reason = "silence", ts } = {}) {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }

    const turnId = this.activeTurnId;
    const text = normalizeText(this.activeText);
    const eventTs = Number.isFinite(Number(ts)) ? Number(ts) : Date.now();

    if (turnId && text) {
      this.emit({
        type: "transcript.final",
        text,
        turnId,
        isFinal: true,
        ts: eventTs
      });
      this.emit({
        type: "turn.final",
        text,
        turnId,
        isFinal: true,
        ts: eventTs
      });
      this.emit({
        type: "speech.end",
        text: reason,
        turnId,
        ts: eventTs
      });
    }

    this.activeTurnId = "";
    this.activeText = "";
    this.activeComparable = "";
    this.activeUpdatedAtMs = 0;
  }

  stop({ flush = true } = {}) {
    this.stopped = true;
    this.queue = [];
    this.lastFinalComparable = "";
    this.lastFinalAtMs = 0;
    if (flush) {
      this.flushTurn({ reason: "stop", ts: Date.now() });
    } else if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
  }
}

module.exports = {
  OpenAiSttTurnStream
};

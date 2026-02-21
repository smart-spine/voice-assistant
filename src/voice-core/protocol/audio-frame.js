const {
  AUDIO_CODEC_PCM16,
  AUDIO_KIND_INPUT,
  AUDIO_KIND_OUTPUT
} = require("./constants");

const BINARY_HEADER_BYTES = 16;

const AUDIO_KIND_TO_CODE = {
  [AUDIO_KIND_INPUT]: 1,
  [AUDIO_KIND_OUTPUT]: 2
};

const AUDIO_CODE_TO_KIND = {
  1: AUDIO_KIND_INPUT,
  2: AUDIO_KIND_OUTPUT
};

const AUDIO_CODEC_TO_CODE = {
  [AUDIO_CODEC_PCM16]: 1
};

const AUDIO_CODE_TO_CODEC = {
  1: AUDIO_CODEC_PCM16
};

function normalizeCodec(codec) {
  const value = String(codec || AUDIO_CODEC_PCM16)
    .trim()
    .toLowerCase();
  return value || AUDIO_CODEC_PCM16;
}

function normalizeKind(kind) {
  const value = String(kind || AUDIO_KIND_INPUT)
    .trim()
    .toLowerCase();
  return value || AUDIO_KIND_INPUT;
}

function estimatePcm16DurationMs({ byteLength = 0, sampleRateHz = 24000, channels = 1 } = {}) {
  const bytes = Math.max(0, Number(byteLength) || 0);
  const safeSampleRate = Math.max(1, Number(sampleRateHz) || 24000);
  const safeChannels = Math.max(1, Number(channels) || 1);
  const samples = Math.floor(bytes / 2 / safeChannels);
  if (!samples) {
    return 0;
  }
  return Math.max(1, Math.round((samples / safeSampleRate) * 1000));
}

function base64ToBytes(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return new Uint8Array(0);
  }
  return new Uint8Array(Buffer.from(raw, "base64"));
}

function bytesToBase64(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) {
    return "";
  }
  return Buffer.from(bytes).toString("base64");
}

function normalizeAudioFrame(frame = {}, { defaultKind = AUDIO_KIND_INPUT } = {}) {
  const kind = normalizeKind(frame.kind || defaultKind);
  if (!AUDIO_KIND_TO_CODE[kind]) {
    throw new Error(`Unsupported audio frame kind: ${String(frame.kind || "")}.`);
  }

  const codec = normalizeCodec(frame.codec || AUDIO_CODEC_PCM16);
  if (!AUDIO_CODEC_TO_CODE[codec]) {
    throw new Error(`Unsupported audio frame codec: ${String(frame.codec || "")}.`);
  }

  const bytes =
    frame.bytes instanceof Uint8Array
      ? frame.bytes
      : Buffer.isBuffer(frame.bytes)
        ? new Uint8Array(frame.bytes)
        : base64ToBytes(frame.audio_b64 || frame.audioBase64 || "");

  if (!bytes.byteLength) {
    throw new Error("Audio frame payload is empty.");
  }

  const sampleRateHz = Math.max(1, Math.trunc(Number(frame.sample_rate_hz || frame.sampleRateHz || 24000)));
  const channels = Math.max(1, Math.trunc(Number(frame.channels || 1)));
  const seq = Math.max(0, Math.trunc(Number(frame.seq || 0)));
  const durationMs = Math.max(
    0,
    Math.trunc(
      Number(frame.duration_ms || frame.durationMs) ||
        estimatePcm16DurationMs({
          byteLength: bytes.byteLength,
          sampleRateHz,
          channels
        })
    )
  );

  return {
    kind,
    codec,
    seq,
    sample_rate_hz: sampleRateHz,
    channels,
    duration_ms: durationMs,
    bytes
  };
}

function encodeBinaryAudioFrame(frame = {}) {
  const normalized = normalizeAudioFrame(frame);
  const header = Buffer.alloc(BINARY_HEADER_BYTES);

  header.writeUInt8(1, 0); // protocol version
  header.writeUInt8(AUDIO_KIND_TO_CODE[normalized.kind], 1);
  header.writeUInt16BE(AUDIO_CODEC_TO_CODE[normalized.codec], 2);
  header.writeUInt32BE(normalized.seq >>> 0, 4);
  header.writeUInt32BE(normalized.sample_rate_hz >>> 0, 8);
  header.writeUInt8(normalized.channels, 12);
  header.writeUInt8(0, 13);
  header.writeUInt16BE(0, 14);

  return Buffer.concat([header, Buffer.from(normalized.bytes)]);
}

function decodeBinaryAudioFrame(binaryValue, { defaultKind = AUDIO_KIND_INPUT } = {}) {
  const buffer = Buffer.isBuffer(binaryValue)
    ? binaryValue
    : Buffer.from(binaryValue || []);
  if (buffer.byteLength < BINARY_HEADER_BYTES) {
    throw new Error("Binary audio frame is shorter than the protocol header.");
  }

  const version = buffer.readUInt8(0);
  if (version !== 1) {
    throw new Error(`Unsupported binary audio frame version: ${version}.`);
  }

  const kindCode = buffer.readUInt8(1);
  const codecCode = buffer.readUInt16BE(2);
  const seq = buffer.readUInt32BE(4);
  const sampleRateHz = buffer.readUInt32BE(8);
  const channels = buffer.readUInt8(12);

  const kind = AUDIO_CODE_TO_KIND[kindCode] || normalizeKind(defaultKind);
  const codec = AUDIO_CODE_TO_CODEC[codecCode] || AUDIO_CODEC_PCM16;

  const bytes = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset + BINARY_HEADER_BYTES,
    buffer.byteLength - BINARY_HEADER_BYTES
  );
  if (!bytes.byteLength) {
    throw new Error("Binary audio frame payload is empty.");
  }

  return normalizeAudioFrame(
    {
      kind,
      codec,
      seq,
      sample_rate_hz: sampleRateHz,
      channels,
      duration_ms: estimatePcm16DurationMs({
        byteLength: bytes.byteLength,
        sampleRateHz,
        channels
      }),
      bytes
    },
    {
      defaultKind
    }
  );
}

module.exports = {
  BINARY_HEADER_BYTES,
  estimatePcm16DurationMs,
  base64ToBytes,
  bytesToBase64,
  normalizeAudioFrame,
  encodeBinaryAudioFrame,
  decodeBinaryAudioFrame
};

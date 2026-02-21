const PROTOCOL_VERSION = 1;

const CLIENT_MESSAGE_TYPES = new Set([
  "session.start",
  "session.update",
  "session.stop",
  "text.input",
  "audio.append",
  "audio.commit",
  "assistant.interrupt",
  "ping"
]);

const CORE_MESSAGE_TYPES = new Set([
  "session.started",
  "session.state",
  "turn.eot",
  "audio.committed",
  "text.committed",
  "audio.clear",
  "audio.chunk",
  "stt.partial",
  "stt.final",
  "assistant.state",
  "assistant.text.delta",
  "assistant.text.final",
  "warning",
  "error",
  "metrics.tick",
  "pong"
]);

const ALL_MESSAGE_TYPES = new Set([
  ...CLIENT_MESSAGE_TYPES,
  ...CORE_MESSAGE_TYPES
]);

const AUDIO_CODEC_PCM16 = "pcm16";

const AUDIO_KIND_INPUT = "input_audio";
const AUDIO_KIND_OUTPUT = "output_audio";

const AUDIO_MIN_COMMIT_MS = 100;
const AUDIO_MIN_COMMIT_BYTES = 2400;

module.exports = {
  PROTOCOL_VERSION,
  CLIENT_MESSAGE_TYPES,
  CORE_MESSAGE_TYPES,
  ALL_MESSAGE_TYPES,
  AUDIO_CODEC_PCM16,
  AUDIO_KIND_INPUT,
  AUDIO_KIND_OUTPUT,
  AUDIO_MIN_COMMIT_MS,
  AUDIO_MIN_COMMIT_BYTES
};

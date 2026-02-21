"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const INITIAL_FORM = {
  meetUrl: "",
  clientName: "",
  clientCompany: "",
  clientNotes: "",
  forceRestart: false
};

const TAB_DASHBOARD = "dashboard";
const TAB_VOICE = "voice";
const TAB_SETTINGS = "settings";

function formatDate(value) {
  if (!value) {
    return "-";
  }

  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return "-";
  }

  return time.toLocaleString();
}

function formatTime(value) {
  if (!value) {
    return "-";
  }

  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    return "-";
  }

  return time.toLocaleTimeString();
}

function formatDuration(totalSeconds) {
  const value = Number(totalSeconds) || 0;
  if (value <= 0) {
    return "0s";
  }

  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;

  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function statusTone(value) {
  const normalized = String(value || "").toLowerCase();

  if (["running", "ok", "idle", "stopped", "ready"].includes(normalized)) {
    return "ok";
  }

  if (["starting", "stopping", "connecting", "speaking"].includes(normalized)) {
    return "warn";
  }

  return "error";
}

async function fetchJson(url, init) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    }
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok === false) {
    throw new Error(
      payload?.error || `Request failed with HTTP ${response.status}.`
    );
  }

  return payload;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function downsampleFloat32Buffer(input, inputSampleRate, targetSampleRate) {
  if (!(input instanceof Float32Array) || input.length === 0) {
    return new Float32Array(0);
  }

  const inRate = Number(inputSampleRate) || 0;
  const outRate = Number(targetSampleRate) || 0;
  if (!inRate || !outRate || inRate <= outRate) {
    return input;
  }

  const ratio = inRate / outRate;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Float32Array(outputLength);

  let inputOffset = 0;
  for (let outputOffset = 0; outputOffset < outputLength; outputOffset += 1) {
    const nextInputOffset = Math.min(
      input.length,
      Math.round((outputOffset + 1) * ratio)
    );

    let sum = 0;
    let count = 0;
    for (let index = inputOffset; index < nextInputOffset; index += 1) {
      sum += input[index];
      count += 1;
    }
    output[outputOffset] = count > 0 ? sum / count : 0;
    inputOffset = nextInputOffset;
  }

  return output;
}

function float32ToPcm16Bytes(input) {
  const source = input instanceof Float32Array ? input : new Float32Array(0);
  const bytes = new Uint8Array(source.length * 2);
  const view = new DataView(bytes.buffer);

  for (let index = 0; index < source.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, source[index]));
    const scaled = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(index * 2, Math.round(scaled), true);
  }

  return bytes;
}

function pcm16BytesToFloat32(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2) {
    return new Float32Array(0);
  }

  const sampleCount = Math.floor(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true) / 0x8000;
  }

  return samples;
}

function computeRms(samples) {
  if (!(samples instanceof Float32Array) || samples.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }

  return Math.sqrt(sum / Math.max(1, samples.length));
}

function truncateText(value, maxChars = 180) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function estimateAudioChunkDurationMs({ audioBase64 = "", format = "pcm16", sampleRate = 24000 }) {
  const normalizedFormat = String(format || "pcm16").trim().toLowerCase();
  if (normalizedFormat !== "pcm16") {
    return 180;
  }

  const normalizedAudio = String(audioBase64 || "").trim();
  if (!normalizedAudio) {
    return 180;
  }

  const safeSampleRate = Math.max(8000, Number(sampleRate) || 24000);
  const bytesLength = Math.floor((normalizedAudio.length * 3) / 4);
  const samples = Math.floor(bytesLength / 2);
  if (!samples) {
    return 180;
  }

  return Math.max(40, Math.round((samples / safeSampleRate) * 1000));
}

function pcm16Base64ToWavBlob(base64, sampleRate = 24000) {
  const pcmBytes = base64ToBytes(base64);
  const pcm16 = new Int16Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    Math.floor(pcmBytes.byteLength / 2)
  );

  const dataByteLength = pcm16.length * 2;
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeAscii = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataByteLength, true);

  const wavBytes = new Uint8Array(44 + dataByteLength);
  wavBytes.set(new Uint8Array(header), 0);
  wavBytes.set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), 44);

  return new Blob([wavBytes], { type: "audio/wav" });
}

function audioMimeFromFormat(format) {
  const value = String(format || "").trim().toLowerCase();
  if (value === "wav") {
    return "audio/wav";
  }
  if (value === "mp3") {
    return "audio/mpeg";
  }
  if (value === "opus") {
    return "audio/opus";
  }
  if (value === "aac") {
    return "audio/aac";
  }
  if (value === "flac") {
    return "audio/flac";
  }
  return "application/octet-stream";
}

function coerceBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

const VOICE_CORE_PROTOCOL = "voice.core.v1";
const VOICE_CORE_VERSION = 1;
const VOICE_BINARY_HEADER_BYTES = 16;
const VOICE_AUDIO_KIND_INPUT = 1;
const VOICE_AUDIO_KIND_OUTPUT = 2;
const VOICE_AUDIO_CODEC_PCM16 = 1;

function createVoiceMsgId(prefix = "ui") {
  return `${String(prefix || "ui")}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function buildVoiceCoreEnvelope({ type, payload = {}, sessionId = "", replyTo = null } = {}) {
  return {
    v: VOICE_CORE_VERSION,
    type: String(type || "").trim().toLowerCase(),
    msg_id: createVoiceMsgId("ui"),
    session_id: String(sessionId || "").trim() || undefined,
    reply_to: String(replyTo || "").trim() || undefined,
    ts_ms: Date.now(),
    payload: payload && typeof payload === "object" ? payload : {}
  };
}

function decodeVoiceBinaryAudioFrame(data) {
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(0);
  if (bytes.byteLength < VOICE_BINARY_HEADER_BYTES) {
    throw new Error("Binary frame is too short.");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== VOICE_CORE_VERSION) {
    throw new Error(`Unsupported binary frame version: ${version}.`);
  }

  const kindCode = view.getUint8(1);
  const codecCode = view.getUint16(2, false);
  const seq = view.getUint32(4, false);
  const sampleRateHz = view.getUint32(8, false);
  const channels = view.getUint8(12);

  if (codecCode !== VOICE_AUDIO_CODEC_PCM16) {
    throw new Error(`Unsupported audio codec code: ${codecCode}.`);
  }

  return {
    kindCode,
    codecCode,
    seq,
    sampleRateHz: Math.max(8000, Number(sampleRateHz) || 24000),
    channels: Math.max(1, Number(channels) || 1),
    bytes: bytes.subarray(VOICE_BINARY_HEADER_BYTES)
  };
}

function encodeVoiceInputBinaryAudioFrame({
  seq = 0,
  sampleRateHz = 24000,
  channels = 1,
  pcmBytes
} = {}) {
  const bytes =
    pcmBytes instanceof Uint8Array
      ? pcmBytes
      : pcmBytes instanceof ArrayBuffer
        ? new Uint8Array(pcmBytes)
        : new Uint8Array(0);
  if (!bytes.byteLength) {
    return null;
  }

  const header = new ArrayBuffer(VOICE_BINARY_HEADER_BYTES);
  const view = new DataView(header);
  view.setUint8(0, VOICE_CORE_VERSION);
  view.setUint8(1, VOICE_AUDIO_KIND_INPUT);
  view.setUint16(2, VOICE_AUDIO_CODEC_PCM16, false);
  view.setUint32(4, Number(seq) >>> 0, false);
  view.setUint32(8, Math.max(1, Math.trunc(Number(sampleRateHz) || 24000)) >>> 0, false);
  view.setUint8(12, Math.max(1, Math.min(2, Math.trunc(Number(channels) || 1))));
  view.setUint8(13, 0);
  view.setUint16(14, 0, false);

  const binary = new Uint8Array(VOICE_BINARY_HEADER_BYTES + bytes.byteLength);
  binary.set(new Uint8Array(header), 0);
  binary.set(bytes, VOICE_BINARY_HEADER_BYTES);
  return binary.buffer;
}

export default function HomePage() {
  const [activeTab, setActiveTab] = useState(TAB_DASHBOARD);

  const [systemState, setSystemState] = useState(null);
  const [logs, setLogs] = useState([]);
  const [form, setForm] = useState(INITIAL_FORM);
  const [busy, setBusy] = useState({
    apiStart: false,
    apiStop: false,
    botStart: false,
    botStop: false,
    refreshing: false
  });
  const [notice, setNotice] = useState({ type: "info", text: "" });
  const [autoScroll, setAutoScroll] = useState(true);

  const logsViewportRef = useRef(null);

  const [voiceStatus, setVoiceStatus] = useState("disconnected");
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [voiceMode, setVoiceMode] = useState("toggle");
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(false);
  const [voiceUserSpeaking, setVoiceUserSpeaking] = useState(false);
  const [voiceAssistantSpeaking, setVoiceAssistantSpeaking] = useState(false);
  const [voicePlaybackActive, setVoicePlaybackActive] = useState(false);
  const [voiceOrbLevel, setVoiceOrbLevel] = useState(0);
  const [voiceInputDevices, setVoiceInputDevices] = useState([]);
  const [voiceOutputDevices, setVoiceOutputDevices] = useState([]);
  const [voiceSelectedInputId, setVoiceSelectedInputId] = useState("");
  const [voiceSelectedOutputId, setVoiceSelectedOutputId] = useState("");
  const [voiceUserPartial, setVoiceUserPartial] = useState("");
  const [voiceAssistantPartial, setVoiceAssistantPartial] = useState("");
  const [voiceConversation, setVoiceConversation] = useState([]);
  const [voiceDebugLogs, setVoiceDebugLogs] = useState([]);
  const [voiceDebugAutoScroll, setVoiceDebugAutoScroll] = useState(true);
  const [voiceMetrics, setVoiceMetrics] = useState({
    sttPartialMs: null,
    sttFinalMs: null,
    firstAudioMs: null,
    turnId: ""
  });
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [voiceBusy, setVoiceBusy] = useState({
    connecting: false,
    startMic: false,
    stoppingMic: false
  });

  const [configSchema, setConfigSchema] = useState([]);
  const [configEntries, setConfigEntries] = useState([]);
  const [configSearch, setConfigSearch] = useState("");
  const [configDraftValues, setConfigDraftValues] = useState({});
  const [configUnsetKeys, setConfigUnsetKeys] = useState([]);
  const [configNewKey, setConfigNewKey] = useState("");
  const [configNewValue, setConfigNewValue] = useState("");
  const [configPreview, setConfigPreview] = useState(null);
  const [configAuditEntries, setConfigAuditEntries] = useState([]);
  const [configBusy, setConfigBusy] = useState({
    loading: false,
    preview: false,
    apply: false,
    audit: false
  });
  const configSearchRef = useRef("");

  const voiceSocketRef = useRef(null);
  const voiceDebugViewportRef = useRef(null);
  const voiceStreamRef = useRef(null);
  const voiceAnalyserRef = useRef(null);
  const voiceSourceNodeRef = useRef(null);
  const voiceCaptureProcessorRef = useRef(null);
  const voiceCaptureSinkRef = useRef(null);
  const voiceAudioContextRef = useRef(null);
  const voiceAnalyserTimerRef = useRef(null);
  const voiceAudioPlaybackChainRef = useRef(Promise.resolve());
  const voiceSessionIdRef = useRef("");
  const voiceInputSeqRef = useRef(0);
  const voiceHasPendingInputRef = useRef(false);
  const voicePlaybackActiveCountRef = useRef(0);
  const voiceCurrentAssistantResponseIdRef = useRef("");
  const voicePlaybackGenerationRef = useRef(0);
  const voiceActiveSourceNodesRef = useRef(new Set());
  const voiceActiveHtmlAudioRef = useRef(new Set());
  const voiceLastPartialLogAtRef = useRef(0);
  const voiceLastAssistantPartialLogAtRef = useRef(0);
  const voiceLastChunkLogAtRef = useRef(0);
  const voicePlaybackChunkBufferRef = useRef([]);
  const voicePlaybackBufferStartedAtRef = useRef(0);
  const voicePlaybackFlushTimerRef = useRef(null);
  const voicePlaybackContextRef = useRef(null);
  const voicePlaybackScheduledAtRef = useRef(0);
  const voiceStatusRef = useRef("disconnected");
  const voiceRecordingRef = useRef(false);
  const voiceAssistantSpeakingRef = useRef(false);
  const voiceInterruptSpeechMsRef = useRef(0);
  const voiceLastInterruptAtRef = useRef(0);
  const voiceBargeInCaptureRef = useRef(false);

  const managedApi = systemState?.managedApi;
  const controlApi = systemState?.controlApi;
  const botStatus = controlApi?.bot?.data;

  const pushNotice = useCallback((type, text) => {
    setNotice({ type, text });
  }, []);

  const appendVoiceDebugLog = useCallback((level, message) => {
    const normalizedMessage = String(message || "").trim();
    if (!normalizedMessage) {
      return;
    }

    const normalizedLevel = String(level || "info").trim().toLowerCase();
    setVoiceDebugLogs((prev) => {
      const next = [
        ...prev,
        {
          id: `voice_log_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          ts: new Date().toISOString(),
          level: normalizedLevel,
          message: normalizedMessage
        }
      ];
      return next.slice(Math.max(0, next.length - 500));
    });
  }, []);

  const loadState = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setBusy((prev) => ({ ...prev, refreshing: true }));
    }

    try {
      const payload = await fetchJson("/api/system/state");
      setSystemState(payload.data);
      if (!silent) {
        pushNotice("success", "State synchronized.");
      }
    } catch (err) {
      pushNotice("error", err.message || "Failed to fetch system state.");
    } finally {
      if (!silent) {
        setBusy((prev) => ({ ...prev, refreshing: false }));
      }
    }
  }, [pushNotice]);

  const loadLogsSnapshot = useCallback(async () => {
    try {
      const payload = await fetchJson("/api/system/logs?limit=400");
      setLogs(payload.data?.logs || []);
    } catch (_) {
      // Keep existing logs if snapshot request fails.
    }
  }, []);

  const loadVoiceDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((item) => item.kind === "audioinput");
      const outputs = devices.filter((item) => item.kind === "audiooutput");
      setVoiceInputDevices(inputs);
      setVoiceOutputDevices(outputs);

      if (!voiceSelectedInputId && inputs[0]?.deviceId) {
        setVoiceSelectedInputId(inputs[0].deviceId);
      }
      if (!voiceSelectedOutputId && outputs[0]?.deviceId) {
        setVoiceSelectedOutputId(outputs[0].deviceId);
      }
    } catch (_) {
      // Ignore device enumeration failures.
    }
  }, [voiceSelectedInputId, voiceSelectedOutputId]);

  const teardownVoiceAnalyser = useCallback(() => {
    if (voiceAnalyserTimerRef.current) {
      clearInterval(voiceAnalyserTimerRef.current);
      voiceAnalyserTimerRef.current = null;
    }
    voiceAnalyserRef.current = null;
    setVoiceLevel(0);
  }, []);

  const teardownVoiceMedia = useCallback(async () => {
    teardownVoiceAnalyser();

    if (voiceCaptureProcessorRef.current) {
      try {
        voiceCaptureProcessorRef.current.disconnect();
      } catch (_) {
        // Ignore processor disconnect errors.
      }
      voiceCaptureProcessorRef.current.onaudioprocess = null;
      voiceCaptureProcessorRef.current = null;
    }

    if (voiceCaptureSinkRef.current) {
      try {
        voiceCaptureSinkRef.current.disconnect();
      } catch (_) {
        // Ignore sink disconnect errors.
      }
      voiceCaptureSinkRef.current = null;
    }

    if (voiceSourceNodeRef.current) {
      try {
        voiceSourceNodeRef.current.disconnect();
      } catch (_) {
        // Ignore source disconnect errors.
      }
      voiceSourceNodeRef.current = null;
    }

    if (voiceStreamRef.current) {
      for (const track of voiceStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch (_) {
          // Ignore track stop errors.
        }
      }
      voiceStreamRef.current = null;
    }

    if (voiceAudioContextRef.current) {
      try {
        await voiceAudioContextRef.current.close();
      } catch (_) {
        // Ignore close failures.
      }
      voiceAudioContextRef.current = null;
    }

    voicePlaybackActiveCountRef.current = 0;
    voiceInputSeqRef.current = 0;
    voiceHasPendingInputRef.current = false;
    voiceCurrentAssistantResponseIdRef.current = "";
    voiceSessionIdRef.current = "";
    voicePlaybackGenerationRef.current += 1;
    voiceActiveSourceNodesRef.current.clear();
    voiceActiveHtmlAudioRef.current.clear();

    if (voicePlaybackFlushTimerRef.current) {
      clearTimeout(voicePlaybackFlushTimerRef.current);
      voicePlaybackFlushTimerRef.current = null;
    }
    voicePlaybackChunkBufferRef.current = [];
    voicePlaybackBufferStartedAtRef.current = 0;

    if (voicePlaybackContextRef.current) {
      try {
        await voicePlaybackContextRef.current.close();
      } catch (_) {
        // Ignore close failures.
      }
      voicePlaybackContextRef.current = null;
    }
    voicePlaybackScheduledAtRef.current = 0;

    setVoiceRecording(false);
    setVoiceUserSpeaking(false);
    setVoiceAssistantSpeaking(false);
    setVoicePlaybackActive(false);
    setVoiceOrbLevel(0);
    voiceInterruptSpeechMsRef.current = 0;
    voiceLastInterruptAtRef.current = 0;
    voiceBargeInCaptureRef.current = false;
  }, [teardownVoiceAnalyser]);

  const sendVoiceEnvelope = useCallback((type, payload = {}, { replyTo = null } = {}) => {
    const socket = voiceSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      const envelope = buildVoiceCoreEnvelope({
        type,
        payload,
        sessionId: voiceSessionIdRef.current,
        replyTo
      });
      socket.send(JSON.stringify(envelope));
      return true;
    } catch (_) {
      return false;
    }
  }, []);

  const sendVoiceBinaryFrame = useCallback((binaryFrame) => {
    const socket = voiceSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    if (!(binaryFrame instanceof ArrayBuffer)) {
      return false;
    }
    try {
      socket.send(binaryFrame);
      return true;
    } catch (_) {
      return false;
    }
  }, []);

  const ensureVoicePlaybackContext = useCallback(async () => {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return null;
    }

    if (
      !voicePlaybackContextRef.current ||
      voicePlaybackContextRef.current.state === "closed"
    ) {
      voicePlaybackContextRef.current = new AudioContextCtor({
        latencyHint: "interactive"
      });
      voicePlaybackScheduledAtRef.current = 0;
    }

    if (voicePlaybackContextRef.current.state !== "running") {
      try {
        await voicePlaybackContextRef.current.resume();
      } catch (_) {
        // Ignore resume failures; caller will fallback to HTMLAudio.
      }
    }

    return voicePlaybackContextRef.current;
  }, []);

  const playVoiceAudioChunk = useCallback(
    async ({ audioBase64, format, sampleRate = 24000 }) => {
      const normalizedAudio = String(audioBase64 || "").trim();
      if (!normalizedAudio) {
        return;
      }

      const generation = voicePlaybackGenerationRef.current;
      const normalizedFormat = String(format || "pcm16").trim().toLowerCase();
      const markPlaybackStart = () => {
        if (generation !== voicePlaybackGenerationRef.current) {
          return false;
        }
        voicePlaybackActiveCountRef.current += 1;
        setVoicePlaybackActive(true);
        setVoiceAssistantSpeaking(true);
        return true;
      };

      const markPlaybackEnd = () => {
        const nextActive = Math.max(0, voicePlaybackActiveCountRef.current - 1);
        voicePlaybackActiveCountRef.current = nextActive;
        if (nextActive === 0) {
          setVoicePlaybackActive(false);
        }
      };

      if (normalizedFormat === "pcm16") {
        const pcmBytes = base64ToBytes(normalizedAudio);
        const samples = pcm16BytesToFloat32(pcmBytes);
        const resolvedSampleRate = Math.max(8000, Number(sampleRate) || 24000);
        if (samples.length > 0) {
          const playbackContext = await ensureVoicePlaybackContext();
          if (playbackContext && markPlaybackStart()) {
            await new Promise((resolve) => {
              let done = false;
              let sourceNode = null;
              const finish = () => {
                if (done) {
                  return;
                }
                done = true;
                if (sourceNode) {
                  voiceActiveSourceNodesRef.current.delete(sourceNode);
                }
                markPlaybackEnd();
                resolve();
              };

              try {
                const audioBuffer = playbackContext.createBuffer(
                  1,
                  samples.length,
                  resolvedSampleRate
                );
                audioBuffer.copyToChannel(samples, 0, 0);
                sourceNode = playbackContext.createBufferSource();
                sourceNode.buffer = audioBuffer;
                sourceNode.connect(playbackContext.destination);
                sourceNode.onended = finish;
                voiceActiveSourceNodesRef.current.add(sourceNode);

                const currentTime = playbackContext.currentTime;
                const startAt = Math.max(
                  currentTime + 0.012,
                  voicePlaybackScheduledAtRef.current || currentTime
                );
                voicePlaybackScheduledAtRef.current = startAt + audioBuffer.duration;
                if (generation !== voicePlaybackGenerationRef.current) {
                  finish();
                  return;
                }
                sourceNode.start(startAt);

                const fallbackMs =
                  Math.ceil((Math.max(0, startAt - currentTime) + audioBuffer.duration) * 1000) +
                  200;
                setTimeout(finish, fallbackMs);
              } catch (_) {
                finish();
              }
            });
            return;
          }
        }
      }

      let blob = null;
      if (normalizedFormat === "pcm16") {
        blob = pcm16Base64ToWavBlob(normalizedAudio, sampleRate);
      } else {
        const bytes = base64ToBytes(normalizedAudio);
        blob = new Blob([bytes], { type: audioMimeFromFormat(normalizedFormat) });
      }

      if (!markPlaybackStart()) {
        return;
      }

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preload = "auto";
      voiceActiveHtmlAudioRef.current.add(audio);

      if (voiceSelectedOutputId && typeof audio.setSinkId === "function") {
        try {
          await audio.setSinkId(voiceSelectedOutputId);
        } catch (_) {
          // Ignore output routing failures.
        }
      }

      await new Promise((resolve, reject) => {
        let done = false;

        const finish = (callback) => {
          if (done) {
            return;
          }
          done = true;
          voiceActiveHtmlAudioRef.current.delete(audio);
          markPlaybackEnd();
          URL.revokeObjectURL(url);
          callback();
        };

        audio.onended = () => finish(resolve);
        audio.onerror = () => finish(() => reject(new Error("Audio playback failed.")));

        const started = audio.play();
        if (started && typeof started.catch === "function") {
          started.catch((err) => {
            finish(() => reject(err));
          });
        }
      });
    },
    [ensureVoicePlaybackContext, voiceSelectedOutputId]
  );

  const enqueueVoicePlayback = useCallback(
    (chunk) => {
      voiceAudioPlaybackChainRef.current = voiceAudioPlaybackChainRef.current
        .then(() => playVoiceAudioChunk(chunk))
        .catch(() => {
          // Keep playback chain alive after one chunk failure.
        });
    },
    [playVoiceAudioChunk]
  );

  const clearVoicePlaybackFlushTimer = useCallback(() => {
    if (!voicePlaybackFlushTimerRef.current) {
      return;
    }
    clearTimeout(voicePlaybackFlushTimerRef.current);
    voicePlaybackFlushTimerRef.current = null;
  }, []);

  const stopAllVoicePlayback = useCallback(
    (reason = "audio.clear") => {
      clearVoicePlaybackFlushTimer();
      voicePlaybackGenerationRef.current += 1;
      voicePlaybackChunkBufferRef.current = [];
      voicePlaybackBufferStartedAtRef.current = 0;
      voicePlaybackScheduledAtRef.current = 0;
      voiceAudioPlaybackChainRef.current = Promise.resolve();

      const sourceNodes = [...voiceActiveSourceNodesRef.current];
      voiceActiveSourceNodesRef.current.clear();
      for (const sourceNode of sourceNodes) {
        try {
          sourceNode.onended = null;
          sourceNode.stop();
        } catch (_) {
          // Ignore source stop races.
        }
      }

      const htmlAudios = [...voiceActiveHtmlAudioRef.current];
      voiceActiveHtmlAudioRef.current.clear();
      for (const audio of htmlAudios) {
        try {
          audio.pause();
          audio.currentTime = 0;
          audio.src = "";
          audio.load();
        } catch (_) {
          // Ignore audio teardown races.
        }
      }

      voicePlaybackActiveCountRef.current = 0;
      setVoicePlaybackActive(false);
      setVoiceAssistantSpeaking(false);
      voiceBargeInCaptureRef.current = false;
      appendVoiceDebugLog("event", `playback cleared (${String(reason || "unknown")})`);
    },
    [appendVoiceDebugLog, clearVoicePlaybackFlushTimer]
  );

  const flushVoicePlaybackBuffer = useCallback(
    ({ force = false } = {}) => {
      const buffered = voicePlaybackChunkBufferRef.current;
      if (!buffered.length) {
        clearVoicePlaybackFlushTimer();
        voicePlaybackBufferStartedAtRef.current = 0;
        return false;
      }

      const totalMs = buffered.reduce(
        (sum, item) => sum + Math.max(1, Number(item?.durationMs) || 0),
        0
      );
      const first = buffered[0] || {};
      const format = String(first?.format || "pcm16").trim().toLowerCase();
      const bufferedSince = Number(voicePlaybackBufferStartedAtRef.current || 0);
      const waitedMs = bufferedSince > 0 ? Math.max(0, Date.now() - bufferedSince) : 0;
      const minBufferedMs = 220;
      const maxBufferedWaitMs = 340;

      if (
        !force &&
        format === "pcm16" &&
        totalMs < minBufferedMs &&
        waitedMs < maxBufferedWaitMs
      ) {
        return false;
      }

      clearVoicePlaybackFlushTimer();
      voicePlaybackChunkBufferRef.current = [];
      voicePlaybackBufferStartedAtRef.current = 0;

      if (format !== "pcm16") {
        for (const chunk of buffered) {
          enqueueVoicePlayback({
            audioBase64: chunk?.audioBase64 || "",
            format: chunk?.format || "pcm16",
            sampleRate: Number(chunk?.sampleRate || 24000)
          });
        }
        return true;
      }

      const totalBytes = buffered.reduce(
        (sum, item) => sum + (item?.bytes?.byteLength || 0),
        0
      );
      if (!totalBytes) {
        return false;
      }

      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const item of buffered) {
        const bytes = item?.bytes;
        if (!(bytes instanceof Uint8Array) || !bytes.byteLength) {
          continue;
        }
        merged.set(bytes, offset);
        offset += bytes.byteLength;
      }
      if (!offset) {
        return false;
      }

      const sampleRate = Math.max(
        8000,
        Number(
          buffered.find((item) => Number(item?.sampleRate) > 0)?.sampleRate || 24000
        )
      );
      enqueueVoicePlayback({
        audioBase64: bytesToBase64(merged.subarray(0, offset)),
        format: "pcm16",
        sampleRate
      });
      return true;
    },
    [clearVoicePlaybackFlushTimer, enqueueVoicePlayback]
  );

  const bufferVoicePlaybackChunk = useCallback(
    ({ audioBase64, format, sampleRate = 24000 }) => {
      const normalizedAudio = String(audioBase64 || "").trim();
      if (!normalizedAudio) {
        return;
      }
      if (!voicePlaybackChunkBufferRef.current.length) {
        voicePlaybackBufferStartedAtRef.current = Date.now();
      }

      const normalizedFormat = String(format || "pcm16").trim().toLowerCase();
      const durationMs = estimateAudioChunkDurationMs({
        audioBase64: normalizedAudio,
        format: normalizedFormat,
        sampleRate
      });

      if (normalizedFormat === "pcm16") {
        voicePlaybackChunkBufferRef.current.push({
          format: "pcm16",
          sampleRate: Number(sampleRate) || 24000,
          durationMs,
          bytes: base64ToBytes(normalizedAudio)
        });
      } else {
        voicePlaybackChunkBufferRef.current.push({
          format: normalizedFormat,
          sampleRate: Number(sampleRate) || 24000,
          durationMs,
          audioBase64: normalizedAudio
        });
      }

      const totalMs = voicePlaybackChunkBufferRef.current.reduce(
        (sum, item) => sum + Math.max(1, Number(item?.durationMs) || 0),
        0
      );
      if (totalMs >= 320) {
        flushVoicePlaybackBuffer({ force: true });
        return;
      }

      if (!voicePlaybackFlushTimerRef.current) {
        voicePlaybackFlushTimerRef.current = setTimeout(() => {
          voicePlaybackFlushTimerRef.current = null;
          const bufferedSince = Number(voicePlaybackBufferStartedAtRef.current || 0);
          const waitedMs = bufferedSince > 0 ? Math.max(0, Date.now() - bufferedSince) : 0;
          const flushed = flushVoicePlaybackBuffer({
            force: waitedMs >= 340
          });
          if (!flushed && voicePlaybackChunkBufferRef.current.length && !voicePlaybackFlushTimerRef.current) {
            voicePlaybackFlushTimerRef.current = setTimeout(() => {
              voicePlaybackFlushTimerRef.current = null;
              flushVoicePlaybackBuffer({ force: true });
            }, 70);
          }
        }, 70);
      }
    },
    [flushVoicePlaybackBuffer]
  );

  const appendVoiceConversation = useCallback((role, text, isFinal = true) => {
    const normalizedText = String(text || "").trim();
    if (!normalizedText) {
      return;
    }

    setVoiceConversation((prev) => {
      const next = [
        ...prev,
        {
          id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          role,
          text: normalizedText,
          isFinal,
          at: new Date().toISOString()
        }
      ];
      return next.slice(Math.max(0, next.length - 300));
    });
  }, []);

  const handleVoiceWsEvent = useCallback(
    (incoming) => {
      if (!incoming || typeof incoming !== "object") {
        return;
      }

      const type = String(incoming?.type || "").trim().toLowerCase();
      if (!type) {
        return;
      }
      const payload =
        incoming?.payload && typeof incoming.payload === "object"
          ? incoming.payload
          : incoming;

      const readMetric = (...values) => {
        for (const value of values) {
          const parsed = Number(value);
          if (Number.isFinite(parsed) && parsed >= 0) {
            return Math.round(parsed);
          }
        }
        return null;
      };

      if (type === "welcome") {
        appendVoiceDebugLog("event", "event: welcome");
        return;
      }

      if (type === "session.started") {
        const sessionId = String(payload?.session_id || incoming?.session_id || "").trim();
        if (sessionId) {
          voiceSessionIdRef.current = sessionId;
        }
        setVoiceStatus("ready");
        appendVoiceDebugLog(
          "info",
          `session started (id=${sessionId || "unknown"}, model=${String(
            payload?.model || "unknown"
          )})`
        );
        return;
      }

      if (type === "session.state") {
        const nextState = String(payload?.state || "").trim().toLowerCase() || "ready";
        setVoiceStatus(nextState);
        setVoiceUserSpeaking(nextState === "listening");
        if (["stopped", "disconnected"].includes(nextState)) {
          setVoiceUserSpeaking(false);
          setVoiceAssistantSpeaking(false);
          stopAllVoicePlayback(`session.state:${nextState}`);
        }
        appendVoiceDebugLog(
          nextState === "stopped" ? "warn" : "info",
          `session state: ${nextState}`
        );
        return;
      }

      if (type === "stt.partial") {
        const text = String(payload?.text || "").trim();
        if (!text) {
          return;
        }
        setVoiceUserPartial(text);
        setVoiceUserSpeaking(true);
        const now = Date.now();
        if (now - voiceLastPartialLogAtRef.current >= 650) {
          voiceLastPartialLogAtRef.current = now;
          appendVoiceDebugLog("info", `stt partial: ${truncateText(text, 120)}`);
        }
        return;
      }

      if (type === "stt.final") {
        const text = String(payload?.text || "").trim();
        if (!text) {
          return;
        }
        setVoiceUserPartial("");
        setVoiceUserSpeaking(false);
        appendVoiceConversation("user", text, true);
        appendVoiceDebugLog("info", `stt final: ${truncateText(text, 180)}`);
        return;
      }

      if (type === "assistant.text.delta") {
        const text = String(payload?.text || "").trim();
        if (!text) {
          return;
        }
        setVoiceAssistantPartial(text);
        const now = Date.now();
        if (now - voiceLastAssistantPartialLogAtRef.current >= 750) {
          voiceLastAssistantPartialLogAtRef.current = now;
          appendVoiceDebugLog("event", `assistant partial: ${truncateText(text, 120)}`);
        }
        return;
      }

      if (type === "assistant.text.final") {
        const text = String(payload?.text || "").trim();
        if (!text) {
          return;
        }
        setVoiceAssistantPartial("");
        appendVoiceConversation("assistant", text, true);
        appendVoiceDebugLog("info", `assistant final: ${truncateText(text, 180)}`);
        return;
      }

      if (type === "assistant.state") {
        const state = String(payload?.state || "").trim().toLowerCase();
        if (!state) {
          return;
        }
        if (state === "speaking") {
          setVoiceAssistantSpeaking(true);
          setVoiceStatus("speaking");
          voiceCurrentAssistantResponseIdRef.current = String(payload?.response_id || "").trim();
        } else if (["done", "interrupted", "stopped", "idle", "ready"].includes(state)) {
          setVoiceAssistantSpeaking(false);
          if (state === "interrupted") {
            stopAllVoicePlayback("assistant.interrupted");
          } else {
            flushVoicePlaybackBuffer({ force: true });
          }
          setVoiceStatus(state === "done" ? "ready" : state);
          if (state === "done") {
            voiceCurrentAssistantResponseIdRef.current = "";
          }
        } else if (state === "requested" || state === "thinking") {
          setVoiceStatus(state);
        }
        appendVoiceDebugLog("info", `assistant state: ${state}`);
        return;
      }

      if (type === "audio.committed") {
        voiceHasPendingInputRef.current = false;
        appendVoiceDebugLog("event", "upstream input buffer committed");
        return;
      }

      if (type === "audio.clear") {
        stopAllVoicePlayback(String(payload?.reason || "audio.clear"));
        return;
      }

      if (type === "turn.eot") {
        appendVoiceDebugLog(
          "event",
          `turn.eot (${String(payload?.reason || "vad_silence")}, delayMs=${
            Number(payload?.delay_ms || 0) || 0
          })`
        );
        return;
      }

      if (type === "metrics.tick") {
        setVoiceMetrics((prev) => ({
          ...prev,
          sttPartialMs: readMetric(payload?.stt_partial_ms, payload?.sttPartialMs),
          sttFinalMs: readMetric(payload?.stt_final_ms, payload?.sttFinalMs),
          firstAudioMs: readMetric(payload?.first_audio_ms, payload?.firstAudioMs),
          turnId: String(payload?.turn_id || payload?.turnId || prev.turnId || "").trim()
        }));
        return;
      }

      if (type === "warning") {
        appendVoiceDebugLog(
          "warn",
          `warning: ${String(payload?.message || payload?.code || "voice warning")}`
        );
        return;
      }

      if (type === "error") {
        const message = String(payload?.message || "Voice session error.").trim();
        appendVoiceDebugLog("error", `voice error: ${message}`);
        pushNotice("error", message);
        return;
      }

      if (type === "pong") {
        appendVoiceDebugLog("event", "pong");
        return;
      }

      appendVoiceDebugLog("event", `event: ${type}`);
    },
    [
      appendVoiceConversation,
      appendVoiceDebugLog,
      flushVoicePlaybackBuffer,
      pushNotice,
      stopAllVoicePlayback
    ]
  );

  const ensureVoiceMedia = useCallback(async () => {
    if (voiceStreamRef.current) {
      return voiceStreamRef.current;
    }

    const constraints = {
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      },
      video: false
    };

    if (voiceSelectedInputId) {
      constraints.audio.deviceId = { exact: voiceSelectedInputId };
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    voiceStreamRef.current = stream;

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextCtor();
    if (context.state !== "running") {
      await context.resume();
    }

    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    voiceAudioContextRef.current = context;
    voiceAnalyserRef.current = analyser;
    voiceSourceNodeRef.current = source;

    if (voiceAnalyserTimerRef.current) {
      clearInterval(voiceAnalyserTimerRef.current);
    }
    voiceAnalyserTimerRef.current = setInterval(() => {
      if (!voiceAnalyserRef.current) {
        return;
      }
      const buffer = new Float32Array(voiceAnalyserRef.current.fftSize);
      voiceAnalyserRef.current.getFloatTimeDomainData(buffer);
      const rms = computeRms(buffer);
      setVoiceLevel(Math.min(1, rms * 8));
    }, 80);

    return stream;
  }, [voiceSelectedInputId]);

  useEffect(() => {
    voiceStatusRef.current = String(voiceStatus || "disconnected")
      .trim()
      .toLowerCase();
  }, [voiceStatus]);

  useEffect(() => {
    voiceRecordingRef.current = Boolean(voiceRecording);
  }, [voiceRecording]);

  useEffect(() => {
    voiceAssistantSpeakingRef.current = Boolean(voiceAssistantSpeaking);
  }, [voiceAssistantSpeaking]);

  const startVoiceRecording = useCallback(async () => {
    if (voiceCaptureProcessorRef.current) {
      return true;
    }

    setVoiceBusy((prev) => ({ ...prev, startMic: true }));
    try {
      const socket = voiceSocketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error("Voice socket is not connected.");
      }

      await ensureVoiceMedia();
      const context = voiceAudioContextRef.current;
      const source = voiceSourceNodeRef.current;
      if (!context || !source) {
        throw new Error("Microphone stream is not initialized.");
      }

      setVoiceMetrics({
        sttPartialMs: null,
        sttFinalMs: null,
        firstAudioMs: null,
        turnId: ""
      });
      voiceHasPendingInputRef.current = false;
      voiceInterruptSpeechMsRef.current = 0;
      voiceBargeInCaptureRef.current = false;

      appendVoiceDebugLog(
        "info",
        `mic start (sampleRate=${Number(context.sampleRate) || "unknown"})`
      );

      const processor = context.createScriptProcessor(2048, 1, 1);
      const silentSink = context.createGain();
      silentSink.gain.value = 0;

      processor.onaudioprocess = (audioEvent) => {
        try {
          const ws = voiceSocketRef.current;
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          if (ws.bufferedAmount > 2 * 1024 * 1024) {
            appendVoiceDebugLog("warn", "audio backpressure: frame skipped");
            return;
          }

          const input = audioEvent?.inputBuffer?.getChannelData(0);
          if (!input || input.length === 0) {
            return;
          }

          const normalized = downsampleFloat32Buffer(input, context.sampleRate, 24000);
          if (!normalized.length) {
            return;
          }
          const frameDurationMs = Math.max(
            1,
            Math.round((normalized.length / 24000) * 1000)
          );
          const rms = computeRms(normalized);

          const assistantActive =
            voiceAssistantSpeakingRef.current ||
            voiceStatusRef.current === "speaking" ||
            voicePlaybackActiveCountRef.current > 0;
          if (assistantActive && voiceRecordingRef.current) {
            if (rms >= 0.02) {
              voiceInterruptSpeechMsRef.current += frameDurationMs;
            } else {
              voiceInterruptSpeechMsRef.current = Math.max(
                0,
                voiceInterruptSpeechMsRef.current - frameDurationMs * 2
              );
            }

            const now = Date.now();
            if (
              voiceInterruptSpeechMsRef.current >= 220 &&
              now - Number(voiceLastInterruptAtRef.current || 0) >= 900
            ) {
              const sent = sendVoiceEnvelope("assistant.interrupt", {
                reason: "client_vad_barge_in"
              });
              if (sent) {
                voiceLastInterruptAtRef.current = now;
                voiceInterruptSpeechMsRef.current = 0;
                voiceBargeInCaptureRef.current = true;
                appendVoiceDebugLog("event", "assistant.interrupt sent (client_vad_barge_in)");
                stopAllVoicePlayback("client_vad_barge_in");
              }
            }

            if (!voiceBargeInCaptureRef.current) {
              return;
            }
          } else {
            voiceInterruptSpeechMsRef.current = 0;
            voiceBargeInCaptureRef.current = false;
          }

          const pcmBytes = float32ToPcm16Bytes(normalized);
          if (!pcmBytes.length) {
            return;
          }

          voiceInputSeqRef.current += 1;
          const binaryFrame = encodeVoiceInputBinaryAudioFrame({
            seq: voiceInputSeqRef.current,
            sampleRateHz: 24000,
            channels: 1,
            pcmBytes
          });
          if (!binaryFrame) {
            return;
          }
          const sent = sendVoiceBinaryFrame(binaryFrame);
          if (sent) {
            voiceHasPendingInputRef.current = true;
          }
        } catch (_) {
          // Ignore per-chunk audio processing errors.
        }
      };

      source.connect(processor);
      processor.connect(silentSink);
      silentSink.connect(context.destination);

      voiceCaptureProcessorRef.current = processor;
      voiceCaptureSinkRef.current = silentSink;
      setVoiceRecording(true);
      pushNotice("success", "Microphone is live.");
      return true;
    } catch (err) {
      appendVoiceDebugLog("error", `mic start failed: ${err.message || "unknown error"}`);
      pushNotice("error", err.message || "Failed to start microphone.");
      return false;
    } finally {
      setVoiceBusy((prev) => ({ ...prev, startMic: false }));
    }
  }, [
    appendVoiceDebugLog,
    ensureVoiceMedia,
    pushNotice,
    sendVoiceBinaryFrame,
    sendVoiceEnvelope,
    stopAllVoicePlayback
  ]);

  const stopVoiceRecording = useCallback(
    async ({ commit = true } = {}) => {
      setVoiceBusy((prev) => ({ ...prev, stoppingMic: true }));
      try {
        if (voiceCaptureProcessorRef.current) {
          try {
            voiceCaptureProcessorRef.current.disconnect();
          } catch (_) {
            // Ignore processor disconnect errors.
          }
          voiceCaptureProcessorRef.current.onaudioprocess = null;
          voiceCaptureProcessorRef.current = null;
        }

        if (voiceCaptureSinkRef.current) {
          try {
            voiceCaptureSinkRef.current.disconnect();
          } catch (_) {
            // Ignore sink disconnect errors.
          }
          voiceCaptureSinkRef.current = null;
        }

        setVoiceRecording(false);
        setVoiceUserSpeaking(false);
        setVoiceLevel(0);
        voiceInterruptSpeechMsRef.current = 0;
        voiceBargeInCaptureRef.current = false;
        appendVoiceDebugLog("info", `mic stop (commit=${commit ? "yes" : "no"})`);

        if (commit) {
          const hasPendingAudio = voiceHasPendingInputRef.current;
          if (!hasPendingAudio) {
            appendVoiceDebugLog("event", "commit skipped: no pending audio");
          } else {
            const committed = sendVoiceEnvelope("audio.commit", {
              reason: "ui_manual_commit",
              force_response: true
            });
            if (committed) {
              voiceHasPendingInputRef.current = false;
              appendVoiceDebugLog("event", "input committed + response requested");
            }
          }
        }
      } finally {
        setVoiceBusy((prev) => ({ ...prev, stoppingMic: false }));
      }
    },
    [appendVoiceDebugLog, sendVoiceEnvelope]
  );

  const disconnectVoiceSocket = useCallback(async () => {
    const socket = voiceSocketRef.current;
    if (socket) {
      try {
        socket.close();
      } catch (_) {
        // Ignore close races.
      }
      voiceSocketRef.current = null;
    }

    appendVoiceDebugLog("info", "voice websocket disconnected");

    voiceSessionIdRef.current = "";
    voiceHasPendingInputRef.current = false;
    voiceInterruptSpeechMsRef.current = 0;
    voiceBargeInCaptureRef.current = false;
    setVoiceConnected(false);
    setVoiceStatus("disconnected");
    setVoiceUserPartial("");
    setVoiceAssistantPartial("");
    setVoiceUserSpeaking(false);
    setVoiceAssistantSpeaking(false);
    setVoicePlaybackActive(false);
    setVoiceSettingsOpen(false);
    stopAllVoicePlayback("manual_disconnect");

    await teardownVoiceMedia();
  }, [appendVoiceDebugLog, stopAllVoicePlayback, teardownVoiceMedia]);

  const connectVoiceSocket = useCallback(async () => {
    if (voiceSocketRef.current && voiceSocketRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    setVoiceBusy((prev) => ({ ...prev, connecting: true }));
    setVoiceStatus("connecting");
    appendVoiceDebugLog("info", "requesting voice websocket ticket...");

    try {
      const payload = await fetchJson("/api/system/voice/ticket", {
        method: "POST",
        body: JSON.stringify({ ttlMs: 60000 })
      });

      const wsBaseUrl = String(payload?.data?.wsBaseUrl || "").trim();
      const wsPath = String(payload?.data?.wsPath || "/ws/voice").trim() || "/ws/voice";
      const ticket = String(payload?.data?.ticket || "").trim();

      if (!wsBaseUrl || !ticket) {
        throw new Error("Control API did not return voice websocket credentials.");
      }

      const wsUrl = `${wsBaseUrl}${wsPath}?ticket=${encodeURIComponent(ticket)}`;
      appendVoiceDebugLog("info", `connecting websocket: ${wsBaseUrl}${wsPath}`);
      const socket = new WebSocket(wsUrl, VOICE_CORE_PROTOCOL);
      socket.binaryType = "arraybuffer";

      await new Promise((resolve, reject) => {
        let settled = false;

        const finish = (callback) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          socket.removeEventListener("open", onOpen);
          socket.removeEventListener("error", onError);
          callback();
        };

        const onOpen = () => finish(resolve);
        const onError = () => finish(() => reject(new Error("Voice websocket connect failed.")));

        const timer = setTimeout(() => {
          finish(() => reject(new Error("Voice websocket connect timed out.")));
        }, 10000);

        socket.addEventListener("open", onOpen);
        socket.addEventListener("error", onError);
      });

      voiceSocketRef.current = socket;
      voiceSessionIdRef.current = "";
      voiceHasPendingInputRef.current = false;
      setVoiceConnected(true);
      setVoiceStatus("connected");
      appendVoiceDebugLog("info", "voice websocket connected");

      socket.onmessage = async (message) => {
        const data = message?.data;
        if (data instanceof ArrayBuffer) {
          try {
            const frame = decodeVoiceBinaryAudioFrame(data);
            if (frame.kindCode !== VOICE_AUDIO_KIND_OUTPUT || frame.bytes.byteLength === 0) {
              return;
            }

            const now = Date.now();
            if (now - voiceLastChunkLogAtRef.current >= 1200) {
              voiceLastChunkLogAtRef.current = now;
              appendVoiceDebugLog(
                "event",
                `assistant audio chunk (format=pcm16, ~${estimateAudioChunkDurationMs({
                  audioBase64: bytesToBase64(frame.bytes),
                  format: "pcm16",
                  sampleRate: frame.sampleRateHz
                })}ms)`
              );
            }
            bufferVoicePlaybackChunk({
              audioBase64: bytesToBase64(frame.bytes),
              format: "pcm16",
              sampleRate: frame.sampleRateHz
            });
          } catch (binaryError) {
            appendVoiceDebugLog(
              "warn",
              `invalid binary audio frame: ${binaryError?.message || "decode failed"}`
            );
          }
          return;
        }

        if (typeof Blob !== "undefined" && data instanceof Blob) {
          try {
            const raw = await data.arrayBuffer();
            const frame = decodeVoiceBinaryAudioFrame(raw);
            if (frame.kindCode !== VOICE_AUDIO_KIND_OUTPUT || frame.bytes.byteLength === 0) {
              return;
            }
            bufferVoicePlaybackChunk({
              audioBase64: bytesToBase64(frame.bytes),
              format: "pcm16",
              sampleRate: frame.sampleRateHz
            });
          } catch (blobError) {
            appendVoiceDebugLog(
              "warn",
              `invalid blob audio frame: ${blobError?.message || "decode failed"}`
            );
          }
          return;
        }

        try {
          const event = JSON.parse(String(data || "{}"));
          handleVoiceWsEvent(event);
        } catch (err) {
          appendVoiceDebugLog(
            "warn",
            `invalid websocket payload: ${err?.message || "json parse failed"}`
          );
        }
      };

      socket.onclose = (closeEvent) => {
        const code = Number(closeEvent?.code || 0);
        const reason = String(closeEvent?.reason || "").trim();
        appendVoiceDebugLog(
          code === 1000 ? "info" : "warn",
          `voice websocket closed (code=${code}${reason ? `, reason=${reason}` : ""})`
        );
        setVoiceConnected(false);
        setVoiceStatus("disconnected");
        setVoiceRecording(false);
        setVoiceUserSpeaking(false);
        setVoiceAssistantSpeaking(false);
        setVoicePlaybackActive(false);
        setVoiceSettingsOpen(false);
        voiceSessionIdRef.current = "";
        voiceHasPendingInputRef.current = false;
        voiceInterruptSpeechMsRef.current = 0;
        voiceBargeInCaptureRef.current = false;
        stopAllVoicePlayback("ws_close");
      };

      socket.onerror = () => {
        appendVoiceDebugLog("error", "voice websocket transport error");
        pushNotice("error", "Voice websocket connection error.");
      };

      sendVoiceEnvelope("session.start", {
        client: {
          kind: "control-ui",
          actor: "human",
          protocol: VOICE_CORE_PROTOCOL
        },
        language: "en-US",
        openaiRealtimeTurnDetection: "semantic_vad",
        openaiRealtimeTurnEagerness: "auto",
        openaiRealtimeVadThreshold: 0.45,
        openaiRealtimeVadSilenceMs: 280,
        openaiRealtimeVadPrefixPaddingMs: 180,
        openaiRealtimeInterruptResponseOnTurn: true,
        openaiRealtimeUpstreamTurnDetectionEnabled: false
      });
      appendVoiceDebugLog("event", "session.start sent");

      await loadVoiceDevices();
      pushNotice("success", "Voice bot connected.");
    } catch (err) {
      await disconnectVoiceSocket();
      appendVoiceDebugLog("error", `voice connect failed: ${err.message || "unknown error"}`);
      pushNotice("error", err.message || "Failed to connect voice bot.");
    } finally {
      setVoiceBusy((prev) => ({ ...prev, connecting: false }));
    }
  }, [
    appendVoiceDebugLog,
    bufferVoicePlaybackChunk,
    disconnectVoiceSocket,
    handleVoiceWsEvent,
    loadVoiceDevices,
    pushNotice,
    sendVoiceEnvelope,
    stopAllVoicePlayback
  ]);

  const loadSettingsSchema = useCallback(async () => {
    const payload = await fetchJson("/api/system/config/schema");
    setConfigSchema(payload?.data?.schema || []);
  }, []);

  const loadSettingsSnapshot = useCallback(async (searchValue = "") => {
    const normalizedSearch = String(searchValue || "").trim();
    const query = normalizedSearch
      ? `?search=${encodeURIComponent(normalizedSearch)}`
      : "";
    const payload = await fetchJson(`/api/system/config${query}`);
    setConfigEntries(payload?.data?.entries || []);
  }, []);

  const loadSettingsAudit = useCallback(async () => {
    const payload = await fetchJson("/api/system/config/audit?limit=120");
    setConfigAuditEntries(payload?.data?.entries || []);
  }, []);

  const refreshSettings = useCallback(async (searchValue = "") => {
    setConfigBusy((prev) => ({ ...prev, loading: true }));
    try {
      await Promise.all([
        loadSettingsSchema(),
        loadSettingsSnapshot(searchValue),
        loadSettingsAudit()
      ]);
    } catch (err) {
      pushNotice("error", err.message || "Failed to load settings.");
    } finally {
      setConfigBusy((prev) => ({ ...prev, loading: false }));
    }
  }, [loadSettingsAudit, loadSettingsSchema, loadSettingsSnapshot, pushNotice]);

  useEffect(() => {
    void loadState();
    void loadLogsSnapshot();
    void loadVoiceDevices();
  }, [loadState, loadLogsSnapshot, loadVoiceDevices]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadState({ silent: true });
    }, 5000);

    return () => {
      clearInterval(timer);
    };
  }, [loadState]);

  useEffect(() => {
    const timer = setInterval(() => {
      void loadLogsSnapshot();
    }, 3000);

    return () => {
      clearInterval(timer);
    };
  }, [loadLogsSnapshot]);

  useEffect(() => {
    const source = new EventSource("/api/system/logs/stream");

    source.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse(event.data);
        setLogs(Array.isArray(payload?.logs) ? payload.logs : []);
      } catch (_) {
        // Ignore invalid payload.
      }
    });

    source.addEventListener("log", (event) => {
      try {
        const entry = JSON.parse(event.data);
        setLogs((prev) => {
          const next = [...prev, entry];
          if (next.length > 1200) {
            return next.slice(next.length - 1200);
          }
          return next;
        });
      } catch (_) {
        // Ignore invalid payload.
      }
    });

    source.onerror = () => {
      void loadLogsSnapshot();
    };

    return () => {
      source.close();
    };
  }, [loadLogsSnapshot]);

  useEffect(() => {
    const viewport = logsViewportRef.current;
    if (!viewport || !autoScroll) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [logs, autoScroll]);

  useEffect(() => {
    const viewport = voiceDebugViewportRef.current;
    if (!viewport || !voiceDebugAutoScroll) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }, [voiceDebugAutoScroll, voiceDebugLogs]);

  useEffect(() => {
    const timer = setInterval(() => {
      const playbackCurrentlyActive = voicePlaybackActiveCountRef.current > 0;
      const assistantActive = voiceAssistantSpeaking || playbackCurrentlyActive;
      const userActive = voiceUserSpeaking || (voiceRecording && voiceLevel > 0.05);

      const target = !voiceConnected
        ? 0
        : assistantActive
          ? Math.max(0.28, voiceLevel)
          : userActive
            ? Math.max(0.16, voiceLevel)
            : voiceRecording
              ? 0.03
              : 0.015;

      setVoiceOrbLevel((prev) => prev + (target - prev) * 0.24);

      if (!assistantActive && voiceAssistantSpeaking) {
        setVoiceAssistantSpeaking(false);
      }
    }, 50);

    return () => {
      clearInterval(timer);
    };
  }, [voiceAssistantSpeaking, voiceConnected, voiceLevel, voiceRecording, voiceUserSpeaking]);

  useEffect(() => {
    configSearchRef.current = configSearch;
  }, [configSearch]);

  useEffect(() => {
    if (activeTab === TAB_SETTINGS) {
      void refreshSettings(configSearchRef.current);
    }
  }, [activeTab, refreshSettings]);

  useEffect(() => {
    return () => {
      void disconnectVoiceSocket();
    };
  }, [disconnectVoiceSocket]);

  const performAction = useCallback(
    async (key, run) => {
      setBusy((prev) => ({ ...prev, [key]: true }));
      try {
        await run();
      } catch (err) {
        pushNotice("error", err.message || "Operation failed.");
      } finally {
        setBusy((prev) => ({ ...prev, [key]: false }));
      }
    },
    [pushNotice]
  );

  const handleManagedApi = useCallback(
    async (action) => {
      await performAction(action === "start" ? "apiStart" : "apiStop", async () => {
        await fetchJson("/api/system/api", {
          method: "POST",
          body: JSON.stringify({ action })
        });
        pushNotice(
          "success",
          action === "start"
            ? "API start request sent."
            : "API stop request sent."
        );
        await loadState({ silent: true });
      });
    },
    [loadState, performAction, pushNotice]
  );

  const handleStartBot = useCallback(async () => {
    await performAction("botStart", async () => {
      await fetchJson("/api/system/bot", {
        method: "POST",
        body: JSON.stringify({
          action: "start",
          meetUrl: form.meetUrl,
          clientName: form.clientName,
          clientCompany: form.clientCompany,
          clientNotes: form.clientNotes,
          forceRestart: form.forceRestart
        })
      });

      pushNotice("success", "Bot session started.");
      await loadState({ silent: true });
    });
  }, [form, loadState, performAction, pushNotice]);

  const handleStopBot = useCallback(async () => {
    await performAction("botStop", async () => {
      await fetchJson("/api/system/bot", {
        method: "POST",
        body: JSON.stringify({
          action: "stop",
          reason: "manual stop from control-ui"
        })
      });

      pushNotice("success", "Bot session stopped.");
      await loadState({ silent: true });
    });
  }, [loadState, performAction, pushNotice]);

  const canStartApi =
    Boolean(managedApi?.enabled) &&
    !busy.apiStart &&
    managedApi?.status !== "running" &&
    managedApi?.status !== "starting";

  const canStopApi =
    Boolean(managedApi?.enabled) &&
    !busy.apiStop &&
    (managedApi?.status === "running" || managedApi?.status === "starting");

  const canStartBot =
    !busy.botStart &&
    Boolean(form.meetUrl.trim()) &&
    Boolean(controlApi?.health?.ok);

  const canStopBot =
    !busy.botStop &&
    ["starting", "running", "stopping"].includes(
      String(botStatus?.status || "").toLowerCase()
    );

  const renderedLogs = useMemo(() => logs.slice(Math.max(logs.length - 800, 0)), [logs]);
  const voiceLikelyUserActive = voiceUserSpeaking || (voiceRecording && voiceLevel > 0.05);
  const voiceLikelyAssistantActive =
    voiceAssistantSpeaking || voicePlaybackActive || voiceStatus === "speaking";
  const voiceOrbMode = !voiceConnected
    ? "offline"
    : voiceLikelyAssistantActive
      ? "assistant"
      : voiceLikelyUserActive
        ? "listening"
        : "ready";
  const voiceOrbLabel =
    voiceOrbMode === "assistant"
      ? "Assistant speaking"
      : voiceOrbMode === "listening"
        ? "Listening"
        : voiceOrbMode === "ready"
          ? "Connected"
          : "Disconnected";

  const configEntryByKey = useMemo(() => {
    const map = new Map();
    for (const item of configEntries) {
      map.set(item.key, item);
    }
    return map;
  }, [configEntries]);

  const schemaByKey = useMemo(() => {
    const map = new Map();
    for (const item of configSchema) {
      map.set(item.key, item);
    }
    return map;
  }, [configSchema]);

  const handlePreviewConfigChanges = useCallback(async () => {
    const changes = {
      set: {},
      unset: [...new Set(configUnsetKeys)]
    };

    for (const [key, value] of Object.entries(configDraftValues || {})) {
      const nextValue = String(value ?? "");
      if (!nextValue) {
        continue;
      }

      const current = configEntryByKey.get(key);
      if (current?.sensitive) {
        if (nextValue === "********") {
          continue;
        }
      } else if (current && current.value === nextValue) {
        continue;
      }

      changes.set[key] = nextValue;
    }

    const normalizedNewKey = String(configNewKey || "").trim().toUpperCase();
    const normalizedNewValue = String(configNewValue || "");
    if (normalizedNewKey && normalizedNewValue) {
      changes.set[normalizedNewKey] = normalizedNewValue;
    }

    if (Object.keys(changes.set).length === 0 && changes.unset.length === 0) {
      pushNotice("error", "No config changes to preview.");
      return;
    }

    setConfigBusy((prev) => ({ ...prev, preview: true }));
    try {
      const payload = await fetchJson("/api/system/config", {
        method: "PUT",
        body: JSON.stringify(changes)
      });
      setConfigPreview(payload?.data || null);
      pushNotice("success", "Config changes validated. Review diff and apply.");
    } catch (err) {
      pushNotice("error", err.message || "Failed to preview config changes.");
    } finally {
      setConfigBusy((prev) => ({ ...prev, preview: false }));
    }
  }, [
    configDraftValues,
    configEntryByKey,
    configNewKey,
    configNewValue,
    configUnsetKeys,
    pushNotice
  ]);

  const handleApplyConfigPreview = useCallback(async () => {
    const previewId = String(configPreview?.previewId || "").trim();
    if (!previewId) {
      pushNotice("error", "Preview is missing. Validate changes first.");
      return;
    }

    setConfigBusy((prev) => ({ ...prev, apply: true }));
    try {
      await fetchJson("/api/system/config/apply", {
        method: "POST",
        body: JSON.stringify({ previewId })
      });
      setConfigPreview(null);
      setConfigDraftValues({});
      setConfigUnsetKeys([]);
      setConfigNewKey("");
      setConfigNewValue("");
      await refreshSettings(configSearchRef.current);
      pushNotice(
        "success",
        "Config applied. If restart-required keys changed, restart the API process."
      );
    } catch (err) {
      pushNotice("error", err.message || "Failed to apply config preview.");
    } finally {
      setConfigBusy((prev) => ({ ...prev, apply: false }));
    }
  }, [configPreview?.previewId, pushNotice, refreshSettings]);

  return (
    <main className="shell">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <header className="header card reveal">
        <div>
          <p className="eyebrow">Voice Assistant Ops</p>
          <h1>Control UI</h1>
          <p className="subtitle">
            Unified dashboard for API control, Voice Bot realtime calls, and secure configuration management.
          </p>
        </div>
        <div className="header-meta">
          <span className={`pill tone-${statusTone(managedApi?.status)}`}>
            API Process: {managedApi?.status || "unknown"}
          </span>
          <span className={`pill tone-${statusTone(botStatus?.status)}`}>
            Bot: {botStatus?.status || "unknown"}
          </span>
          <span className={`pill tone-${statusTone(voiceStatus)}`}>
            Voice: {voiceStatus}
          </span>
        </div>
      </header>

      <nav className="tabs reveal reveal-delay-1">
        <button
          className={`tab ${activeTab === TAB_DASHBOARD ? "tab-active" : ""}`}
          onClick={() => setActiveTab(TAB_DASHBOARD)}
        >
          Dashboard
        </button>
        <button
          className={`tab ${activeTab === TAB_VOICE ? "tab-active" : ""}`}
          onClick={() => setActiveTab(TAB_VOICE)}
        >
          Voice Bot
        </button>
        <button
          className={`tab ${activeTab === TAB_SETTINGS ? "tab-active" : ""}`}
          onClick={() => setActiveTab(TAB_SETTINGS)}
        >
          Settings
        </button>
      </nav>

      {activeTab === TAB_DASHBOARD ? (
        <>
          <section className="grid reveal reveal-delay-2">
            <article className="card panel">
              <h2>API Process</h2>
              <dl className="kv">
                <div>
                  <dt>Status</dt>
                  <dd>{managedApi?.status || "-"}</dd>
                </div>
                <div>
                  <dt>PID</dt>
                  <dd>{managedApi?.pid || "-"}</dd>
                </div>
                <div>
                  <dt>Uptime</dt>
                  <dd>{formatDuration(managedApi?.uptimeSeconds)}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{formatDate(managedApi?.startedAt)}</dd>
                </div>
                <div>
                  <dt>Command</dt>
                  <dd className="mono">{managedApi?.command || "-"}</dd>
                </div>
                <div>
                  <dt>CWD</dt>
                  <dd className="mono">{managedApi?.cwd || "-"}</dd>
                </div>
              </dl>

              <div className="actions">
                <button
                  className="btn btn-strong"
                  onClick={() => {
                    void handleManagedApi("start");
                  }}
                  disabled={!canStartApi}
                >
                  Start API
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    void handleManagedApi("stop");
                  }}
                  disabled={!canStopApi}
                >
                  Stop API
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    void loadState();
                  }}
                  disabled={busy.refreshing}
                >
                  Refresh
                </button>
              </div>

              {!managedApi?.enabled ? (
                <p className="help warning">
                  Managed API mode is disabled (`MANAGED_API_ENABLED=false`).
                </p>
              ) : null}
            </article>

            <article className="card panel">
              <h2>Control API / Bot</h2>
              <dl className="kv">
                <div>
                  <dt>Base URL</dt>
                  <dd className="mono">{controlApi?.baseUrl || "-"}</dd>
                </div>
                <div>
                  <dt>Health</dt>
                  <dd>
                    {controlApi?.health?.reachable
                      ? `HTTP ${controlApi?.health?.httpStatus ?? "-"}`
                      : "unreachable"}
                  </dd>
                </div>
                <div>
                  <dt>Bot Status</dt>
                  <dd>{botStatus?.status || "-"}</dd>
                </div>
                <div>
                  <dt>Session ID</dt>
                  <dd className="mono">{botStatus?.sessionId || "-"}</dd>
                </div>
                <div>
                  <dt>Meet URL</dt>
                  <dd className="mono">{botStatus?.meetUrl || "-"}</dd>
                </div>
                <div>
                  <dt>Queue Size</dt>
                  <dd>{botStatus?.queueSize ?? "-"}</dd>
                </div>
              </dl>

              <div className="actions">
                <button className="btn btn-strong" onClick={() => void handleStartBot()} disabled={!canStartBot}>
                  Start Bot
                </button>
                <button className="btn" onClick={() => void handleStopBot()} disabled={!canStopBot}>
                  Stop Bot
                </button>
              </div>

              {controlApi?.health?.error ? (
                <p className="help error">{controlApi.health.error}</p>
              ) : null}
            </article>
          </section>

          <section className="card panel reveal reveal-delay-3">
            <h2>Launch Bot in Meet</h2>
            <div className="form-grid">
              <label>
                <span>Meet URL</span>
                <input
                  value={form.meetUrl}
                  onChange={(event) => {
                    setForm((prev) => ({ ...prev, meetUrl: event.target.value }));
                  }}
                  placeholder="https://meet.google.com/xxx-xxxx-xxx"
                />
              </label>

              <label>
                <span>Client Name</span>
                <input
                  value={form.clientName}
                  onChange={(event) => {
                    setForm((prev) => ({ ...prev, clientName: event.target.value }));
                  }}
                  placeholder="John Doe"
                />
              </label>

              <label>
                <span>Company</span>
                <input
                  value={form.clientCompany}
                  onChange={(event) => {
                    setForm((prev) => ({ ...prev, clientCompany: event.target.value }));
                  }}
                  placeholder="Acme Inc"
                />
              </label>

              <label className="notes">
                <span>Client Context / Notes</span>
                <textarea
                  value={form.clientNotes}
                  onChange={(event) => {
                    setForm((prev) => ({ ...prev, clientNotes: event.target.value }));
                  }}
                  placeholder="Budget, goals, constraints, and key notes..."
                />
              </label>
            </div>

            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.forceRestart}
                onChange={(event) => {
                  setForm((prev) => ({ ...prev, forceRestart: event.target.checked }));
                }}
              />
              <span>Force restart if a session is already active</span>
            </label>
          </section>

          <section className="card panel logs-section reveal reveal-delay-3">
            <div className="logs-head">
              <h2>Live Logs</h2>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(event) => {
                    setAutoScroll(event.target.checked);
                  }}
                />
                <span>Auto-scroll</span>
              </label>
            </div>

            <div className="logs" ref={logsViewportRef}>
              {renderedLogs.length === 0 ? (
                <p className="logs-empty">No logs yet.</p>
              ) : (
                renderedLogs.map((entry) => (
                  <div key={entry.id} className={`log-line level-${entry.level || "info"}`}>
                    <span className="log-ts">[{formatDate(entry.ts)}]</span>
                    <span className="log-source">[{entry.source}]</span>
                    <span className="log-msg">{entry.message}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      ) : null}

      {activeTab === TAB_VOICE ? (
        <section className="card panel reveal reveal-delay-2">
          <div className="voice-head">
            <h2>Voice Bot</h2>
            <div className="header-meta">
              <span className={`pill tone-${statusTone(voiceStatus)}`}>Connection: {voiceStatus}</span>
              <span className={`pill tone-${voiceRecording ? "warn" : "ok"}`}>
                {voiceRecording ? "Recording..." : "Mic idle"}
              </span>
            </div>
          </div>

          <div className="voice-controls">
            <button
              className="btn btn-strong"
              onClick={() => void connectVoiceSocket()}
              disabled={voiceConnected || voiceBusy.connecting}
            >
              Connect
            </button>
            <button
              className="btn"
              onClick={() => void disconnectVoiceSocket()}
              disabled={!voiceConnected}
            >
              Disconnect
            </button>

            <button
              className={`voice-mic-btn ${
                voiceRecording ? "is-live" : ""
              } ${voiceBusy.startMic || voiceBusy.stoppingMic ? "is-busy" : ""}`}
              onClick={() => {
                if (voiceRecording) {
                  void stopVoiceRecording({ commit: true });
                } else {
                  void startVoiceRecording();
                }
              }}
              disabled={
                !voiceConnected ||
                !["ready", "listening", "thinking", "speaking", "interrupted"].includes(
                  String(voiceStatus || "").toLowerCase()
                ) ||
                voiceBusy.startMic ||
                voiceBusy.stoppingMic
              }
              aria-label={voiceRecording ? "Stop microphone" : "Start microphone"}
              title={voiceRecording ? "Stop microphone" : "Start microphone"}
            >
              <span className="voice-mic-icon" aria-hidden>
                {voiceRecording ? "■" : "🎤"}
              </span>
            </button>

            <button
              className={`btn btn-ghost icon-btn ${voiceSettingsOpen ? "is-active" : ""}`}
              onClick={() => {
                setVoiceSettingsOpen((prev) => !prev);
              }}
              aria-label="Toggle voice settings"
              title="Voice settings"
            >
              <span aria-hidden>⚙</span>
              <span className="sr-only">Voice settings</span>
            </button>
          </div>

          <p className="help voice-help">
            Use the mic button to talk. Device/mode options are under the settings gear.
          </p>

          {voiceSettingsOpen ? (
            <div className="voice-settings-pop">
              <div className="voice-settings-top">
                <label className="inline-control">
                  <span>Mode</span>
                  <select
                    value={voiceMode}
                    onChange={(event) => {
                      setVoiceMode(event.target.value);
                    }}
                  >
                    <option value="toggle">Toggle</option>
                    <option value="ptt">Push-to-talk</option>
                  </select>
                </label>
              </div>

              <div className="voice-devices">
                <label>
                  <span>Input Device</span>
                  <select
                    value={voiceSelectedInputId}
                    onChange={(event) => {
                      setVoiceSelectedInputId(event.target.value);
                    }}
                  >
                    {voiceInputDevices.length === 0 ? <option value="">Default</option> : null}
                    {voiceInputDevices.map((item, index) => (
                      <option key={item.deviceId || index} value={item.deviceId || ""}>
                        {item.label || `audioinput#${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Output Device</span>
                  <select
                    value={voiceSelectedOutputId}
                    onChange={(event) => {
                      setVoiceSelectedOutputId(event.target.value);
                    }}
                  >
                    {voiceOutputDevices.length === 0 ? <option value="">Default</option> : null}
                    {voiceOutputDevices.map((item, index) => (
                      <option key={item.deviceId || index} value={item.deviceId || ""}>
                        {item.label || `audiooutput#${index + 1}`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          ) : null}

          <div className="voice-orb-stage">
            <div
              className={`voice-orb ${
                voiceConnected ? "is-live" : "is-off"
              } ${voiceLikelyUserActive ? "is-user" : ""} ${
                voiceLikelyAssistantActive ? "is-assistant" : ""
              }`}
              style={{
                "--orb-level": Math.max(0, Math.min(1, voiceOrbLevel)).toFixed(3),
                "--orb-tilt": `${(voiceOrbLevel * 18 - 9).toFixed(2)}deg`
              }}
            >
              <div className="voice-orb-core">
                <span className="voice-orb-shine voice-orb-shine-a" />
                <span className="voice-orb-shine voice-orb-shine-b" />
                <span className="voice-orb-shell" />
              </div>
              <span className="voice-orb-ring ring-a" />
              <span className="voice-orb-ring ring-b" />
              <span className="voice-orb-halo" />
            </div>

            <div className="voice-orb-meta">
              <span className="voice-orb-label">{voiceOrbLabel}</span>
            </div>
          </div>

          {voiceMode === "ptt" ? (
            <div className="voice-ptt-wrap">
              <button
                className="btn btn-ptt"
                disabled={
                  !voiceConnected ||
                  !["ready", "listening", "thinking", "speaking", "interrupted"].includes(
                    String(voiceStatus || "").toLowerCase()
                  )
                }
                onMouseDown={() => {
                  void startVoiceRecording();
                }}
                onMouseUp={() => {
                  void stopVoiceRecording({ commit: true });
                }}
                onMouseLeave={() => {
                  if (voiceRecording) {
                    void stopVoiceRecording({ commit: true });
                  }
                }}
                onTouchStart={() => {
                  void startVoiceRecording();
                }}
                onTouchEnd={() => {
                  void stopVoiceRecording({ commit: true });
                }}
              >
                Hold To Talk
              </button>
            </div>
          ) : null}

          <div className="voice-latency">
            <span>STT partial: {voiceMetrics.sttPartialMs == null ? "-" : `${voiceMetrics.sttPartialMs} ms`}</span>
            <span>STT final: {voiceMetrics.sttFinalMs == null ? "-" : `${voiceMetrics.sttFinalMs} ms`}</span>
            <span>First audio: {voiceMetrics.firstAudioMs == null ? "-" : `${voiceMetrics.firstAudioMs} ms`}</span>
            <span>Turn: {voiceMetrics.turnId || "-"}</span>
          </div>

          <div className="voice-conversation">
            {voiceConversation.length === 0 && !voiceUserPartial && !voiceAssistantPartial ? (
              <p className="logs-empty">No voice transcript yet.</p>
            ) : null}
            {voiceConversation.map((item) => (
              <div key={item.id} className={`voice-line voice-${item.role}`}>
                <span className="voice-role">{item.role === "assistant" ? "Assistant" : "You"}</span>
                <span className="voice-text">{item.text}</span>
              </div>
            ))}
            {voiceUserPartial ? (
              <div className="voice-line voice-user voice-partial">
                <span className="voice-role">You (partial)</span>
                <span className="voice-text">{voiceUserPartial}</span>
              </div>
            ) : null}
            {voiceAssistantPartial ? (
              <div className="voice-line voice-assistant voice-partial">
                <span className="voice-role">Assistant (partial)</span>
                <span className="voice-text">{voiceAssistantPartial}</span>
              </div>
            ) : null}
          </div>

          <div className="voice-debug-head">
            <h3>Voice Session Log</h3>
            <div className="voice-debug-actions">
              <label className="checkbox small">
                <input
                  type="checkbox"
                  checked={voiceDebugAutoScroll}
                  onChange={(event) => {
                    setVoiceDebugAutoScroll(event.target.checked);
                  }}
                />
                <span>Auto-scroll</span>
              </label>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setVoiceDebugLogs([]);
                }}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="voice-debug" ref={voiceDebugViewportRef}>
            {voiceDebugLogs.length === 0 ? (
              <p className="logs-empty">No voice events yet.</p>
            ) : (
              voiceDebugLogs.map((entry) => (
                <div key={entry.id} className={`voice-debug-line level-${entry.level || "info"}`}>
                  <span className="voice-debug-ts">[{formatTime(entry.ts)}]</span>
                  <span className="voice-debug-msg">{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </section>
      ) : null}

      {activeTab === TAB_SETTINGS ? (
        <section className="card panel reveal reveal-delay-2">
          <div className="settings-head">
            <h2>Settings</h2>
            <div className="actions">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  void refreshSettings(configSearch);
                }}
                disabled={configBusy.loading}
              >
                Refresh
              </button>
              <button
                className="btn btn-strong"
                onClick={() => {
                  void handlePreviewConfigChanges();
                }}
                disabled={configBusy.preview}
              >
                Preview Changes
              </button>
              <button
                className="btn"
                onClick={() => {
                  void handleApplyConfigPreview();
                }}
                disabled={!configPreview?.previewId || configBusy.apply}
              >
                Apply
              </button>
            </div>
          </div>

          <div className="settings-search-row">
            <input
              value={configSearch}
              placeholder="Search key"
              onChange={(event) => {
                setConfigSearch(event.target.value);
              }}
            />
            <button
              className="btn btn-ghost"
              onClick={() => {
                void loadSettingsSnapshot(configSearch);
              }}
            >
              Search
            </button>
          </div>

          <div className="settings-add-grid">
            <input
              className="mono"
              placeholder="NEW_KEY (known schema key or CUSTOM_*)"
              value={configNewKey}
              onChange={(event) => setConfigNewKey(event.target.value.toUpperCase())}
            />
            <input
              placeholder="Value"
              value={configNewValue}
              onChange={(event) => setConfigNewValue(event.target.value)}
            />
          </div>

          <div className="settings-table">
            <div className="settings-table-head">
              <span>Key</span>
              <span>Current</span>
              <span>New value</span>
              <span>Unset override</span>
            </div>
            {configEntries.map((entry) => {
              const schema = schemaByKey.get(entry.key);
              return (
                <div key={entry.key} className="settings-row">
                  <div>
                    <div className="mono">{entry.key}</div>
                    <div className="settings-meta">
                      <span>{schema?.type || entry.type || "string"}</span>
                      <span>{entry.restartRequired ? "restart" : "hot"}</span>
                      <span>{entry.sensitive ? "secret" : "plain"}</span>
                      <span>{entry.source}</span>
                    </div>
                  </div>
                  <div className="mono">{entry.value || ""}</div>
                  <input
                    placeholder={entry.sensitive ? "Set new secret" : "New value"}
                    value={configDraftValues[entry.key] || ""}
                    onChange={(event) => {
                      const next = event.target.value;
                      setConfigDraftValues((prev) => ({ ...prev, [entry.key]: next }));
                    }}
                  />
                  <label className="checkbox small">
                    <input
                      type="checkbox"
                      checked={configUnsetKeys.includes(entry.key)}
                      onChange={(event) => {
                        setConfigUnsetKeys((prev) => {
                          if (event.target.checked) {
                            return [...new Set([...prev, entry.key])];
                          }
                          return prev.filter((item) => item !== entry.key);
                        });
                      }}
                    />
                    <span>Unset</span>
                  </label>
                </div>
              );
            })}
          </div>

          {configPreview ? (
            <div className="settings-preview">
              <h3>Preview Diff</h3>
              <p>
                Preview ID: <span className="mono">{configPreview.previewId}</span>
                {" | "}
                Restart required: {configPreview.restartRequired ? "yes" : "no"}
              </p>
              <div className="settings-diff-list">
                {(configPreview.diff || []).map((item, index) => (
                  <div key={`${item.key}-${index}`} className="settings-diff-item mono">
                    [{item.action}] {item.key}: {item.from || "<empty>"} → {item.to || "<empty>"}
                    {item.restartRequired ? " (restart)" : " (hot)"}
                  </div>
                ))}
                {(configPreview.diff || []).length === 0 ? (
                  <div className="settings-diff-item mono">No effective changes.</div>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="settings-audit">
            <h3>Audit Log</h3>
            <div className="settings-audit-list">
              {configAuditEntries.length === 0 ? (
                <p className="logs-empty">No audit entries yet.</p>
              ) : (
                configAuditEntries
                  .slice()
                  .reverse()
                  .map((entry, index) => (
                    <div key={`${entry.ts || "ts"}-${index}`} className="settings-audit-item">
                      <div>
                        <strong>{entry.action || "config.apply"}</strong>
                        <span> by {entry.actor || "unknown"}</span>
                      </div>
                      <div className="mono">{formatDate(entry.ts)}</div>
                      <div className="mono">
                        keys: {(entry.changedKeys || []).join(", ") || "-"}
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        </section>
      ) : null}

      <footer className={`notice notice-${notice.type}`}>
        <span>{notice.text || "Ready."}</span>
      </footer>
    </main>
  );
}

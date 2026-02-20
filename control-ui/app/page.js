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
  const [voiceInputDevices, setVoiceInputDevices] = useState([]);
  const [voiceOutputDevices, setVoiceOutputDevices] = useState([]);
  const [voiceSelectedInputId, setVoiceSelectedInputId] = useState("");
  const [voiceSelectedOutputId, setVoiceSelectedOutputId] = useState("");
  const [voiceUserPartial, setVoiceUserPartial] = useState("");
  const [voiceAssistantPartial, setVoiceAssistantPartial] = useState("");
  const [voiceConversation, setVoiceConversation] = useState([]);
  const [voiceMetrics, setVoiceMetrics] = useState({
    sttPartialMs: null,
    sttFinalMs: null,
    firstAudioMs: null
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
  const voiceStreamRef = useRef(null);
  const voiceAnalyserRef = useRef(null);
  const voiceSourceNodeRef = useRef(null);
  const voiceCaptureProcessorRef = useRef(null);
  const voiceCaptureSinkRef = useRef(null);
  const voiceAudioContextRef = useRef(null);
  const voiceAnalyserTimerRef = useRef(null);
  const voiceAudioPlaybackChainRef = useRef(Promise.resolve());
  const voiceUserSpeechStartRef = useRef(0);
  const voiceLastUserFinalAtRef = useRef(0);
  const voiceFirstAudioAfterFinalRef = useRef(false);

  const managedApi = systemState?.managedApi;
  const controlApi = systemState?.controlApi;
  const botStatus = controlApi?.bot?.data;

  const pushNotice = useCallback((type, text) => {
    setNotice({ type, text });
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

    setVoiceRecording(false);
  }, [teardownVoiceAnalyser]);

  const sendVoiceMessage = useCallback((payload) => {
    const socket = voiceSocketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }, []);

  const playVoiceAudioChunk = useCallback(
    async ({ audioBase64, format, sampleRate = 24000 }) => {
      const normalizedAudio = String(audioBase64 || "").trim();
      if (!normalizedAudio) {
        return;
      }

      const normalizedFormat = String(format || "pcm16").trim().toLowerCase();
      let blob = null;

      if (normalizedFormat === "pcm16") {
        blob = pcm16Base64ToWavBlob(normalizedAudio, sampleRate);
      } else {
        const bytes = base64ToBytes(normalizedAudio);
        blob = new Blob([bytes], { type: audioMimeFromFormat(normalizedFormat) });
      }

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preload = "auto";

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
    [voiceSelectedOutputId]
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
    (event) => {
      const type = String(event?.type || "").trim().toLowerCase();
      if (!type) {
        return;
      }

      if (type === "session_started") {
        setVoiceStatus("ready");
        return;
      }

      if (type === "session_state") {
        const state = String(event?.state || "").trim().toLowerCase();
        setVoiceStatus(state || "ready");
        return;
      }

      if (type === "vad") {
        if (String(event?.state || "").trim().toLowerCase() === "start") {
          voiceUserSpeechStartRef.current = Date.now();
          voiceFirstAudioAfterFinalRef.current = false;
        }
        return;
      }

      if (type === "stt_partial") {
        const text = String(event?.text || "").trim();
        if (!text) {
          return;
        }
        setVoiceUserPartial(text);

        if (voiceUserSpeechStartRef.current && voiceMetrics.sttPartialMs == null) {
          setVoiceMetrics((prev) => ({
            ...prev,
            sttPartialMs: Math.max(0, Date.now() - voiceUserSpeechStartRef.current)
          }));
        }
        return;
      }

      if (type === "stt_final") {
        const text = String(event?.text || "").trim();
        if (!text) {
          return;
        }

        setVoiceUserPartial("");
        appendVoiceConversation("user", text, true);
        voiceLastUserFinalAtRef.current = Date.now();
        voiceFirstAudioAfterFinalRef.current = false;

        if (voiceUserSpeechStartRef.current) {
          setVoiceMetrics((prev) => ({
            ...prev,
            sttFinalMs: Math.max(0, Date.now() - voiceUserSpeechStartRef.current),
            firstAudioMs: null
          }));
        }
        return;
      }

      if (type === "assistant_text") {
        const text = String(event?.text || "").trim();
        if (!text) {
          return;
        }

        if (coerceBoolean(event?.is_final, false)) {
          setVoiceAssistantPartial("");
          appendVoiceConversation("assistant", text, true);
        } else {
          setVoiceAssistantPartial(text);
        }
        return;
      }

      if (type === "tts_audio_chunk") {
        if (
          !voiceFirstAudioAfterFinalRef.current &&
          voiceLastUserFinalAtRef.current > 0
        ) {
          voiceFirstAudioAfterFinalRef.current = true;
          setVoiceMetrics((prev) => ({
            ...prev,
            firstAudioMs: Math.max(0, Date.now() - voiceLastUserFinalAtRef.current)
          }));
        }

        enqueueVoicePlayback({
          audioBase64: event?.audio_base64 || event?.audioBase64 || "",
          format: event?.format || "pcm16",
          sampleRate: Number(event?.sample_rate || event?.sampleRate || 24000)
        });
        return;
      }

      if (type === "assistant_state") {
        const state = String(event?.state || "").trim().toLowerCase();
        if (state) {
          setVoiceStatus(state);
        }
        return;
      }

      if (type === "error") {
        const message = String(event?.message || "Voice session error.").trim();
        pushNotice("error", message);
      }
    },
    [appendVoiceConversation, enqueueVoicePlayback, pushNotice, voiceMetrics.sttPartialMs]
  );

  const ensureVoiceMedia = useCallback(async () => {
    if (voiceStreamRef.current) {
      return voiceStreamRef.current;
    }

    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
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
      let sum = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        sum += buffer[index] * buffer[index];
      }
      const rms = Math.sqrt(sum / Math.max(1, buffer.length));
      setVoiceLevel(Math.min(1, rms * 8));
    }, 80);

    return stream;
  }, [voiceSelectedInputId]);

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

          const pcmBytes = float32ToPcm16Bytes(normalized);
          if (!pcmBytes.length) {
            return;
          }

          sendVoiceMessage({
            type: "audio_chunk",
            audio_base64: bytesToBase64(pcmBytes)
          });
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
      pushNotice("error", err.message || "Failed to start microphone.");
      return false;
    } finally {
      setVoiceBusy((prev) => ({ ...prev, startMic: false }));
    }
  }, [ensureVoiceMedia, pushNotice, sendVoiceMessage]);

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

        if (commit) {
          sendVoiceMessage({ type: "commit" });
        }
      } finally {
        setVoiceBusy((prev) => ({ ...prev, stoppingMic: false }));
      }
    },
    [sendVoiceMessage]
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

    setVoiceConnected(false);
    setVoiceStatus("disconnected");
    setVoiceUserPartial("");
    setVoiceAssistantPartial("");

    await teardownVoiceMedia();
  }, [teardownVoiceMedia]);

  const connectVoiceSocket = useCallback(async () => {
    if (voiceSocketRef.current && voiceSocketRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    setVoiceBusy((prev) => ({ ...prev, connecting: true }));
    setVoiceStatus("connecting");

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
      const socket = new WebSocket(wsUrl);

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
      setVoiceConnected(true);
      setVoiceStatus("connected");

      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(String(message?.data || "{}"));
          handleVoiceWsEvent(event);
        } catch (_) {
          // Ignore malformed messages.
        }
      };

      socket.onclose = () => {
        setVoiceConnected(false);
        setVoiceStatus("disconnected");
        setVoiceRecording(false);
      };

      socket.onerror = () => {
        pushNotice("error", "Voice websocket connection error.");
      };

      sendVoiceMessage({
        type: "start_session",
        language: "en-US",
        turnDetection: "server_vad",
        turnDetectionEagerness: "auto",
        vadThreshold: 0.45,
        vadSilenceMs: 280,
        vadPrefixPaddingMs: 180,
        interruptResponseOnTurn: true
      });

      await loadVoiceDevices();
      pushNotice("success", "Voice bot connected.");
    } catch (err) {
      await disconnectVoiceSocket();
      pushNotice("error", err.message || "Failed to connect voice bot.");
    } finally {
      setVoiceBusy((prev) => ({ ...prev, connecting: false }));
    }
  }, [
    disconnectVoiceSocket,
    handleVoiceWsEvent,
    loadVoiceDevices,
    pushNotice,
    sendVoiceMessage
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
              className={`btn ${voiceRecording ? "btn-danger" : ""}`}
              onClick={() => {
                if (voiceRecording) {
                  void stopVoiceRecording({ commit: true });
                } else {
                  void startVoiceRecording();
                }
              }}
              disabled={!voiceConnected || voiceBusy.startMic || voiceBusy.stoppingMic}
            >
              {voiceRecording ? "Stop Mic" : "Start Mic"}
            </button>

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

          {voiceMode === "ptt" ? (
            <div className="voice-ptt-wrap">
              <button
                className="btn btn-ptt"
                disabled={!voiceConnected}
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

          <div className="voice-meter-row">
            <div className="voice-meter">
              <div
                className="voice-meter-fill"
                style={{ width: `${Math.round(Math.max(0, Math.min(1, voiceLevel)) * 100)}%` }}
              />
            </div>
            <span className="voice-meter-label">Input level</span>
          </div>

          <div className="voice-latency">
            <span>STT partial: {voiceMetrics.sttPartialMs == null ? "-" : `${voiceMetrics.sttPartialMs} ms`}</span>
            <span>STT final: {voiceMetrics.sttFinalMs == null ? "-" : `${voiceMetrics.sttFinalMs} ms`}</span>
            <span>First audio: {voiceMetrics.firstAudioMs == null ? "-" : `${voiceMetrics.firstAudioMs} ms`}</span>
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

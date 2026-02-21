const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const {
  loadEncryptedOverrides,
  applyOverridesToProcessEnv,
  loadDotEnvFile
} = require("./config-overrides-store");

dotenv.config();

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoundedNumber(
  value,
  { fallback, min = -Infinity, max = Infinity, integer = false } = {}
) {
  const parsed = asNumber(value, fallback);
  const coerced = integer ? Math.trunc(parsed) : parsed;
  return Math.min(max, Math.max(min, coerced));
}

function pickAudioFormat(rawValue) {
  const value = String(rawValue || "mp3").toLowerCase();
  if (["mp3", "wav", "opus", "aac", "flac", "pcm"].includes(value)) {
    return value;
  }
  return "mp3";
}

function pickTtsStreamFormat(rawValue) {
  const value = String(rawValue || "audio")
    .trim()
    .toLowerCase();
  if (["audio", "sse"].includes(value)) {
    return value;
  }
  return "audio";
}

function parseCsvList(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return [];
  }
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function pickVoiceCoreMode(rawValue) {
  return "server";
}

function pickRealtimeTurnDetection(rawValue) {
  const value = String(rawValue || "semantic_vad")
    .trim()
    .toLowerCase();
  if (["manual", "server_vad", "semantic_vad"].includes(value)) {
    return value;
  }
  return "semantic_vad";
}

function pickOpenAiSttSource(rawValue) {
  const value = String(rawValue || "bridge-input")
    .trim()
    .toLowerCase();
  if (value === "bridge-input") {
    return value;
  }
  return "bridge-input";
}

function cleanString(value, fallback = "") {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function resolvePathFromCwd(inputPath, fallbackRelativePath = "") {
  const rawValue = cleanString(inputPath, fallbackRelativePath);
  if (!rawValue) {
    return "";
  }
  return path.resolve(process.cwd(), rawValue);
}

function loadSystemPrompt({
  inlinePrompt,
  promptFilePath,
  fallbackPrompt
} = {}) {
  const fromEnv = cleanString(inlinePrompt);
  if (fromEnv) {
    return fromEnv;
  }

  const resolvedPath = resolvePathFromCwd(promptFilePath);
  if (resolvedPath) {
    try {
      const fromFile = fs.readFileSync(resolvedPath, "utf8").trim();
      if (fromFile) {
        return fromFile;
      }
    } catch (_) {
      // Fall back to default prompt when file is not available.
    }
  }

  return fallbackPrompt;
}

function preloadUiManagedOverrides(env = process.env) {
  const encryptionKey = cleanString(env.CONFIG_ENCRYPTION_KEY);
  if (!encryptionKey) {
    return;
  }

  try {
    const loaded = loadEncryptedOverrides({
      overridesFile: env.CONFIG_OVERRIDES_FILE,
      encryptionKey
    });
    const baseDotEnv = loadDotEnvFile(".env");
    applyOverridesToProcessEnv({
      overrides: loaded?.payload?.overrides || {},
      previousOverrides: {},
      baseDotEnv,
      env
    });
  } catch (err) {
    // Keep startup resilient; invalid encrypted store should not expose secrets.
    console.warn(
      `[CONFIG] UI overrides were not applied: ${String(
        err?.message || "unknown error"
      ).replace(/\s+/g, " ")}`
    );
  }
}

function isAllowedMeetUrl(value, { allowAnyMeetUrl = false } = {}) {
  try {
    const parsed = new URL(String(value || ""));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    if (allowAnyMeetUrl) {
      return true;
    }
    return (
      parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "meet.google.com"
    );
  } catch (_) {
    return false;
  }
}

const defaultSystemPrompt =
  "You are a helpful assistant in a Google Meet call. Reply briefly and clearly.";

preloadUiManagedOverrides(process.env);

const systemPromptFile = resolvePathFromCwd(
  process.env.SYSTEM_PROMPT_FILE,
  "prompts/system-prompt.txt"
);

const config = {
  openaiApiKey: cleanString(process.env.OPENAI_API_KEY),
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  openaiTemperature: asBoundedNumber(process.env.OPENAI_TEMPERATURE, {
    fallback: 0.4,
    min: 0,
    max: 2
  }),
  openaiTtsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
  openaiTtsVoice: process.env.OPENAI_TTS_VOICE || "alloy",
  openaiTtsFormat: pickAudioFormat(process.env.OPENAI_TTS_FORMAT),
  openaiTtsVoiceId: cleanString(process.env.OPENAI_TTS_VOICE_ID),
  openaiTtsInstructions: cleanString(process.env.OPENAI_TTS_INSTRUCTIONS),
  openaiTtsSpeed: asBoundedNumber(process.env.OPENAI_TTS_SPEED, {
    fallback: 1,
    min: 0.25,
    max: 4
  }),
  openaiTtsStreamFormat: pickTtsStreamFormat(process.env.OPENAI_TTS_STREAM_FORMAT),
  voiceCoreMode: pickVoiceCoreMode(process.env.VOICE_CORE_MODE),
  voiceCoreVerboseLogs: asBoolean(process.env.VOICE_CORE_VERBOSE_LOGS, false),
  voiceCoreMinUserAudioMs: asBoundedNumber(
    process.env.VOICE_CORE_MIN_USER_AUDIO_MS,
    {
      fallback: 400,
      min: 120,
      max: 12000,
      integer: true
    }
  ),
  voiceCoreMinTranscriptChars: asBoundedNumber(
    process.env.VOICE_CORE_MIN_TRANSCRIPT_CHARS,
    {
      fallback: 3,
      min: 1,
      max: 64,
      integer: true
    }
  ),
  voiceCoreMinAudioMsWithoutTranscript: asBoundedNumber(
    process.env.VOICE_CORE_MIN_AUDIO_MS_WITHOUT_TRANSCRIPT,
    {
      fallback: 1200,
      min: 240,
      max: 16000,
      integer: true
    }
  ),
  openaiRealtimeModel: cleanString(
    process.env.OPENAI_REALTIME_MODEL,
    "gpt-4o-mini-realtime-preview-2024-12-17"
  ),
  openaiRealtimeConnectTimeoutMs: asBoundedNumber(
    process.env.OPENAI_REALTIME_CONNECT_TIMEOUT_MS,
    {
      fallback: 8000,
      min: 1000,
      max: 30000,
      integer: true
    }
  ),
  openaiRealtimeInputTranscriptionModel: cleanString(
    process.env.OPENAI_REALTIME_INPUT_TRANSCRIPTION_MODEL,
    "gpt-4o-mini-transcribe"
  ),
  openaiRealtimeTurnDetection: pickRealtimeTurnDetection(
    process.env.OPENAI_REALTIME_TURN_DETECTION
  ),
  openaiRealtimeTurnEagerness: cleanString(
    process.env.OPENAI_REALTIME_TURN_EAGERNESS,
    "auto"
  ),
  openaiRealtimeVadThreshold: asBoundedNumber(
    process.env.OPENAI_REALTIME_VAD_THRESHOLD,
    {
      fallback: 0.45,
      min: 0,
      max: 1
    }
  ),
  openaiRealtimeVadSilenceMs: asBoundedNumber(
    process.env.OPENAI_REALTIME_VAD_SILENCE_MS,
    {
      fallback: 280,
      min: 120,
      max: 2000,
      integer: true
    }
  ),
  openaiRealtimeVadPrefixPaddingMs: asBoundedNumber(
    process.env.OPENAI_REALTIME_VAD_PREFIX_PADDING_MS,
    {
      fallback: 180,
      min: 0,
      max: 1000,
      integer: true
    }
  ),
  openaiRealtimeInterruptResponseOnTurn: asBoolean(
    process.env.OPENAI_REALTIME_INTERRUPT_RESPONSE_ON_TURN,
    true
  ),
  openaiTtsTimeoutMs: asBoundedNumber(process.env.OPENAI_TTS_TIMEOUT_MS, {
    fallback: 8000,
    min: 1000,
    max: 60000,
    integer: true
  }),
  meetUrl: cleanString(process.env.MEET_URL),
  projectContext: cleanString(process.env.PROJECT_CONTEXT),
  botName: process.env.BOT_NAME || "Meet Voice Bot",
  language: process.env.LANGUAGE || "en-US",
  wakeWord: cleanString(process.env.WAKE_WORD),
  systemPromptFile,
  systemPrompt: loadSystemPrompt({
    inlinePrompt: process.env.SYSTEM_PROMPT,
    promptFilePath: systemPromptFile,
    fallbackPrompt: defaultSystemPrompt
  }),
  maxUserMessageChars: asBoundedNumber(process.env.MAX_USER_MESSAGE_CHARS, {
    fallback: 12000,
    min: 200,
    max: 50000,
    integer: true
  }),
  maxAssistantReplyChars: asBoundedNumber(process.env.MAX_ASSISTANT_REPLY_CHARS, {
    fallback: 500,
    min: 80,
    max: 4000,
    integer: true
  }),
  callSummaryEnabled: asBoolean(process.env.CALL_SUMMARY_ENABLED, true),
  callSummaryModel: cleanString(
    process.env.CALL_SUMMARY_MODEL,
    process.env.OPENAI_MODEL || "gpt-4o-mini"
  ),
  callSummaryTemperature: asBoundedNumber(process.env.CALL_SUMMARY_TEMPERATURE, {
    fallback: 0.2,
    min: 0,
    max: 2
  }),
  callSummaryMaxTurns: asBoundedNumber(process.env.CALL_SUMMARY_MAX_TURNS, {
    fallback: 40,
    min: 5,
    max: 300,
    integer: true
  }),
  callSummaryMaxTranscriptChars: asBoundedNumber(
    process.env.CALL_SUMMARY_MAX_TRANSCRIPT_CHARS,
    {
      fallback: 12000,
      min: 1000,
      max: 100000,
      integer: true
    }
  ),
  callSummaryMaxOutputChars: asBoundedNumber(
    process.env.CALL_SUMMARY_MAX_OUTPUT_CHARS,
    {
      fallback: 1500,
      min: 300,
      max: 10000,
      integer: true
    }
  ),
  callSummaryTimeoutMs: asBoundedNumber(process.env.CALL_SUMMARY_TIMEOUT_MS, {
    fallback: 12000,
    min: 2000,
    max: 120000,
    integer: true
  }),
  maxHistoryMessages: asBoundedNumber(process.env.MAX_HISTORY_MESSAGES, {
    fallback: 12,
    min: 4,
    max: 100,
    integer: true
  }),
  replyChunkMinChars: asBoundedNumber(process.env.REPLY_CHUNK_MIN_CHARS, {
    fallback: 55,
    min: 8,
    max: 500,
    integer: true
  }),
  replyChunkTargetChars: asBoundedNumber(process.env.REPLY_CHUNK_TARGET_CHARS, {
    fallback: 170,
    min: 20,
    max: 1000,
    integer: true
  }),
  replyChunkMaxChars: asBoundedNumber(process.env.REPLY_CHUNK_MAX_CHARS, {
    fallback: 320,
    min: 40,
    max: 1200,
    integer: true
  }),
  replyChunkMaxLatencyMs: asBoundedNumber(
    process.env.REPLY_CHUNK_MAX_LATENCY_MS,
    {
      fallback: 220,
      min: 50,
      max: 5000,
      integer: true
    }
  ),
  bargeInEnabled: asBoolean(process.env.BARGE_IN_ENABLED, true),
  bargeInMinMs: asBoundedNumber(process.env.BARGE_IN_MIN_MS, {
    fallback: 260,
    min: 0,
    max: 10000,
    integer: true
  }),
  bargeInMinWordsOpenAiStt: asBoundedNumber(
    process.env.BARGE_IN_MIN_WORDS_OPENAI_STT,
    {
      fallback: 2,
      min: 1,
      max: 10,
      integer: true
    }
  ),
  bargeInContinuationWindowMs: asBoundedNumber(
    process.env.BARGE_IN_CONTINUATION_WINDOW_MS,
    {
      fallback: 20000,
      min: 2000,
      max: 120000,
      integer: true
    }
  ),
  bargeInOnPartials: asBoolean(process.env.BARGE_IN_ON_PARTIALS, false),
  bargeInOnVadConfirmed: asBoolean(
    process.env.BARGE_IN_ON_VAD_CONFIRMED,
    true
  ),
  bargeInVadMinPeak: asBoundedNumber(process.env.BARGE_IN_VAD_MIN_PEAK, {
    fallback: 0.018,
    min: 0,
    max: 1
  }),
  softInterruptEnabled: asBoolean(process.env.SOFT_INTERRUPT_ENABLED, true),
  softInterruptConfirmMs: asBoundedNumber(
    process.env.SOFT_INTERRUPT_CONFIRM_MS,
    {
      fallback: 280,
      min: 150,
      max: 6000,
      integer: true
    }
  ),
  softInterruptDuckLevel: asBoundedNumber(
    process.env.SOFT_INTERRUPT_DUCK_LEVEL,
    {
      fallback: 0.22,
      min: 0,
      max: 1
    }
  ),
  intakeCompleteToken: cleanString(
    process.env.INTAKE_COMPLETE_TOKEN,
    "[[INTAKE_COMPLETE]]"
  ),
  autoLeaveOnIntakeComplete: asBoolean(
    process.env.AUTO_LEAVE_ON_INTAKE_COMPLETE,
    true
  ),
  intakeCompleteLeaveDelayMs: asBoundedNumber(
    process.env.INTAKE_COMPLETE_LEAVE_DELAY_MS,
    {
      fallback: 1800,
      min: 0,
      max: 30000,
      integer: true
    }
  ),
  openaiSttModel: cleanString(
    process.env.OPENAI_STT_MODEL,
    "gpt-4o-mini-transcribe"
  ),
  openaiSttSource: pickOpenAiSttSource(process.env.OPENAI_STT_SOURCE),
  openaiSttLanguage: cleanString(
    process.env.OPENAI_STT_LANGUAGE,
    cleanString(process.env.LANGUAGE, "en-US")
  ),
  openaiSttPartialsEnabled: asBoolean(
    process.env.OPENAI_STT_PARTIALS_ENABLED,
    true
  ),
  openaiSttPartialEmitMs: asBoundedNumber(
    process.env.OPENAI_STT_PARTIAL_EMIT_MS,
    {
      fallback: 240,
      min: 120,
      max: 3000,
      integer: true
    }
  ),
  openaiSttChunkMs: asBoundedNumber(process.env.OPENAI_STT_CHUNK_MS, {
    fallback: 260,
    min: 120,
    max: 10000,
    integer: true
  }),
  openaiSttTimeoutMs: asBoundedNumber(process.env.OPENAI_STT_TIMEOUT_MS, {
    fallback: 4500,
    min: 1000,
    max: 60000,
    integer: true
  }),
  openaiSttLogFinals: asBoolean(process.env.OPENAI_STT_LOG_FINALS, true),
  openaiSttLogPartials: asBoolean(process.env.OPENAI_STT_LOG_PARTIALS, false),
  verboseSessionLogs: asBoolean(process.env.VERBOSE_SESSION_LOGS, true),
  openaiSttMaxRetries: asBoundedNumber(process.env.OPENAI_STT_MAX_RETRIES, {
    fallback: 1,
    min: 0,
    max: 5,
    integer: true
  }),
  openaiSttMinChunkBytes: asBoundedNumber(
    process.env.OPENAI_STT_MIN_CHUNK_BYTES,
    {
      fallback: 1200,
      min: 0,
      max: 500000,
      integer: true
    }
  ),
  openaiSttMaxQueueChunks: asBoundedNumber(
    process.env.OPENAI_STT_MAX_QUEUE_CHUNKS,
    {
      fallback: 8,
      min: 1,
      max: 64,
      integer: true
    }
  ),
  openaiSttMimeType: cleanString(
    process.env.OPENAI_STT_MIME_TYPE,
    "audio/webm;codecs=opus"
  ),
  openaiSttDeviceId: cleanString(process.env.OPENAI_STT_DEVICE_ID),
  openaiSttDeviceLabel: cleanString(process.env.OPENAI_STT_DEVICE_LABEL),
  openaiSttPreferLoopback: asBoolean(
    process.env.OPENAI_STT_PREFER_LOOPBACK,
    true
  ),
  openaiSttAudioBitsPerSecond: asBoundedNumber(
    process.env.OPENAI_STT_AUDIO_BITS_PER_SECOND,
    {
      fallback: 96000,
      min: 16000,
      max: 320000,
      integer: true
    }
  ),
  openaiSttMinSignalPeak: asBoundedNumber(
    process.env.OPENAI_STT_MIN_SIGNAL_PEAK,
    {
      fallback: 0.004,
      min: 0,
      max: 1
    }
  ),
  openaiSttVadThreshold: asBoundedNumber(
    process.env.OPENAI_STT_VAD_THRESHOLD,
    {
      fallback: 0.015,
      min: 0,
      max: 1
    }
  ),
  openaiSttHangoverMs: asBoundedNumber(
    process.env.OPENAI_STT_HANGOVER_MS,
    {
      fallback: 300,
      min: 120,
      max: 8000,
      integer: true
    }
  ),
  openaiSttSegmentMinMs: asBoundedNumber(
    process.env.OPENAI_STT_SEGMENT_MIN_MS,
    {
      fallback: 240,
      min: 120,
      max: 12000,
      integer: true
    }
  ),
  openaiSttSegmentMaxMs: asBoundedNumber(
    process.env.OPENAI_STT_SEGMENT_MAX_MS,
    {
      fallback: 7000,
      min: 400,
      max: 30000,
      integer: true
    }
  ),
  bridgeTtsOutputDeviceId: cleanString(
    process.env.BRIDGE_TTS_OUTPUT_DEVICE_ID,
    cleanString(process.env.OPENAI_TTS_OUTPUT_DEVICE_ID)
  ),
  bridgeTtsOutputDeviceLabel: cleanString(
    process.env.BRIDGE_TTS_OUTPUT_DEVICE_LABEL,
    cleanString(process.env.OPENAI_TTS_OUTPUT_DEVICE_LABEL)
  ),
  autoGreetingEnabled: asBoolean(process.env.AUTO_GREETING_ENABLED, true),
  autoGreetingDelayMs: asBoundedNumber(process.env.AUTO_GREETING_DELAY_MS, {
    fallback: 2000,
    min: 0,
    max: 60000,
    integer: true
  }),
  autoGreetingPrompt: cleanString(
    process.env.AUTO_GREETING_PROMPT,
    "System event: The Google Meet call has just connected and the user is silent. Start with one short friendly opening, briefly introduce yourself as SmartSpine's live assistant, then ask for the user's name and goal. Do not use rigid scripted wording."
  ),
  semanticEotEnabled: asBoolean(process.env.SEMANTIC_EOT_ENABLED, true),
  semanticEotUseLlm: asBoolean(process.env.SEMANTIC_EOT_USE_LLM, false),
  semanticEotModel: cleanString(
    process.env.SEMANTIC_EOT_MODEL,
    process.env.OPENAI_MODEL || "gpt-4o-mini"
  ),
  semanticEotTimeoutMs: asBoundedNumber(process.env.SEMANTIC_EOT_TIMEOUT_MS, {
    fallback: 180,
    min: 60,
    max: 5000,
    integer: true
  }),
  semanticEotMinDelayMs: asBoundedNumber(
    process.env.SEMANTIC_EOT_MIN_DELAY_MS,
    {
      fallback: 250,
      min: 120,
      max: 1500,
      integer: true
    }
  ),
  semanticEotMaxDelayMs: asBoundedNumber(
    process.env.SEMANTIC_EOT_MAX_DELAY_MS,
    {
      fallback: 900,
      min: 180,
      max: 6000,
      integer: true
    }
  ),
  partialSpeculationEnabled: asBoolean(
    process.env.PARTIAL_SPECULATION_ENABLED,
    true
  ),
  partialSpeculationMinWords: asBoundedNumber(
    process.env.PARTIAL_SPECULATION_MIN_WORDS,
    {
      fallback: 3,
      min: 1,
      max: 20,
      integer: true
    }
  ),
  partialSpeculationTimeoutMs: asBoundedNumber(
    process.env.PARTIAL_SPECULATION_TIMEOUT_MS,
    {
      fallback: 1400,
      min: 100,
      max: 10000,
      integer: true
    }
  ),
  partialSpeculationMaxAgeMs: asBoundedNumber(
    process.env.PARTIAL_SPECULATION_MAX_AGE_MS,
    {
      fallback: 1800,
      min: 100,
      max: 15000,
      integer: true
    }
  ),
  turnSilenceMs: asBoundedNumber(process.env.TURN_SILENCE_MS, {
    fallback: 280,
    min: 120,
    max: 6000,
    integer: true
  }),
  postTurnResponseDelayMs: asBoundedNumber(
    process.env.POST_TURN_RESPONSE_DELAY_MS,
    {
      fallback: 0,
      min: 0,
      max: 10000,
      integer: true
    }
  ),
  turnContinuationSilenceMs: asBoundedNumber(
    process.env.TURN_CONTINUATION_SILENCE_MS,
    {
      fallback: 360,
      min: 120,
      max: 10000,
      integer: true
    }
  ),
  turnStitchEnabled: asBoolean(process.env.TURN_STITCH_ENABLED, true),
  turnStitchWindowMs: asBoundedNumber(process.env.TURN_STITCH_WINDOW_MS, {
    fallback: 1100,
    min: 200,
    max: 5000,
    integer: true
  }),
  silenceAfterSpeakMs: asBoundedNumber(process.env.SILENCE_AFTER_SPEAK_MS, {
    fallback: 180,
    min: 0,
    max: 8000,
    integer: true
  }),
  inboundDedupMs: asBoundedNumber(process.env.INBOUND_DEDUP_MS, {
    fallback: 10000,
    min: 500,
    max: 120000,
    integer: true
  }),
  bridgePort: asBoundedNumber(process.env.BRIDGE_PORT, {
    fallback: 3100,
    min: 1,
    max: 65535,
    integer: true
  }), // Local bridge UI + TTS playback
  bridgeHost: cleanString(process.env.BRIDGE_HOST, "127.0.0.1"),
  controlApiPort: asBoundedNumber(process.env.CONTROL_API_PORT, {
    fallback: 3200,
    min: 1,
    max: 65535,
    integer: true
  }),
  controlApiHost: cleanString(process.env.CONTROL_API_HOST, "127.0.0.1"),
  controlApiToken: cleanString(process.env.CONTROL_API_TOKEN),
  controlApiCorsAllowlist: parseCsvList(process.env.CONTROL_API_CORS_ALLOWLIST),
  configEncryptionKey: cleanString(process.env.CONFIG_ENCRYPTION_KEY),
  configOverridesFile: cleanString(
    process.env.CONFIG_OVERRIDES_FILE,
    ".config/config.overrides.enc"
  ),
  configAuditFile: cleanString(
    process.env.CONFIG_AUDIT_FILE,
    ".config/config.audit.log"
  ),
  configBackupsDir: cleanString(
    process.env.CONFIG_BACKUPS_DIR,
    ".config/config-backups"
  ),
  allowAnyMeetUrl: asBoolean(process.env.ALLOW_ANY_MEET_URL, false),
  headless: asBoolean(process.env.HEADLESS, false),
  chromePath: cleanString(process.env.CHROME_PATH),
  chromeUserDataDir: process.env.CHROME_USER_DATA_DIR || ".chrome-profile",
  meetAssumeLoggedIn: asBoolean(process.env.MEET_ASSUME_LOGGED_IN, false),
  meetJoinStateTimeoutMs: asBoundedNumber(
    process.env.MEET_JOIN_STATE_TIMEOUT_MS,
    {
      fallback: 6000,
      min: 1000,
      max: 30000,
      integer: true
    }
  ),
  meetJoinPollMs: asBoundedNumber(process.env.MEET_JOIN_POLL_MS, {
    fallback: 1200,
    min: 300,
    max: 15000,
    integer: true
  }),
  meetJoinClickAttempts: asBoundedNumber(
    process.env.MEET_JOIN_CLICK_ATTEMPTS,
    {
      fallback: 8,
      min: 1,
      max: 30,
      integer: true
    }
  ),
  meetJoinClickRetryMs: asBoundedNumber(
    process.env.MEET_JOIN_CLICK_RETRY_MS,
    {
      fallback: 700,
      min: 120,
      max: 5000,
      integer: true
    }
  )
};

function validateCoreConfig(inputConfig = config) {
  const missing = [];
  if (!inputConfig.openaiApiKey) {
    missing.push("OPENAI_API_KEY");
  }
  return missing;
}

function validateSessionConfig(
  inputConfig = config,
  { requireMeetUrl = true } = {}
) {
  const missing = [];
  if (!inputConfig.openaiApiKey) {
    missing.push("OPENAI_API_KEY");
  }
  if (requireMeetUrl && !inputConfig.meetUrl) {
    missing.push("MEET_URL");
  } else if (
    inputConfig.meetUrl &&
    !isAllowedMeetUrl(inputConfig.meetUrl, {
      allowAnyMeetUrl: inputConfig.allowAnyMeetUrl
    })
  ) {
    missing.push(
      inputConfig.allowAnyMeetUrl
        ? "MEET_URL (must be a valid http/https URL)"
        : "MEET_URL (must match https://meet.google.com/...)"
    );
  }
  return missing;
}

function validateConfig(inputConfig = config) {
  return validateSessionConfig(inputConfig, { requireMeetUrl: true });
}

module.exports = {
  config,
  validateConfig,
  validateCoreConfig,
  validateSessionConfig,
  isAllowedMeetUrl
};

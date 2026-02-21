const fs = require("fs");
const path = require("path");

const KEY_NAME_REGEX = /^[A-Z0-9_]{2,64}$/;
const SAFE_CUSTOM_PREFIX = "CUSTOM_";

const DANGEROUS_ENV_KEYS = new Set([
  "PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "INIT_CWD",
  "NPM_CONFIG_PREFIX",
  "NPM_TOKEN",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "BASH_ENV"
]);

function readEnvExampleKeys() {
  const envExamplePath = path.resolve(process.cwd(), ".env.example");
  try {
    const content = fs.readFileSync(envExamplePath, "utf8");
    const keys = new Set();
    for (const line of content.split(/\r?\n/)) {
      const trimmed = String(line || "").trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = /^([A-Z0-9_]{2,64})\s*=/.exec(trimmed);
      if (match) {
        keys.add(match[1]);
      }
    }
    return keys;
  } catch (_) {
    return new Set();
  }
}

function buildBaseSchema() {
  const keys = readEnvExampleKeys();
  const schema = {};

  for (const key of keys) {
    schema[key] = {
      type: "string",
      sensitive: false,
      restartRequired: true,
      maxLength: 4096,
      multiline: false,
      description: "Environment variable"
    };
  }

  const overrides = {
    OPENAI_API_KEY: {
      sensitive: true,
      description: "OpenAI API key"
    },
    CONTROL_API_TOKEN: {
      sensitive: true,
      description: "Bearer token for Control API"
    },
    CONFIG_ENCRYPTION_KEY: {
      sensitive: true,
      description: "32-byte key used to encrypt UI config overrides"
    },
    OPENAI_TEMPERATURE: {
      type: "number",
      min: 0,
      max: 2,
      restartRequired: false
    },
    OPENAI_TTS_SPEED: {
      type: "number",
      min: 0.25,
      max: 4,
      restartRequired: false
    },
    OPENAI_TTS_STREAM_FORMAT: {
      type: "enum",
      allowedValues: ["audio", "sse"],
      restartRequired: false
    },
    OPENAI_TTS_FORMAT: {
      type: "enum",
      allowedValues: ["mp3", "opus", "aac", "flac", "wav", "pcm"],
      restartRequired: false
    },
    OPENAI_TTS_MODEL: {
      type: "enum",
      allowedValues: [
        "tts-1",
        "tts-1-hd",
        "gpt-4o-mini-tts",
        "gpt-4o-mini-tts-2025-12-15"
      ],
      restartRequired: false
    },
    OPENAI_TTS_INSTRUCTIONS: {
      type: "string",
      maxLength: 2000,
      multiline: true,
      restartRequired: false
    },
    OPENAI_TTS_VOICE_ID: {
      type: "string",
      maxLength: 128,
      restartRequired: false
    },
    SYSTEM_PROMPT: {
      type: "string",
      maxLength: 20000,
      multiline: true,
      restartRequired: false
    },
    PROJECT_CONTEXT: {
      type: "string",
      maxLength: 12000,
      multiline: true,
      restartRequired: false
    },
    VOICE_CORE_MODE: {
      type: "enum",
      allowedValues: ["server"],
      restartRequired: false
    },
    VOICE_CORE_VERBOSE_LOGS: {
      type: "boolean",
      restartRequired: false
    },
    OPENAI_REALTIME_TURN_DETECTION: {
      type: "enum",
      allowedValues: ["manual", "server_vad", "semantic_vad"],
      restartRequired: false
    },
    OPENAI_REALTIME_TURN_EAGERNESS: {
      type: "enum",
      allowedValues: ["low", "medium", "high", "auto"],
      restartRequired: false
    },
    OPENAI_REALTIME_VAD_THRESHOLD: {
      type: "number",
      min: 0,
      max: 1,
      restartRequired: false
    },
    OPENAI_REALTIME_VAD_SILENCE_MS: {
      type: "number",
      min: 120,
      max: 5000,
      integer: true,
      restartRequired: false
    },
    OPENAI_REALTIME_VAD_PREFIX_PADDING_MS: {
      type: "number",
      min: 0,
      max: 2000,
      integer: true,
      restartRequired: false
    },
    OPENAI_REALTIME_INTERRUPT_RESPONSE_ON_TURN: {
      type: "boolean",
      restartRequired: false
    },
    OPENAI_STT_LOG_FINALS: {
      type: "boolean",
      restartRequired: false
    },
    OPENAI_STT_LOG_PARTIALS: {
      type: "boolean",
      restartRequired: false
    },
    OPENAI_STT_PREFER_LOOPBACK: {
      type: "boolean",
      restartRequired: false
    },
    BARGE_IN_ENABLED: {
      type: "boolean",
      restartRequired: false
    },
    BARGE_IN_ON_VAD_CONFIRMED: {
      type: "boolean",
      restartRequired: false
    },
    BARGE_IN_MIN_MS: {
      type: "number",
      min: 0,
      max: 10000,
      integer: true,
      restartRequired: false
    },
    SOFT_INTERRUPT_ENABLED: {
      type: "boolean",
      restartRequired: false
    },
    SOFT_INTERRUPT_CONFIRM_MS: {
      type: "number",
      min: 150,
      max: 6000,
      integer: true,
      restartRequired: false
    },
    SOFT_INTERRUPT_DUCK_LEVEL: {
      type: "number",
      min: 0,
      max: 1,
      restartRequired: false
    },
    AUTO_GREETING_ENABLED: {
      type: "boolean",
      restartRequired: false
    },
    AUTO_GREETING_DELAY_MS: {
      type: "number",
      min: 0,
      max: 60000,
      integer: true,
      restartRequired: false
    },
    AUTO_LEAVE_ON_INTAKE_COMPLETE: {
      type: "boolean",
      restartRequired: false
    },
    INTAKE_COMPLETE_LEAVE_DELAY_MS: {
      type: "number",
      min: 0,
      max: 30000,
      integer: true,
      restartRequired: false
    },
    CALL_SUMMARY_ENABLED: {
      type: "boolean",
      restartRequired: false
    },
    CALL_SUMMARY_TEMPERATURE: {
      type: "number",
      min: 0,
      max: 2,
      restartRequired: false
    },
    CALL_SUMMARY_TIMEOUT_MS: {
      type: "number",
      min: 2000,
      max: 120000,
      integer: true,
      restartRequired: false
    },
    HEADLESS: {
      type: "boolean",
      restartRequired: true
    },
    MEET_ASSUME_LOGGED_IN: {
      type: "boolean",
      restartRequired: false
    },
    ALLOW_ANY_MEET_URL: {
      type: "boolean",
      restartRequired: true
    },
    CONTROL_API_PORT: {
      type: "number",
      min: 1,
      max: 65535,
      integer: true,
      restartRequired: true
    },
    CONTROL_API_HOST: {
      type: "string",
      maxLength: 128,
      restartRequired: true
    },
    CONTROL_API_CORS_ALLOWLIST: {
      type: "string",
      maxLength: 2000,
      restartRequired: true,
      description: "Comma-separated origins"
    },
    CONFIG_OVERRIDES_FILE: {
      type: "string",
      maxLength: 512,
      restartRequired: true
    },
    CONFIG_AUDIT_FILE: {
      type: "string",
      maxLength: 512,
      restartRequired: true
    },
    CONFIG_BACKUPS_DIR: {
      type: "string",
      maxLength: 512,
      restartRequired: true
    },
    VERBOSE_SESSION_LOGS: {
      type: "boolean",
      restartRequired: false
    }
  };

  for (const [key, partial] of Object.entries(overrides)) {
    schema[key] = {
      type: "string",
      sensitive: false,
      restartRequired: true,
      maxLength: 4096,
      multiline: false,
      description: "Environment variable",
      ...(schema[key] || {}),
      ...partial
    };
  }

  // Explicitly expose vars not present in .env.example yet.
  for (const missingKey of [
    "OPENAI_TTS_INSTRUCTIONS",
    "OPENAI_TTS_SPEED",
    "OPENAI_TTS_STREAM_FORMAT",
    "OPENAI_TTS_VOICE_ID",
    "VOICE_CORE_MODE",
    "VOICE_CORE_VERBOSE_LOGS",
    "CONTROL_API_CORS_ALLOWLIST",
    "CONFIG_ENCRYPTION_KEY",
    "CONFIG_OVERRIDES_FILE",
    "CONFIG_AUDIT_FILE",
    "CONFIG_BACKUPS_DIR"
  ]) {
    if (!schema[missingKey]) {
      schema[missingKey] = {
        type: "string",
        sensitive: false,
        restartRequired: true,
        maxLength: 4096,
        multiline: false,
        description: "Environment variable"
      };
    }
  }

  return schema;
}

const SCHEMA = buildBaseSchema();

function normalizeKeyName(key) {
  return String(key || "").trim().toUpperCase();
}

function isSensitiveKey(key) {
  const normalized = normalizeKeyName(key);
  if (!normalized) {
    return false;
  }
  const meta = SCHEMA[normalized];
  if (meta?.sensitive) {
    return true;
  }
  return /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/.test(normalized);
}

function maskSensitiveValue(value) {
  const normalized = String(value || "");
  if (!normalized) {
    return "";
  }
  return "********";
}

function normalizeBoolean(rawValue) {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  const normalized = String(rawValue || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error("must be a boolean value");
}

function normalizeNumber(rawValue, meta = {}) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error("must be a finite number");
  }
  if (meta.integer && !Number.isInteger(parsed)) {
    throw new Error("must be an integer");
  }
  if (Number.isFinite(meta.min) && parsed < Number(meta.min)) {
    throw new Error(`must be >= ${meta.min}`);
  }
  if (Number.isFinite(meta.max) && parsed > Number(meta.max)) {
    throw new Error(`must be <= ${meta.max}`);
  }
  return String(meta.integer ? Math.trunc(parsed) : parsed);
}

function normalizeString(rawValue, meta = {}) {
  const text = String(rawValue ?? "");
  if (!meta.multiline && /\r|\n/.test(text)) {
    throw new Error("must be single-line");
  }
  const maxLength = Number.isFinite(Number(meta.maxLength))
    ? Number(meta.maxLength)
    : 4096;
  if (text.length > maxLength) {
    throw new Error(`must be <= ${maxLength} characters`);
  }
  if (meta.pattern) {
    const regex = meta.pattern instanceof RegExp ? meta.pattern : new RegExp(meta.pattern);
    if (!regex.test(text)) {
      throw new Error("has invalid format");
    }
  }
  return text;
}

function normalizeEnum(rawValue, meta = {}) {
  const value = String(rawValue ?? "").trim();
  const allowed = Array.isArray(meta.allowedValues) ? meta.allowedValues : [];
  if (!allowed.includes(value)) {
    throw new Error(`must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function normalizeJson(rawValue) {
  if (rawValue && typeof rawValue === "object") {
    return JSON.stringify(rawValue);
  }
  const text = String(rawValue ?? "").trim();
  if (!text) {
    return "";
  }
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed);
  } catch (_) {
    throw new Error("must be valid JSON");
  }
}

function validateKeyNameOrThrow(key) {
  const normalized = normalizeKeyName(key);
  if (!normalized) {
    throw new Error("key is required");
  }
  if (!KEY_NAME_REGEX.test(normalized)) {
    throw new Error("key must match ^[A-Z0-9_]{2,64}$");
  }
  if (DANGEROUS_ENV_KEYS.has(normalized)) {
    throw new Error("key is blocked for security reasons");
  }
  const hasKnownSchema = Boolean(SCHEMA[normalized]);
  const isCustom = normalized.startsWith(SAFE_CUSTOM_PREFIX);
  if (!hasKnownSchema && !isCustom) {
    throw new Error(
      `key is not in schema allowlist; use a known key or ${SAFE_CUSTOM_PREFIX}*`
    );
  }
  return normalized;
}

function validateKeyValueOrThrow(key, value) {
  const normalizedKey = validateKeyNameOrThrow(key);
  const meta =
    SCHEMA[normalizedKey] || {
      type: "string",
      sensitive: isSensitiveKey(normalizedKey),
      restartRequired: false,
      maxLength: 4096,
      multiline: false,
      description: "Custom environment variable"
    };

  let normalizedValue = "";
  if (meta.type === "boolean") {
    normalizedValue = String(normalizeBoolean(value));
  } else if (meta.type === "number") {
    normalizedValue = normalizeNumber(value, meta);
  } else if (meta.type === "enum") {
    normalizedValue = normalizeEnum(value, meta);
  } else if (meta.type === "json") {
    normalizedValue = normalizeJson(value);
  } else {
    normalizedValue = normalizeString(value, meta);
  }

  return {
    key: normalizedKey,
    value: normalizedValue,
    meta
  };
}

function listSchemaForClient() {
  return Object.keys(SCHEMA)
    .sort()
    .map((key) => ({
      key,
      type: SCHEMA[key].type || "string",
      sensitive: Boolean(SCHEMA[key].sensitive),
      restartRequired: SCHEMA[key].restartRequired !== false,
      description: SCHEMA[key].description || "",
      allowedValues: Array.isArray(SCHEMA[key].allowedValues)
        ? [...SCHEMA[key].allowedValues]
        : undefined,
      min: Number.isFinite(Number(SCHEMA[key].min)) ? Number(SCHEMA[key].min) : undefined,
      max: Number.isFinite(Number(SCHEMA[key].max)) ? Number(SCHEMA[key].max) : undefined,
      integer: Boolean(SCHEMA[key].integer),
      multiline: Boolean(SCHEMA[key].multiline)
    }));
}

module.exports = {
  KEY_NAME_REGEX,
  SAFE_CUSTOM_PREFIX,
  DANGEROUS_ENV_KEYS,
  SCHEMA,
  normalizeKeyName,
  isSensitiveKey,
  maskSensitiveValue,
  validateKeyNameOrThrow,
  validateKeyValueOrThrow,
  listSchemaForClient
};

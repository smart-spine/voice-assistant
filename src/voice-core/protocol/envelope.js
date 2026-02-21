const crypto = require("crypto");
const {
  PROTOCOL_VERSION,
  ALL_MESSAGE_TYPES
} = require("./constants");

function nowMs() {
  return Date.now();
}

function createId(prefix = "msg") {
  return `${String(prefix || "msg")}_${Date.now()}_${crypto
    .randomBytes(4)
    .toString("hex")}`;
}

function normalizeType(type) {
  return String(type || "")
    .trim()
    .toLowerCase();
}

function normalizeSessionId(sessionId) {
  return String(sessionId || "").trim();
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

function buildEnvelope({
  type,
  payload = {},
  sessionId = "",
  msgId = "",
  replyTo = null,
  tsMs = nowMs(),
  v = PROTOCOL_VERSION
} = {}) {
  const normalizedType = normalizeType(type);
  if (!normalizedType) {
    throw new Error("Envelope type is required.");
  }

  const envelope = {
    v: Number.isFinite(Number(v)) ? Number(v) : PROTOCOL_VERSION,
    type: normalizedType,
    msg_id: String(msgId || createId("msg")),
    ts_ms: Number.isFinite(Number(tsMs)) ? Number(tsMs) : nowMs(),
    payload: normalizePayload(payload)
  };

  const normalizedSessionId = normalizeSessionId(sessionId);
  if (normalizedSessionId) {
    envelope.session_id = normalizedSessionId;
  }

  const normalizedReplyTo = String(replyTo || "").trim();
  if (normalizedReplyTo) {
    envelope.reply_to = normalizedReplyTo;
  }

  return envelope;
}

function validateEnvelope(rawValue, {
  requireSessionId = false,
  strictType = false,
  allowUnknownType = true
} = {}) {
  const envelope =
    rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)
      ? rawValue
      : null;

  if (!envelope) {
    return {
      ok: false,
      code: "bad_envelope",
      message: "Envelope must be a JSON object.",
      value: null
    };
  }

  const normalizedType = normalizeType(envelope.type);
  if (!normalizedType) {
    return {
      ok: false,
      code: "bad_type",
      message: "Envelope `type` is required.",
      value: null
    };
  }

  if (strictType && !ALL_MESSAGE_TYPES.has(normalizedType) && !allowUnknownType) {
    return {
      ok: false,
      code: "unsupported_type",
      message: `Unsupported envelope type: ${normalizedType}.`,
      value: null
    };
  }

  const normalizedMsgId = String(envelope.msg_id || "").trim();
  if (!normalizedMsgId) {
    return {
      ok: false,
      code: "bad_msg_id",
      message: "Envelope `msg_id` is required.",
      value: null
    };
  }

  const normalizedSessionId = normalizeSessionId(envelope.session_id);
  if (requireSessionId && !normalizedSessionId) {
    return {
      ok: false,
      code: "bad_session_id",
      message: "Envelope `session_id` is required.",
      value: null
    };
  }

  const normalizedVersion = Number(envelope.v);
  if (!Number.isFinite(normalizedVersion) || normalizedVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "bad_protocol_version",
      message: `Unsupported protocol version: ${String(envelope.v)}.`,
      value: null
    };
  }

  const normalizedTs = Number(envelope.ts_ms);
  if (!Number.isFinite(normalizedTs) || normalizedTs <= 0) {
    return {
      ok: false,
      code: "bad_timestamp",
      message: "Envelope `ts_ms` must be a positive number.",
      value: null
    };
  }

  return {
    ok: true,
    code: "ok",
    message: "ok",
    value: {
      v: PROTOCOL_VERSION,
      type: normalizedType,
      msg_id: normalizedMsgId,
      session_id: normalizedSessionId || undefined,
      reply_to: String(envelope.reply_to || "").trim() || undefined,
      ts_ms: normalizedTs,
      payload: normalizePayload(envelope.payload)
    }
  };
}

function parseEnvelope(raw, options = {}) {
  let decoded = raw;
  if (typeof raw === "string") {
    try {
      decoded = JSON.parse(raw);
    } catch (_) {
      return {
        ok: false,
        code: "bad_json",
        message: "Control frame is not valid JSON.",
        value: null
      };
    }
  }
  return validateEnvelope(decoded, options);
}

module.exports = {
  nowMs,
  createId,
  normalizeType,
  buildEnvelope,
  validateEnvelope,
  parseEnvelope
};

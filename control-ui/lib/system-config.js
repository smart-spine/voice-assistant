import path from "node:path";

function asBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function asInteger(value, fallback, min = 0, max = Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeBaseUrl(raw) {
  try {
    const parsed = new URL(String(raw || "http://127.0.0.1:3200").trim());
    return parsed.toString().replace(/\/$/, "");
  } catch (_) {
    return "http://127.0.0.1:3200";
  }
}

function normalizeWsBaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    }

    if (!["ws:", "wss:"].includes(parsed.protocol)) {
      return "";
    }

    return parsed.toString().replace(/\/$/, "");
  } catch (_) {
    return "";
  }
}

export function getSystemConfig() {
  return {
    controlApiBaseUrl: normalizeBaseUrl(process.env.CONTROL_API_BASE_URL),
    controlApiWsBaseUrl: normalizeWsBaseUrl(process.env.CONTROL_API_WS_BASE_URL),
    controlApiToken: String(process.env.CONTROL_API_TOKEN || "").trim(),
    controlApiTimeoutMs: asInteger(process.env.CONTROL_API_TIMEOUT_MS, 8000, 1000, 60000),
    controlApiStartTimeoutMs: asInteger(
      process.env.CONTROL_API_START_TIMEOUT_MS,
      120000,
      5000,
      600000
    ),
    managedApiEnabled: asBoolean(process.env.MANAGED_API_ENABLED, true),
    managedApiCommand: String(process.env.MANAGED_API_COMMAND || "npm run start:api").trim(),
    managedApiCwd: path.resolve(process.cwd(), process.env.MANAGED_API_CWD || ".."),
    managedApiStopTimeoutMs: asInteger(
      process.env.MANAGED_API_STOP_TIMEOUT_MS,
      15000,
      1000,
      120000
    ),
    logBufferLimit: asInteger(process.env.LOG_BUFFER_LIMIT, 2000, 200, 20000)
  };
}
